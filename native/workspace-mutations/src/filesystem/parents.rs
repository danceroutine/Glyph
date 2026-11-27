//! Installation parents are shared directories. Rollback claims an empty directory in the private transaction
//! before checking its identity a second time and using rmdir. Any other occupant is restored without replacement.
use super::*;
use sha2::{Digest, Sha256};

fn identity(directory: &OwnedFd) -> Result<String, Failure> {
    let info = fstat(directory)?;
    #[cfg(target_os = "macos")]
    let birth = (info.st_birthtime as i64, info.st_birthtime_nsec as u32);
    #[cfg(target_os = "linux")]
    let birth = {
        use rustix::fs::{statx, StatxFlags};
        let stat = statx(directory, "", AtFlags::EMPTY_PATH, StatxFlags::BTIME)?;
        birth_time(stat)?
    };
    Ok(format!(
        "{:x}",
        Sha256::digest(format!(
            "{}:{}:{}:{}",
            info.st_dev, info.st_ino, birth.0, birth.1
        ))
    ))
}

#[cfg(target_os = "linux")]
fn birth_time(stat: rustix::fs::Statx) -> Result<(i64, u32), Failure> {
    if stat.stx_mask & rustix::fs::StatxFlags::BTIME.bits() == 0 {
        return Err(Failure::new(
            "ENOTSUP",
            "Installation parent identity requires a creation timestamp.",
        ));
    }
    Ok((stat.stx_btime.tv_sec, stat.stx_btime.tv_nsec))
}

pub(super) fn is_staging_slot(parts: &[&str]) -> bool {
    matches!(parts, [".skill-staging", _, slot] if slot.strip_prefix("parent-").is_some_and(|suffix| suffix.parse::<usize>().is_ok()))
}

fn staging_parent<'a>(root: &OwnedFd, path: &'a str) -> Result<(OwnedFd, &'a str), Failure> {
    let parts = relative_components(path)?;
    if !is_staging_slot(&parts) {
        return Err(Failure::invalid());
    }
    open_parent(root, &parts)
}

/// The host journals this private inode's identity before publishing it into the checkout.
pub(super) fn stage(root: &OwnedFd, mode: Mode, staging_slot: &str) -> Result<String, Failure> {
    let (stage, slot) = staging_parent(root, staging_slot)?;
    mkdirat(&stage, slot, mode)?;
    let directory = open_child(&stage, slot, DIRECTORY, Mode::empty())?;
    let receipt = identity(&directory)?;
    fsync(&stage)?;
    Ok(receipt)
}

/// Select the actual destination parent's inheritance through the descriptor used for the exclusive rename.
pub(super) fn inherit_permissions(
    stage: &OwnedFd,
    slot: &str,
    parent: &OwnedFd,
) -> Result<(), Failure> {
    glyph_filesystem_metadata::assert_access_metadata(parent).map_err(unsupported_metadata)?;
    let parent_info = fstat(parent)?;
    #[cfg(target_os = "macos")]
    let inherited_group = false;
    #[cfg(target_os = "linux")]
    let inherited_group = parent_info.st_mode & 0o2000 != 0;
    #[cfg(target_os = "macos")]
    let group = parent_info.st_gid;
    #[cfg(target_os = "linux")]
    let group = if inherited_group {
        parent_info.st_gid
    } else {
        rustix::process::getegid().as_raw()
    };
    let directory = open_child(stage, slot, DIRECTORY, Mode::empty())?;
    apply_permissions(&directory, group, inherited_group)
}

fn apply_permissions(
    directory: &OwnedFd,
    group: u32,
    inherited_group: bool,
) -> Result<(), Failure> {
    let staged = fstat(directory)?;
    if staged.st_gid != group {
        rustix::fs::fchown(directory, None, Some(rustix::process::Gid::from_raw(group)))?;
    }
    let permissions = (staged.st_mode & 0o777) | if inherited_group { 0o2000 } else { 0 };
    fchmod(directory, Mode::from_raw_mode(permissions))?;
    fsync(directory)?;
    Ok(())
}

fn matches_empty(parent: &OwnedFd, name: &str, expected: &str) -> Result<bool, Failure> {
    let directory = match open_child(parent, name, DIRECTORY, Mode::empty()) {
        Err(Errno::NOENT | Errno::NOTDIR | Errno::LOOP | Errno::XDEV) => return Ok(false),
        other => other?,
    };
    if identity(&directory)? != expected {
        return Ok(false);
    }
    for entry in Dir::read_from(&directory)? {
        if !matches!(entry?.file_name().to_bytes(), b"." | b"..") {
            return Ok(false);
        }
    }
    Ok(true)
}

pub(super) fn rollback(
    root: &OwnedFd,
    relative: &str,
    expected: &str,
    staging_slot: &str,
) -> Result<(), Failure> {
    let (stage, slot) = staging_parent(root, staging_slot)?;
    let claimed = optional(statat(&stage, slot, AtFlags::SYMLINK_NOFOLLOW))?.is_some();
    let parts = relative_components(relative)?;
    let destination = if claimed {
        None
    } else {
        let (parent, name) = match open_parent(root, &parts) {
            Err(error) if matches!(error.code, "ENOENT" | "ENOTDIR" | "ELOOP" | "EXDEV") => {
                return Ok(())
            }
            other => other?,
        };
        if !matches_empty(&parent, name, expected)? || !claim(&parent, name, &stage, slot)? {
            return Ok(());
        }
        Some((parent, name))
    };
    finish_claim(root, &parts, destination, &stage, slot, expected)
}

fn finish_claim(
    root: &OwnedFd,
    parts: &[&str],
    destination: Option<(OwnedFd, &str)>,
    stage: &OwnedFd,
    slot: &str,
    expected: &str,
) -> Result<(), Failure> {
    if matches_empty(stage, slot, expected)? && remove_empty(stage, slot)? {
        return Ok(());
    }
    let (parent, name) = match destination {
        Some(destination) => destination,
        None => open_parent(root, parts)?,
    };
    // A peer populated or replaced the directory while it was being claimed. Preserve it even when
    // restoration is blocked by a newer occupant: the live journal will retry this same staging slot.
    rename_pinned(stage, slot, &parent, name)
}

fn optional<T>(result: rustix::io::Result<T>) -> Result<Option<T>, Failure> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(Errno::NOENT) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn claim(parent: &OwnedFd, name: &str, stage: &OwnedFd, slot: &str) -> Result<bool, Failure> {
    if optional(renameat_with(
        parent,
        name,
        stage,
        slot,
        RenameFlags::NOREPLACE,
    ))?
    .is_none()
    {
        return Ok(false);
    }
    fsync(parent)?;
    fsync(stage)?;
    Ok(true)
}

fn remove_empty(stage: &OwnedFd, slot: &str) -> Result<bool, Failure> {
    match unlinkat(stage, slot, AtFlags::REMOVEDIR) {
        Ok(()) => {
            fsync(stage)?;
            Ok(true)
        }
        Err(Errno::NOTEMPTY | Errno::EXIST) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
#[path = "../tests/parents.rs"]
mod tests;
