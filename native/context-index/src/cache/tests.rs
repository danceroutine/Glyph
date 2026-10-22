use super::*;
use tempfile::tempdir;

#[test]
fn decoding_reports_an_io_fault_after_a_complete_record() {
    struct FailingEof(io::Cursor<Vec<u8>>);
    impl Read for FailingEof {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            if self.0.position() == self.0.get_ref().len() as u64 {
                return Err(io::Error::other("device unavailable"));
            }
            self.0.read(bytes)
        }
    }
    let mut bytes = Vec::new();
    encode(&mut bytes, "/project", &[7; 32], &["a.ts".into()], false).unwrap();
    assert_eq!(
        decode(FailingEof(io::Cursor::new(bytes)), "/project", &[7; 32], 10),
        Err("Could not finish reading the file-index cache: device unavailable".into())
    );
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CacheFault {
    Header,
    Metadata,
    Flush,
    Sync,
}

struct FaultyCacheFile<'a> {
    file: File,
    fault: CacheFault,
    operations: &'a std::cell::RefCell<Vec<&'static str>>,
}

struct FaultyCacheWriter<'a> {
    file: &'a FaultyCacheFile<'a>,
    written: usize,
}

impl Write for FaultyCacheWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let limit = match self.file.fault {
            CacheFault::Header => 0,
            CacheFault::Metadata => CACHE_MAGIC.len() + 32 + 4 + "/project".len(),
            _ => usize::MAX,
        };
        if self.written >= limit {
            return Err(io::Error::other("disk full"));
        }
        let size = bytes.len().min(limit - self.written);
        let written = (&self.file.file).write(&bytes[..size])?;
        self.written += written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.operations.borrow_mut().push("flush");
        if self.file.fault == CacheFault::Flush {
            Err(io::Error::other("disk full"))
        } else {
            (&self.file.file).flush()
        }
    }
}

impl PendingCacheFile for FaultyCacheFile<'_> {
    fn writer(&self) -> impl Write + '_ {
        FaultyCacheWriter {
            file: self,
            written: 0,
        }
    }

    fn synchronize(&self) -> io::Result<()> {
        self.operations.borrow_mut().push("sync");
        assert!(
            self.fault == CacheFault::Sync,
            "an earlier failure must prevent sync"
        );
        Err(io::Error::other("disk full"))
    }
}

#[test]
fn failed_cache_publications_preserve_the_previous_file_and_remove_the_temporary() {
    for (fault, message, expected_operations) in [
        (
            CacheFault::Header,
            "Could not write the file-index cache header: disk full",
            vec![],
        ),
        (
            CacheFault::Metadata,
            "Could not write the file-index cache metadata: disk full",
            vec![],
        ),
        (
            CacheFault::Flush,
            "Could not flush the file-index cache: disk full",
            vec!["flush"],
        ),
        (
            CacheFault::Sync,
            "Could not synchronize the file-index cache: disk full",
            vec!["flush", "sync"],
        ),
    ] {
        let directory = tempdir().unwrap();
        let path = directory.path().join("index.bin");
        fs::write(&path, b"previous cache").unwrap();
        let operations = std::cell::RefCell::new(Vec::new());
        let result = store_with_file(
            &path,
            "/project",
            &[7; 32],
            &["a.ts".into()],
            false,
            |temporary| {
                Ok(FaultyCacheFile {
                    file: create_file(temporary)?,
                    fault,
                    operations: &operations,
                })
            },
        );
        assert_eq!(result, Err(message.into()));
        assert_eq!(*operations.borrow(), expected_operations);
        assert_eq!(fs::read(&path).unwrap(), b"previous cache");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}

#[test]
fn cache_encoding_preserves_the_version_one_wire_format() {
    let mut bytes = Vec::new();
    encode(&mut bytes, "/project", &[7; 32], &["a.ts".into()], true).unwrap();
    let mut expected = b"HCTXIDX1".to_vec();
    expected.extend([7; 32]);
    expected.extend(8_u32.to_le_bytes());
    expected.extend(b"/project");
    expected.push(1);
    expected.extend(1_u64.to_le_bytes());
    expected.extend(4_u32.to_le_bytes());
    expected.extend(b"a.ts");
    assert_eq!(bytes, expected);
}

#[derive(Serialize)]
struct Policy<'a> {
    ignored: &'a [&'a str],
}

