use crate::catalog_names::CatalogNames;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Debug, Serialize)]
pub(crate) struct PackageListing {
    packages: Vec<PackageEntry>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
struct PackageEntry {
    directory: String,
    manifest: Option<String>,
}

/// The native index owns both role lookup and the boundary of each admitted package. Return
/// stored paths so callers never need to guess which marker in a nested path matched.
pub(crate) fn list(
    paths: &BTreeSet<String>,
    marker: Option<&str>,
    root: &Path,
    limit: usize,
    mut truncated: bool,
    visible: impl Fn(&Path) -> bool,
) -> PackageListing {
    let mut names = CatalogNames::new(root);
    let mut packages = BTreeMap::new();
    for path in paths {
        let relative = Path::new(path);
        let mut parts = relative.iter();
        if let Some(marker) = marker {
            let mut parent = Path::new("");
            let mut previous_marker = false;
            let mut matched = false;
            for part in parts.by_ref() {
                // The prefix comes from one stored UTF-8 path in the resident index.
                let end = parent.as_os_str().len()
                    + usize::from(!parent.as_os_str().is_empty())
                    + part.len();
                parent = Path::new(&path[..end]);
                if previous_marker && names.matches(parent, "skills") {
                    matched = true;
                    break;
                }
                previous_marker = names.matches(parent, marker);
            }
            if !matched {
                continue;
            }
        }
        let Some(_) = parts.next() else {
            continue;
        };
        let remaining = parts.as_path();
        if remaining.as_os_str().is_empty() {
            continue;
        }
        let directory = &path[..path.len() - remaining.as_os_str().len() - 1];
        let manifest = remaining.components().count() == 1 && names.matches(relative, "SKILL.md");
        let admitted = packages.contains_key(directory);
        if admitted && !manifest {
            continue;
        }
        // A package or its manifest may have become private since indexing. A denied entry
        // contributes neither a directory nor a missing-manifest diagnostic to the result.
        if (!admitted && !visible(Path::new(directory))) || !visible(relative) {
            continue;
        }
        if !admitted && packages.len() == limit {
            truncated = true;
            break;
        }
        let entry = packages.entry(directory).or_insert_with(|| PackageEntry {
            directory: directory.to_owned(),
            manifest: None,
        });
        if manifest {
            entry.manifest = Some(path.clone());
        }
    }
    PackageListing {
        packages: packages.into_values().collect(),
        truncated,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lists_packages_independently_of_resource_count_and_retains_missing_manifests() {
        let mut paths: BTreeSet<String> = (0..40)
            .flat_map(|package| {
                (0..250).map(move |file| format!("src/.glyph/skills/p{package}/{file}"))
            })
            .collect();
        paths.insert("src/.glyph/skills/p0/SKILL.md".into());
        paths.insert("src/.glyph/skills/p1/sub/SKILL.md".into());
        paths.insert("src/.glyph/skills/unpackaged.txt".into());
        paths.insert("src/.cursor/skills/other/SKILL.md".into());
        let result = list(&paths, Some(".glyph"), Path::new("."), 40, false, |_| true);
        assert!(!result.truncated);
        assert_eq!(result.packages.len(), 40);
        assert_eq!(
            result.packages[0].manifest.as_deref(),
            Some("src/.glyph/skills/p0/SKILL.md")
        );
        assert!(result.packages[1].manifest.is_none());
        assert!(list(&paths, Some(".glyph"), Path::new("."), 39, false, |_| true).truncated);
        assert!(list(&paths, Some(".glyph"), Path::new("."), 40, true, |_| true).truncated);
    }

    #[test]
    fn admits_only_visible_directories_and_files_before_the_package_limit() {
        let paths = [
            ".cursor/skills/other/SKILL.md",
            ".glyph/skills",
            ".glyph/skills/0-unpackaged",
            ".glyph/skills/a/SKILL.md",
            ".glyph/skills/b/SKILL.md",
            ".glyph/skills/c/first-asset",
            ".glyph/skills/c/second-asset",
            ".glyph/skills/c/SKILL.md",
            ".glyph/skills/d/SKILL.md",
            ".glyph/skills/e/SKILL.md",
        ]
        .map(String::from)
        .into();
        // The same admission source guards a project marker and a user package root.
        let visible = |path: &Path| {
            let relative = path.strip_prefix(".glyph/skills").unwrap_or(path);
            !matches!(relative.to_str(), Some("a" | "b/SKILL.md" | "c/SKILL.md"))
        };
        let result = list(&paths, Some(".glyph"), Path::new("."), 2, false, visible);
        assert!(result.truncated);
        assert_eq!(result.packages.len(), 2);
        assert_eq!(result.packages[0].directory, ".glyph/skills/c");
        assert!(result.packages[0].manifest.is_none());
        assert_eq!(
            result.packages[1].manifest.as_deref(),
            Some(".glyph/skills/d/SKILL.md")
        );
        let user_paths = paths
            .iter()
            .filter_map(|path| path.strip_prefix(".glyph/skills/").map(str::to_owned))
            .collect();
        let user = list(&user_paths, None, Path::new("."), 2, false, visible);
        assert!(user.truncated);
        assert_eq!(user.packages.len(), 2);
        assert_eq!(user.packages[0].directory, "c");
        assert!(user.packages[0].manifest.is_none());
        assert_eq!(user.packages[1].manifest.as_deref(), Some("d/SKILL.md"));
    }

    #[test]
    fn uses_the_project_marker_or_immediate_user_packages_and_the_volume_case_policy() {
        let root = tempfile::tempdir().unwrap();
        let files = [
            "ordinary/.glyph/skills/example/SKILL.md",
            "sub/.GLYPH/SKILLS/example/SKILL.md",
            "kelvin/.glyph/sKills/example/SKILL.md",
            "user/SKILL.md",
            "orphan",
        ];
        for path in files {
            let full = root.path().join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, "data").unwrap();
        }
        let paths = files.map(String::from).into();
        let project = list(&paths, Some(".glyph"), root.path(), 40, false, |_| true);
        let expected = [
            "ordinary/.glyph/skills/example/SKILL.md",
            "kelvin/.glyph/skills/example/SKILL.md",
            "sub/.glyph/skills/example/SKILL.md",
        ]
        .into_iter()
        .filter(|p| root.path().join(p).exists())
        .count();
        assert_eq!(
            project
                .packages
                .iter()
                .filter(|p| p.manifest.is_some())
                .count(),
            expected
        );
        let user = list(&paths, None, root.path(), 40, false, |_| true);
        assert_eq!(user.packages.len(), 4);
        assert_eq!(
            user.packages.last().unwrap().manifest.as_deref(),
            Some("user/SKILL.md")
        );
        assert!(list(
            &["a/.glyph/skills".into()].into(),
            Some(".glyph"),
            root.path(),
            40,
            false,
            |_| true
        )
        .packages
        .is_empty());
    }
}
