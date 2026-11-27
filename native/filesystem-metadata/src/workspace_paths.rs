//! Project physical host exclusions into the process's visible filesystem namespace.
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default)]
pub struct WorkspacePaths {
    private: BTreeSet<PathBuf>,
    managed: Option<BTreeSet<PathBuf>>,
    /// Preserve the host's authority spelling as well as its current physical destination.
    configured: Vec<(PathBuf, PathBuf)>,
    #[cfg(target_os = "linux")]
    mounts: Option<std::sync::Arc<fs::File>>,
}

fn canonical_location(path: &Path) -> io::Result<PathBuf> {
    match path.canonicalize() {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let (parent, name) = path.parent().zip(path.file_name()).ok_or(error)?;
            Ok(canonical_location(parent)?.join(name))
        }
        Err(error) => Err(error),
    }
}

fn future_name(value: &str, normalizes: bool, fold: bool, sensitive: bool) -> String {
    use unicode_normalization::UnicodeNormalization;
    let name = if normalizes {
        value.nfc().collect()
    } else {
        value.to_owned()
    };
    if sensitive {
        return name;
    }
    if !fold {
        return name.to_lowercase();
    }
    let mut folded = String::new();
    for c in name.chars() {
        if c == 'ı' {
            folded.push(c);
        } else {
            folded.extend(
                c.to_lowercase()
                    .flat_map(char::to_uppercase)
                    .flat_map(char::to_lowercase),
            );
        }
    }
    folded.nfc().collect()
}

pub(crate) fn same_location(left: &Path, right: &Path) -> bool {
    if same_inode(left, right) {
        return true;
    }
    let absent =
        |p: &Path| fs::symlink_metadata(p).is_err_and(|e| e.kind() == io::ErrorKind::NotFound);
    if !absent(left) || !absent(right) {
        return false;
    }
    // Both inputs are absolute. At least their filesystem root exists.
    let existing = |p: &Path| {
        p.ancestors()
            .find(|p| p.is_dir())
            .expect("absolute path root")
            .to_owned()
    };
    let (a, b) = (existing(left), existing(right));
    if !same_inode(&a, &b) {
        return false;
    }
    let policy = crate::filesystem_casing::unicode_policy(&a)
        .and_then(|(n, f)| crate::filesystem_casing::detect(&a).map(|s| (n, f, s)));
    let left = left.strip_prefix(&a).expect("inspected ancestor").to_str();
    let right = right.strip_prefix(&b).expect("inspected ancestor").to_str();
    policy.map_or(true, |(normalizes, fold, sensitive)| {
        left.zip(right).is_some_and(|(l, r)| {
            future_name(l, normalizes, fold, sensitive)
                == future_name(r, normalizes, fold, sensitive)
        })
    })
}

fn same_inode(left: &Path, right: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        matches!((fs::metadata(left), fs::metadata(right)), (Ok(a), Ok(b)) if (a.dev(), a.ino()) == (b.dev(), b.ino()))
    }
    #[cfg(not(unix))]
    {
        matches!((left.canonicalize(), right.canonicalize()), (Ok(a), Ok(b)) if a == b)
    }
}

fn name_matches(path: &Path, expected: &str) -> bool {
    path.file_name().is_some_and(|name| {
        name == expected
            || ((!name.as_encoded_bytes().is_ascii() || name.eq_ignore_ascii_case(expected))
                && same_location(path, &path.with_file_name(expected)))
    })
}

/// Match host-reserved components using the containing filesystem's actual filename semantics.
pub fn private_name(path: &Path) -> bool {
    name_matches(path, ".skill-staging") || name_matches(path, ".glyph-skill-run")
}

fn package_marker(path: &Path) -> bool {
    name_matches(path, ".glyph") || name_matches(path, ".cursor")
}

fn managed_name(path: &Path) -> bool {
    name_matches(path, "skills") && path.parent().is_some_and(package_marker)
}

/// Project both whole managed packages and a marker's managed child across Linux bind mounts.
#[cfg(target_os = "linux")]
pub fn project_managed_mounts(
    table: &crate::mount_table::MountTable<'_>,
    paths: &mut BTreeSet<PathBuf>,
) {
    for (root, point) in table.locations() {
        if root.ancestors().chain(point.ancestors()).any(managed_name) {
            table.aliases(point, true, paths);
        } else if package_marker(root) || package_marker(point) {
            table.aliases(&point.join("skills"), true, paths);
        }
    }
}

