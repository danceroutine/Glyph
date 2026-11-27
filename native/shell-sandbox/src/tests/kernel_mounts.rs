use super::*;
use crate::{ContentStore, ContentStoreLayout, SandboxProfile};
use sha2::{Digest, Sha512};

fn workspace(base: &Path, request: &crate::SandboxRequest) -> KernelWorkspace {
    let target = base.join("target");
    fs::create_dir(&target).unwrap();
    KernelWorkspace {
        stores: crate::content_store::VerifiedStores::open(request),
        scratch: base.join("scratch"),
        root: request.working_directory.clone(),
        target,
        next: 0,
        runtime_views: Default::default(),
        budget: SnapshotBudget::default(),
    }
}

#[test]
fn linked_file_materializes_verified_bytes_on_a_distinct_read_only_inode() {
    let base = tempfile::tempdir().unwrap();
    let root = base.path().join("project");
    let store = base.path().join("store");
    fs::create_dir(&root).unwrap();
    let mut request =
        crate::tests::request(SandboxProfile::ReadOnly, &root, &base.path().join("state"));
    request.content_stores.push(ContentStore {
        root: store.clone(),
        layout: ContentStoreLayout::Sha512Prefix2,
        executable_suffix: "-exec".into(),
    });
    let bytes = b"verified package";
    let digest = format!("{:x}", Sha512::digest(bytes));
    let shard = store.join(&digest[..2]);
    fs::create_dir_all(&shard).unwrap();
    let object = shard.join(&digest[2..]);
    fs::write(&object, bytes).unwrap();
    let dependency = root.join("entry");
    fs::hard_link(&object, &dependency).unwrap();
    let mut view = workspace(base.path(), &request);
    (&mut view)
        .linked_file(&dependency, &fs::File::open(&dependency).unwrap().into())
        .unwrap();
    let projected = view.target(&dependency);
    let copy = fs::metadata(&projected).unwrap();
    let source = fs::metadata(&object).unwrap();
    assert_eq!(fs::read(&projected).unwrap(), bytes);
    assert_ne!((source.dev(), source.ino()), (copy.dev(), copy.ino()));
    assert_eq!(copy.mode() & 0o777, 0o444);
    if !rustix::process::getuid().is_root() {
        assert!(fs::OpenOptions::new().write(true).open(&projected).is_err());
    }
}

#[test]
#[ignore = "requires an unprivileged Linux user and mount namespace"]
fn workspace_bindings_pin_the_file_and_enforce_the_selected_write_permission() {
    // The mount namespace is created before the child test harness starts any threads.
    const CHILD: &str = "GLYPH_TEST_READ_ONLY_BIND";
    if std::env::var_os(CHILD).is_none() {
        let result = std::process::Command::new("unshare")
            .arg("-Urm").arg(std::env::current_exe().unwrap())
            .args(["--exact", "kernel_workspace::kernel_mounts::workspace_bindings_pin_the_file_and_enforce_the_selected_write_permission", "--ignored"])
            .env(CHILD, "1").output().unwrap();
        assert!(result.status.success(), "{result:?}");
        assert!(
            String::from_utf8_lossy(&result.stdout).contains("1 passed"),
            "{result:?}"
        );
        return;
    }
    let base = tempfile::tempdir().unwrap();
    let root = base.path().join("project");
    fs::create_dir(&root).unwrap();
    let source = root.join("entry");
    fs::write(&source, b"live source").unwrap();
    let request =
        crate::tests::request(SandboxProfile::ReadOnly, &root, &base.path().join("state"));
    let mut view = workspace(base.path(), &request);
    (&mut view)
        .file(
            &source,
            &fs::File::open(&source).unwrap().into(),
            false,
            Scope::Workspace,
        )
        .unwrap();
    let target = view.target(&source);
    let inode = fs::metadata(&source).unwrap();
    let binding = fs::metadata(&target).unwrap();
    assert_eq!((binding.dev(), binding.ino()), (inode.dev(), inode.ino()));
    assert_eq!(fs::read(&target).unwrap(), b"live source");
    assert_eq!(
        fs::write(&target, b"change").unwrap_err().raw_os_error(),
        Some(rustix::io::Errno::ROFS.raw_os_error())
    );
    assert_eq!(fs::read(&source).unwrap(), b"live source");
    unmount(&target, UnmountFlags::empty()).unwrap();

    let writable_source = root.join("editable");
    fs::write(&writable_source, b"original").unwrap();
    let writable_target = view.target(&writable_source);
    (&mut view)
        .file(
            &writable_source,
            &fs::File::open(&writable_source).unwrap().into(),
            true,
            Scope::Workspace,
        )
        .unwrap();
    fs::write(&writable_target, b"saved edit").unwrap();
    assert_eq!(fs::read(&writable_source).unwrap(), b"saved edit");
    unmount(&writable_target, UnmountFlags::empty()).unwrap();

    let resource = root.join("template");
    fs::write(&resource, b"pinned resource").unwrap();
    fs::set_permissions(&resource, fs::Permissions::from_mode(0o640)).unwrap();
    (&mut view)
        .file(
            &resource,
            &fs::File::open(&resource).unwrap().into(),
            false,
            Scope::Resource,
        )
        .unwrap();
    let copy = view.target(&resource);
    assert_eq!(fs::read(&copy).unwrap(), b"pinned resource");
    assert_eq!(fs::metadata(&copy).unwrap().mode() & 0o777, 0o640);
    assert_ne!(
        fs::metadata(&copy).unwrap().ino(),
        fs::metadata(&resource).unwrap().ino()
    );

    // A private runtime root produces a sealed, empty overlay. A reserved run
    // name is omitted before any overlay can be allocated.
    fs::create_dir(&view.scratch).unwrap();
    let reserved = root.join(".glyph-skill-run");
    fs::create_dir(&reserved).unwrap();
    assert!((&mut view)
        .runtime(&reserved, &reserved, &request, &[])
        .unwrap()
        .is_empty());
    let hidden = root.join("private-runtime");
    fs::create_dir(&hidden).unwrap();
    let arguments = (&mut view)
        .runtime(&hidden, &hidden, &request, std::slice::from_ref(&hidden))
        .unwrap();
    assert!(!arguments.is_empty());
    assert_eq!(fs::read_dir(&view.target).unwrap().count(), 0);
    assert!(fs::write(view.target.join("denied"), b"fixture").is_err());
    unmount(&view.target, UnmountFlags::empty()).unwrap();
}

#[test]
fn restore_directory_mode_copies_permissions_from_the_opened_directory() {
    let base = tempfile::tempdir().unwrap();
    let root = base.path().join("project");
    let folder = root.join("templates");
    fs::create_dir_all(&folder).unwrap();
    let request =
        crate::tests::request(SandboxProfile::ReadOnly, &root, &base.path().join("state"));
    let mut view = workspace(base.path(), &request);
    fs::create_dir(view.target(&folder)).unwrap();
    let handle = fs::File::open(&folder).unwrap();
    handle
        .set_permissions(fs::Permissions::from_mode(0o750))
        .unwrap();
    (&mut view)
        .restore_directory_mode(&folder, &handle.into())
        .unwrap();
    assert_eq!(
        fs::metadata(view.target(&folder)).unwrap().mode() & 0o777,
        0o750
    );
}
