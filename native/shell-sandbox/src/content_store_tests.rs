use super::*;
use crate::{SandboxProfile, WorkspaceAccessPolicy};
use std::fs;
use std::io::{Seek, SeekFrom};
use std::os::unix::fs::{symlink, MetadataExt};
use std::path::PathBuf;

fn store(root: PathBuf) -> ContentStore {
    ContentStore {
        root,
        layout: ContentStoreLayout::Sha512Prefix2,
        executable_suffix: "-exec".into(),
    }
}

#[test]
fn store_authority_excludes_workspace_private_symlink_and_writable_roots() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let files = base.join("files");
    fs::create_dir(&files).unwrap();
    let mut request = SandboxRequest {
        profile: SandboxProfile::ReadOnly,
        working_directory: base.join("project"),
        workspace_roots: vec![base.join("project")],
        state_directory: base.join("state"),
        private_paths: vec![base.join("private")],
        protected_paths: vec![],
        read_only_paths: vec![],
        workspace_policy: WorkspaceAccessPolicy::default(),
        command: vec![],
        content_stores: vec![],
    };
    for name in [
        "project",
        "state",
        ".skill-staging",
        ".glyph/skills",
        ".cursor/skills",
        "private",
        "writable",
        ".GLYPH/SKILLS",
    ] {
        fs::create_dir_all(base.join(name)).unwrap();
        request.content_stores.push(store(base.join(name)));
    }
    fs::set_permissions(base.join("writable"), fs::Permissions::from_mode(0o777)).unwrap();
    symlink(&files, base.join("alias")).unwrap();
    for path in [
        base.join("alias"),
        base.join("files/../files"),
        PathBuf::from("relative"),
        base.clone(),
    ] {
        request.content_stores.push(store(path));
    }
    for suffix in ["bad/slash", "abcdefghijklmnopqrstuvwxyz0123456789"] {
        let mut invalid = store(files.clone());
        invalid.executable_suffix = suffix.into();
        request.content_stores.push(invalid);
    }
    request.content_stores.push(store(files));
    assert_eq!(VerifiedStores::open(&request).stores.len(), 1);
}

#[test]
fn copied_bytes_match_the_trusted_object_and_obey_modes_size_and_work_bounds() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let store = store(base.join("files"));
    fs::create_dir(&store.root).unwrap();
    let fixture = base.join("fixture");
    fs::write(&fixture, b"fixture bytes").unwrap();
    let source = || -> OwnedFd { File::open(&fixture).unwrap().into() };
    let target = base.join("copy");
    let mut stores = VerifiedStores {
        stores: vec![],
        remaining_bytes: Some(0),
    };
    stores.copy_object(&source(), &target).unwrap();
    stores.stores.push(open_store(&store).unwrap());
    stores.copy_object(&source(), &target).unwrap();
    stores.copy_object(&source(), &target).unwrap();
    assert!(!target.exists());
    stores.remaining_bytes = Some(MAX_REQUEST_BYTES);
    let mut short = File::open(&fixture).unwrap();
    short.seek(SeekFrom::Start(1)).unwrap();
    stores.copy_object(&short.into(), &target).unwrap();
    let digest = format!("{:x}", Sha512::digest(b"fixture bytes"));
    let shard = store.root.join(&digest[..2]);
    let object = shard.join(&digest[2..]);
    stores.copy_object(&source(), &target).unwrap();
    fs::create_dir(&shard).unwrap();
    symlink(&fixture, &object).unwrap();
    stores.copy_object(&source(), &target).unwrap();
    fs::remove_file(&object).unwrap();
    fs::write(&object, b"fixture bytes").unwrap();
    stores.copy_object(&source(), &target).unwrap();
    assert!(!target.exists());
    fs::remove_file(&object).unwrap();
    fs::hard_link(&fixture, &object).unwrap();
    fs::set_permissions(&fixture, fs::Permissions::from_mode(0o666)).unwrap();
    stores.copy_object(&source(), &target).unwrap();
    assert!(!target.exists());
    fs::set_permissions(&fixture, fs::Permissions::from_mode(0o644)).unwrap();
    stores.copy_object(&source(), &target).unwrap();
    fs::write(&fixture, b"later host change").unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"fixture bytes");
    fs::write(&fixture, b"fixture bytes").unwrap();
    assert_ne!(
        fs::metadata(&target).unwrap().ino(),
        fs::metadata(&fixture).unwrap().ino()
    );
    assert_eq!(fs::metadata(&target).unwrap().mode() & 0o777, 0o444);
    fs::remove_file(&target).unwrap();
    fs::set_permissions(&fixture, fs::Permissions::from_mode(0o755)).unwrap();
    fs::rename(&object, shard.join(format!("{}-exec", &digest[2..]))).unwrap();
    stores.copy_object(&source(), &target).unwrap();
    assert_eq!(fs::metadata(&target).unwrap().mode() & 0o777, 0o555);
    fs::remove_file(&target).unwrap();
    let large = File::create(&fixture).unwrap();
    large.set_len(MAX_OBJECT_BYTES + 1).unwrap();
    stores.copy_object(&source(), &target).unwrap();
    assert!(!target.exists());
}
