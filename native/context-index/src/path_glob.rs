use std::borrow::Cow;
use std::collections::BTreeSet;

use globset::GlobBuilder;
use serde::Serialize;

const MAX_PATTERN_CHARS: usize = 4_096;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobResult {
    pub(crate) files: Vec<String>,
    pub(crate) truncated: bool,
}

pub(crate) fn find_matches(
    paths: &BTreeSet<String>,
    pattern: &str,
    target_directory: Option<&str>,
    limit: usize,
    case_sensitive: bool,
    index_truncated: bool,
) -> Result<GlobResult, String> {
    if pattern.is_empty() {
        return Err("pattern must not be empty.".to_owned());
    }
    if pattern.chars().count() > MAX_PATTERN_CHARS {
        return Err(format!(
            "pattern may contain at most {MAX_PATTERN_CHARS} characters."
        ));
    }
    let normalized_pattern = if pattern.starts_with("**/") {
        pattern.to_owned()
    } else {
        format!("**/{pattern}")
    };
    let matcher = GlobBuilder::new(&normalized_pattern)
        .literal_separator(true)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|error| format!("pattern is not a valid glob: {error}"))?
        .compile_matcher();
    let directory_prefix = target_directory.map(|directory| format!("{directory}/"));
    let normalized_directory_prefix = directory_prefix.as_ref().map(|prefix| {
        if case_sensitive {
            prefix.clone()
        } else {
            prefix.to_lowercase()
        }
    });
    let candidates: Box<dyn Iterator<Item = &String> + '_> = match directory_prefix.as_deref() {
        Some(prefix) if case_sensitive => Box::new(paths.range(prefix.to_owned()..)),
        None => Box::new(paths.iter()),
        Some(_) => Box::new(paths.iter()),
    };
    let mut files = Vec::with_capacity(limit.min(256));
    let mut query_truncated = false;

    for path in candidates {
        let candidate = match (
            directory_prefix.as_deref(),
            normalized_directory_prefix.as_deref(),
        ) {
            (Some(prefix), _) if case_sensitive => {
                let Some(relative) = path.strip_prefix(prefix) else {
                    break;
                };
                Cow::Borrowed(relative)
            }
            (Some(_), Some(normalized_prefix)) => {
                let normalized_path = path.to_lowercase();
                let Some(relative) = normalized_path.strip_prefix(normalized_prefix) else {
                    continue;
                };
                Cow::Owned(relative.to_owned())
            }
            (Some(_), None) => continue,
            (None, _) => Cow::Borrowed(path.as_str()),
        };
        if !matcher.is_match(candidate.as_ref()) {
            continue;
        }
        if files.len() == limit {
            query_truncated = true;
            break;
        }
        files.push(path.clone());
    }

    Ok(GlobResult {
        files,
        truncated: index_truncated || query_truncated,
    })
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    #[test]
    fn matches_recursively_with_directory_scoping_and_stable_ordering() {
        let paths = BTreeSet::from([
            "README.md".to_owned(),
            "src/App.tsx".to_owned(),
            "src/nested/Card.tsx".to_owned(),
            "tests/App.test.tsx".to_owned(),
        ]);

        let result = find_matches(&paths, "*.tsx", Some("src"), 20, true, false)
            .expect("glob should compile");

        assert_eq!(
            result,
            GlobResult {
                files: vec!["src/App.tsx".to_owned(), "src/nested/Card.tsx".to_owned()],
                truncated: false,
            }
        );
    }

    #[test]
    fn honors_case_sensitivity_and_both_truncation_sources() {
        let paths = BTreeSet::from(["Src/App.TSX".to_owned(), "src/Card.tsx".to_owned()]);

        let sensitive = find_matches(&paths, "*.tsx", None, 20, true, false)
            .expect("case-sensitive glob should compile");
        let insensitive = find_matches(&paths, "*.tsx", Some("src"), 1, false, false)
            .expect("case-insensitive glob should compile");
        let incomplete_index =
            find_matches(&paths, "*.never", None, 20, true, true).expect("glob should compile");

        assert_eq!(sensitive.files, ["src/Card.tsx"]);
        assert_eq!(insensitive.files, ["Src/App.TSX"]);
        assert!(insensitive.truncated);
        assert!(incomplete_index.truncated);
    }

    #[test]
    fn rejects_empty_oversized_and_malformed_patterns() {
        let paths = BTreeSet::new();

        for pattern in ["", &"x".repeat(MAX_PATTERN_CHARS + 1), "["] {
            assert!(find_matches(&paths, pattern, None, 20, true, false).is_err());
        }
    }

    #[test]
    #[ignore = "manual performance harness; run with --ignored --nocapture"]
    fn measures_glob_queries_on_half_a_million_paths() {
        let paths: BTreeSet<_> = (0..500_000)
            .map(|number| {
                format!(
                    "workspaces/workspace-{:05}/src/module-{number:06}.typescript",
                    number / 50
                )
            })
            .collect();
        let exact_started = Instant::now();
        let exact = find_matches(&paths, "module-499999.typescript", None, 2_000, true, false)
            .expect("glob should compile");
        let exact_duration = exact_started.elapsed();
        let no_match_started = Instant::now();
        let no_match =
            find_matches(&paths, "*.never", None, 2_000, true, false).expect("glob should compile");
        let no_match_duration = no_match_started.elapsed();
        let scoped_started = Instant::now();
        let scoped = find_matches(
            &paths,
            "*.typescript",
            Some("workspaces/workspace-09999/src"),
            2_000,
            true,
            false,
        )
        .expect("glob should compile");
        let scoped_duration = scoped_started.elapsed();

        eprintln!(
            "500k indexed paths: exact glob={exact_duration:?}, no match={no_match_duration:?}, scoped 50 files={scoped_duration:?}"
        );
        assert_eq!(exact.files.len(), 1);
        assert!(no_match.files.is_empty());
        assert_eq!(scoped.files.len(), 50);
    }
}
