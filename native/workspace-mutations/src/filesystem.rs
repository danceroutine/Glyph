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

pub(super) fn execute(request: &Request) -> Result<(), Failure> {
    let root = open_root(&request.root, &request.root_identity)?;
    match &request.operation {
        Operation::EnsureDirectory { relative, mode } => {
            let components = relative_components(relative)?;
            open_directories(
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
                Err(error) if error.code == "ENOENT" => return Ok(()),
                Err(error) => return Err(error),
                Ok((parent, name)) => {
                    let mut remaining = MAX_REMOVE_ENTRIES;
                    let leaf = CString::new(name).expect("validated path component");
                    remove_entry(&parent, &leaf, 0, &mut remaining)?;
                    fsync(&parent)?;
                }
            }
        }
    }
    Ok(())
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
        open_directories(rustix::io::dup(root)?, ancestors, None)?,
        name,
    ))
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
