use super::{Failure, Identity, Operation, Request};
use rustix::fd::OwnedFd;
use rustix::fs::{
    fchmod, fstat, fsync, mkdirat, open, openat, renameat_with, statat, unlinkat, AtFlags, Dir,
    Mode, OFlags, RenameFlags, Stat,
};
use rustix::io::Errno;
use std::ffi::{CStr, CString};
mod staging;

#[cfg(test)]
#[path = "tests/filesystem.rs"]
mod tests;

const DIRECTORY: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);
const MAX_REMOVE_DEPTH: usize = 64;
const MAX_REMOVE_ENTRIES: usize = 65_536;

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Self::new("EIO", error.to_string())
    }
}

impl From<Errno> for Failure {
    fn from(errno: Errno) -> Self {
        let code = match errno {
            Errno::NOENT => "ENOENT",
            Errno::EXIST => "EEXIST",
            Errno::NOTDIR => "ENOTDIR",
            Errno::LOOP => "ELOOP",
            Errno::NOTEMPTY => "ENOTEMPTY",
            Errno::ACCESS | Errno::PERM => "EACCES",
            Errno::STALE => "ESTALE",
            Errno::XDEV => "EXDEV",
            Errno::NOTSUP | Errno::NOSYS => "ENOTSUP",
            _ => "OTHER",
        };
        Self::new(code, errno.to_string())
    }
}

pub(super) fn execute(request: &Request) -> Result<Option<String>, Failure> {
    let root = open_root(&request.root, &request.root_identity)?;
    match &request.operation {
        Operation::AssertReplaceableMetadata {
            relative,
            recursive,
            ownership_reference,
        } => {
            let owner = if let Some(path) = ownership_reference {
                let dir = open_relative_directories(
                    rustix::io::dup(&root)?,
                    &relative_components(path)?,
                    None,
                )?;
                let stat = fstat(dir)?;
                Some((stat.st_uid, stat.st_gid))
            } else {
                None
            };
            let parts = relative_components(relative)?;
            let (parent, name) = open_parent(&root, &parts)?;
            let mut remaining = MAX_REMOVE_ENTRIES;
            let digest = inspect_metadata(
                &parent,
                &CString::new(name).expect("validated name"),
                *recursive,
                0,
                &mut remaining,
                owner,
            )?;
            return Ok(Some(format!("{digest:x}")));
        }
        Operation::EnsureDirectory { relative, mode } => {
            let components = relative_components(relative)?;
            open_relative_directories(
                root,
                &components,
                Some(staging::mode(mode.unwrap_or(0o700))?),
            )?;
        }
        Operation::CreateStage { relative } => {
            staging::create_stage(&root, relative)?;
        }
        Operation::StagePackage {
            relative,
            directories,
            files,
        } => {
            staging::materialize(&root, relative, directories, files)?;
        }
        Operation::RenameExclusive {
            source_relative,
            target_relative,
        } => {
            let source = relative_components(source_relative)?;
            let target = relative_components(target_relative)?;
            let (from, source_name) = open_parent(&root, &source)?;
            let (to, target_name) = open_parent(&root, &target)?;
            rename_pinned(&from, source_name, &to, target_name)?;
        }
        Operation::RemoveTree { relative } => {
            let components = relative_components(relative)?;
            match open_parent(&root, &components) {
                Err(error) if error.code == "ENOENT" => return Ok(None),
                Err(error) => return Err(error),
                Ok((parent, name)) => {
                    let mut remaining = MAX_REMOVE_ENTRIES;
                    let leaf = CString::new(name).expect("validated path component");
                    if let [".skill-staging", _] = components.as_slice() {
                        match openat(&parent, &leaf, DIRECTORY, Mode::empty()) {
                            Ok(stage) => staging::check_private(&stage)?,
                            Err(Errno::NOENT) => return Ok(None),
                            Err(error) => return Err(error.into()),
                        }
                    }
                    remove_entry(&parent, &leaf, 0, &mut remaining)?;
                    fsync(&parent)?;
                }
            }
        }
    }
    Ok(None)
}

