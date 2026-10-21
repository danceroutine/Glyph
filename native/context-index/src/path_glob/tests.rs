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

    let result =
        find_matches(&paths, "*.tsx", Some("src"), 20, true, false).expect("glob should compile");

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
fn accepts_explicitly_recursive_patterns_and_scopes_case_insensitively() {
    let paths = BTreeSet::from([
        "Docs/Guide.md".to_owned(),
        "SRC/App.tsx".to_owned(),
        "src/nested/Card.tsx".to_owned(),
    ]);

    let recursive = find_matches(&paths, "**/*.md", None, 20, true, false)
        .expect("recursive glob should compile");
    let scoped = find_matches(&paths, "*.TSX", Some("Src"), 20, false, false)
        .expect("case-insensitive glob should compile");

    assert_eq!(recursive.files, ["Docs/Guide.md"]);
    assert_eq!(scoped.files, ["SRC/App.tsx", "src/nested/Card.tsx"]);
    assert!(!scoped.truncated);
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
