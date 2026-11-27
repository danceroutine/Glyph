use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

struct Mount<'a> {
    device: &'a [u8],
    root: PathBuf,
    point: PathBuf,
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid Linux mount table")
}

// The kernel escapes tabs, newlines, spaces and backslashes in the two pathname fields.
fn mount_path(raw: &[u8]) -> io::Result<PathBuf> {
    let mut decoded = Vec::with_capacity(raw.len());
    let mut remaining = raw;
    while let Some((&byte, tail)) = remaining.split_first() {
        if byte == b'\\' {
            let (escaped, rest) = tail.split_at_checked(3).ok_or_else(invalid)?;
            decoded.push(match escaped {
                b"011" => b'\t',
                b"012" => b'\n',
                b"040" => b' ',
                b"134" => b'\\',
                _ => return Err(invalid()),
            });
            remaining = rest;
        } else {
            decoded.push(byte);
            remaining = tail;
        }
    }
    let path = Path::new(OsStr::from_bytes(&decoded));
    if !path.is_absolute() {
        return Err(invalid());
    }
    Ok(path.to_owned())
}

fn records(input: &[u8]) -> io::Result<Vec<Mount<'_>>> {
    input
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut fields = line.split(|byte| *byte == b' ');
            let device = fields.nth(2).ok_or_else(invalid)?;
            let root = mount_path(fields.next().ok_or_else(invalid)?)?;
            let point = mount_path(fields.next().ok_or_else(invalid)?)?;
            Ok(Mount {
                device,
                root,
                point,
            })
        })
        .collect()
}

/// The kernel's view of filesystem roots and their mount points in the current namespace.
pub struct MountTable<'a>(Vec<Mount<'a>>);

impl<'a> MountTable<'a> {
    pub fn parse(input: &'a [u8]) -> io::Result<Self> {
        let mounts = records(input)?;
        if !mounts.iter().any(|entry| entry.point == Path::new("/")) {
            return Err(invalid());
        }
        Ok(Self(mounts))
    }

    pub fn locations(&self) -> impl Iterator<Item = (&Path, &Path)> {
        self.0
            .iter()
            .map(|mount| (mount.root.as_path(), mount.point.as_path()))
    }

    /// Map a namespace pathname to its filesystem-relative backing location, then back through
    /// each mount of that filesystem. Overmounted records at the same depth are handled conservatively.
    pub fn aliases(&self, path: &Path, descendants: bool, output: &mut BTreeSet<PathBuf>) {
        self.aliases_on_device(path, descendants, output);
        if descendants {
            // A separate filesystem can be mounted beneath a private directory, then exposed
            // elsewhere. Its backing root belongs to its own device.
            for child in self
                .0
                .iter()
                .filter(|mount| mount.point != path && mount.point.starts_with(path))
            {
                self.aliases_on_device(&child.point, true, output);
            }
        }
    }

    /// Editor and catalog routes must identify the visible object. A covered mount record
    /// can describe an unrelated file now occupying the same namespace pathname.
    pub fn visible_aliases(&self, path: &Path, descendants: bool) -> io::Result<BTreeSet<PathBuf>> {
        let mut candidates = BTreeSet::new();
        self.aliases(path, descendants, &mut candidates);
        let mut visible = BTreeSet::new();
        for candidate in candidates {
            let mut sources = BTreeSet::from([path.to_owned()]);
            if descendants {
                self.aliases(&candidate, false, &mut sources);
            }
            for source in sources
                .into_iter()
                .filter(|source| source.starts_with(path))
            {
                for entry in [&source, &candidate] {
                    if let Err(error) = entry.metadata()
                        && error.kind() != io::ErrorKind::NotFound
                    {
                        return Err(error);
                    }
                }
                if crate::workspace_paths::same_location(&source, &candidate) {
                    visible.insert(candidate);
                    break;
                }
            }
        }
        Ok(visible)
    }

    fn aliases_on_device(&self, path: &Path, descendants: bool, output: &mut BTreeSet<PathBuf>) {
        let mounts = &self.0;
        let owners = || mounts.iter().filter(|mount| path.starts_with(&mount.point));
        let depth = owners().map(|mount| mount.point.components().count()).max();
        for source in owners().filter(|mount| Some(mount.point.components().count()) == depth) {
            let backing = source
                .root
                .join(path.strip_prefix(&source.point).expect("mount prefix"));
            for other in mounts.iter().filter(|mount| mount.device == source.device) {
                if let Ok(tail) = backing.strip_prefix(&other.root) {
                    output.insert(if tail.as_os_str().is_empty() {
                        other.point.clone()
                    } else {
                        other.point.join(tail)
                    });
                } else if descendants && other.root.starts_with(&backing) {
                    // The other mount exposes a child of this private or protected directory.
                    output.insert(other.point.clone());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_mountinfo_pathnames_losslessly_and_rejects_malformed_tables() {
        assert_eq!(
            mount_path(br"/a\011b\012c\040d\134e").unwrap(),
            Path::new("/a\tb\nc d\\e")
        );
        for value in [b"relative".as_slice(), br"/short\1", br"/bad\777"] {
            assert!(mount_path(value).is_err());
        }
        for table in [
            b"no fields".as_slice(),
            b"1 2 0:1",
            b"1 2 0:1 /",
            b"1 2 0:1 / /unrelated",
        ] {
            assert!(MountTable::parse(table).is_err());
        }
    }
    #[test]
    fn editor_routes_reject_overmounted_objects_and_include_visible_descendant_aliases() {
        use std::os::unix::ffi::OsStrExt;
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().canonicalize().unwrap();
        let target = root.join("package");
        let resource = target.join("guide");
        let alias = root.join("mounted-guide");
        let unrelated = root.join("covered-guide");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(&resource, b"guide").unwrap();
        std::fs::hard_link(&resource, &alias).unwrap();
        std::fs::write(&unrelated, b"ordinary").unwrap();
        let records = format!(
            "1 0 0:1 / / rest\n2 0 0:1 {0} {1} rest\n3 0 0:1 {0} {2} rest\n",
            resource.display(),
            alias.display(),
            unrelated.display()
        );
        let table = MountTable::parse(records.as_bytes()).unwrap();
        assert_eq!(
            table.visible_aliases(&target, true).unwrap(),
            BTreeSet::from([target.clone(), alias.clone()])
        );
        assert_eq!(
            table.visible_aliases(&target, false).unwrap(),
            BTreeSet::from([target.clone()])
        );
        // This visible route traverses a non-directory and cannot establish the editor identity.
        let mut bad = records.into_bytes();
        bad.extend_from_slice(b"4 0 0:1 ");
        bad.extend_from_slice(resource.as_os_str().as_bytes());
        bad.push(b' ');
        bad.extend_from_slice(alias.join("nested").as_os_str().as_bytes());
        bad.extend_from_slice(b" rest\n");
        assert!(
            MountTable::parse(&bad)
                .unwrap()
                .visible_aliases(&target, true)
                .is_err()
        );
    }
}
