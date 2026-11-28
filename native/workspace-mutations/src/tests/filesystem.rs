use super::*;
use std::fs;
use std::os::unix::fs::symlink;
use tempfile::tempdir;

#[test]
fn rename_uses_already_open_parents_even_when_their_old_names_are_rebound() {
    let base = tempdir().unwrap();
    let root = base.path().canonicalize().unwrap();
    for path in ["from", "to", "elsewhere"] {
        fs::create_dir(root.join(path)).unwrap();
    }
    fs::write(root.join("from/source"), "pinned").unwrap();
    fs::write(root.join("elsewhere/source"), "different").unwrap();
    let fd = open(&root, DIRECTORY, Mode::empty()).unwrap();
    let (from, source) = open_parent(&fd, &["from", "source"]).unwrap();
    let (to, target) = open_parent(&fd, &["to", "target"]).unwrap();
    for dir in ["from", "to"] {
        fs::rename(root.join(dir), root.join(format!("saved-{dir}"))).unwrap();
        symlink(root.join("elsewhere"), root.join(dir)).unwrap();
    }
    rename_pinned(&from, source, &to, target).unwrap();
    assert_eq!(
        fs::read_to_string(root.join("saved-to/target")).unwrap(),
        "pinned"
    );
    assert_eq!(
        fs::read_to_string(root.join("elsewhere/source")).unwrap(),
        "different"
    );
    assert!(!root.join("elsewhere/target").exists());
}

#[test]
fn reports_exhausted_cleanup_limits_removed_parents_and_non_directory_failures() {
    let base = tempdir().unwrap();
    let root = base.path().canonicalize().unwrap();
    let fd = open(&root, DIRECTORY, Mode::empty()).unwrap();
    let mut empty = 0;
    let mut enough = 100;
    assert_eq!(
        remove_entry(&fd, c"missing", 0, &mut empty)
            .unwrap_err()
            .code,
        "INVALID_INPUT"
    );
    assert_eq!(
        remove_entry(&fd, c"missing", MAX_REMOVE_DEPTH + 1, &mut enough)
            .unwrap_err()
            .code,
        "INVALID_INPUT"
    );
    assert_eq!(
        remove_entry(&fd, &CString::new("x".repeat(300)).unwrap(), 0, &mut enough)
            .unwrap_err()
            .code,
        "OTHER"
    );
    fs::write(root.join("file"), "keep").unwrap();
    assert_eq!(
        unlink_if_present(&fd, c"file", AtFlags::REMOVEDIR)
            .unwrap_err()
            .code,
        "ENOTDIR"
    );
    unlink_if_present(&fd, c"missing", AtFlags::empty()).unwrap();
    fs::create_dir(root.join("vanishing")).unwrap();
    let removed = openat(&fd, "vanishing", DIRECTORY, Mode::empty()).unwrap();
    fs::remove_dir(root.join("vanishing")).unwrap();
    assert_eq!(
        open_directories(removed, &["new"], Some(Mode::RWXU))
            .unwrap_err()
            .code,
        "ENOENT"
    );
}

#[test]
fn rejects_changed_cleanup_identity_and_device() {
    let dir = tempdir().unwrap();
    let meta = fstat(open(dir.path(), DIRECTORY, Mode::empty()).unwrap()).unwrap();
    let mut changed = meta;
    changed.st_dev = changed.st_dev.wrapping_add(1);
    #[cfg(target_os = "macos")]
    assert_eq!(check_device(&meta, &changed).unwrap_err(), Errno::XDEV);
    assert_eq!(
        check_cleanup_identity(&meta, &changed).unwrap_err().code,
        "ESTALE"
    );
    let mut changed = meta;
    changed.st_ino = changed.st_ino.wrapping_add(1);
    assert_eq!(
        check_cleanup_identity(&meta, &changed).unwrap_err().code,
        "ESTALE"
    );
}

#[test]
fn returns_stable_error_codes_to_the_host() {
    for (errno, code) in [
        (Errno::NOENT, "ENOENT"),
        (Errno::EXIST, "EEXIST"),
        (Errno::NOTDIR, "ENOTDIR"),
        (Errno::LOOP, "ELOOP"),
        (Errno::NOTEMPTY, "ENOTEMPTY"),
        (Errno::ACCESS, "EACCES"),
        (Errno::PERM, "EACCES"),
        (Errno::STALE, "ESTALE"),
        (Errno::XDEV, "EXDEV"),
        (Errno::NOTSUP, "ENOTSUP"),
        (Errno::NOSYS, "ENOTSUP"),
        (Errno::IO, "OTHER"),
    ] {
        assert_eq!(Failure::from(errno).code, code);
    }
}

#[test]
fn accepts_a_trusted_filesystem_root_descriptor_without_mutating_it() {
    let stat = fstat(open("/", DIRECTORY, Mode::empty()).unwrap()).unwrap();
    let fd = open_root(
        "/",
        &Identity {
            device: stat.st_dev.to_string(),
            inode: stat.st_ino.to_string(),
        },
    )
    .unwrap();
    assert_eq!(fstat(fd).unwrap().st_ino, stat.st_ino);
}

#[test]
fn reports_stream_write_failures() {
    assert_eq!(
        Failure::from(std::io::Error::other("stream failure")).code,
        "EIO"
    );
}

#[test]
fn bounds_metadata_inspection_and_rejects_special_files() {
    let base = tempdir().unwrap();
    let fd = open(base.path(), DIRECTORY, Mode::empty()).unwrap();
    fs::write(base.path().join("different"), "fixture").unwrap();
    assert_eq!(
        inspect_metadata(
            &fd,
            c"different",
            true,
            0,
            &mut 1,
            Some((u32::MAX, u32::MAX))
        )
        .unwrap_err()
        .code,
        "ENOTSUP"
    );
    assert!(inspect_metadata(&fd, c"file", true, 0, &mut 0, None).is_err());
    assert!(inspect_metadata(&fd, c"file", true, MAX_REMOVE_DEPTH + 1, &mut 1, None).is_err());
    std::process::Command::new("mkfifo")
        .arg(base.path().join("fifo"))
        .status()
        .unwrap();
    assert!(inspect_metadata(&fd, c"fifo", true, 0, &mut 1, None).is_err());
}