#[test]
fn cache_round_trips_sorted_paths() {
    let directory = tempdir().expect("temporary directory should exist");
    let path = directory.path().join("index.bin");
    let hash = policy_fingerprint(&Policy { ignored: &["dist"] }).expect("policy should hash");
    let paths = vec!["src/App.tsx".to_owned(), "src/main.ts".to_owned()];

    store(&path, "/project", &hash, &paths, false).expect("cache should write");
    let cached = load(&path, "/project", &hash, 100)
        .expect("cache should read")
        .expect("cache should match");

    assert_eq!(cached.paths, paths);
    assert!(!cached.truncated);
}

#[test]
fn cache_miss_when_policy_or_root_changes() {
    let directory = tempdir().expect("temporary directory should exist");
    let path = directory.path().join("index.bin");
    let first = policy_fingerprint(&Policy { ignored: &["dist"] }).expect("policy should hash");
    let second = policy_fingerprint(&Policy {
        ignored: &["build"],
    })
    .expect("policy should hash");
    store(
        &path,
        "/project",
        &first,
        &["src/main.ts".to_owned()],
        false,
    )
    .expect("cache should write");

    assert!(load(&path, "/other", &first, 100)
        .expect("cache should read")
        .is_none());
    assert!(load(&path, "/project", &second, 100)
        .expect("cache should read")
        .is_none());
}

#[test]
fn rejects_truncated_cache_data() {
    let directory = tempdir().expect("temporary directory should exist");
    let path = directory.path().join("index.bin");
    fs::write(&path, CACHE_MAGIC).expect("fixture should write");
    let hash = policy_fingerprint(&Policy { ignored: &[] }).expect("policy should hash");

    let error = load(&path, "/project", &hash, 100).expect_err("truncated cache should fail");

    assert!(error.contains("incomplete"));
}

fn encoded_string(value: &[u8]) -> Vec<u8> {
    let mut bytes = (value.len() as u32).to_le_bytes().to_vec();
    bytes.extend_from_slice(value);
    bytes
}

fn encoded_cache(hash: &[u8; 32], truncated: u8, count: u64, paths: &[&[u8]]) -> Vec<u8> {
    let mut bytes = CACHE_MAGIC.to_vec();
    bytes.extend_from_slice(hash);
    bytes.extend(encoded_string(b"/project"));
    bytes.push(truncated);
    bytes.extend_from_slice(&count.to_le_bytes());
    for path in paths {
        bytes.extend(encoded_string(path));
    }
    bytes
}

#[test]
fn rejects_corrupted_cache_contents() {
    let directory = tempdir().expect("temporary directory should exist");
    let path = directory.path().join("index.bin");
    let hash = policy_fingerprint(&Policy { ignored: &[] }).expect("policy should hash");
    let mut trailing = encoded_cache(&hash, 0, 1, &[b"src/main.ts"]);
    trailing.push(0);
    let mut empty_string = encoded_cache(&hash, 0, 1, &[]);
    empty_string.extend_from_slice(&0_u32.to_le_bytes());
    let cases: [(Vec<u8>, &str); 8] = [
        (b"NOTCACHE".to_vec(), "unsupported format"),
        (encoded_cache(&hash, 2, 0, &[]), "invalid truncated flag"),
        (encoded_cache(&hash, 0, 101, &[]), "too many paths"),
        (
            encoded_cache(&hash, 0, 1, &[b"../outside"]),
            "invalid project path",
        ),
        (
            encoded_cache(&hash, 0, 2, &[b"b.ts", b"a.ts"]),
            "not strictly sorted",
        ),
        (trailing, "trailing data"),
        (empty_string, "invalid string length"),
        (encoded_cache(&hash, 0, 1, &[b"\xff"]), "not UTF-8"),
    ];

    for (contents, expected) in cases {
        fs::write(&path, contents).expect("fixture should write");

        let error = load(&path, "/project", &hash, 100).expect_err("corrupt cache should fail");

        assert!(error.contains(expected), "{error}");
    }
}

#[test]
fn loads_truncated_caches_and_reports_unreadable_cache_locations() {
    let directory = tempdir().expect("temporary directory should exist");
    let path = directory.path().join("index.bin");
    let hash = policy_fingerprint(&Policy { ignored: &[] }).expect("policy should hash");
    fs::write(&path, encoded_cache(&hash, 1, 1, &[b"src/main.ts"])).expect("fixture");
    let blocked = path.join("nested.bin");

    let cached = load(&path, "/project", &hash, 100).expect("cache should read");
    let error = load(&blocked, "/project", &hash, 100).expect_err("open should fail");

    assert_eq!(
        cached,
        Some(CachedPaths {
            paths: vec!["src/main.ts".to_owned()],
            truncated: true,
        })
    );
    assert!(error.starts_with("Could not open the file-index cache:"));
    assert_eq!(
        load(
            &directory.path().join("missing.bin"),
            "/project",
            &hash,
            100
        ),
        Ok(None)
    );
}

