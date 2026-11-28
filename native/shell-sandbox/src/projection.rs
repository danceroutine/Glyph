//! A Bubblewrap workspace is a read-only directory snapshot with descriptor-pinned file mounts.
//! New host directory entries, including transactions opened by other windows, cannot appear mid-command.
use super::{
    is_sensitive_workspace_file, SandboxError, SandboxProfile, SandboxRequest,
    MAX_WORKSPACE_SCAN_DEPTH, MAX_WORKSPACE_SCAN_ENTRIES,
};
use rustix::fd::OwnedFd;
use rustix::fs::{fstat, open, openat, readlinkat, statat, AtFlags, Dir, FileType, Mode, OFlags};

use std::ffi::{OsStr, OsString};
use std::io;

use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

pub(super) trait Mounts {
    fn start(&mut self, root: &Path) -> io::Result<()>;
    fn directory(&mut self, path: &Path) -> io::Result<()>;
    fn symlink(&mut self, target: &OsStr, path: &Path) -> io::Result<()>;
    fn file(&mut self, path: &Path, fd: &OwnedFd, writable: bool) -> io::Result<()>;
    fn finish(&mut self, root: &Path) -> io::Result<Vec<OsString>>;
}

struct Access<'a> {
    request: &'a SandboxRequest,
    protected: &'a [PathBuf],
    private: &'a [PathBuf],
}

pub(super) struct WorkspaceView<M> {
    pub(super) mounts: M,
    entries: usize,
}
impl<M: Mounts> WorkspaceView<M> {
    pub(super) fn new(mounts: M) -> Self {
        Self { mounts, entries: 0 }
    }

    pub(super) fn workspace(
        &mut self,
        root: &Path,
        request: &SandboxRequest,
        protected: &[PathBuf],
        private: &[PathBuf],
    ) -> Result<Vec<OsString>, SandboxError> {
        // Enter the projection namespace before opening directory or file descriptors for bind mounts.
        self.mounts.start(root)?;
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mut directory = open("/", flags, Mode::empty()).map_err(io::Error::from)?;
        for component in root.components().filter_map(|p| {
            if let std::path::Component::Normal(name) = p {
                Some(name)
            } else {
                None
            }
        }) {
            directory =
                openat(&directory, component, flags, Mode::empty()).map_err(io::Error::from)?;
        }
        let writable = request.profile == SandboxProfile::WorkspaceWrite;
        self.directory(
            root,
            directory,
            &Access {
                request,
                protected,
                private,
            },
            writable,
            0,
        )?;
        Ok(self.mounts.finish(root)?)
    }

    fn directory(
        &mut self,
        path: &Path,
        directory: OwnedFd,
        access: &Access,
        writable: bool,
        depth: usize,
    ) -> Result<(), SandboxError> {
        if depth > MAX_WORKSPACE_SCAN_DEPTH {
            return Err(SandboxError::InvalidPath(
                "Workspace projection exceeds its directory depth limit.".into(),
            ));
        }
        let entries = Dir::read_from(&directory).map_err(io::Error::from)?;
        for entry in entries {
            let entry = entry.map_err(io::Error::from)?;
            let name = OsStr::from_bytes(entry.file_name().to_bytes());
            if name == "." || name == ".." {
                continue;
            }
            self.entries += 1;
            if self.entries > MAX_WORKSPACE_SCAN_ENTRIES {
                return Err(SandboxError::InvalidPath(
                    "Workspace projection exceeds its entry limit.".into(),
                ));
            }
            let child = path.join(name);
            if glyph_filesystem_metadata::workspace_paths::private_name(&child)
                || access.private.iter().any(|p| child.starts_with(p))
                || is_sensitive_workspace_file(&child, &access.request.workspace_policy)
            {
                continue;
            }
            let writable = writable
                && !name.eq_ignore_ascii_case(".git")
                && !access.protected.iter().any(|p| child.starts_with(p));
            let kind = FileType::from_raw_mode(
                statat(&directory, name, AtFlags::SYMLINK_NOFOLLOW)
                    .map_err(io::Error::from)?
                    .st_mode,
            );
            if kind == FileType::Symlink {
                let target = readlinkat(&directory, name, Vec::new()).map_err(io::Error::from)?;
                self.mounts
                    .symlink(OsStr::from_bytes(target.as_bytes()), &child)?;
                continue;
            }
            if !matches!(kind, FileType::Directory | FileType::RegularFile) {
                continue;
            }
            let fd = openat(
                &directory,
                name,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(io::Error::from)?;
            let info = fstat(&fd).map_err(io::Error::from)?;
            match FileType::from_raw_mode(info.st_mode) {
                FileType::Directory => {
                    self.mounts.directory(&child)?;
                    self.directory(&child, fd, access, writable, depth + 1)?;
                }
                FileType::RegularFile if info.st_nlink == 1 => {
                    self.mounts.file(&child, &fd, writable)?;
                }
                _ => {}
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct MountTrace(Vec<OsString>);
#[cfg(test)]
impl Mounts for MountTrace {
    fn start(&mut self, root: &Path) -> io::Result<()> {
        self.0.extend(["--tmpfs".into(), root.into()]);
        Ok(())
    }
    fn directory(&mut self, path: &Path) -> io::Result<()> {
        self.0.extend(["--dir".into(), path.into()]);
        Ok(())
    }
    fn symlink(&mut self, target: &OsStr, path: &Path) -> io::Result<()> {
        self.0
            .extend(["--symlink".into(), target.into(), path.into()]);
        Ok(())
    }
    fn file(&mut self, path: &Path, _fd: &OwnedFd, writable: bool) -> io::Result<()> {
        self.0.extend([
            if writable { "--bind" } else { "--ro-bind" }.into(),
            path.into(),
            path.into(),
        ]);
        Ok(())
    }
    fn finish(&mut self, root: &Path) -> io::Result<Vec<OsString>> {
        self.0.extend(["--remount-ro".into(), root.into()]);
        Ok(std::mem::take(&mut self.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_entry_budget_counts_across_projected_roots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let request = crate::tests::request(SandboxProfile::ReadOnly, &root, &root.join("state"));
        std::fs::write(root.join("entry"), "fixture").unwrap();
        let mut view = WorkspaceView::new(MountTrace::default());
        view.entries = MAX_WORKSPACE_SCAN_ENTRIES - 1;
        view.workspace(&root, &request, &[], &[]).unwrap();
        let error = view.workspace(&root, &request, &[], &[]).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Workspace projection exceeds its entry limit."
        );
    }
}
