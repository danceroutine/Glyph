//! A Bubblewrap workspace is a read-only directory snapshot with descriptor-pinned file mounts.
//! New host directory entries, including transactions opened by other windows, cannot appear mid-command.
use super::{
    is_sensitive_workspace_file, private_component, SandboxError, SandboxProfile, SandboxRequest,
    MAX_WORKSPACE_SCAN_DEPTH, MAX_WORKSPACE_SCAN_ENTRIES,
};
use rustix::fd::OwnedFd;
use rustix::fs::{fstat, open, openat, readlinkat, statat, AtFlags, Dir, FileType, Mode, OFlags};

use std::ffi::{OsStr, OsString};
use std::io;

use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

pub(super) trait Mounts {
    fn runtime(
        &mut self,
        source: &Path,
        target: &Path,
        request: &SandboxRequest,
        private: &[PathBuf],
    ) -> Result<Vec<OsString>, SandboxError>;
    fn start(&mut self, root: &Path) -> io::Result<()>;
    fn directory(&mut self, path: &Path) -> io::Result<()>;
    fn symlink(&mut self, target: &OsStr, path: &Path) -> io::Result<()>;
    fn linked_file(&mut self, path: &Path, fd: &OwnedFd) -> io::Result<()>;
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
        self.mounts.start(root)?;
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
            if private_component(&child)
                || access.private.iter().any(|p| child.starts_with(p))
                || is_sensitive_workspace_file(&child, &access.request.workspace_policy)
            {
                continue;
            }
            let writable = writable
                && !super::managed_directory(&child)
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
                FileType::RegularFile
                    if access
                        .request
                        .workspace_roots
                        .iter()
                        .any(|root| child.starts_with(root)) =>
                {
                    self.mounts.linked_file(&child, &fd)?;
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
    fn runtime(
        &mut self,
        source: &Path,
        target: &Path,
        _request: &SandboxRequest,
        _private: &[PathBuf],
    ) -> Result<Vec<OsString>, SandboxError> {
        Ok(vec!["--ro-bind".into(), source.into(), target.into()])
    }
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
    fn linked_file(&mut self, _path: &Path, _fd: &OwnedFd) -> io::Result<()> {
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
    use crate::{SandboxProfile, WorkspaceAccessPolicy};
    use std::os::unix::fs::symlink;

    #[test]
    fn authenticates_each_mounted_file_and_omits_private_and_hardlinked_names() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let ordinary = root.join("ordinary");
        std::fs::write(&ordinary, "fixture").unwrap();
        let protected = root.join(".cursor/skills/managed");
        std::fs::create_dir_all(protected.parent().unwrap()).unwrap();
        std::fs::write(&protected, "managed").unwrap();
        std::fs::create_dir(root.join(".skill-staging")).unwrap();
        std::fs::write(root.join(".skill-staging/private"), "private").unwrap();
        std::fs::hard_link(
            root.join(".skill-staging/private"),
            root.join("multiple-links"),
        )
        .unwrap();
        symlink(&ordinary, root.join("symbolic")).unwrap();
        let _socket = std::os::unix::net::UnixListener::bind(root.join("socket")).unwrap();
        let mut request = SandboxRequest {
            profile: SandboxProfile::WorkspaceWrite,
            working_directory: root.clone(),
            workspace_roots: vec![root.clone()],
            private_paths: vec![],
            protected_paths: vec![],
            read_only_paths: vec![],
            content_stores: Vec::new(),
            workspace_policy: WorkspaceAccessPolicy::default(),
            state_directory: root.join("state"),
            command: vec!["true".into()],
        };
        let mut view = WorkspaceView::new(MountTrace::default());
        let plan = view.workspace(&root, &request, &[], &[]).unwrap();
        for hidden in ["socket", ".skill-staging", "multiple-links"] {
            assert!(!plan.iter().any(|arg| arg == root.join(hidden).as_os_str()));
        }
        assert!(plan
            .windows(3)
            .any(|args| args[0] == "--ro-bind" && args[2] == protected));
        assert!(plan.iter().any(|arg| arg == "--symlink"));
        // Runtime toolchain projections are independent of the selected project. A hardlinked
        // runtime file cannot use the workspace's content-store admission.
        request.workspace_roots.clear();
        let external_plan = view.workspace(&root, &request, &[], &[]).unwrap();
        assert!(!external_plan
            .iter()
            .any(|arg| arg == root.join("multiple-links").as_os_str()));
        view.entries = MAX_WORKSPACE_SCAN_ENTRIES;
        assert!(view.workspace(&root, &request, &[], &[]).is_err());
        let handle = open(&root, OFlags::RDONLY | OFlags::DIRECTORY, Mode::empty()).unwrap();
        assert!(view
            .directory(
                &root,
                handle,
                &Access {
                    request: &request,
                    protected: &[],
                    private: &[]
                },
                true,
                MAX_WORKSPACE_SCAN_DEPTH + 1
            )
            .is_err());
    }
}
