use super::*;
use std::fs;
use tempfile::tempdir;

#[test]
fn preserves_concurrent_directory_claims_and_reports_other_filesystem_errors() {
    let temp = tempdir().unwrap();
    let root = open(temp.path(), DIRECTORY, Mode::empty()).unwrap();
    assert!(!claim(&root, "already-moved", &root, "slot").unwrap());
    fs::create_dir(temp.path().join("slot")).unwrap();
    fs::write(temp.path().join("slot/note"), b"keep").unwrap();
    fs::create_dir(temp.path().join("peer")).unwrap();
    assert_eq!(
        claim(&root, "peer", &root, "slot").unwrap_err().code,
        "EEXIST"
    );
    assert!(!remove_empty(&root, "slot").unwrap());
    assert_eq!(remove_empty(&root, "missing").unwrap_err().code, "ENOENT");
    assert_eq!(
        optional::<()>(Err(Errno::ACCESS)).unwrap_err().code,
        "EACCES"
    );
}

#[test]
fn carries_directory_group_and_permissions_through_staging() {
    let temp = tempdir().unwrap();
    let root = open(temp.path(), DIRECTORY, Mode::empty()).unwrap();
    let group = fstat(&root).unwrap().st_gid;
    apply_permissions(&root, group, true).unwrap();
    assert_ne!(fstat(&root).unwrap().st_mode & 0o2000, 0);
    // An unprivileged process can inherit a supplementary group. A prohibited group stops publication.
    let other = group + 1;
    match apply_permissions(&root, other, false) {
        Ok(()) => assert_eq!(fstat(&root).unwrap().st_gid, other),
        Err(error) => assert_eq!(error.code, "EACCES"),
    }
}

#[test]
fn restores_a_directory_populated_after_the_exclusive_claim_to_its_original_parent() {
    let temp = tempdir().unwrap();
    let root = open(temp.path(), DIRECTORY, Mode::empty()).unwrap();
    fs::create_dir(temp.path().join("skills")).unwrap();
    let original = open_child(&root, "skills", DIRECTORY, Mode::empty()).unwrap();
    let receipt = identity(&original).unwrap();
    let destination = open_parent(&root, &["skills"]).unwrap();
    assert!(claim(&destination.0, destination.1, &root, "slot").unwrap());
    fs::write(temp.path().join("slot/notes"), b"concurrent").unwrap();
    finish_claim(
        &root,
        &["skills"],
        Some(destination),
        &root,
        "slot",
        &receipt,
    )
    .unwrap();
    assert_eq!(
        fs::read(temp.path().join("skills/notes")).unwrap(),
        b"concurrent"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn declines_to_publish_a_directory_without_a_stable_registration_identity() {
    use rustix::fs::{statx, StatxFlags};
    let temp = tempdir().unwrap();
    let root = open(temp.path(), DIRECTORY, Mode::empty()).unwrap();
    let mut info = statx(&root, "", AtFlags::EMPTY_PATH, StatxFlags::BTIME).unwrap();
    info.stx_mask &= !StatxFlags::BTIME.bits();
    assert_eq!(birth_time(info).unwrap_err().code, "ENOTSUP");
}