/// Check physical spelling only when unequal components could be filesystem aliases.
/// This keeps ordinary unrelated ASCII paths in large native indexes free of stat calls.
fn contains(root: &Path, candidate: &Path) -> bool {
    if candidate.starts_with(root) {
        return true;
    }
    let depth = root.components().count();
    if candidate.components().count() < depth {
        return false;
    }
    if !root
        .components()
        .zip(candidate.components())
        .all(|(left, right)| {
            let (a, b) = (left.as_os_str(), right.as_os_str());
            a.eq_ignore_ascii_case(b)
                || !a.as_encoded_bytes().is_ascii()
                || !b.as_encoded_bytes().is_ascii()
        })
    {
        return false;
    }
    let prefix: PathBuf = candidate.components().take(depth).collect();
    same_location(root, &prefix)
}

impl WorkspacePaths {
    pub fn current(private: &[PathBuf]) -> io::Result<Self> {
        Self::for_operation(private, None)
    }

    /// Managed package directories remain readable during ordinary project operations.
    pub fn for_operation(private: &[PathBuf], managed: Option<&[PathBuf]>) -> io::Result<Self> {
        if private
            .iter()
            .chain(managed.unwrap_or_default())
            .any(|p| !p.is_absolute())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Workspace access boundaries must be absolute.",
            ));
        }
        let configured = private
            .iter()
            .map(|path| Ok((path.clone(), canonical_location(path)?)))
            .collect::<io::Result<Vec<_>>>()?;
        #[allow(unused_mut)]
        let mut policy = Self {
            private: configured
                .iter()
                .map(|(_, target)| target.clone())
                .collect(),
            configured,
            managed: managed
                .map(|paths| {
                    paths
                        .iter()
                        .map(|path| canonical_location(path))
                        .collect::<io::Result<_>>()
                })
                .transpose()?,
            #[cfg(target_os = "linux")]
            mounts: None,
        };
        #[cfg(target_os = "linux")]
        {
            use std::io::Read;
            let mut file = fs::File::open("/proc/self/mountinfo")?;
            let mut data = Vec::new();
            file.read_to_end(&mut data)?;
            let table = crate::mount_table::MountTable::parse(&data)?;
            for path in policy.private.clone() {
                table.aliases(&path, true, &mut policy.private);
            }
            if let Some(paths) = &mut policy.managed {
                for path in paths.clone() {
                    table.aliases(&path, true, paths);
                }
                project_managed_mounts(&table, paths);
            }
            policy.include_private_mounts(&table);
            policy.mounts = Some(std::sync::Arc::new(file));
        }
        Ok(policy)
    }

    #[cfg(target_os = "linux")]
    fn include_private_mounts(&mut self, table: &crate::mount_table::MountTable<'_>) {
        for (root, point) in table.locations() {
            if root.ancestors().chain(point.ancestors()).any(private_name) {
                table.aliases(point, true, &mut self.private);
            }
        }
    }

    /// Linux marks a mountinfo descriptor for priority I/O on any namespace topology change.
    /// Discard results prepared using a changed table, including a change undone during a read.
    pub fn topology_current(&self) -> bool {
        #[cfg(target_os = "linux")]
        if let Some(file) = &self.mounts {
            use std::os::fd::AsRawFd;
            let mut descriptor = libc::pollfd {
                fd: file.as_raw_fd(),
                events: libc::POLLPRI,
                revents: 0,
            };
            return unsafe { libc::poll(&mut descriptor, 1, 0) } == 0;
        }
        true
    }

    /// A policy input may have been redirected during a request even without changing mounts.
    pub fn current_at_completion(&self) -> bool {
        self.topology_current()
            && self
                .configured
                .iter()
                .all(|(path, target)| canonical_location(path).is_ok_and(|now| &now == target))
    }

    pub fn excludes(&self, path: &Path) -> bool {
        path.ancestors().any(private_name)
            || self.private.iter().any(|p| contains(p, path))
            || self.managed.as_ref().is_some_and(|paths| {
                path.ancestors().any(managed_name)
                    || package_marker(path)
                    || paths.iter().any(|p| contains(p, path) || contains(path, p))
            })
    }

    pub fn assert_path(&self, path: &Path, identity: Option<(&str, &str)>) -> io::Result<()> {
        self.assert_batch_path(path, identity)?;
        self.finish_batch()
    }

    /// Validate one path against this batch's mount and reservation snapshot. Call finish_batch before delivery.
    pub fn assert_batch_path(&self, path: &Path, identity: Option<(&str, &str)>) -> io::Result<()> {
        let denied = || {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Path is excluded from project access.",
            )
        };
        if !self.topology_current()
            || !path.is_absolute()
            || self.excludes(path)
            || self.excludes(&canonical_location(path)?)
        {
            return Err(denied());
        }
        #[cfg(unix)]
        if let Some((dev, ino)) = identity {
            use std::os::unix::fs::MetadataExt;
            let meta = fs::metadata(path)?;
            if meta.dev().to_string() != dev || meta.ino().to_string() != ino {
                return Err(denied());
            }
        }
        Ok(())
    }

    /// Recheck all live authority inputs once after examining the complete batch.
    pub fn finish_batch(&self) -> io::Result<()> {
        if self.current_at_completion() {
            Ok(())
        } else {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "Workspace access changed."))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn privately_named_mounts_hide_their_ordinary_aliases_and_nested_volumes() {
        let table = crate::mount_table::MountTable::parse(
            b"1 1 0:1 / /
2 1 0:1 /elsewhere/.skill-staging /project/hidden
3 2 0:2 / /project/hidden/volume
4 1 0:2 / /project/second
5 1 0:3 / /project/ordinary",
        )
        .unwrap();
        let mut access = WorkspacePaths::default();
        access.include_private_mounts(&table);
        assert!(access.excludes(Path::new("/project/hidden/entry")));
        assert!(access.excludes(Path::new("/project/second/entry")));
        assert!(!access.excludes(Path::new("/project/ordinary/entry")));
    }

    #[test]
    fn admits_ordinary_siblings_and_reserves_only_the_selected_objects() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path().canonicalize().unwrap();
        let absent = dir.join("missing/private");
        let store = dir.join("catalog");
        let visible = dir.join("CatalogSibling");
        fs::create_dir(&store).unwrap();
        fs::write(&visible, "ordinary").unwrap();
        assert!(WorkspacePaths::current(&[PathBuf::from("relative")]).is_err());
        let admitted = WorkspacePaths::current(&[absent.clone(), store.clone()]).unwrap();
        for path in [&absent, &store, &dir.join("nested/.skill-staging/fixture")] {
            assert!(admitted.assert_path(path, None).is_err());
        }
        let absent_variant = dir.join("missing/Private");
        let sensitive = crate::filesystem_casing::detect(&dir).unwrap();
        assert_eq!(admitted.excludes(&absent_variant), !sensitive);
        assert!(same_location(&store, &store));
        assert!(!same_location(&store, &visible));
        // The snapshot must also reject a normal file when its authority input
        // is redirected after the policy was assembled.
        #[cfg(unix)]
        {
            let authority = dir.join("host-location");
            std::os::unix::fs::symlink(&store, &authority).unwrap();
            let prior = WorkspacePaths::current(std::slice::from_ref(&authority)).unwrap();
            fs::remove_file(&authority).unwrap();
            assert!(prior.assert_path(&visible, None).is_err());
        }
        assert!(!same_location(&absent, &store.join("missing")));
        assert_eq!(future_name("e\u{301}", true, false, true), "é");
        assert_eq!(future_name("A", false, false, false), "a");
        assert_eq!(future_name("ẞı", true, true, false), "ssı");
        let mutation =
            WorkspacePaths::for_operation(&[], Some(std::slice::from_ref(&store))).unwrap();
        for reserved in [
            &store,
            &dir,
            &dir.join(".glyph"),
            &dir.join(".cursor/skills/key"),
            &dir.join("nested/.glyph/skills/example"),
        ] {
            assert!(mutation.assert_path(reserved, None).is_err());
        }
        mutation.assert_path(&visible, None).unwrap();
        mutation
            .assert_path(&dir.join(".cursor/rules/example"), None)
            .unwrap();
        assert!(admitted
            .assert_path(&dir.join(".glyph-skill-run/tool"), None)
            .is_err());
        let renamed = dir.join("cataloG");
        assert_eq!(admitted.excludes(&renamed), same_inode(&renamed, &store));
        let name = dir.join("ſample");
        fs::write(&name, "ordinary").unwrap();
        let alternate = dir.join("sample");
        assert_eq!(contains(&alternate, &name), same_inode(&alternate, &name));
        admitted.assert_path(&visible, None).unwrap();
        assert!(admitted.assert_path(Path::new("relative"), None).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let m = fs::metadata(&visible).unwrap();
            admitted
                .assert_path(&visible, Some((&m.dev().to_string(), &m.ino().to_string())))
                .unwrap();
            assert!(admitted.assert_path(&visible, Some(("0", "0"))).is_err());
            assert!(admitted
                .assert_path(&visible.join("invalid"), None)
                .is_err());
        }
    }
}
