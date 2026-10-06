use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};

const CACHE_MAGIC: &[u8; 8] = b"HCTXIDX1";
const MAX_CACHED_PATH_BYTES: usize = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CachedPaths {
    pub(crate) paths: Vec<String>,
    pub(crate) truncated: bool,
}

pub(crate) fn policy_fingerprint<T: Serialize>(policy: &T) -> Result<[u8; 32], String> {
    let encoded = serde_json::to_vec(policy)
        .map_err(|error| format!("Could not encode the file-index policy: {error}"))?;
    Ok(Sha256::digest(encoded).into())
}

pub(crate) fn load(
    cache_path: &Path,
    canonical_root: &str,
    policy_hash: &[u8; 32],
    max_files: usize,
) -> Result<Option<CachedPaths>, String> {
    let file = match File::open(cache_path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not open the file-index cache: {error}")),
    };
    let mut reader = BufReader::new(file);

    let mut magic = [0_u8; CACHE_MAGIC.len()];
    read_exact(&mut reader, &mut magic)?;
    if &magic != CACHE_MAGIC {
        return Err("The file-index cache has an unsupported format.".to_owned());
    }

    let mut actual_policy_hash = [0_u8; 32];
    read_exact(&mut reader, &mut actual_policy_hash)?;
    if &actual_policy_hash != policy_hash {
        return Ok(None);
    }

    let root = read_string(&mut reader)?;
    if root != canonical_root {
        return Ok(None);
    }

    let mut truncated = [0_u8; 1];
    read_exact(&mut reader, &mut truncated)?;
    if truncated[0] > 1 {
        return Err("The file-index cache contains an invalid truncated flag.".to_owned());
    }

    let count = read_u64(&mut reader)?;
    if count > max_files as u64 || count > u32::MAX as u64 {
        return Err("The file-index cache contains too many paths.".to_owned());
    }

    let mut paths = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let path = read_string(&mut reader)?;
        if !is_normalized_relative_path(&path) {
            return Err("The file-index cache contains an invalid project path.".to_owned());
        }
        if paths.last().is_some_and(|previous| previous >= &path) {
            return Err("The file-index cache paths are not strictly sorted.".to_owned());
        }
        paths.push(path);
    }

    let mut trailing = [0_u8; 1];
    match reader.read(&mut trailing) {
        Ok(0) => {}
        Ok(_) => return Err("The file-index cache contains trailing data.".to_owned()),
        Err(error) => {
            return Err(format!(
                "Could not finish reading the file-index cache: {error}"
            ))
        }
    }

    Ok(Some(CachedPaths {
        paths,
        truncated: truncated[0] == 1,
    }))
}

pub(crate) fn store(
    cache_path: &Path,
    canonical_root: &str,
    policy_hash: &[u8; 32],
    paths: &[String],
    truncated: bool,
) -> Result<(), String> {
    let parent = cache_path
        .parent()
        .ok_or_else(|| "The file-index cache path has no parent directory.".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the file-index cache directory: {error}"))?;

    let temporary = temporary_path(cache_path);
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(&temporary)
        .map_err(|error| format!("Could not create a temporary file-index cache: {error}"))?;

    let result = (|| -> Result<(), String> {
        let mut writer = BufWriter::new(&file);
        writer
            .write_all(CACHE_MAGIC)
            .and_then(|_| writer.write_all(policy_hash))
            .map_err(|error| format!("Could not write the file-index cache header: {error}"))?;
        write_string(&mut writer, canonical_root)?;
        writer
            .write_all(&[u8::from(truncated)])
            .and_then(|_| writer.write_all(&(paths.len() as u64).to_le_bytes()))
            .map_err(|error| format!("Could not write the file-index cache metadata: {error}"))?;
        for path in paths {
            write_string(&mut writer, path)?;
        }
        writer
            .flush()
            .map_err(|error| format!("Could not flush the file-index cache: {error}"))?;
        drop(writer);
        file.sync_all()
            .map_err(|error| format!("Could not synchronize the file-index cache: {error}"))?;

        replace_file(&temporary, cache_path)
            .map_err(|error| format!("Could not install the file-index cache: {error}"))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_exact(reader: &mut impl Read, bytes: &mut [u8]) -> Result<(), String> {
    reader
        .read_exact(bytes)
        .map_err(|error| format!("The file-index cache is incomplete: {error}"))
}

fn read_u32(reader: &mut impl Read) -> Result<u32, String> {
    let mut bytes = [0_u8; 4];
    read_exact(reader, &mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_u64(reader: &mut impl Read) -> Result<u64, String> {
    let mut bytes = [0_u8; 8];
    read_exact(reader, &mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}

fn read_string(reader: &mut impl Read) -> Result<String, String> {
    let length = read_u32(reader)? as usize;
    if length == 0 || length > MAX_CACHED_PATH_BYTES {
        return Err("The file-index cache contains an invalid string length.".to_owned());
    }
    let mut bytes = vec![0_u8; length];
    read_exact(reader, &mut bytes)?;
    String::from_utf8(bytes)
        .map_err(|_| "The file-index cache contains text that is not UTF-8.".to_owned())
}

fn write_string(writer: &mut impl Write, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_CACHED_PATH_BYTES || value.len() > u32::MAX as usize {
        return Err("A file-index cache string has an unsupported length.".to_owned());
    }
    writer
        .write_all(&(value.len() as u32).to_le_bytes())
        .and_then(|_| writer.write_all(value.as_bytes()))
        .map_err(|error| format!("Could not write the file-index cache: {error}"))
}

fn is_normalized_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains('\0')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn temporary_path(cache_path: &Path) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let name = cache_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("context-index");
    cache_path.with_file_name(format!(".{name}.{}.{}.tmp", std::process::id(), timestamp))
}

fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(error)
            if destination.exists()
                && matches!(
                    error.kind(),
                    io::ErrorKind::AlreadyExists | io::ErrorKind::PermissionDenied
                ) =>
        {
            fs::remove_file(destination)?;
            fs::rename(source, destination)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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
}
