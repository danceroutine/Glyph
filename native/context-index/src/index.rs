use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread::available_parallelism;

use nucleo::pattern::{CaseMatching, Normalization};
use nucleo::{Config, Matcher, Nucleo, Utf32String};
use serde::Serialize;

const MATCH_COLUMNS: u32 = 1;
const MATCH_WAIT_MS: u64 = 10;
const MAX_MATCHER_THREADS: usize = 4;

#[derive(Debug)]
struct FileRecord {
    path: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileMatch {
    pub(crate) path: String,
    pub(crate) score: u32,
    pub(crate) indices: Vec<u32>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchResult {
    pub(crate) generation: u64,
    pub(crate) query: String,
    pub(crate) file_count: u32,
    pub(crate) matches: Vec<FileMatch>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SearchFailure {
    Superseded,
}

pub(crate) struct SearchIndex {
    matcher: Nucleo<FileRecord>,
    query: String,
}

impl SearchIndex {
    pub(crate) fn from_paths(mut paths: Vec<String>) -> Result<Self, String> {
        paths.sort_unstable();
        paths.dedup();
        if paths.len() > u32::MAX as usize {
            return Err("The project contains more files than the index can address.".to_owned());
        }

        let notify = Arc::new(|| {});
        let threads = available_parallelism()
            .map(|value| value.get())
            .unwrap_or(1)
            .clamp(1, MAX_MATCHER_THREADS);
        let mut matcher = Nucleo::new(
            Config::DEFAULT.match_paths(),
            notify,
            Some(threads),
            MATCH_COLUMNS,
        );
        let injector = matcher.injector();
        for path in paths {
            injector.push(FileRecord { path }, |record, columns| {
                columns[0] = Utf32String::from(record.path.as_str());
            });
        }
        drop(injector);
        settle(&mut matcher);

        Ok(Self {
            matcher,
            query: String::new(),
        })
    }

    pub(crate) fn file_count(&self) -> u32 {
        self.matcher.snapshot().item_count()
    }

    pub(crate) fn search(
        &mut self,
        query: String,
        limit: usize,
        generation: u64,
        latest_generation: &AtomicU64,
    ) -> Result<SearchResult, SearchFailure> {
        if latest_generation.load(Ordering::Acquire) > generation {
            return Err(SearchFailure::Superseded);
        }

        if query != self.query {
            let append = query.starts_with(&self.query);
            self.matcher.pattern.reparse(
                0,
                &query,
                CaseMatching::Smart,
                Normalization::Smart,
                append,
            );
            self.query.clone_from(&query);

            loop {
                let status = self.matcher.tick(MATCH_WAIT_MS);
                if latest_generation.load(Ordering::Acquire) > generation {
                    return Err(SearchFailure::Superseded);
                }
                if !status.running {
                    break;
                }
            }
        }

        let snapshot = self.matcher.snapshot();
        let count = usize::min(limit, snapshot.matched_item_count() as usize);
        let pattern = snapshot.pattern().column_pattern(0);
        let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
        let mut matches = Vec::with_capacity(count);

        for item in snapshot.matched_items(0..count as u32) {
            let mut indices = Vec::with_capacity(query.chars().count());
            if !query.is_empty() {
                let _ = pattern.indices(
                    item.matcher_columns[0].slice(..),
                    &mut matcher,
                    &mut indices,
                );
                indices.sort_unstable();
                indices.dedup();
            }
            let score = pattern
                .score(item.matcher_columns[0].slice(..), &mut matcher)
                .unwrap_or(0);
            matches.push(FileMatch {
                path: item.data.path.clone(),
                score,
                indices,
            });
        }

        Ok(SearchResult {
            generation,
            query,
            file_count: snapshot.item_count(),
            matches,
        })
    }
}

fn settle<T: Sync + Send + 'static>(matcher: &mut Nucleo<T>) {
    while matcher.tick(MATCH_WAIT_MS).running {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn search(index: &mut SearchIndex, query: &str, generation: u64) -> SearchResult {
        let latest = AtomicU64::new(generation);
        index
            .search(query.to_owned(), 20, generation, &latest)
            .expect("search should complete")
    }

    #[test]
    fn ranks_and_highlights_fuzzy_path_matches() {
        let mut index = SearchIndex::from_paths(vec![
            "src/application/HarnessService.ts".to_owned(),
            "src/chat/ChatProvider.ts".to_owned(),
            "examples/todo-app/src/App.tsx".to_owned(),
        ])
        .expect("index should build");

        let result = search(&mut index, "apptsx", 1);

        assert_eq!(result.matches[0].path, "examples/todo-app/src/App.tsx");
        assert_eq!(result.matches[0].indices.len(), 6);
        assert!(result.matches[0]
            .indices
            .windows(2)
            .all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn an_appended_query_matches_a_subset_of_the_previous_query() {
        let paths = vec![
            "src/App.tsx".to_owned(),
            "src/application/HarnessService.ts".to_owned(),
            "src/chat/ChatProvider.ts".to_owned(),
        ];
        let mut incremental = SearchIndex::from_paths(paths.clone()).expect("index should build");
        let _ = search(&mut incremental, "ap", 1);
        let refined = search(&mut incremental, "appt", 2);

        let mut clean = SearchIndex::from_paths(paths).expect("index should build");
        let expected = search(&mut clean, "appt", 2);

        assert_eq!(refined.matches, expected.matches);
    }

    #[test]
    fn rejects_a_generation_superseded_before_search() {
        let mut index =
            SearchIndex::from_paths(vec!["src/App.tsx".to_owned()]).expect("index should build");
        let latest = AtomicU64::new(2);

        let result = index.search("app".to_owned(), 20, 1, &latest);

        assert_eq!(result, Err(SearchFailure::Superseded));
    }

    #[test]
    fn empty_query_returns_deterministic_lexical_results() {
        let mut index =
            SearchIndex::from_paths(vec!["z-last.ts".to_owned(), "a-first.ts".to_owned()])
                .expect("index should build");

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
        let mut index = SearchIndex::from_paths(paths).expect("large index should build");

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
        let mut index = SearchIndex::from_paths(paths).expect("benchmark index should build");
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
}
