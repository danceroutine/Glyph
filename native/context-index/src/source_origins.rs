//! Collect descriptor identities and parent-route fingerprints for a catalog's disclosure batch.
use glyph_filesystem_metadata::workspace_paths::WorkspacePaths;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(test)]
mod tests;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    paths: Vec<PathBuf>,
    private_paths: Vec<PathBuf>,
    #[serde(default)]
    allow_unavailable: bool,
    #[serde(default)]
    directories: bool,
}

#[derive(Serialize)]
struct SourceOrigin {
    identity: String,
    origin: String,
}

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Instruction source location changed or is unavailable.",
    )
}

fn mount_identity(file: &fs::File, hash: &mut Sha256) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let info = fs::read_to_string(format!("/proc/self/fdinfo/{}", file.as_raw_fd()))?;
        let mount = info
            .lines()
            .find_map(|line| line.strip_prefix("mnt_id:"))
            .ok_or_else(denied)?;
        hash.update(
            mount
                .trim()
                .parse::<u64>()
                .map_err(io::Error::other)?
                .to_le_bytes(),
        );
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (file, hash);
    Ok(())
}

fn directory_origin(path: &Path, cache: &mut HashMap<PathBuf, [u8; 32]>) -> io::Result<[u8; 32]> {
    if let Some(origin) = cache.get(path) {
        return Ok(*origin);
    }
    let mut hash = Sha256::new();
    if let Some(parent) = path.parent() {
        hash.update(directory_origin(parent, cache)?);
    }
    #[cfg(target_os = "linux")]
    let directory = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_DIRECTORY)
        .open(path)?;
    #[cfg(target_os = "linux")]
    let meta = directory.metadata()?;
    #[cfg(not(target_os = "linux"))]
    let meta = fs::metadata(path)?;
    hash.update(meta.dev().to_le_bytes());
    hash.update(meta.ino().to_le_bytes());
    hash_creation_time(&mut hash, meta.created())?;
    #[cfg(target_os = "linux")]
    mount_identity(&directory, &mut hash)?;
    let origin = hash.finalize().into();
    cache.insert(path.to_owned(), origin);
    Ok(origin)
}

/// Birth time distinguishes recycled directory inodes on filesystems that expose it.
fn hash_creation_time(hash: &mut Sha256, created: io::Result<SystemTime>) -> io::Result<()> {
    if let Ok(created) = created {
        let time = created
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?;
        hash.update(time.as_nanos().to_le_bytes());
    }
    Ok(())
}

/// Bind the open file's device and mount to its admitted route. An ancestor that disappears
/// after canonicalization invalidates the fingerprint even while the file remains open.
fn source_fingerprint(
    file: &fs::File,
    device: u64,
    canonical: &Path,
    directory: &Path,
    directories: &mut HashMap<PathBuf, [u8; 32]>,
) -> io::Result<String> {
    let mut hash = Sha256::new_with_prefix(directory_origin(directory, directories)?);
    hash.update(device.to_le_bytes());
    mount_identity(file, &mut hash)?;
    hash.update(canonical.as_os_str().as_encoded_bytes());
    Ok(format!("{:x}", hash.finalize()))
}

fn inspect_path(
    path: &Path,
    authority: &WorkspacePaths,
    directories: &mut HashMap<PathBuf, [u8; 32]>,
    inspect_directory: bool,
) -> io::Result<SourceOrigin> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    let admitted = if inspect_directory {
        meta.is_dir()
    } else {
        meta.is_file() && meta.nlink() == 1
    };
    if !admitted {
        return Err(denied());
    }
    let (dev, ino) = (meta.dev().to_string(), meta.ino().to_string());
    authority.assert_batch_path(path, Some((&dev, &ino)))?;
    let canonical = fs::canonicalize(path)?;
    let directory = if inspect_directory {
        canonical.as_path()
    } else {
        canonical.parent().ok_or_else(denied)?
    };
    let origin = source_fingerprint(&file, meta.dev(), &canonical, directory, directories)?;
    Ok(SourceOrigin {
        identity: format!("{dev}:{ino}"),
        origin,
    })
}

pub fn inspect() -> io::Result<()> {
    let req: Request = serde_json::from_reader(io::stdin().lock())?;
    let authority = WorkspacePaths::current(&req.private_paths)?;
    let mut directories = HashMap::new();
    let mut sources = Vec::with_capacity(req.paths.len());
    for path in req.paths {
        let origin = inspect_path(&path, &authority, &mut directories, req.directories);
        sources.push(if req.allow_unavailable {
            origin.ok()
        } else {
            Some(origin?)
        });
    }
    authority.finish_batch()?;
    serde_json::to_writer(io::stdout().lock(), &sources)?;
    Ok(())
}

/// Runs only in the short-lived inspector process. An unlinked APFS directory can retain nlink=2, but
/// a current working directory has no physical pathname after unlink. A renamed directory still has one.
pub fn assert_unlinked_directory() -> io::Result<()> {
    // SAFETY: fchdir accepts a borrowed integer descriptor and returns a status without retaining memory.
    if unsafe { libc::fchdir(libc::STDIN_FILENO) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if !std::env::current_dir().is_err_and(|error| error.kind() == io::ErrorKind::NotFound) {
        return Err(denied());
    }
    println!("verified");
    Ok(())
}
