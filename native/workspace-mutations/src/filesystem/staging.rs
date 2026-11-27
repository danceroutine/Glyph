use super::{
    open_directories, open_parent, relative_components, Failure, Mode, OwnedFd, DIRECTORY,
};
use crate::{StagedDirectory, StagedFile};
use base64::{engine::general_purpose::STANDARD, Engine};
use rustix::fs::{fchmod, fstat, fsync, mkdirat, openat, OFlags};
use rustix::io::dup;
use std::collections::HashSet;
use std::io::Write;

pub(super) fn mode(bits: u32) -> Result<Mode, Failure> {
    if bits > 0o777 {
        return Err(Failure::invalid());
    }
    Ok(Mode::from_raw_mode(bits as _))
}

fn staging_root(root: &OwnedFd) -> Result<OwnedFd, Failure> {
    let staging = open_directories(dup(root)?, &[".skill-staging"], Some(Mode::RWXU))?;
    check_private(&staging)?;
    Ok(staging)
}

pub(super) fn check_private(directory: &OwnedFd) -> Result<(), Failure> {
    let info = fstat(directory)?;
    if info.st_uid != rustix::process::geteuid().as_raw() || info.st_mode & 0o777 != 0o700 {
        return Err(Failure::new(
            "EACCES",
            "Skill staging requires a private, current-user-owned directory.",
        ));
    }
    glyph_filesystem_metadata::assert_access_metadata(directory)
        .map_err(|error| Failure::new("EACCES", error.to_string()))
}

pub(super) fn create_stage(root: &OwnedFd, relative: &str) -> Result<(), Failure> {
    let parts = relative_components(relative)?;
    let [".skill-staging", id] = parts.as_slice() else {
        return Err(Failure::invalid());
    };
    let staging = staging_root(root)?;
    mkdirat(&staging, *id, Mode::RWXU)?;
    check_private(&openat(&staging, *id, DIRECTORY, Mode::empty())?)?;
    fsync(staging)?;
    Ok(())
}

pub(super) fn materialize(
    root: &OwnedFd,
    relative: &str,
    directories: &[StagedDirectory],
    files: &[StagedFile],
) -> Result<(), Failure> {
    let parts = relative_components(relative)?;
    let [".skill-staging", id, "package"] = parts.as_slice() else {
        return Err(Failure::invalid());
    };
    if directories.len() > 8451 || files.len() > 256 || files.is_empty() {
        return Err(Failure::invalid());
    }
    let parents: HashSet<_> = directories.iter().map(|item| item.path.as_str()).collect();
    if parents.len() != directories.len() || !parents.contains("") {
        return Err(Failure::invalid());
    }
    // Modes describe the installed object, which is owned by the current user after copying.
    // Reject an unreadable tree while the original installation is still in place.
    for directory in directories {
        mode(directory.mode)?;
        if directory.mode & 0o500 != 0o500 {
            return Err(Failure::new(
                "EACCES",
                "Installed directories must be readable and searchable by their owner.",
            ));
        }
    }
    let staging = staging_root(root)?;
    let transaction = openat(staging, *id, DIRECTORY, Mode::empty())?;
    check_private(&transaction)?;
    mkdirat(&transaction, "package", Mode::RWXU)?;
    let package = openat(&transaction, "package", DIRECTORY, Mode::empty())?;
    let mut sorted = directories.iter().collect::<Vec<_>>();
    sorted.sort_unstable_by_key(|directory| directory.path.len());
    for directory in sorted.iter().filter(|directory| !directory.path.is_empty()) {
        let path = relative_components(&directory.path)?;
        let (parent, name) = open_parent(&package, &path)?;
        mkdirat(&parent, name, Mode::RWXU)?;
    }
    let mut byte_count = 0;
    for file in files {
        let path = relative_components(&file.path)?;
        let permissions = mode(file.mode)?;
        if file.mode & 0o400 == 0 {
            return Err(Failure::new(
                "EACCES",
                "Installed skill files must be readable by their owner.",
            ));
        }
        if file.content.len() > 1_398_104 {
            return Err(Failure::invalid());
        }
        let bytes = STANDARD
            .decode(&file.content)
            .map_err(|_| Failure::invalid())?;
        byte_count += bytes.len();
        if bytes.len() > 1024 * 1024 || byte_count > 8 * 1024 * 1024 {
            return Err(Failure::invalid());
        }
        let (parent, name) = open_parent(&package, &path)?;
        let flags =
            OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::WRONLY | OFlags::CLOEXEC;
        let mut handle = std::fs::File::from(openat(parent, name, flags, Mode::RUSR | Mode::WUSR)?);
        handle.write_all(&bytes)?;
        fchmod(&handle, permissions)?;
        fsync(handle)?;
    }
    // Descendants must be populated before an inherited read-only mode is restored.
    for directory in sorted.into_iter().rev() {
        let path = if directory.path.is_empty() {
            Vec::new()
        } else {
            relative_components(&directory.path)?
        };
        let fd = open_directories(dup(&package)?, &path, None)?;
        fchmod(&fd, mode(directory.mode)?)?;
        fsync(fd)?;
    }
    fsync(transaction)?;
    Ok(())
}
