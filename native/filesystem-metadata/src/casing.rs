#[cfg(target_os = "macos")]
mod platform {
    use std::{fs::File, io, os::fd::AsRawFd, path::Path};
    pub fn detect(path: &Path) -> io::Result<bool> {
        let file = File::open(path)?;
        // The open descriptor pins the volume even if a registered folder alias changes.
        let value = unsafe { libc::fpathconf(file.as_raw_fd(), libc::_PC_CASE_SENSITIVE) };
        case_setting(value)
    }
    pub fn unicode_policy(path: &Path) -> io::Result<(bool, bool)> {
        let file = File::open(path)?;
        normalizing_volume(file.as_raw_fd())
    }
    pub fn normalizing_volume(fd: libc::c_int) -> io::Result<(bool, bool)> {
        let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(fd, stat.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let stat = unsafe { stat.assume_init() };
        let filesystem = unsafe { std::ffi::CStr::from_ptr(stat.f_fstypename.as_ptr()) };
        let name = filesystem.to_bytes();
        Ok((matches!(name, b"apfs" | b"hfs"), name == b"apfs"))
    }
    pub fn case_setting(value: libc::c_long) -> io::Result<bool> {
        match value {
            -1 => Err(io::Error::last_os_error()),
            value => Ok(value != 0),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use std::{fs, io, path::Path};
    pub fn detect(path: &Path) -> io::Result<bool> {
        let names: Vec<_> = fs::read_dir(path)?
            .take(64)
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect();
        if let Some(value) = observed_names(path, &names) {
            return Ok(value);
        }
        empty_directory(path)
    }

    pub fn observed_names(path: &Path, names: &[String]) -> Option<bool> {
        for name in names {
            let Some(position) = name.find(|c: char| c.is_ascii_alphabetic()) else {
                continue;
            };
            let mut other = name.clone();
            let letter = other.as_bytes()[position] ^ 32;
            other.replace_range(position..position + 1, &(letter as char).to_string());
            // Both spellings being separately listed proves they are distinct names, including hardlinks.
            if names.contains(&other) {
                return Some(true);
            }
            if let Some(sensitive) = compare(path, name, &other) {
                return Some(sensitive);
            }
        }
        None
    }

    #[cfg(unix)]
    pub fn compare(path: &Path, name: &str, other: &str) -> Option<bool> {
        use std::os::unix::fs::MetadataExt;
        let actual = fs::symlink_metadata(path.join(name)).ok()?;
        match fs::symlink_metadata(path.join(other)) {
            Ok(alias) if actual.dev() != alias.dev() || actual.ino() != alias.ino() => Some(true),
            Ok(_) if actual.is_dir() || actual.nlink() == 1 => Some(false),
            Ok(_) => None,
            Err(error) => (error.kind() == io::ErrorKind::NotFound).then_some(true),
        }
    }

    #[cfg(not(unix))]
    fn compare(path: &Path, name: &str, other: &str) -> Option<bool> {
        let actual = fs::canonicalize(path.join(name)).ok()?;
        Some(fs::canonicalize(path.join(other)).map_or(true, |alias| actual != alias))
    }

    #[cfg(target_os = "linux")]
    pub fn unicode_policy(path: &Path) -> io::Result<(bool, bool)> {
        use std::os::fd::AsRawFd;
        let directory = fs::File::open(path)?;
        let fold = casefold_directory(directory.as_raw_fd());
        Ok((fold, fold))
    }

    #[cfg(not(target_os = "linux"))]
    pub fn unicode_policy(_path: &Path) -> io::Result<(bool, bool)> {
        Ok((false, false))
    }

    #[cfg(target_os = "linux")]
    fn casefold_directory(fd: libc::c_int) -> bool {
        let mut flags: libc::c_long = 0;
        // ext4 and F2FS enable canonical Unicode equivalence with their directory casefold flag.
        let result = unsafe { libc::ioctl(fd, libc::FS_IOC_GETFLAGS, &mut flags) };
        result == 0 && flags & 0x4000_0000 != 0
    }

    #[cfg(target_os = "linux")]
    pub fn empty_directory(path: &Path) -> io::Result<bool> {
        use std::os::fd::AsRawFd;
        let directory = fs::File::open(path)?;
        // FAT and exFAT names remain case-insensitive even when the directory has no entries.
        let filesystem = filesystem_type(directory.as_raw_fd())?;
        Ok(!matches!(filesystem, 0x4d44 | 0x2011_bab0)
            && !casefold_directory(directory.as_raw_fd()))
    }

    #[cfg(target_os = "linux")]
    pub fn filesystem_type(fd: libc::c_int) -> io::Result<u64> {
        let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
        if unsafe { libc::fstatfs(fd, filesystem.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // A successful fstatfs initializes the buffer. glibc and musl use different integer types for f_type.
        #[allow(clippy::unnecessary_cast)]
        Ok(unsafe { filesystem.assume_init() }.f_type as u64)
    }

    #[cfg(not(target_os = "linux"))]
    fn empty_directory(_path: &Path) -> io::Result<bool> {
        Ok(!cfg!(windows))
    }
}

pub use platform::*;
