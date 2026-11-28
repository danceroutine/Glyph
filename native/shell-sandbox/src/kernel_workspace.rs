//! Builds the admitted file view in a private mount namespace before Bubblewrap starts the command.
//! Each bind mount holds the verified inode, so open descriptors are bounded by directory depth.
use super::projection::Mounts;
use rustix::fd::{AsRawFd, OwnedFd};
use rustix::mount::{
    mount, mount_bind, mount_change, mount_remount, unmount, MountFlags, MountPropagationFlags,
    UnmountFlags,
};
use rustix::process::{getgid, getuid};
use rustix::thread::{unshare_unsafe, UnshareFlags};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub(super) struct KernelWorkspace {
    scratch: Option<PathBuf>,
    root: PathBuf,
    target: PathBuf,
    next: usize,
}

impl KernelWorkspace {
    fn open_scratch() -> io::Result<PathBuf> {
        let uid = getuid().as_raw();
        let gid = getgid().as_raw();
        // The standalone helper enters fresh user and mount namespaces. Its file descriptor table stays shared.
        unsafe { unshare_unsafe(UnshareFlags::NEWUSER | UnshareFlags::NEWNS) }?;
        fs::write("/proc/self/setgroups", "deny")?;
        fs::write("/proc/self/uid_map", format!("{uid} {uid} 1\n"))?;
        fs::write("/proc/self/gid_map", format!("{gid} {gid} 1\n"))?;
        let propagation = MountPropagationFlags::REC | MountPropagationFlags::PRIVATE;
        mount_change("/", propagation)?;
        let scratch = tempfile::Builder::new()
            .prefix("glyph-shell-view-")
            .tempdir_in("/tmp")?;
        private_tmpfs(scratch.path())?;
        Ok(scratch.keep())
    }
    fn target(&self, path: &Path) -> PathBuf {
        self.target.join(
            path.strip_prefix(&self.root)
                .expect("workspace traversal stays under its root"),
        )
    }
}
impl Drop for KernelWorkspace {
    fn drop(&mut self) {
        // Remove only the empty host mount point. No recursive cleanup can traverse a file mount.
        if let Some(scratch) = &self.scratch {
            let _ = unmount(scratch, UnmountFlags::DETACH);
            let _ = fs::remove_dir(scratch);
        }
    }
}

impl Mounts for &mut KernelWorkspace {
    fn start(&mut self, root: &Path) -> io::Result<()> {
        self.root = root.to_owned();
        if self.scratch.is_none() {
            self.scratch = Some(KernelWorkspace::open_scratch()?);
        }
        self.target = self
            .scratch
            .as_ref()
            .expect("initialized projection")
            .join(self.next.to_string());
        self.next += 1;
        fs::create_dir(&self.target)?;
        private_tmpfs(&self.target)
    }
    fn directory(&mut self, path: &Path) -> io::Result<()> {
        fs::create_dir(self.target(path))
    }
    fn symlink(&mut self, target: &OsStr, path: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, self.target(path))
    }
    fn file(&mut self, path: &Path, fd: &OwnedFd, writable: bool) -> io::Result<()> {
        let target = self.target(path);
        fs::File::create_new(&target)?;
        mount_bind(format!("/proc/self/fd/{}", fd.as_raw_fd()), &target)?;
        verify_file(fd, &target)?;
        if writable {
            Ok(())
        } else {
            readonly(&target, MountFlags::BIND)
        }
    }
    fn finish(&mut self, root: &Path) -> io::Result<Vec<OsString>> {
        readonly(&self.target, MountFlags::empty())?;
        Ok(vec![
            "--bind".into(),
            self.target.clone().into(),
            root.into(),
        ])
    }
}

fn private_tmpfs(target: &Path) -> io::Result<()> {
    let flags = MountFlags::NODEV | MountFlags::NOSUID;
    Ok(mount("tmpfs", target, "tmpfs", flags, c"mode=0700")?)
}
fn readonly(target: &Path, extra: MountFlags) -> io::Result<()> {
    let flags = extra | MountFlags::RDONLY | MountFlags::NODEV | MountFlags::NOSUID;
    Ok(mount_remount(target, flags, "")?)
}
fn verify_file(fd: &OwnedFd, target: &Path) -> io::Result<()> {
    let source = rustix::fs::fstat(fd)?;
    let mounted = fs::symlink_metadata(target)?;
    if mounted.dev() != source.st_dev || mounted.ino() != source.st_ino || mounted.nlink() != 1 {
        return Err(io::Error::other(
            "Workspace file changed during sandbox preparation.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_the_binding_against_the_open_file() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        let file: OwnedFd = fs::File::create_new(&first).unwrap().into();
        verify_file(&file, &first).unwrap();
        fs::write(&second, "different inode").unwrap();
        assert!(verify_file(&file, &second).is_err());
    }
}