#[test]
fn reports_policies_that_cannot_be_encoded() {
    let policy = std::collections::BTreeMap::from([((1_u8, 2_u8), 3_u8)]);

    let error = policy_fingerprint(&policy).expect_err("tuple keys are not JSON");

    assert!(error.starts_with("Could not encode the file-index policy:"));
}

#[test]
fn reports_cache_locations_that_cannot_be_written() {
    let directory = tempdir().expect("temporary directory should exist");
    let hash = policy_fingerprint(&Policy { ignored: &[] }).expect("policy should hash");
    let paths = ["src/main.ts".to_owned()];
    let file = directory.path().join("file");
    fs::write(&file, "fixture").expect("fixture should write");
    let occupied = directory.path().join("occupied");
    fs::create_dir_all(occupied.join("child")).expect("fixture directory should exist");
    let long_name = directory.path().join("n".repeat(240));

    let without_parent = store(Path::new("/"), "/project", &hash, &paths, false);
    let under_file = store(&file.join("index.bin"), "/project", &hash, &paths, false);
    let long_temporary = store(&long_name, "/project", &hash, &paths, false);
    let over_directory = store(&occupied, "/project", &hash, &paths, false);
    let empty_root = store(
        &directory.path().join("empty.bin"),
        "",
        &hash,
        &paths,
        false,
    );

    assert_eq!(
        without_parent,
        Err("The file-index cache path has no parent directory.".to_owned())
    );
    assert!(under_file
        .expect_err("parent is a file")
        .starts_with("Could not create the file-index cache directory:"));
    assert!(long_temporary
        .expect_err("temporary name is too long")
        .starts_with("Could not create a temporary file-index cache:"));
    assert!(over_directory
        .expect_err("destination is a directory")
        .starts_with("Could not install the file-index cache:"));
    assert_eq!(
        empty_root,
        Err("A file-index cache string has an unsupported length.".to_owned())
    );
    let mut leftovers = fs::read_dir(directory.path())
        .expect("directory should list")
        .map(|entry| entry.expect("entry should read").file_name())
        .collect::<Vec<_>>();
    leftovers.sort();
    assert_eq!(leftovers, ["file", "occupied"]);
}

#[test]
fn replacing_a_file_fails_when_the_source_is_missing() {
    let directory = tempdir().expect("temporary directory should exist");

    let result = replace_file(
        &directory.path().join("missing"),
        &directory.path().join("destination"),
    );

    assert_eq!(
        result.map_err(|error| error.kind()),
        Err(io::ErrorKind::NotFound)
    );
}

#[cfg(target_os = "macos")]
#[test]
fn replacing_a_file_retries_after_removing_a_destination_it_could_not_overwrite() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let directory = tempdir().expect("temporary directory should exist");
    let source = directory.path().join("source");
    let destination = directory.path().join("destination");
    fs::write(&source, "replacement").expect("source should write");
    fs::write(&destination, "previous").expect("destination should write");
    let source_name = CString::new(source.as_os_str().as_bytes()).expect("path is C text");
    assert_eq!(
        unsafe { libc::chflags(source_name.as_ptr(), libc::UF_IMMUTABLE as _) },
        0
    );

    let result = replace_file(&source, &destination);

    assert_eq!(unsafe { libc::chflags(source_name.as_ptr(), 0) }, 0);
    assert_eq!(
        result.map_err(|error| error.kind()),
        Err(io::ErrorKind::PermissionDenied)
    );
    assert!(!destination.exists());
    assert_eq!(fs::read_to_string(&source).unwrap(), "replacement");
}

#[test]
fn replacement_retries_only_after_removing_an_existing_destination() {
    for kind in [
        io::ErrorKind::AlreadyExists,
        io::ErrorKind::PermissionDenied,
    ] {
        for retry_succeeds in [true, false] {
            let directory = tempdir().unwrap();
            let source = directory.path().join("source");
            let destination = directory.path().join("destination");
            fs::write(&source, "replacement").unwrap();
            fs::write(&destination, "previous").unwrap();
            let mut calls = 0;
            let result = replace_file_with_rename(&source, &destination, |from, to| {
                assert_eq!(from, source);
                assert_eq!(to, destination);
                calls += 1;
                if calls == 1 {
                    assert_eq!(fs::read_to_string(to).unwrap(), "previous");
                    return Err(io::Error::from(kind));
                }
                assert!(!to.exists());
                if retry_succeeds {
                    fs::rename(from, to)
                } else {
                    Err(io::Error::from(io::ErrorKind::PermissionDenied))
                }
            });
            assert_eq!(calls, 2);
            if retry_succeeds {
                assert!(result.is_ok());
                assert_eq!(fs::read_to_string(destination).unwrap(), "replacement");
                assert!(!source.exists());
            } else {
                assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
                assert!(!destination.exists());
                assert_eq!(fs::read_to_string(source).unwrap(), "replacement");
            }
        }
    }
}

