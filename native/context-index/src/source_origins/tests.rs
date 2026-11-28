use super::*;
use std::time::Duration;

#[test]
fn hashes_directory_creation_time_only_when_the_filesystem_supplies_it() {
    let mut hash = Sha256::new_with_prefix(b"directory identity");
    let mut expected = hash.clone();
    hash_creation_time(&mut hash, Err(io::ErrorKind::Unsupported.into())).unwrap();
    assert_eq!(hash.clone().finalize(), expected.clone().finalize());

    let nanos = 1_234_567_890;
    hash_creation_time(&mut hash, Ok(UNIX_EPOCH + Duration::from_nanos(nanos))).unwrap();
    expected.update(u128::from(nanos).to_le_bytes());
    assert_eq!(hash.finalize(), expected.finalize());
}

#[test]
fn discards_an_open_sources_fingerprint_when_its_parent_moves_after_canonicalization() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("rules");
    let moved = root.path().join("moved");
    fs::create_dir(&directory).unwrap();
    let source = directory.join("AGENTS.md");
    fs::write(&source, "guidance").unwrap();
    let file = fs::File::open(&source).unwrap();
    let device = file.metadata().unwrap().dev();
    let canonical = source.canonicalize().unwrap();
    let parent = canonical.parent().unwrap();
    let fingerprint = || source_fingerprint(&file, device, &canonical, parent, &mut HashMap::new());
    let original = fingerprint().unwrap();

    fs::rename(&directory, &moved).unwrap();
    assert_eq!(fingerprint().unwrap_err().kind(), io::ErrorKind::NotFound);
    fs::rename(&moved, &directory).unwrap();
    assert_eq!(fingerprint().unwrap(), original);
}
