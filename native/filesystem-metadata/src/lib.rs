//! Descriptor-bound inspection for private storage and mode-only filesystem replacements.
#[cfg(target_os = "linux")]
pub mod mount_table;

mod host_paths;
pub use host_paths::assert_host_paths;
use std::io;

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn assert_replaceable(fd: impl std::os::fd::AsFd) -> io::Result<()> {
    inspect(fd, true)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn assert_access_metadata(fd: impl std::os::fd::AsFd) -> io::Result<()> {
    inspect(fd, false)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn inspect(fd: impl std::os::fd::AsFd, replacement: bool) -> io::Result<()> {
    let fd = fd.as_fd();
    let stat = rustix::fs::fstat(fd)?;
    let special = stat.st_mode & 0o7000 != 0;
    #[cfg(target_os = "macos")]
    let special = {
        // Mode-only publication cannot restore BSD flags, including Finder visibility and backup preferences.
        // Access-only inspection still admits ordinary presentation flags.
        special
            || (replacement && stat.st_flags != 0)
            || stat.st_flags & 0x001e_0086 != 0
            || darwin_acl(std::os::fd::AsRawFd::as_raw_fd(&fd))?
    };
    if special || has_unsupported_xattrs(fd, replacement)? {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Unsupported extended data or access-control metadata on the opened filesystem object.",
        ))
    } else {
        Ok(())
    }
}

/// A direct child and its parent must both permit staging outside the destination directory.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn assert_child_replaceable(parent: &std::fs::File, name: &str) -> io::Result<()> {
    use rustix::fs::{openat, Mode, OFlags};
    assert_access_metadata(parent)?;
    let child = openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?;
    assert_replaceable(child)
}

#[cfg(target_os = "macos")]
fn darwin_acl(fd: i32) -> io::Result<bool> {
    use std::ffi::c_void;
    unsafe extern "C" {
        fn acl_get_fd(fd: i32) -> *mut c_void;
        fn acl_free(acl: *mut c_void) -> i32;
    }
    // Darwin returns ENOENT for a valid descriptor with no extended ACL.
    let acl = unsafe { acl_get_fd(fd) };
    if acl.is_null() {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            return Ok(false);
        }
        return Err(error);
    }
    // acl_get_fd transfers ownership of the ACL to the caller.
    unsafe { acl_free(acl) };
    Ok(true)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn has_unsupported_xattrs(fd: std::os::fd::BorrowedFd, replacement: bool) -> io::Result<bool> {
    let mut names = vec![0; 65_536];
    let length = xattr_length(rustix::fs::flistxattr(fd, &mut names[..]))?;
    Ok(names[..length].split(|byte| *byte == 0).any(|name| {
        // Darwin independently assigns this kernel-managed provenance attribute to newly created inodes.
        // All user-supplied attributes, including resource forks, must survive replacement or stop it.
        let protected_data = replacement
            && !name.is_empty()
            && !(cfg!(target_os = "macos") && name == b"com.apple.provenance");
        // POSIX access/default ACLs, capability and security-module labels, and Darwin access controls.
        protected_data
            || name.starts_with(b"system.")
            || name.starts_with(b"security.")
            || matches!(
                name,
                b"user.NTACL" | b"com.apple.quarantine" | b"com.apple.macl" | b"com.apple.rootless"
            )
    }))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn xattr_length(result: rustix::io::Result<usize>) -> io::Result<usize> {
    match result {
        Ok(size) => Ok(size),
        Err(rustix::io::Errno::NOTSUP) => Ok(0),
        Err(error) => Err(error.into()),
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_mode_only_replacement_of_files_and_folders_with_user_flags() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rule");
        let file = std::fs::File::create(&path).unwrap();
        let folder = std::fs::File::open(directory.path()).unwrap();
        for (path, handle, flag) in [
            (path.as_path(), &file, "nodump"),
            (directory.path(), &folder, "hidden"),
        ] {
            assert!(std::process::Command::new("/usr/bin/chflags")
                .arg(flag)
                .arg(path)
                .status()
                .unwrap()
                .success());
            assert_access_metadata(handle).unwrap();
            assert_eq!(
                assert_replaceable(handle).unwrap_err().kind(),
                io::ErrorKind::Unsupported
            );
        }
    }

    #[test]
    fn refuses_extended_access_controls_on_the_opened_file() {
        assert_eq!(xattr_length(Err(rustix::io::Errno::NOTSUP)).unwrap(), 0);
        assert!(xattr_length(Err(rustix::io::Errno::IO)).is_err());
        #[cfg(target_os = "macos")]
        assert!(darwin_acl(-1).is_err());
        let labelled = tempfile::NamedTempFile::new().unwrap();
        #[cfg(target_os = "macos")]
        let label = c"com.apple.quarantine";
        #[cfg(target_os = "linux")]
        let label = c"user.NTACL";
        rustix::fs::fsetxattr(
            &labelled,
            label,
            b"fixture",
            rustix::fs::XattrFlags::empty(),
        )
        .unwrap();
        assert!(assert_replaceable(&labelled).is_err());
        assert!(assert_access_metadata(&labelled).is_err());
        let data = tempfile::NamedTempFile::new().unwrap();
        #[cfg(target_os = "macos")]
        let attribute = c"com.apple.ResourceFork";
        #[cfg(target_os = "linux")]
        let attribute = c"user.record";
        rustix::fs::fsetxattr(
            &data,
            attribute,
            b"secondary stream",
            rustix::fs::XattrFlags::empty(),
        )
        .unwrap();
        assert_access_metadata(&data).unwrap();
        assert!(assert_replaceable(&data).is_err());
        let fixture = tempfile::NamedTempFile::new().unwrap();
        assert_replaceable(&fixture).unwrap();
        #[cfg(target_os = "macos")]
        assert!(std::process::Command::new("/bin/chmod")
            .args(["+a", "everyone deny write"])
            .arg(fixture.path())
            .status()
            .unwrap()
            .success());
        #[cfg(target_os = "linux")]
        {
            // POSIX ACL xattr v2: owner rw, named user 42 r, group r, mask r, other none.
            let mut acl = 2u32.to_le_bytes().to_vec();
            for (tag, perm, id) in [
                (1u16, 6u16, u32::MAX),
                (2, 4, 42),
                (4, 4, u32::MAX),
                (16, 4, u32::MAX),
                (32, 0, u32::MAX),
            ] {
                acl.extend(tag.to_le_bytes());
                acl.extend(perm.to_le_bytes());
                acl.extend(id.to_le_bytes());
            }
            rustix::fs::fsetxattr(
                &fixture,
                c"system.posix_acl_access",
                &acl,
                rustix::fs::XattrFlags::empty(),
            )
            .unwrap();
        }
        assert_eq!(
            assert_replaceable(&fixture).unwrap_err().kind(),
            io::ErrorKind::Unsupported
        );
    }
}
