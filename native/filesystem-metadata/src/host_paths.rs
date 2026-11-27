//! Establish host file provenance before the caller uses a host configuration or executable.
use std::io;
use std::path::PathBuf;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn assert_host_paths(_: &[PathBuf], _: &[PathBuf]) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Host filesystem identity is unavailable.",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use unix::assert_host_paths;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod unix {
    use super::*;
    use std::collections::{BTreeSet, VecDeque};
    use std::ffi::OsString;
    use std::fs;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Component, Path};

    fn denied() -> io::Error {
        io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Could not establish host filesystem authority outside every workspace.",
        )
    }

    type Id = (u64, u64);
    fn id(meta: &fs::Metadata) -> Id {
        (meta.dev(), meta.ino())
    }

    struct Location {
        path: PathBuf,
        identity: Option<Id>,
        traversed: BTreeSet<PathBuf>,
        inodes: BTreeSet<Id>,
        directory: bool,
    }

    fn resolve(path: &Path, host: bool) -> io::Result<Location> {
        if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
            return Err(denied());
        }
        let mut remaining: VecDeque<OsString> = path
            .components()
            .map(|part| part.as_os_str().to_owned())
            .collect();
        let mut current = PathBuf::new();
        let mut traversed = BTreeSet::new();
        let mut inodes = BTreeSet::new();
        let mut links = 0;
        while let Some(part) = remaining.pop_front() {
            if part == ".." {
                current.pop();
            } else {
                current.push(part);
            }
            traversed.insert(current.clone());
            let meta = match fs::symlink_metadata(&current) {
                Ok(meta) => meta,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            inodes.insert(id(&meta));
            if meta.is_symlink() {
                links += 1;
                if links > 40 {
                    return Err(denied());
                }
                let target = fs::read_link(&current)?;
                current.pop();
                for part in target.components().rev() {
                    remaining.push_front(part.as_os_str().to_owned());
                }
            } else if !meta.is_dir() && (!meta.is_file() || !remaining.is_empty()) {
                return Err(denied());
            }
        }
        // Confirm that resolving the caller's spelling still selects the inode we inspected.
        // A future file is admitted only when the same missing suffix is anchored by this trace.
        let identity = |path: &Path| -> io::Result<Option<fs::Metadata>> {
            match fs::metadata(path) {
                Ok(meta) => Ok(Some(meta)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error),
            }
        };
        let final_meta = identity(&current)?;
        let final_id = final_meta.as_ref().map(id);
        if identity(path)?.as_ref().map(id) != final_id {
            return Err(denied());
        }
        let directory = final_meta.as_ref().is_some_and(fs::Metadata::is_dir);
        if let Some(meta) = final_meta {
            // A regular hard link can also be present under a workspace without any mount record.
            // Non-writable system multicall binaries legitimately have several installation names.
            if host
                && meta.is_file()
                && meta.nlink() > 1
                && (meta.uid() != 0
                    || meta.mode() & 0o022 != 0
                    || rustix::fs::access(&current, rustix::fs::Access::WRITE_OK).is_ok())
            {
                return Err(denied());
            }
        }
        Ok(Location {
            path: current,
            identity: final_id,
            traversed,
            inodes,
            directory,
        })
    }

    pub fn assert_host_paths(paths: &[PathBuf], workspace_roots: &[PathBuf]) -> io::Result<()> {
        let hosts = paths
            .iter()
            .map(|p| resolve(p, true))
            .collect::<io::Result<Vec<_>>>()?;
        let roots = workspace_roots
            .iter()
            .map(|p| resolve(p, false))
            .collect::<io::Result<Vec<_>>>()?;
        #[cfg(target_os = "linux")]
        let bytes = fs::read("/proc/self/mountinfo")?;
        #[cfg(target_os = "linux")]
        let mounts = crate::mount_table::MountTable::parse(&bytes)?;
        for host in hosts {
            #[cfg(target_os = "linux")]
            let traversed = {
                let mut paths = host.traversed.clone();
                for path in &host.traversed {
                    mounts.aliases(path, false, &mut paths);
                }
                paths
            };
            #[cfg(target_os = "macos")]
            let traversed = host.traversed;
            for (root, logical) in roots.iter().zip(workspace_roots) {
                #[cfg(target_os = "macos")]
                let exposed = BTreeSet::from([root.path.clone()]);
                #[cfg(target_os = "linux")]
                let mut exposed = BTreeSet::from([root.path.clone()]);
                #[cfg(target_os = "linux")]
                mounts.aliases(&root.path, true, &mut exposed);
                if host.directory
                    && (host.identity.is_some_and(|i| root.inodes.contains(&i))
                        || exposed.iter().any(|p| p.starts_with(&host.path)))
                {
                    return Err(denied());
                }
                if root.identity.is_some_and(|i| host.inodes.contains(&i))
                    || traversed
                        .iter()
                        .any(|path| path.starts_with(&root.path) || path.starts_with(logical))
                {
                    return Err(denied());
                }
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::symlink;
        #[test]
        fn admits_only_paths_whose_resolution_stays_on_the_host() {
            let dir = tempfile::tempdir().unwrap();
            let base = dir.path().canonicalize().unwrap();
            let workspace = base.join("workspace");
            fs::create_dir(&workspace).unwrap();
            let roots = [workspace.clone()];
            let file = base.join("host");
            fs::write(&file, "synthetic fixture").unwrap();
            let missing = base.join("new/child");
            let check = |p| assert_host_paths(&[p], &roots);
            check(file.clone()).unwrap();
            check(missing.clone()).unwrap();
            assert!(check(base.clone()).is_err());
            let sibling = base.join("sibling");
            fs::create_dir(&sibling).unwrap();
            check(sibling).unwrap();
            symlink(&file, workspace.join("link")).unwrap();
            symlink("workspace/link", base.join("indirect")).unwrap();
            assert!(check(base.join("indirect")).is_err());
            symlink("../host", workspace.join("rel")).unwrap();
            assert!(check(workspace.join("rel")).is_err());
            assert!(check(workspace.join("future")).is_err());
            assert!(check(PathBuf::from("relative")).is_err());
            assert!(check(base.join("../other")).is_err());
            symlink("loop", base.join("loop")).unwrap();
            assert!(check(base.join("loop")).is_err());
            assert!(check(file.join("child")).is_err());
            assert!(check(PathBuf::from("/dev/null")).is_err());
            fs::hard_link(&file, workspace.join("other")).unwrap();
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o666)).unwrap();
            assert!(check(file).is_err());
            assert!(assert_host_paths(&[missing.clone()], &[missing]).is_err());
        }
    }
}