fn open_root(root: &str, expected: &Identity) -> Result<OwnedFd, Failure> {
    let relative = root.strip_prefix('/').ok_or_else(Failure::invalid)?;
    let mut fd = open("/", DIRECTORY, Mode::empty())?;
    if !relative.is_empty() {
        let components = components(relative)?;
        fd = open_directories(fd, &components, None)?;
    }
    let stat = fstat(&fd)?;
    if stat.st_dev.to_string() != expected.device || stat.st_ino.to_string() != expected.inode {
        return Err(Failure::new(
            "ESTALE",
            "The workspace root identity changed.",
        ));
    }
    Ok(fd)
}

fn components(path: &str) -> Result<Vec<&str>, Failure> {
    if path.len() > 4096 || path.as_bytes().contains(&0) {
        return Err(Failure::invalid());
    }
    let parts: Vec<_> = path.split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(Failure::invalid());
    }
    Ok(parts)
}

fn relative_components(path: &str) -> Result<Vec<&str>, Failure> {
    if path.contains('\\') {
        return Err(Failure::invalid());
    }
    components(path)
}

fn open_directories(
    mut parent: OwnedFd,
    path: &[&str],
    create: Option<Mode>,
) -> Result<OwnedFd, Failure> {
    for name in path {
        parent = match openat(&parent, *name, DIRECTORY, Mode::empty()) {
            Err(Errno::NOENT) if create.is_some() => {
                // Another initializer can publish the same directory. Re-open and verify its actual type in both cases.
                match mkdirat(&parent, *name, create.expect("requested creation")) {
                    Ok(()) | Err(Errno::EXIST) => {}
                    Err(error) => return Err(error.into()),
                }
                fsync(&parent)?;
                openat(&parent, *name, DIRECTORY, Mode::empty())?
            }
            other => other?,
        };
    }
    Ok(parent)
}

fn open_parent<'a>(root: &OwnedFd, components: &[&'a str]) -> Result<(OwnedFd, &'a str), Failure> {
    // Validated paths contain a final non-empty name; the parent walk never includes that name.
    let (name, ancestors) = components.split_last().expect("validated relative path");
    Ok((
        open_relative_directories(rustix::io::dup(root)?, ancestors, None)?,
        name,
    ))
}

fn open_relative_directories(
    mut parent: OwnedFd,
    path: &[&str],
    create: Option<Mode>,
) -> Result<OwnedFd, Failure> {
    if path.first() != Some(&".skill-staging") {
        return open_directories(parent, path, create);
    }
    let (private, contents) = path.split_at(path.len().min(2));
    for component in private {
        parent = open_directories(
            parent,
            std::slice::from_ref(component),
            create.map(|_| Mode::RWXU),
        )?;
        staging::check_private(&parent)?;
    }
    open_directories(parent, contents, create)
}

fn rename_pinned(
    source_parent: &OwnedFd,
    source: &str,
    target_parent: &OwnedFd,
    target: &str,
) -> Result<(), Failure> {
    renameat_with(
        source_parent,
        source,
        target_parent,
        target,
        RenameFlags::NOREPLACE,
    )?;
    fsync(source_parent)?;
    fsync(target_parent)?;
    Ok(())
}

fn check_cleanup_device(opened: &Stat, parent: &Stat) -> Result<(), Failure> {
    if opened.st_dev != parent.st_dev {
        return Err(Errno::XDEV.into());
    }
    Ok(())
}

fn check_cleanup_identity(opened: &Stat, current: &Stat) -> Result<(), Failure> {
    if opened.st_dev != current.st_dev || opened.st_ino != current.st_ino {
        return Err(Failure::new(
            "ESTALE",
            "The cleanup directory was replaced.",
        ));
    }
    Ok(())
}

