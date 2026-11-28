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
