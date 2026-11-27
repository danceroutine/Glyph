//! Builds the admitted file view in a private mount namespace before Bubblewrap starts the command.
//! Each bind mount holds the verified inode, so open descriptors are bounded by directory depth.
use super::projection::{Mounts, Scope, SnapshotBudget};
use rustix::fd::{AsRawFd, OwnedFd};
use rustix::mount::{
    mount, mount_bind, mount_change, mount_remount, unmount, MountFlags, MountPropagationFlags,
    UnmountFlags,
};
use rustix::process::{getgid, getuid};
use rustix::thread::{capabilities, set_capabilities, unshare_unsafe, CapabilitySet, UnshareFlags};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

pub(super) struct KernelWorkspace {
    budget: SnapshotBudget,
    stores: super::content_store::VerifiedStores,
    scratch: PathBuf,
    root: PathBuf,
    target: PathBuf,
    next: usize,
    runtime_views: std::collections::BTreeMap<PathBuf, Vec<(PathBuf, PathBuf)>>,
}

impl KernelWorkspace {
    pub(super) fn open(
        request: &mut super::SandboxRequest,
        home: Option<&Path>,
    ) -> Result<Self, super::SandboxError> {
        let mut stores = super::content_store::VerifiedStores::open(request);
        let original = capabilities(None).map_err(io::Error::from)?.effective;
        let uid = getuid().as_raw();
        let gid = getgid().as_raw();
        // The standalone helper enters fresh user and mount namespaces. Its file descriptor table stays shared.
        unsafe { unshare_unsafe(UnshareFlags::NEWUSER | UnshareFlags::NEWNS) }
            .map_err(io::Error::from)?;
        fs::write("/proc/self/setgroups", "deny")?;
        fs::write("/proc/self/uid_map", format!("{uid} {uid} 1\n"))?;
        fs::write("/proc/self/gid_map", format!("{gid} {gid} 1\n"))?;
        // A new user namespace grants DAC overrides even for an unprivileged owner. Source descriptors
        // and private runtime copies must retain the original caller's file access.
        let gained = (CapabilitySet::DAC_OVERRIDE | CapabilitySet::DAC_READ_SEARCH) - original;
        let mut caps = capabilities(None).map_err(io::Error::from)?;
        caps.effective.remove(gained);
        caps.permitted.remove(gained);
        set_capabilities(None, caps).map_err(io::Error::from)?;
        let propagation = MountPropagationFlags::REC | MountPropagationFlags::PRIVATE;
        mount_change("/", propagation).map_err(io::Error::from)?;
        super::mount_aliases::protect(request, home, &fs::read("/proc/self/mountinfo")?)?;
        stores.retain_admitted(request);
        let scratch = tempfile::Builder::new()
            .prefix("glyph-shell-view-")
            .tempdir_in("/tmp")?;
        private_tmpfs(scratch.path())?;
        Ok(Self {
            budget: SnapshotBudget::default(),
            stores,
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
impl SnapshotBudget {
    fn take_mount(&mut self, scope: Scope) -> bool {
        let remaining = match scope {
            Scope::Runtime | Scope::Resource => &mut self.runtime_mounts,
            Scope::Dependency => &mut self.dependency_mounts,
            Scope::Workspace => &mut self.workspace_mounts,
        };
        if *remaining == 0 {
            self.omitted();
            return false;
        }
        *remaining -= 1;
        true
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
    fn budget(&mut self) -> &mut SnapshotBudget {
        &mut self.budget
    }
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
        if super::private_component(&source) && !request.read_only_paths.contains(&source) {
            return Ok(Vec::new());
        }
        let ancestor = if let Some(root) = self
            .runtime_views
            .keys()
            .find(|root| source.starts_with(root))
        {
            root.clone()
        } else {
            let replaceable_path = replaceable_ancestor(&source)?;
            let mut boundaries = Vec::new();
            let mut remaining = 750_000;
            let scan = runtime_boundaries(
                &source,
                private,
                &mut boundaries,
                0,
                &|path| Ok((path == source && replaceable_path) || user_controls(path)?),
                &mut remaining,
            );
            scan?;
            let mut overlays = Vec::new();
            for (boundary, hidden) in boundaries {
                if hidden {
                    self.start(&boundary)?;
                    self.finish(&boundary)?;
                } else {
                    let protected = std::slice::from_ref(&boundary);
                    let mut view = super::projection::WorkspaceView::runtime(&mut **self);
                    view.workspace(&boundary, request, protected, private)?;
                }
                overlays.push((boundary, self.target.clone()));
            }
            self.runtime_views.insert(source.clone(), overlays);
            source.clone()
        };
        Ok(runtime_arguments(
            &source,
            target,
            &self.runtime_views[&ancestor],
        ))
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
    fn restore_directory_mode(&mut self, path: &Path, directory: &OwnedFd) -> io::Result<()> {
        let mode = rustix::fs::fstat(directory)?.st_mode & 0o777;
        fs::set_permissions(self.target(path), fs::Permissions::from_mode(mode))
    }
    fn symlink(&mut self, target: &OsStr, path: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, self.target(path))
    }
    fn linked_file(&mut self, path: &Path, fd: &OwnedFd) -> io::Result<()> {
        let target = self.target(path);
        self.stores.copy_object(fd, &target)
    }
    fn file(&mut self, path: &Path, fd: &OwnedFd, writable: bool, scope: Scope) -> io::Result<()> {
        let target = self.target(path);
        let source = rustix::fs::fstat(fd)?;
        let length = source.st_size as u64;
        // Small read-only files share the sealed tmpfs. Reserve mounts for large binaries and live writes.
        let charge = length.saturating_add(4095) / 4096 * 4096 + 512;
        if matches!(scope, Scope::Runtime | Scope::Resource)
            && length <= 1024 * 1024
            && charge <= self.budget.runtime_bytes
        {
            self.budget.runtime_bytes -= charge;
            return copy_runtime_file(
                fd,
                &target,
                length,
                (scope == Scope::Resource).then_some(source.st_mode & 0o777),
            );
        }
        if !self.budget.take_mount(scope) {
            return Ok(());
        }
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

/// Reuse only real directories from an already sealed snapshot. An alias can refer to a directory
/// omitted from the frozen view or to the former name of a symlink that was subsequently replaced.
fn runtime_arguments(
    source: &Path,
    target: &Path,
    overlays: &[(PathBuf, PathBuf)],
) -> Vec<OsString> {
    let mut result = vec!["--ro-bind".into(), source.into(), target.into()];
    for (original, view) in overlays {
        if let Ok(relative) = original.strip_prefix(source) {
            result.extend([
                "--ro-bind".into(),
                view.into(),
                target.join(relative).into_os_string(),
            ]);
        } else if let Ok(relative) = source.strip_prefix(original) {
            let mut child = view.clone();
            for name in relative {
                child.push(name);
                if !fs::symlink_metadata(&child).is_ok_and(|stat| stat.is_dir()) {
                    return Vec::new();
                }
            }
            result.extend(["--ro-bind".into(), child.into_os_string(), target.into()]);
        }
    }
    result
}

fn copy_runtime_file(
    fd: &OwnedFd,
    target: &Path,
    length: u64,
    resource_mode: Option<u32>,
) -> io::Result<()> {
    let mut copy = fs::File::create_new(target)?;
    let mut source_file = fs::File::from(rustix::io::dup(fd)?).take(length + 1);
    if io::copy(&mut source_file, &mut copy)? != length || rustix::fs::fstat(fd)?.st_nlink != 1 {
        return fs::remove_file(target);
    }
    let mode = resource_mode.unwrap_or_else(|| {
        let descriptor = format!("/proc/self/fd/{}", fd.as_raw_fd());
        if rustix::fs::access(descriptor, rustix::fs::Access::EXEC_OK).is_ok() {
            0o500
        } else {
            0o400
        }
    });
    copy.set_permissions(fs::Permissions::from_mode(mode))
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
    remaining: &mut usize,
) -> io::Result<()> {
    if rustix::fs::access(
        path,
        rustix::fs::Access::READ_OK | rustix::fs::Access::EXEC_OK,
    )
    .is_err()
        || depth > super::MAX_WORKSPACE_SCAN_DEPTH
        || private.iter().any(|p| path.starts_with(p))
    {
        out.push((path.to_owned(), true));
        return Ok(());
    }
    if mutable(path)? {
        out.push((path.to_owned(), false));
        return Ok(());
    }
    let Some(children) = public_subdirectories(path, private, remaining)? else {
        out.push((path.to_owned(), false));
        return Ok(());
    };
    let start = out.len();
    for child in children {
        runtime_boundaries(&child, private, out, depth + 1, mutable, remaining)?;
        if out.len() - start > 512 {
            out.truncate(start);
            out.push((path.to_owned(), false));
            break;
        }
    }
    Ok(())
}

fn public_subdirectories(
    path: &Path,
    private: &[PathBuf],
    remaining: &mut usize,
) -> io::Result<Option<Vec<PathBuf>>> {
    // Seal the parent view even if the reserved trace pathname has not appeared yet.
    if private.iter().any(|child| child.parent() == Some(path)) {
        return Ok(None);
    }
    let mut children = Vec::new();
    for entry in fs::read_dir(path)? {
        if *remaining == 0 {
            return Ok(None);
        }
        *remaining -= 1;
        let entry = entry?;
        let child = entry.path();
        if super::private_component(&child) {
            return Ok(None);
        }
        if entry.file_type()?.is_dir() {
            children.push(child);
        }
    }
    children.sort_unstable();
    Ok(Some(children))
}

/// A user with write access to an ancestor can replace an otherwise immutable runtime root.
fn replaceable_ancestor(source: &Path) -> io::Result<bool> {
    for ancestor in source.ancestors().skip(1) {
        if user_controls(ancestor)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn user_controls(path: &Path) -> io::Result<bool> {
    let info = fs::symlink_metadata(path)?;
    Ok(info.uid() == getuid().as_raw()
        || rustix::fs::access(path, rustix::fs::Access::WRITE_OK).is_ok())
}

#[cfg(test)]
#[path = "tests/kernel_mounts.rs"]
mod kernel_mounts;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserved_entries_and_inaccessible_roots_receive_filtered_views() {
        let base = tempfile::tempdir().unwrap();
        assert!(replaceable_ancestor(&base.path().join("child")).unwrap());
        assert!(!replaceable_ancestor(Path::new("/")).unwrap());
        assert!(replaceable_ancestor(Path::new("/usr")).is_ok());
        assert!(replaceable_ancestor(&base.path().join("missing/child")).is_err());
        let dir = base.path().join("vendor");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join(".Skill-Staging"), "private").unwrap();
        let mut views = Vec::new();
        let immutable = |_: &Path| Ok(false);
        runtime_boundaries(base.path(), &[], &mut views, 0, &immutable, &mut 10_000).unwrap();
        assert_eq!(views, vec![(dir.clone(), false)]);
        views.clear();
        runtime_boundaries(
            &dir,
            std::slice::from_ref(&dir),
            &mut views,
            0,
            &immutable,
            &mut 10_000,
        )
        .unwrap();
        assert_eq!(views, vec![(dir.clone(), true)]);
        assert!(runtime_boundaries(
            &dir,
            &[],
            &mut views,
            super::super::MAX_WORKSPACE_SCAN_DEPTH + 1,
            &user_controls,
            &mut 10_000
        )
        .is_ok());
        views.clear();
        runtime_boundaries(&dir, &[], &mut views, 0, &|_| Ok(true), &mut 10_000).unwrap();
        assert_eq!(views, vec![(dir.clone(), false)]);
        assert!(public_subdirectories(base.path(), &[], &mut 0)
            .unwrap()
            .is_none());
        let future_trace = base.path().join("provider.log");
        assert!(!future_trace.exists());
        assert!(
            public_subdirectories(base.path(), &[future_trace], &mut 10_000)
                .unwrap()
                .is_none()
        );
        let many = base.path().join("many");
        fs::create_dir(&many).unwrap();
        for id in 0..513 {
            fs::create_dir(many.join(id.to_string())).unwrap();
        }
        views.clear();
        runtime_boundaries(&many, &[], &mut views, 0, &|p| Ok(p != many), &mut 600).unwrap();
        assert_eq!(views, vec![(many, false)]);
        let source = base.path().join("fixture");
        fs::write(&source, "fixture").unwrap();
        let request = crate::tests::request(
            crate::SandboxProfile::ReadOnly,
            base.path(),
            &base.path().join("state"),
        );
        let mut view = KernelWorkspace {
            stores: crate::content_store::VerifiedStores::open(&request),
            scratch: base.path().join("unused-scratch"),
            root: base.path().to_owned(),
            target: base.path().join("unused-target"),
            next: 0,
            runtime_views: Default::default(),
            budget: SnapshotBudget::default(),
        };
        view.budget.workspace_mounts = 0;
        (&mut view)
            .file(
                &source,
                &fs::File::open(&source).unwrap().into(),
                true,
                Scope::Workspace,
            )
            .unwrap();
        let ancestor = base.path().join("runtime");
        let child = ancestor.join("bin");
        fs::create_dir_all(&child).unwrap();
        view.runtime_views.insert(
            ancestor.clone(),
            vec![
                (ancestor.join("sibling"), base.path().join("sibling-view")),
                (ancestor, base.path().join("omitted")),
            ],
        );
        assert!((&mut view)
            .runtime(&child, &child, &request, &[])
            .unwrap()
            .is_empty());
        let reserved = dir.join(".GlYpH-SkIlL-RuN");
        fs::create_dir(&reserved).unwrap();
        let alias = base.path().join("toolchain-alias");
        std::os::unix::fs::symlink(&reserved, &alias).unwrap();
        assert!((&mut view)
            .runtime(&alias, &alias, &request, &[])
            .unwrap()
            .is_empty());
        let backing = base.path().join("view");
        fs::create_dir_all(backing.join("bin")).unwrap();
        let overlays = [
            (base.path().join("unrelated"), backing.clone()),
            (child.join("nested"), backing.clone()),
            (child.parent().unwrap().into(), backing.clone()),
        ];
        let args = runtime_arguments(&child, &child, &overlays);
        assert!(args.contains(&backing.join("bin").into_os_string()));
        assert!(args.contains(&child.join("nested").into_os_string()));
        let budget = &mut view.budget;
        budget.runtime_mounts = 0;
        assert!(!budget.take_mount(Scope::Runtime));
        assert!(budget.take_mount(Scope::Dependency));
        let program = base.path().join("executable");
        fs::write(&program, "fixture").unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        let copy = base.path().join("read-only");
        let read = || fs::File::open(&program).unwrap().into();
        copy_runtime_file(&read(), &copy, 7, None).unwrap();
        assert_eq!(fs::symlink_metadata(&copy).unwrap().mode() & 0o777, 0o500);
        fs::remove_file(&copy).unwrap();
        copy_runtime_file(&read(), &copy, 3, None).unwrap();
        assert!(!copy.exists());
        let occupied = base.path().join("occupied");
        fs::write(&occupied, "fixture").unwrap();
        assert!(copy_runtime_file(&read(), &occupied, 7, None).is_err());
        let program = std::env::current_exe().unwrap();
        assert!((&mut view)
            .runtime(&program, &program, &request, &[])
            .is_err());
        let first = dir.join("first");
        let second = dir.join("second");
        let file: OwnedFd = fs::File::create_new(&first).unwrap().into();
        verify_file(&file, &first).unwrap();
        fs::write(&second, "different inode").unwrap();
        assert!(verify_file(&file, &second).is_err());
    }
}
