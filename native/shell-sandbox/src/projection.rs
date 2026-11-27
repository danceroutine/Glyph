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

/// Optional trees have independent limits so a toolchain or dependency cannot starve project files.
#[derive(Debug)]
pub(super) struct SnapshotBudget {
    pub dependency_entries: usize,
    pub runtime_entries: usize,
    #[cfg(target_os = "linux")]
    pub runtime_bytes: u64,
    #[cfg(target_os = "linux")]
    pub runtime_mounts: usize,
    #[cfg(target_os = "linux")]
    pub dependency_mounts: usize,
    #[cfg(target_os = "linux")]
    pub workspace_mounts: usize,
    warned: bool,
}

impl Default for SnapshotBudget {
    fn default() -> Self {
        Self {
            dependency_entries: 100_000,
            runtime_entries: 150_000,
            #[cfg(target_os = "linux")]
            runtime_bytes: 256 * 1024 * 1024,
            #[cfg(target_os = "linux")]
            runtime_mounts: 2048,
            #[cfg(target_os = "linux")]
            dependency_mounts: 8192,
            #[cfg(target_os = "linux")]
            workspace_mounts: 16_384,
            warned: false,
        }
    }
}

impl SnapshotBudget {
    pub(super) fn omitted(&mut self) {
        if !self.warned {
            self.warned = true;
            eprintln!("glyph-shell-sandbox: some files were omitted because the sandbox snapshot reached its resource limit.");
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Scope {
    Workspace,
    Dependency,
    Runtime,
}

pub(super) trait Mounts {
    fn budget(&mut self) -> &mut SnapshotBudget;
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
    fn file(&mut self, path: &Path, fd: &OwnedFd, writable: bool, scope: Scope) -> io::Result<()>;
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
    scope: Scope,
}
impl<M: Mounts> WorkspaceView<M> {
    pub(super) fn new(mounts: M) -> Self {
        Self {
            mounts,
            entries: 0,
            scope: Scope::Workspace,
        }
    }

    pub(super) fn runtime(mounts: M) -> Self {
        Self {
            mounts,
            entries: 0,
            scope: Scope::Runtime,
        }
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
        let writable = request.profile == SandboxProfile::WorkspaceWrite
            && !root.ancestors().any(|path| {
                super::managed_directory(path)
                    || path
                        .file_name()
                        .is_some_and(|n| n.eq_ignore_ascii_case(".git"))
            })
            && !protected.iter().any(|path| root.starts_with(path));
        self.directory(
            root,
            directory,
            &Access {
                request,
                protected,
                private,
            },
            writable,
            self.scope,
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
        scope: Scope,
        depth: usize,
    ) -> Result<(), SandboxError> {
        if depth > MAX_WORKSPACE_SCAN_DEPTH {
            if scope != Scope::Workspace {
                self.mounts.budget().omitted();
                return Ok(());
            }
            return Err(SandboxError::InvalidPath(
                "Workspace projection exceeds its directory depth limit.".into(),
            ));
        }
        let Some(entries) = accessible(Dir::read_from(&directory))? else {
            return Ok(());
        };
        for entry in entries {
            let entry = entry.map_err(io::Error::from)?;
            let name = OsStr::from_bytes(entry.file_name().to_bytes());
            if name == "." || name == ".." {
                continue;
            }
            let remaining = match scope {
                Scope::Workspace => None,
                Scope::Dependency => Some(&mut self.mounts.budget().dependency_entries),
                Scope::Runtime => Some(&mut self.mounts.budget().runtime_entries),
            };
            if let Some(remaining) = remaining {
                if *remaining == 0 {
                    self.mounts.budget().omitted();
                    break;
                }
                *remaining -= 1;
            } else {
                self.entries += 1;
            }
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
            let fd = match accessible(open_entry(&directory, name))?.flatten() {
                Some(Entry::File(fd)) => fd,
                Some(Entry::Link(target)) => {
                    self.mounts
                        .symlink(OsStr::from_bytes(target.as_bytes()), &child)?;
                    continue;
                }
                None => continue,
            };
            let info = fstat(&fd).map_err(io::Error::from)?;
            match FileType::from_raw_mode(info.st_mode) {
                FileType::Directory => {
                    self.mounts.directory(&child)?;
                    let child_scope = if scope == Scope::Workspace
                        && super::is_ignored_directory(&child, &access.request.workspace_policy)
                    {
                        Scope::Dependency
                    } else {
                        scope
                    };
                    self.directory(&child, fd, access, writable, child_scope, depth + 1)?;
                }
                FileType::RegularFile if info.st_nlink == 1 => {
                    self.mounts.file(&child, &fd, writable, scope)?;
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

enum Entry {
    File(OwnedFd),
    Link(std::ffi::CString),
}

fn open_entry(directory: &OwnedFd, name: &OsStr) -> rustix::io::Result<Option<Entry>> {
    let kind = FileType::from_raw_mode(statat(directory, name, AtFlags::SYMLINK_NOFOLLOW)?.st_mode);
    match kind {
        FileType::Symlink => {
            readlinkat(directory, name, Vec::new()).map(|target| Some(Entry::Link(target)))
        }
        FileType::Directory | FileType::RegularFile => openat(
            directory,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map(|fd| Some(Entry::File(fd))),
        _ => Ok(None),
    }
}

fn accessible<T>(result: rustix::io::Result<T>) -> io::Result<Option<T>> {
    use rustix::io::Errno;
    match result {
        Ok(entry) => Ok(Some(entry)),
        Err(Errno::ACCESS | Errno::PERM | Errno::NOENT | Errno::LOOP) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
#[derive(Default)]
pub(super) struct MountTrace(Vec<OsString>, SnapshotBudget);
#[cfg(test)]
impl Mounts for MountTrace {
    fn budget(&mut self) -> &mut SnapshotBudget {
        &mut self.1
    }
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
    fn file(
        &mut self,
        path: &Path,
        _fd: &OwnedFd,
        writable: bool,
        _scope: Scope,
    ) -> io::Result<()> {
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
        let mut optional = WorkspaceView::runtime(MountTrace::default());
        use std::os::unix::fs::PermissionsExt;
        let inaccessible_dir = root.join("no-search");
        std::fs::create_dir(&inaccessible_dir).unwrap();
        std::fs::write(inaccessible_dir.join("child"), "fixture").unwrap();
        std::fs::set_permissions(&inaccessible_dir, std::fs::Permissions::from_mode(0o400))
            .unwrap();
        let unreadable = root.join("unreadable");
        std::fs::write(&unreadable, "fixture").unwrap();
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();
        let plan = optional.workspace(&root, &request, &[], &[]).unwrap();
        let privileged = rustix::process::getuid().as_raw() == 0;
        assert_eq!(plan.contains(&unreadable.into_os_string()), privileged);
        assert_eq!(
            plan.contains(&inaccessible_dir.join("child").into_os_string()),
            privileged
        );
        std::fs::set_permissions(&inaccessible_dir, std::fs::Permissions::from_mode(0o700))
            .unwrap();
        optional.mounts.budget().runtime_entries = 0;
        assert!(!optional
            .workspace(&root, &request, &[], &[])
            .unwrap()
            .contains(&ordinary.clone().into_os_string()));
        optional.mounts.budget().omitted();
        assert!(accessible::<()>(Err(rustix::io::Errno::ACCESS))
            .unwrap()
            .is_none());
        assert!(accessible::<()>(Err(rustix::io::Errno::IO)).is_err());
        assert_eq!(accessible(Ok(())).unwrap(), Some(()));
        let dep = root.join("node_modules");
        std::fs::create_dir(&dep).unwrap();
        std::fs::write(dep.join("ignored"), "fixture").unwrap();
        request
            .workspace_policy
            .ignored_directories
            .push("node_modules".into());
        view.mounts.budget().dependency_entries = 0;
        let plan = view.workspace(&root, &request, &[], &[]).unwrap();
        assert!(plan.contains(&ordinary.into_os_string()));
        assert!(!plan.contains(&dep.join("ignored").into_os_string()));
        for boundary in [root.join(".cursor/skills"), root.join(".git/nested")] {
            std::fs::create_dir_all(&boundary).unwrap();
            std::fs::write(boundary.join("resource"), "fixture").unwrap();
            let plan = view.workspace(&boundary, &request, &[], &[]).unwrap();
            assert!(plan
                .windows(3)
                .any(|args| args[0] == "--ro-bind" && args[2] == boundary.join("resource")));
        }
        let handle = open(&root, OFlags::RDONLY | OFlags::DIRECTORY, Mode::empty()).unwrap();
        assert!(optional
            .directory(
                &root,
                handle,
                &Access {
                    request: &request,
                    protected: &[],
                    private: &[]
                },
                false,
                Scope::Runtime,
                MAX_WORKSPACE_SCAN_DEPTH + 1
            )
            .is_ok());
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
                Scope::Workspace,
                MAX_WORKSPACE_SCAN_DEPTH + 1
            )
            .is_err());
    }
}