#[test]
fn replacement_does_not_retry_if_the_destination_cannot_be_removed() {
    let directory = tempdir().unwrap();
    let source = directory.path().join("source");
    let destination = directory.path().join("destination");
    fs::write(&source, "replacement").unwrap();
    fs::create_dir(&destination).unwrap();
    let mut calls = 0;

    let result = replace_file_with_rename(&source, &destination, |_, _| {
        calls += 1;
        Err(io::Error::from(io::ErrorKind::AlreadyExists))
    });

    assert!(result.is_err());
    assert_eq!(calls, 1);
    assert!(destination.is_dir());
    assert_eq!(fs::read_to_string(source).unwrap(), "replacement");
}

#[test]
fn reports_cache_strings_that_cannot_be_written() {
    let mut storage = [0_u8; 2];
    let mut writer = &mut storage[..];

    let error = write_string(&mut writer, "src/main.ts").expect_err("the writer is too small");

    assert!(error.starts_with("Could not write the file-index cache:"));
}

struct ScriptedReader {
    bytes: io::Cursor<Vec<u8>>,
    fail_at_end: bool,
}

impl Read for ScriptedReader {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        if self.fail_at_end && self.bytes.position() == self.bytes.get_ref().len() as u64 {
            return Err(io::Error::other("device unavailable"));
        }
        self.bytes.read(bytes)
    }
}

#[test]
fn decoding_classifies_every_record_outcome_from_any_byte_source() {
    let hash = [7_u8; 32];
    let mut trailing = encoded_cache(&hash, 0, 1, &[b"a.ts"]);
    trailing.push(0);
    let mut foreign_root = CACHE_MAGIC.to_vec();
    foreign_root.extend_from_slice(&hash);
    foreign_root.extend(encoded_string(b"/elsewhere"));
    type Case = (Vec<u8>, bool, Result<Option<CachedPaths>, String>);
    let cases: [Case; 11] = [
        (
            encoded_cache(&hash, 1, 2, &[b"a.ts", b"b.ts"]),
            false,
            Ok(Some(CachedPaths {
                paths: vec!["a.ts".to_owned(), "b.ts".to_owned()],
                truncated: true,
            })),
        ),
        (
            b"HCTX".to_vec(),
            false,
            Err("The file-index cache is incomplete: failed to fill whole buffer".to_owned()),
        ),
        (
            b"NOTCACHE".to_vec(),
            false,
            Err("The file-index cache has an unsupported format.".to_owned()),
        ),
        (encoded_cache(&[8; 32], 0, 0, &[]), false, Ok(None)),
        (foreign_root, false, Ok(None)),
        (
            encoded_cache(&hash, 2, 0, &[]),
            false,
            Err("The file-index cache contains an invalid truncated flag.".to_owned()),
        ),
        (
            encoded_cache(&hash, 0, 11, &[]),
            false,
            Err("The file-index cache contains too many paths.".to_owned()),
        ),
        (
            encoded_cache(&hash, 0, 1, &[b"../a.ts"]),
            false,
            Err("The file-index cache contains an invalid project path.".to_owned()),
        ),
        (
            encoded_cache(&hash, 0, 2, &[b"b.ts", b"a.ts"]),
            false,
            Err("The file-index cache paths are not strictly sorted.".to_owned()),
        ),
        (
            trailing,
            false,
            Err("The file-index cache contains trailing data.".to_owned()),
        ),
        (
            encoded_cache(&hash, 0, 1, &[b"a.ts"]),
            true,
            Err("Could not finish reading the file-index cache: device unavailable".to_owned()),
        ),
    ];

    for (bytes, fail_at_end, expected) in cases {
        let reader = ScriptedReader {
            bytes: io::Cursor::new(bytes),
            fail_at_end,
        };

        assert_eq!(decode(reader, "/project", &hash, 10), expected);
    }
}
