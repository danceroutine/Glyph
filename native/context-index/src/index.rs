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

/// The request coordinator owns which generation may publish a search result.
pub(crate) trait SearchGenerations {
    fn latest(&self) -> u64;
}

impl SearchGenerations for AtomicU64 {
    fn latest(&self) -> u64 {
        self.load(Ordering::Acquire)
    }
}

pub(crate) struct SearchIndex {
    matcher: Nucleo<FileRecord>,
    query: String,
}

impl SearchIndex {
    // Service scans and cache loads both enforce the policy's u32 max_files.
    pub(crate) fn from_paths(mut paths: Vec<String>) -> Self {
        paths.sort_unstable();
        paths.dedup();

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

        Self {
            matcher,
            query: String::new(),
        }
    }

    pub(crate) fn file_count(&self) -> u32 {
        self.matcher.snapshot().item_count()
    }

    pub(crate) fn search(
        &mut self,
        query: String,
        limit: usize,
        generation: u64,
        latest_generation: &impl SearchGenerations,
    ) -> Result<SearchResult, SearchFailure> {
        if latest_generation.latest() > generation {
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
        }

        // An interrupted generation may have parsed this same query without
        // publishing its snapshot. Even unchanged text must settle the worker.
        loop {
            let status = self.matcher.tick(MATCH_WAIT_MS);
            if latest_generation.latest() > generation {
                return Err(SearchFailure::Superseded);
            }
            if !status.running {
                break;
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
mod tests;
