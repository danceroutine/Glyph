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
fn read_only_binding_pins_the_source_inode_and_rejects_writes() {
    // The mount namespace is created before the child test harness starts any threads.
    const CHILD: &str = "GLYPH_TEST_READ_ONLY_BIND";
    if std::env::var_os(CHILD).is_none() {
        let result = std::process::Command::new("unshare")
            .arg("-Urm").arg(std::env::current_exe().unwrap())
            .args(["--exact", "kernel_workspace::kernel_mounts::read_only_binding_pins_the_source_inode_and_rejects_writes", "--ignored"])
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
}
