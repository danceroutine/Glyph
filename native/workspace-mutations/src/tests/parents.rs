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
    fchmod(&root, Mode::from_raw_mode(0o750)).unwrap();
    apply_permissions(&root, group).unwrap();
    assert_eq!(fstat(&root).unwrap().st_mode & 0o7777, 0o750);
    // An unprivileged process can inherit a supplementary group. A prohibited group stops publication.
    let other = group + 1;
    match apply_permissions(&root, other) {
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
fn observes_the_filesystems_creation_group_without_leaving_a_directory_entry() {
    let temp = tempdir().unwrap();
    let parent = open(temp.path(), DIRECTORY, Mode::empty()).unwrap();
    let group = fstat(&parent).unwrap().st_gid;
    mkdirat(&parent, c"control", Mode::RWXU).unwrap();
    let control = open_child(&parent, "control", DIRECTORY, Mode::empty()).unwrap();
    let expected = fstat(&control).unwrap().st_gid;

    // A single-group test runner can still exercise both inheritance decisions.
    assert_eq!(creation_group(&parent, group).unwrap(), group);
    assert_eq!(creation_group(&parent, group ^ 1).unwrap(), expected);
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
}

#[cfg(target_os = "linux")]
#[test]
fn requires_an_observed_group_only_when_the_parent_and_caller_groups_differ() {
    // procfs supplies directory metadata but cannot create an anonymous file.
    let parent = open("/proc", DIRECTORY, Mode::empty()).unwrap();
    let group = fstat(&parent).unwrap().st_gid;
    assert_eq!(creation_group(&parent, group).unwrap(), group);
    assert!(creation_group(&parent, group ^ 1).is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn rejects_setgid_destination_metadata_before_changing_the_staged_directory() {
    let temp = tempdir().unwrap();
    let stage = open(temp.path(), DIRECTORY, Mode::empty()).unwrap();
    for name in ["incoming", "destination"] {
        fs::create_dir(temp.path().join(name)).unwrap();
    }
    let incoming = open_child(&stage, "incoming", DIRECTORY, Mode::empty()).unwrap();
    let parent = open_child(&stage, "destination", DIRECTORY, Mode::empty()).unwrap();
    fchmod(&incoming, Mode::from_raw_mode(0o750)).unwrap();
    fchmod(&parent, Mode::from_raw_mode(0o2700)).unwrap();

    let error = inherit_permissions(&stage, "incoming", &parent).unwrap_err();
    assert_eq!(error.code, "ENOTSUP");
    assert_eq!(fstat(&incoming).unwrap().st_mode & 0o7777, 0o750);

    fchmod(&parent, Mode::from_raw_mode(0o700)).unwrap();
    inherit_permissions(&stage, "incoming", &parent).unwrap();
    let staged = fstat(&incoming).unwrap();
    assert_eq!(staged.st_gid, rustix::process::getegid().as_raw());
    assert_eq!(staged.st_mode & 0o7777, 0o750);
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
