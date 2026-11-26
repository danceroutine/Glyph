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

pub(super) struct KernelWorkspace {
    scratch: PathBuf,
    root: PathBuf,
    target: PathBuf,
    next: usize,
    runtime_views: std::collections::BTreeMap<PathBuf, Vec<(PathBuf, PathBuf)>>,
}

impl KernelWorkspace {
    pub(super) fn open() -> io::Result<Self> {
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
        Ok(Self {
            scratch: scratch.keep(),
            root: PathBuf::new(),
            target: PathBuf::new(),
            next: 0,
            runtime_views: Default::default(),
        })
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
        let _ = unmount(&self.scratch, UnmountFlags::DETACH);
        let _ = fs::remove_dir(&self.scratch);
    }
}

impl Mounts for &mut KernelWorkspace {
    /// Keep immutable system directories bulk-mounted. Snapshot mutable parts of system and
    /// user toolchains to keep later private transactions out of the already running command.
    fn runtime(
        &mut self,
        source: &Path,
        target: &Path,
        request: &super::SandboxRequest,
        private: &[PathBuf],
    ) -> Result<Vec<OsString>, super::SandboxError> {
        let source = source.canonicalize()?;
        let mut result = vec![
            "--ro-bind".into(),
            source.clone().into_os_string(),
            target.into(),
        ];
        let ancestor = if let Some(root) = self
            .runtime_views
            .keys()
            .find(|root| source.starts_with(root))
        {
            root.clone()
        } else {
            let mut boundaries = Vec::new();
            runtime_boundaries(&source, private, &mut boundaries, 0, &user_controls)?;
            let mut overlays = Vec::new();
            for (boundary, hidden) in boundaries {
                if hidden {
                    self.start(&boundary)?;
                    self.finish(&boundary)?;
                } else {
                    let protected = std::slice::from_ref(&boundary);
                    let mut view = super::projection::WorkspaceView::new(&mut **self);
                    view.workspace(&boundary, request, protected, private)?;
                }
                overlays.push((boundary, self.target.clone()));
            }
            self.runtime_views.insert(source.clone(), overlays);
            source.clone()
        };
        for (original, view) in &self.runtime_views[&ancestor] {
            if let Ok(relative) = original.strip_prefix(&source) {
                result.extend([
                    "--ro-bind".into(),
                    view.into(),
                    target.join(relative).into_os_string(),
                ]);
            } else if let Ok(relative) = source.strip_prefix(original) {
                result.extend([
                    "--ro-bind".into(),
                    view.join(relative).into_os_string(),
                    target.into(),
                ]);
            }
        }
        Ok(result)
    }

    fn start(&mut self, root: &Path) -> io::Result<()> {
        self.root = root.to_owned();
        self.target = self.scratch.join(self.next.to_string());
        self.next += 1;
        fs::create_dir(&self.target)?;
        private_tmpfs(&self.target)?;
        Ok(())
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
        if !writable {
            readonly(&target, MountFlags::BIND)?;
        }
        Ok(())
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

fn runtime_boundaries(
    path: &Path,
    private: &[PathBuf],
    out: &mut Vec<(PathBuf, bool)>,
    depth: usize,
    mutable: &dyn Fn(&Path) -> io::Result<bool>,
) -> io::Result<()> {
    if depth > super::MAX_WORKSPACE_SCAN_DEPTH {
        return Err(io::Error::other(
            "Runtime directory exceeds its scan depth limit.",
        ));
    }
    if rustix::fs::access(
        path,
        rustix::fs::Access::READ_OK | rustix::fs::Access::EXEC_OK,
    )
    .is_err()
        || private.iter().any(|p| path.starts_with(p))
    {
        out.push((path.to_owned(), true));
        return Ok(());
    }
    if mutable(path)? {
        out.push((path.to_owned(), false));
        return Ok(());
    }
    let Some(children) = public_subdirectories(path, private)? else {
        out.push((path.to_owned(), false));
        return Ok(());
    };
    for child in children {
        runtime_boundaries(&child, private, out, depth + 1, mutable)?;
    }
    Ok(())
}

fn public_subdirectories(path: &Path, private: &[PathBuf]) -> io::Result<Option<Vec<PathBuf>>> {
    let mut children = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let child = entry.path();
        if super::private_component(&child) || private.contains(&child) {
            return Ok(None);
        }
        if entry.file_type()?.is_dir() {
            children.push(child);
        }
    }
    Ok(Some(children))
}

fn user_controls(path: &Path) -> io::Result<bool> {
    let info = fs::symlink_metadata(path)?;
    Ok(info.uid() == getuid().as_raw()
        || rustix::fs::access(path, rustix::fs::Access::WRITE_OK).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserved_entries_and_inaccessible_roots_receive_filtered_views() {
        let base = tempfile::tempdir().unwrap();
        let dir = base.path().join("vendor");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join(".Skill-Staging"), "private").unwrap();
        let mut views = Vec::new();
        let immutable = |_: &Path| Ok(false);
        runtime_boundaries(base.path(), &[], &mut views, 0, &immutable).unwrap();
        assert_eq!(views, vec![(dir.clone(), false)]);
        views.clear();
        runtime_boundaries(&dir, std::slice::from_ref(&dir), &mut views, 0, &immutable).unwrap();
        assert_eq!(views, vec![(dir.clone(), true)]);
        assert!(runtime_boundaries(
            &dir,
            &[],
            &mut views,
            super::super::MAX_WORKSPACE_SCAN_DEPTH + 1,
            &user_controls
        )
        .is_err());
        views.clear();
        runtime_boundaries(&dir, &[], &mut views, 0, &|_| Ok(true)).unwrap();
        assert_eq!(views, vec![(dir.clone(), false)]);
        let first = dir.join("first");
        let second = dir.join("second");
        let file: OwnedFd = fs::File::create_new(&first).unwrap().into();
        verify_file(&file, &first).unwrap();
        fs::write(&second, "different inode").unwrap();
        assert!(verify_file(&file, &second).is_err());
    }
}