fn inspect_metadata(
    parent: &OwnedFd,
    name: &CStr,
    recursive: bool,
    depth: usize,
    remaining: &mut usize,
    owner: Option<(u32, u32)>,
) -> Result<sha2::digest::Output<sha2::Sha256>, Failure> {
    use rustix::fs::FileType;
    use sha2::{Digest, Sha256};
    if depth > MAX_REMOVE_DEPTH || *remaining == 0 {
        return Err(Failure::invalid());
    }
    *remaining -= 1;
    let fd = openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    let info = fstat(&fd)?;
    let kind = FileType::from_raw_mode(info.st_mode);
    if !matches!(kind, FileType::RegularFile | FileType::Directory) {
        return Err(Failure::invalid());
    }
    if owner.is_some_and(|(uid, gid)| info.st_gid != gid || (recursive && info.st_uid != uid)) {
        return Err(Failure::new(
            "ENOTSUP",
            "The replacement cannot preserve existing ownership or special permission bits.",
        ));
    }
    let metadata = if recursive || kind != FileType::Directory {
        glyph_filesystem_metadata::assert_replaceable(&fd)
    } else {
        glyph_filesystem_metadata::assert_access_metadata(&fd)
    };
    metadata.map_err(|error| Failure::new("ENOTSUP", error.to_string()))?;
    let mut hash = Sha256::new();
    hash.update(info.st_uid.to_le_bytes());
    hash.update(info.st_gid.to_le_bytes());
    hash.update(info.st_mode.to_le_bytes());
    if recursive && kind == FileType::Directory {
        let mut children = std::collections::BTreeMap::new();
        for entry in Dir::read_from(&fd)? {
            let entry = entry?;
            let child = entry.file_name();
            if child.to_bytes() != b"." && child.to_bytes() != b".." {
                let digest = inspect_metadata(&fd, child, true, depth + 1, remaining, owner)?;
                children.insert(child.to_owned(), digest);
            }
        }
        for (name, digest) in children {
            hash.update(name.as_bytes_with_nul());
            hash.update(digest);
        }
    }
    Ok(hash.finalize())
}

fn remove_entry(
    parent: &OwnedFd,
    name: &CStr,
    depth: usize,
    remaining: &mut usize,
) -> Result<(), Failure> {
    if depth > MAX_REMOVE_DEPTH || *remaining == 0 {
        return Err(Failure::new(
            "INVALID_INPUT",
            "Workspace cleanup exceeded its tree limit.",
        ));
    }
    *remaining -= 1;
    let flags = match openat(parent, name, DIRECTORY, Mode::empty()) {
        Err(Errno::NOENT) => return Ok(()),
        Err(Errno::NOTDIR | Errno::LOOP) => AtFlags::empty(),
        Err(error) => return Err(error.into()),
        Ok(directory) => {
            let opened = fstat(&directory)?;
            check_cleanup_device(&opened, &fstat(parent)?)?;
            if opened.st_uid == rustix::process::geteuid().as_raw()
                && opened.st_mode & 0o700 != 0o700
            {
                let permissions = Mode::from_raw_mode(opened.st_mode) | Mode::RWXU;
                fchmod(&directory, permissions)?;
            }
            for entry in Dir::read_from(&directory)? {
                let entry = entry?;
                let child = entry.file_name();
                if child.to_bytes() != b"." && child.to_bytes() != b".." {
                    remove_entry(&directory, child, depth + 1, remaining)?;
                }
            }
            let current = statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)?;
            check_cleanup_identity(&opened, &current)?;
            AtFlags::REMOVEDIR
        }
    };
    unlink_if_present(parent, name, flags)
}

fn unlink_if_present(parent: &OwnedFd, name: &CStr, flags: AtFlags) -> Result<(), Failure> {
    match unlinkat(parent, name, flags) {
        Ok(()) | Err(Errno::NOENT) => Ok(()),
        Err(error) => Err(error.into()),
    }
}
