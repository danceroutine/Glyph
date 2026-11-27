//! Admit immutable private copies only when a trusted content address identifies the same inode.
use super::{ContentStore, ContentStoreLayout, SandboxRequest};
use rustix::fd::OwnedFd;
use rustix::fs::{fstat, open, openat, FileType, Mode, OFlags, Stat};
use rustix::process::getuid;
use sha2::{Digest, Sha512};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

const MAX_OBJECT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES: u64 = 2 * 1024 * 1024 * 1024;

struct OpenedStore {
    root: PathBuf,
    directory: File,
    executable_suffix: String,
}

pub(super) struct VerifiedStores {
    stores: Vec<OpenedStore>,
    remaining_bytes: Option<u64>,
}

impl VerifiedStores {
    pub(super) fn open(request: &SandboxRequest) -> Self {
        let stores = request
            .content_stores
            .iter()
            .filter_map(|store| {
                let excluded = request
                    .workspace_roots
                    .iter()
                    .chain(&request.private_paths)
                    .chain(&request.protected_paths)
                    .chain([&request.state_directory]);
                if excluded
                    .into_iter()
                    .any(|path| path.starts_with(&store.root) || store.root.starts_with(path))
                    || super::private_component(&store.root)
                    || store.root.ancestors().any(super::managed_directory)
                {
                    return None;
                }
                open_store(store)
            })
            .collect();
        Self {
            stores,
            remaining_bytes: Some(MAX_REQUEST_BYTES),
        }
    }

    /// Host ownership was checked before user IDs were mapped into the new namespace.
    /// Keep that exact inode only when the frozen mount layout still admits its path.
    pub(super) fn retain_admitted(&mut self, request: &SandboxRequest) {
        self.stores.retain(|store| {
            request
                .content_stores
                .iter()
                .any(|allowed| allowed.root == store.root)
                && store.directory.metadata().is_ok_and(|before| {
                    std::fs::symlink_metadata(&store.root)
                        .is_ok_and(|now| now.dev() == before.dev() && now.ino() == before.ino())
                })
        });
    }

    pub(super) fn copy_object(&mut self, candidate: &OwnedFd, target: &Path) -> io::Result<()> {
        if self.stores.is_empty() {
            return Ok(());
        }
        let source = fstat(candidate)?;
        if !trusted_entry(&source) || source.st_size as u64 > MAX_OBJECT_BYTES {
            return Ok(());
        }
        let length = source.st_size as u64;
        // Charge the bounded read even when the candidate has no trusted object.
        let Some(previous) = self.remaining_bytes else {
            return Ok(());
        };
        self.remaining_bytes = previous.checked_sub(length + 1);
        if self.remaining_bytes.is_none() {
            eprintln!("glyph-shell-sandbox: additional dependency hard links were omitted after the verification byte limit.");
            return Ok(());
        }
        let mut bytes = Vec::new();
        File::from(rustix::io::dup(candidate)?)
            .take(length + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 != length {
            return Ok(());
        }
        let digest = format!("{:x}", Sha512::digest(&bytes));
        let (shard, name) = digest.split_at(2);
        let executable = source.st_mode & 0o111 != 0;
        for store in &self.stores {
            let suffix = &store.executable_suffix;
            let filename = if executable {
                format!("{name}{suffix}")
            } else {
                name.to_owned()
            };
            if trusted_object(&store.directory, shard, &filename, &source) {
                // The mount namespace owns this tmpfs. Its root is sealed read-only before launch.
                let mut copy = File::create_new(target)?;
                copy.write_all(&bytes)?;
                let mode = if executable { 0o555 } else { 0o444 };
                copy.set_permissions(std::fs::Permissions::from_mode(mode))?;
                break;
            }
        }
        Ok(())
    }
}

fn trusted_entry(stat: &Stat) -> bool {
    stat.st_uid == getuid().as_raw() && stat.st_mode & 0o022 == 0
}

fn trusted_object(store: &File, shard: &str, filename: &str, source: &Stat) -> bool {
    let Some(directory) = openat(store, shard, directory_flags(), Mode::empty())
        .ok()
        .filter(|dir| fstat(dir).is_ok_and(|stat| trusted_entry(&stat)))
    else {
        return false;
    };
    let flags = OFlags::RDONLY | OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    openat(directory, filename, flags, Mode::empty())
        .and_then(fstat)
        .is_ok_and(|stat| {
            FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile
                && trusted_entry(&stat)
                && stat.st_dev == source.st_dev
                && stat.st_ino == source.st_ino
        })
}

fn directory_flags() -> OFlags {
    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC
}

fn open_store(store: &ContentStore) -> Option<OpenedStore> {
    let ContentStoreLayout::Sha512Prefix2 = store.layout;
    if !store.root.is_absolute()
        || store.executable_suffix.len() > 32
        || !store
            .executable_suffix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return None;
    }
    let mut dir = open("/", directory_flags(), Mode::empty()).ok()?;
    for component in store.root.components().skip(1) {
        let Component::Normal(name) = component else {
            return None;
        };
        dir = openat(dir, name, directory_flags(), Mode::empty()).ok()?;
        // A root-owned sticky directory can host independent user-owned store directories.
        let stat = fstat(&dir).ok()?;
        let trusted_owner = stat.st_uid == 0 || stat.st_uid == getuid().as_raw();
        if !trusted_owner
            || (stat.st_mode & 0o022 != 0 && !(stat.st_uid == 0 && stat.st_mode & 0o1000 != 0))
        {
            return None;
        }
    }
    trusted_entry(&fstat(&dir).ok()?).then(|| OpenedStore {
        root: store.root.clone(),
        directory: dir.into(),
        executable_suffix: store.executable_suffix.clone(),
    })
}

#[cfg(test)]
#[path = "content_store_tests.rs"]
mod tests;
