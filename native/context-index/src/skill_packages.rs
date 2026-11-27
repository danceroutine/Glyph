use crate::path_glob::GlobResult;
use std::collections::{BTreeMap, BTreeSet};

/// Count package directories, independent of how many resources each package contributes.
/// One admitted path also identifies a package whose direct manifest is missing or ignored.
pub(crate) fn list(
    paths: &BTreeSet<String>,
    marker: Option<&str>,
    sensitive: bool,
    limit: usize,
    mut truncated: bool,
) -> GlobResult {
    let equal = |actual: &str, expected: &str| {
        if sensitive {
            actual == expected
        } else {
            actual.eq_ignore_ascii_case(expected)
                || (!actual.is_ascii() && actual.to_lowercase() == expected.to_lowercase())
        }
    };
    let mut packages = BTreeMap::new();
    for path in paths {
        let mut relative = path.as_str();
        if let Some(marker) = marker {
            let mut previous_marker = false;
            while let Some((segment, rest)) = relative.split_once('/') {
                relative = rest;
                if previous_marker && equal(segment, "skills") {
                    break;
                }
                previous_marker = equal(segment, marker);
            }
        }
        let Some((_, tail)) = relative.split_once('/') else {
            continue;
        };
        let directory = &path[..path.len() - tail.len() - 1];
        if packages.len() == limit && !packages.contains_key(directory) {
            truncated = true;
            break;
        }
        let representative = packages.entry(directory).or_insert(path);
        if equal(tail, "SKILL.md") {
            *representative = path;
        }
    }
    GlobResult {
        files: packages.into_values().cloned().collect(),
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
        let result = list(&paths, Some(".glyph"), true, 40, false);
        assert!(!result.truncated);
        assert_eq!(result.files.len(), 40);
        assert!(result
            .files
            .contains(&"src/.glyph/skills/p0/SKILL.md".into()));
        assert!(result.files.contains(&"src/.glyph/skills/p1/0".into()));
        assert!(list(&paths, Some(".glyph"), true, 39, false).truncated);
        assert!(list(&paths, Some(".glyph"), true, 40, true).truncated);
    }

    #[test]
    fn uses_the_project_marker_or_immediate_user_packages_and_the_volume_case_policy() {
        let paths = [
            "sub/.GLYPH/SKILLS/example/a",
            "sub/.GLYPH/SKILLS/example/skill.MD",
            "kelvin/.glyph/sKills/example/SKILL.md",
            "orphan",
            "user/SKILL.md",
        ]
        .map(String::from)
        .into();
        assert!(list(&paths, Some(".glyph"), true, 40, false)
            .files
            .is_empty());
        assert_eq!(
            list(&paths, Some(".glyph"), false, 40, false).files,
            [
                "kelvin/.glyph/sKills/example/SKILL.md",
                "sub/.GLYPH/SKILLS/example/skill.MD"
            ]
        );
        assert_eq!(
            list(&paths, None, true, 40, false).files,
            [
                "kelvin/.glyph/sKills/example/SKILL.md",
                "sub/.GLYPH/SKILLS/example/a",
                "user/SKILL.md"
            ]
        );
    }
}
