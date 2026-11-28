//! Project host exclusions through Linux bind mounts before constructing the sandbox.
//! Mountinfo is captured after the helper makes its mount namespace private.
use super::{home_sensitive_paths, private_component, SandboxError, SandboxRequest};
use glyph_filesystem_metadata::mount_table::MountTable;
use std::collections::BTreeSet;
use std::path::Path;

pub(super) fn protect(
    request: &mut SandboxRequest,
    home: Option<&Path>,
    table: &[u8],
) -> Result<(), SandboxError> {
    let mounts = MountTable::parse(table)?;
    let private_sources = request
        .private_paths
        .iter()
        .chain([&request.state_directory])
        .cloned()
        .chain(home_sensitive_paths(home));
    let mut hidden = BTreeSet::new();
    for path in private_sources {
        let mut additional = BTreeSet::new();
        mounts.aliases(&path, true, &mut additional);
        // Home locations and state have their own existing masking rules.
        additional.remove(&path);
        hidden.extend(additional);
    }
    hidden.extend(request.private_paths.iter().cloned());
    let mut protected: BTreeSet<_> = request.protected_paths.iter().cloned().collect();
    for path in request
        .protected_paths
        .iter()
        .chain(&request.read_only_paths)
        .chain([&super::protected_executable()?])
    {
        mounts.aliases(path, true, &mut protected);
    }
    glyph_filesystem_metadata::workspace_paths::project_managed_mounts(&mounts, &mut protected);
    // A bind may expose only a managed descendant, with no visible marker in its new name.
    for (root, point) in mounts.locations() {
        if private_component(root) || private_component(point) {
            mounts.aliases(point, true, &mut hidden);
        }
        if root
            .ancestors()
            .chain(point.ancestors())
            .any(|path| super::named(path, ".git"))
        {
            mounts.aliases(point, true, &mut protected);
        }
    }
    if request
        .workspace_roots
        .iter()
        .chain(&request.read_only_paths)
        .any(|root| hidden.iter().any(|path| root.starts_with(path)))
    {
        return Err(SandboxError::InvalidPath(
            "A sandbox root aliases private host storage.".into(),
        ));
    }
    // A content store authenticates indexed hard links. Only external host trees may supply
    // that authority, including after a descendant is mounted under a workspace.
    let mut store_exclusions = hidden.clone();
    store_exclusions.extend(protected.iter().cloned());
    for root in request
        .workspace_roots
        .iter()
        .chain([&request.state_directory])
    {
        mounts.aliases(root, true, &mut store_exclusions);
    }
    store_exclusions.extend(home_sensitive_paths(home));
    request.content_stores.retain(|store| {
        let mut views = BTreeSet::new();
        mounts.aliases(&store.root, true, &mut views);
        !views.iter().any(|view| {
            store_exclusions
                .iter()
                .any(|excluded| view.starts_with(excluded) || excluded.starts_with(view))
        })
    });
    request.private_paths = hidden.into_iter().collect();
    request.protected_paths = protected.into_iter().collect();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SandboxProfile;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn projects_explicit_paths_through_file_directory_and_ancestor_aliases() {
        let mut request = crate::tests::request(
            SandboxProfile::WorkspaceWrite,
            Path::new("/project"),
            Path::new("/state"),
        );
        request.protected_paths.push("/tools".into());
        request.private_paths.push("/host/trace".into());
        let table = b"1 1 0:1 / /
2 1 0:1 /host/trace /project/single
3 1 0:1 /host /project/config
4 1 0:1 /tools/sub /project/library
5 1 0:2 / /project/ordinary
6 1 0:1 /state /other
7 1 0:1 /repo/.glyph/skills/sample /project/managed
8 1 0:1 /repo/.skill-staging/entry /project/transaction
9 1 0:3 / /state/nested-volume
10 1 0:3 /sub /project/volume-alias
11 1 0:1 /another/.cursor /project/marker
12 1 0:1 /repo/.git/objects /project/repo-objects";
        for name in ["/host", "/ordinary/store"] {
            request.content_stores.push(crate::ContentStore {
                root: name.into(),
                layout: crate::ContentStoreLayout::Sha512Prefix2,
                executable_suffix: String::new(),
            });
        }
        protect(&mut request, None, table).unwrap();
        assert_eq!(request.content_stores.len(), 1);
        assert_eq!(request.content_stores[0].root, Path::new("/ordinary/store"));
        for hidden in [
            "/project/single",
            "/project/config/trace",
            "/other",
            "/project/transaction",
            "/project/volume-alias",
        ] {
            assert!(request.private_paths.contains(&PathBuf::from(hidden)));
        }
        for protected in [
            "/project/library",
            "/project/managed",
            "/project/marker/skills",
            "/project/repo-objects",
        ] {
            assert!(request.protected_paths.contains(&PathBuf::from(protected)));
        }
        assert!(!request
            .private_paths
            .contains(&PathBuf::from("/project/ordinary")));
        request.workspace_roots = vec!["/other/sub".into()];
        assert!(protect(&mut request, None, table).is_err());
    }

    #[test]
    #[ignore = "requires an unprivileged Linux user and mount namespace"]
    fn retains_private_and_protected_authority_across_real_bind_mounts() {
        const CHILD: &str = "GLYPH_MOUNT_IDENTITY_TEST";
        if std::env::var_os(CHILD).is_none() {
            let result = std::process::Command::new("unshare").args(["-Urm"]).arg(std::env::current_exe().unwrap())
                .args(["--exact", "mount_aliases::tests::retains_private_and_protected_authority_across_real_bind_mounts", "--ignored"])
                .env(CHILD, "1").output().unwrap();
            assert!(
                result.status.success()
                    && String::from_utf8_lossy(&result.stdout).contains("1 passed")
            );
            return;
        }
        let base = tempfile::tempdir().unwrap();
        let base_path = base.path().canonicalize().unwrap();
        let project = base_path.join("project");
        let hidden = base_path.join("host");
        let protected = base_path.join("protected");
        for dir in [&project, &hidden, &protected] {
            fs::create_dir(dir).unwrap();
        }
        let private_file = hidden.join("record");
        fs::write(&private_file, b"synthetic fixture").unwrap();
        let named = project.join("record");
        let nested = project.join("library");
        let alias = base_path.join("attached");
        fs::write(&named, b"").unwrap();
        for dir in [&nested, &alias] {
            fs::create_dir(dir).unwrap();
        }
        use rustix::mount::{mount_bind, unmount, UnmountFlags};
        for (source, target) in [
            (&private_file, &named),
            (&protected, &nested),
            (&hidden, &alias),
        ] {
            mount_bind(source, target).unwrap();
        }
        let mut request = crate::tests::request(SandboxProfile::WorkspaceWrite, &project, &hidden);
        request.protected_paths.push(protected.clone());
        let assert_host = |p: &Path, root: &Path| {
            glyph_filesystem_metadata::assert_host_paths(&[p.to_owned()], &[root.to_owned()])
        };
        assert!(assert_host(&private_file, &project).is_err());
        assert!(assert_host(&hidden, &project).is_err());
        assert!(assert_host(&protected.join("future"), &project).is_err());
        assert!(assert_host(&private_file, &alias).is_err());
        assert_host(&base_path.join("ordinary-host"), &project).unwrap();
        let table = fs::read("/proc/self/mountinfo").unwrap();
        protect(&mut request, None, &table).unwrap();
        assert!(request.private_paths.contains(&named));
        assert!(request.protected_paths.contains(&nested));
        request.workspace_roots = vec![alias.clone()];
        assert!(protect(&mut request, None, &table).is_err());
        // The typed host receives the same positive mount identity evidence as the shell.
        // Ordinary nested mounts remain writable while managed package bytes remain readable.
        use glyph_filesystem_metadata::workspace_paths::WorkspacePaths;
        let earlier = WorkspacePaths::current(std::slice::from_ref(&private_file)).unwrap();
        let named_staging = base_path.join(".skill-staging");
        let marker = base_path.join(".glyph");
        let library = marker.join("skills");
        let ordinary = base_path.join("shared-data");
        let links =
            ["staged", "packages", "mounted-marker", "ordinary"].map(|name| project.join(name));
        for path in [&named_staging, &library, &ordinary] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(library.join("manifest"), "reviewed package").unwrap();
        fs::write(marker.join("notes"), "ordinary sibling").unwrap();
        let marker_only = project.join("parent-only");
        fs::create_dir(&marker_only).unwrap();
        mount_bind(&marker, &marker_only).unwrap();
        let mut marker_view =
            crate::tests::request(SandboxProfile::WorkspaceWrite, &project, &hidden);
        protect(
            &mut marker_view,
            None,
            &fs::read("/proc/self/mountinfo").unwrap(),
        )
        .unwrap();
        assert!(marker_view
            .protected_paths
            .contains(&marker_only.join("skills")));
        assert!(!marker_view
            .protected_paths
            .iter()
            .any(|p| marker_only.join("notes").starts_with(p)));
        use crate::projection::{MountTrace, WorkspaceView};
        let plan = WorkspaceView::new(MountTrace::default())
            .workspace(
                &project,
                &marker_view,
                &marker_view.protected_paths,
                &marker_view.private_paths,
            )
            .unwrap();
        for (mode, entry) in [("--ro-bind", "skills/manifest"), ("--bind", "notes")] {
            assert!(plan
                .windows(3)
                .any(|args| { args[0] == mode && args[2] == marker_only.join(entry).as_os_str() }));
        }
        unmount(&marker_only, UnmountFlags::empty()).unwrap();
        for (src, dst) in [&named_staging, &library, &marker, &ordinary]
            .into_iter()
            .zip(&links)
        {
            fs::create_dir(dst).unwrap();
            mount_bind(src, dst).unwrap();
        }
        assert!(!earlier.topology_current());
        let private = std::slice::from_ref(&private_file);
        let read = WorkspacePaths::current(private).unwrap();
        let edit =
            WorkspacePaths::for_operation(private, Some(std::slice::from_ref(&protected))).unwrap();
        for path in [&named, &links[0]] {
            assert!(read.assert_path(path, None).is_err());
        }
        for path in [&nested, &links[1], &links[2].join("skills")] {
            read.assert_path(&path.join("document"), None).unwrap();
            assert!(edit.assert_path(&path.join("document"), None).is_err());
        }
        let writable = links[3].join("example");
        edit.assert_path(&writable, None).unwrap();
        fs::write(&writable, "ordinary edit").unwrap();
        read.assert_path(&writable, None).unwrap();
        assert_eq!(
            fs::read_to_string(ordinary.join("example")).unwrap(),
            "ordinary edit"
        );
        for path in &links {
            unmount(path, UnmountFlags::empty()).unwrap();
        }
        for target in [&alias, &nested, &named] {
            unmount(target, UnmountFlags::empty()).unwrap();
        }
    }
}
