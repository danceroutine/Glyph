//! Establish host file provenance before the caller uses a host configuration or executable.
use std::io;
use std::path::PathBuf;

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn assert_host_paths_with_sockets(
    _: &[PathBuf],
    _: &[PathBuf],
    _: &[PathBuf],
) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Host filesystem identity is unavailable.",
    ))
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub use unix::assert_host_paths_with_sockets;

pub fn assert_host_paths(paths: &[PathBuf], workspace_roots: &[PathBuf]) -> io::Result<()> {
    assert_host_paths_with_sockets(paths, workspace_roots, &[])
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod unix {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet, VecDeque};
    use std::ffi::OsString;
    use std::fs;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
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

    fn existing(result: io::Result<fs::Metadata>) -> io::Result<Option<fs::Metadata>> {
        match result {
            Ok(meta) => Ok(Some(meta)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn unchanged(before: Option<Id>, after: Option<Id>) -> io::Result<()> {
        if before == after {
            Ok(())
        } else {
            Err(denied())
        }
    }

    fn writable_link(uid: u32, mode: u32, writable: bool) -> bool {
        uid != 0 || mode & 0o022 != 0 || writable
    }

    struct Location {
        path: PathBuf,
        identity: Option<Id>,
        traversed: BTreeSet<PathBuf>,
        inodes: BTreeSet<Id>,
        directory: bool,
    }

    fn resolve(path: &Path, host: bool, socket: bool) -> io::Result<Location> {
        if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
            return Err(denied());
        }
        let mut remaining: VecDeque<OsString> = path
            .components()
            .map(|part| part.as_os_str().to_owned())
            .collect();
        let mut current = PathBuf::new();
        let mut traversed = BTreeSet::new();
        let mut observed = BTreeMap::new();
        let mut links = 0;
        while let Some(part) = remaining.pop_front() {
            if part == ".." {
                current.pop();
            } else {
                current.push(part);
            }
            traversed.insert(current.clone());
            let meta = existing(fs::symlink_metadata(&current))?;
            observed.insert(current.clone(), meta.as_ref().map(id));
            let Some(meta) = meta else {
                continue;
            };
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
            } else if !meta.is_dir()
                && !(remaining.is_empty()
                    && (meta.is_file() || (socket && meta.file_type().is_socket())))
            {
                return Err(denied());
            }
        }
        // Confirm that resolving the caller's spelling still selects the inode we inspected.
        // A future file is admitted only when the same missing suffix is anchored by this trace.
        let final_meta = existing(fs::metadata(&current))?;
        let final_id = final_meta.as_ref().map(id);
        unchanged(final_id, existing(fs::metadata(path))?.as_ref().map(id))?;
        for (name, expected) in &observed {
            let current = existing(fs::symlink_metadata(name))?.as_ref().map(id);
            unchanged(*expected, current)?;
        }
        // A reserved future location may become a directory while its host lease is active.
        let directory = final_meta.as_ref().is_none_or(fs::Metadata::is_dir);
        if let Some(meta) = final_meta {
            if socket && !meta.file_type().is_socket() {
                return Err(denied());
            }
            // A regular hard link can also be present under a workspace without any mount record.
            // Non-writable system multicall binaries legitimately have several installation names.
            if host
                && (meta.is_file() || socket)
                && meta.nlink() > 1
                && writable_link(
                    meta.uid(),
                    meta.mode(),
                    rustix::fs::access(&current, rustix::fs::Access::WRITE_OK).is_ok(),
                )
            {
                return Err(denied());
            }
        }
        Ok(Location {
            path: current,
            identity: final_id,
            traversed,
            inodes: observed.into_values().flatten().collect(),
            directory,
        })
    }

    pub fn assert_host_paths_with_sockets(
        paths: &[PathBuf],
        workspace_roots: &[PathBuf],
        sockets: &[PathBuf],
    ) -> io::Result<()> {
        let hosts = paths
            .iter()
            .map(|p| resolve(p, true, sockets.contains(p)))
            .collect::<io::Result<Vec<_>>>()?;
        let roots = workspace_roots
            .iter()
            .map(|p| resolve(p, false, false))
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
        fn admits_the_agent_socket_only_for_a_socket_input_outside_the_workspace() {
            use std::os::unix::net::UnixListener;
            let dir = tempfile::tempdir_in("/tmp").unwrap();
            let base = dir.path().canonicalize().unwrap();
            let socket = base.join("agent");
            let _listener = UnixListener::bind(&socket).unwrap();
            let file = base.join("key");
            fs::write(&file, "").unwrap();
            let route = base.join("socket-link");
            symlink(&socket, &route).unwrap();
            for name in [&socket, &route] {
                let input = std::slice::from_ref(name);
                assert_host_paths_with_sockets(input, &[], input).unwrap();
                assert!(assert_host_paths(input, &[]).is_err());
                assert!(
                    assert_host_paths_with_sockets(input, std::slice::from_ref(&base), input)
                        .is_err()
                );
            }
            let input = std::slice::from_ref(&file);
            assert!(assert_host_paths_with_sockets(input, &[], input).is_err());
        }
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
            assert!(assert_host_paths(
                std::slice::from_ref(&missing),
                std::slice::from_ref(&missing)
            )
            .is_err());
            assert!(assert_host_paths(
                std::slice::from_ref(&missing),
                &[missing.join("future-root")]
            )
            .is_err());
            assert!(existing(Err(io::ErrorKind::PermissionDenied.into())).is_err());
            assert!(unchanged(Some((1, 2)), Some((1, 3))).is_err());
            assert!(writable_link(0, 0o755, true));
            assert!(writable_link(0, 0o775, false));
            assert!(!writable_link(0, 0o755, false));
            check(PathBuf::from("/bin/sh")).unwrap();
        }
    }
}
