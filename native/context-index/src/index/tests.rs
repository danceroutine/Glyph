use super::*;
use std::time::Instant;

#[test]
fn a_generation_superseded_during_matching_does_not_publish_and_can_be_retried() {
    let mut index = SearchIndex::from_paths(vec!["src/app.ts".into(), "src/other.ts".into()]);
    let generations = AdvancingGeneration(std::cell::Cell::new(1), 1);
    assert_eq!(
        index.search("app".into(), 20, 1, &generations),
        Err(SearchFailure::Superseded)
    );
    assert_eq!(
        generations.0.get(),
        3,
        "admission and post-tick publication both check ownership"
    );
    let resumed = search(&mut index, "app", 2);
    assert_eq!(
        resumed
            .matches
            .iter()
            .map(|m| m.path.as_str())
            .collect::<Vec<_>>(),
        ["src/app.ts"]
    );
}

struct AdvancingGeneration(std::cell::Cell<u64>, u64);

impl SearchGenerations for AdvancingGeneration {
    fn latest(&self) -> u64 {
        let value = self.0.get();
        self.0.set(value + self.1);
        value
    }
}

fn search(index: &mut SearchIndex, query: &str, generation: u64) -> SearchResult {
    let latest = AdvancingGeneration(std::cell::Cell::new(generation), 0);
    index
        .search(query.to_owned(), 20, generation, &latest)
        .expect("search should complete")
}

#[test]
fn ranks_and_highlights_fuzzy_path_matches() {
    let mut index = SearchIndex::from_paths(vec![
        "src/application/GlyphService.ts".to_owned(),
        "src/chat/ChatProvider.ts".to_owned(),
        "examples/todo-app/src/App.tsx".to_owned(),
    ]);

    let result = search(&mut index, "apptsx", 1);

    assert_eq!(result.matches[0].path, "examples/todo-app/src/App.tsx");
    assert_eq!(result.matches[0].indices.len(), 6);
    assert!(result.matches[0]
        .indices
        .windows(2)
        .all(|pair| pair[0] < pair[1]));
}

#[test]
fn settles_an_unpublished_query_when_the_next_generation_repeats_it() {
    let mut index = SearchIndex::from_paths(vec!["alpha.ts".into(), "zebra.ts".into()]);
    let _ = search(&mut index, "zebra", 1);
    // Reproduce the state left by an interrupted search: the parsed query
    // changed but the matcher has not published its replacement snapshot.
    index
        .matcher
        .pattern
        .reparse(0, "alpha", CaseMatching::Smart, Normalization::Smart, false);
    index.query = "alpha".into();
    let result = search(&mut index, "alpha", 3);
    assert_eq!(
        result
            .matches
            .iter()
            .map(|item| item.path.as_str())
            .collect::<Vec<_>>(),
        vec!["alpha.ts"]
    );
    assert_eq!(result.matches[0].indices.len(), 5);
}

#[test]
fn an_appended_query_matches_a_subset_of_the_previous_query() {
    let paths = vec![
        "src/App.tsx".to_owned(),
        "src/application/GlyphService.ts".to_owned(),
        "src/chat/ChatProvider.ts".to_owned(),
    ];
    let mut incremental = SearchIndex::from_paths(paths.clone());
    let _ = search(&mut incremental, "ap", 1);
    let refined = search(&mut incremental, "appt", 2);

    let mut clean = SearchIndex::from_paths(paths);
    let expected = search(&mut clean, "appt", 2);

    assert_eq!(refined.matches, expected.matches);
}

#[test]
fn rejects_a_generation_superseded_before_search() {
    let mut index = SearchIndex::from_paths(vec!["src/App.tsx".to_owned()]);
    let latest = AdvancingGeneration(std::cell::Cell::new(2), 0);

    let result = index.search("app".to_owned(), 20, 1, &latest);

    assert_eq!(result, Err(SearchFailure::Superseded));
}

#[test]
fn a_repeated_query_waits_for_paths_added_since_the_last_search() {
    let mut index = SearchIndex::from_paths(vec!["src/app.ts".to_owned()]);
    let first = search(&mut index, "app", 1);
    index.matcher.injector().push(
        FileRecord {
            path: "src/app-shell.ts".to_owned(),
        },
        |record, columns| {
            columns[0] = Utf32String::from(record.path.as_str());
        },
    );

    let second = search(&mut index, "app", 2);

    assert_eq!(first.file_count, 1);
    assert_eq!(second.file_count, 2);
    let mut paths = second
        .matches
        .iter()
        .map(|item| item.path.as_str())
        .collect::<Vec<_>>();
    paths.sort_unstable();
    assert_eq!(paths, ["src/app-shell.ts", "src/app.ts"]);
}

#[test]
fn empty_query_returns_deterministic_lexical_results() {
    let mut index = SearchIndex::from_paths(vec!["z-last.ts".to_owned(), "a-first.ts".to_owned()]);

    let result = search(&mut index, "", 1);

    assert_eq!(result.matches[0].path, "a-first.ts");
    assert!(result.matches[0].indices.is_empty());
}

#[test]
fn searches_a_deterministic_large_synthetic_corpus() {
    let mut paths: Vec<_> = (0..100_000)
        .map(|number| {
            format!(
                "packages/package-{:04}/src/generated/component-{number:06}.tsx",
                number / 100
            )
        })
        .collect();
    paths.push("packages/payments/src/context/FilePickerController.tsx".to_owned());
    let mut index = SearchIndex::from_paths(paths);

    let broad = search(&mut index, "payfile", 1);
    let refined = search(&mut index, "payfilepickctrl", 2);

    assert_eq!(broad.file_count, 100_001);
    assert_eq!(
        refined.matches[0].path,
        "packages/payments/src/context/FilePickerController.tsx"
    );
}

#[test]
#[ignore = "manual performance harness; run with --ignored --nocapture"]
fn measures_cold_build_and_incremental_refinement_on_half_a_million_paths() {
    let paths: Vec<_> = (0..500_000)
        .map(|number| {
            format!(
                "workspaces/workspace-{:05}/src/module-{number:06}.typescript",
                number / 50
            )
        })
        .collect();
    let build_started = Instant::now();
    let mut index = SearchIndex::from_paths(paths);
    let build_elapsed = build_started.elapsed();
    let latest = AtomicU64::new(3);
    let search_started = Instant::now();
    let _ = index
        .search("work".to_owned(), 20, 3, &latest)
        .expect("broad benchmark search should complete");
    let broad_elapsed = search_started.elapsed();
    let refine_started = Instant::now();
    let result = index
        .search("workspace09999module499999".to_owned(), 20, 3, &latest)
        .expect("refined benchmark search should complete");
    let refine_elapsed = refine_started.elapsed();

    assert_eq!(result.file_count, 500_000);
    eprintln!(
        "500k paths: cold build={build_elapsed:?}, broad search={broad_elapsed:?}, incremental refinement={refine_elapsed:?}"
    );
}
