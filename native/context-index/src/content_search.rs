use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, RwLock};
use std::thread;

use globset::{GlobBuilder, GlobMatcher};
use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use ignore::types::{Types, TypesBuilder};
use serde::{Deserialize, Serialize};

const MAX_PATTERN_CHARS: usize = 4_096;
const MAX_RESULT_LIMIT: u32 = 1_000;
const MAX_OFFSET: u32 = 100_000;
const MAX_CONTEXT_LINES: u32 = 20;
const MAX_CAPTURE_BYTES: usize = 8 * 1_024;
const MAX_LINE_BYTES: usize = 8 * 1_024;
const MAX_RESULT_TEXT_BYTES: usize = 512 * 1_024;
const MAX_WORKERS: usize = 8;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ContentSearchPatternKind {
    RegularExpression,
    Literal,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ContentSearchOutputMode {
    Content,
    FilesWithMatches,
    Count,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContentSearchParams {
    pub(crate) pattern: String,
    pub(crate) pattern_kind: ContentSearchPatternKind,
    #[serde(default)]
    pub(crate) path: Option<String>,
    #[serde(default)]
    pub(crate) file_glob: Option<String>,
    #[serde(default)]
    pub(crate) file_type: Option<String>,
    pub(crate) output_mode: ContentSearchOutputMode,
    pub(crate) lines_before: u32,
    pub(crate) lines_after: u32,
    pub(crate) case_sensitive: bool,
    pub(crate) multiline: bool,
    pub(crate) limit: u32,
    pub(crate) offset: u32,
}

impl ContentSearchParams {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.pattern.is_empty() {
            return Err("pattern must not be empty.".to_owned());
        }
        if self.pattern.chars().count() > MAX_PATTERN_CHARS {
            return Err(format!(
                "pattern may contain at most {MAX_PATTERN_CHARS} characters."
            ));
        }
        if self.limit == 0 || self.limit > MAX_RESULT_LIMIT {
            return Err(format!("limit must be between 1 and {MAX_RESULT_LIMIT}."));
        }
        if self.offset > MAX_OFFSET {
            return Err(format!("offset may be at most {MAX_OFFSET}."));
        }
        if self.lines_before > MAX_CONTEXT_LINES || self.lines_after > MAX_CONTEXT_LINES {
            return Err(format!(
                "linesBefore and linesAfter may each be at most {MAX_CONTEXT_LINES}."
            ));
        }
        for (label, value) in [("path", &self.path), ("fileGlob", &self.file_glob)] {
            if value.as_deref().is_some_and(str::is_empty) {
                return Err(format!("{label} must not be empty when provided."));
            }
        }
        if self
            .path
            .as_deref()
            .is_some_and(|path| !is_normalized_project_relative_path(path))
        {
            return Err("path must be a normalized project-relative path.".to_owned());
        }
        if self.file_glob.as_deref().is_some_and(|pattern| {
            pattern.chars().count() > MAX_PATTERN_CHARS || pattern.contains('\0')
        }) {
            return Err(format!(
                "fileGlob may contain at most {MAX_PATTERN_CHARS} characters and no null bytes."
            ));
        }
        if self.file_type.as_deref().is_some_and(|value| {
            value.is_empty()
                || value.len() > 64
                || !value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                })
        }) {
            return Err(
                "fileType must be at most 64 characters and contain only letters, numbers, hyphens, and underscores."
                    .to_owned(),
            );
        }
        Ok(())
    }
}

fn is_normalized_project_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && !has_windows_drive_prefix(path)
        && path
            .split('/')
            .all(|component| !component.is_empty() && component != "." && component != "..")
}

fn has_windows_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

#[derive(Clone)]
pub(crate) struct ContentSearchContext {
    root: PathBuf,
    paths: Arc<RwLock<BTreeSet<String>>>,
    index_truncated: Arc<AtomicBool>,
    path_case_sensitive: bool,
    max_file_bytes: u64,
}

impl ContentSearchContext {
    pub(crate) fn new(
        root: PathBuf,
        paths: Arc<RwLock<BTreeSet<String>>>,
        index_truncated: Arc<AtomicBool>,
        path_case_sensitive: bool,
        max_file_bytes: u64,
    ) -> Self {
        Self {
            root,
            paths,
            index_truncated,
            path_case_sensitive,
            max_file_bytes,
        }
    }

    pub(crate) fn search(
        &self,
        params: ContentSearchParams,
        cancelled: &AtomicBool,
    ) -> Result<ContentSearchResult, ContentSearchError> {
        params
            .validate()
            .map_err(ContentSearchError::InvalidRequest)?;
        if cancelled.load(Ordering::Acquire) {
            return Err(ContentSearchError::Cancelled);
        }
        let matcher = compile_matcher(&params).map_err(ContentSearchError::InvalidRequest)?;
        let file_glob = compile_file_glob(params.file_glob.as_deref(), self.path_case_sensitive)
            .map_err(ContentSearchError::InvalidRequest)?;
        let file_types = compile_file_type(params.file_type.as_deref())
            .map_err(ContentSearchError::InvalidRequest)?;
        let candidates = self
            .candidate_paths(
                params.path.as_deref(),
                file_glob.as_ref(),
                file_types.as_ref(),
            )
            .map_err(ContentSearchError::Internal)?;
        let index_truncated = self.index_truncated.load(Ordering::Acquire);
        let searched_files = AtomicUsize::new(0);
        let skipped_files = AtomicUsize::new(0);
        let finished = AtomicBool::new(false);
        let next_candidate = AtomicUsize::new(0);
        let worker_count = thread::available_parallelism()
            .map_or(1, usize::from)
            .min(MAX_WORKERS)
            .min(candidates.len().max(1));
        let channel_capacity = worker_count.saturating_mul(2).max(1);
        let (sender, receiver) = mpsc::sync_channel(channel_capacity);
        let target_entries = params.offset as usize + params.limit as usize + 1;
        let mut accumulator = ResultAccumulator::new(&params, index_truncated);

        thread::scope(|scope| {
            for _ in 0..worker_count {
                let sender = sender.clone();
                let matcher = matcher.clone();
                let params = &params;
                let candidates = &candidates;
                let next_candidate = &next_candidate;
                let searched_files = &searched_files;
                let skipped_files = &skipped_files;
                let finished = &finished;
                scope.spawn(move || {
                    while !cancelled.load(Ordering::Acquire) && !finished.load(Ordering::Acquire) {
                        let index = next_candidate.fetch_add(1, Ordering::AcqRel);
                        let Some(path) = candidates.get(index) else {
                            break;
                        };
                        let outcome =
                            match read_searchable_file(&self.root, path, self.max_file_bytes) {
                                Ok(text) => {
                                    searched_files.fetch_add(1, Ordering::AcqRel);
                                    search_file(
                                        path,
                                        &text,
                                        &matcher,
                                        params,
                                        target_entries,
                                        cancelled,
                                    )
                                }
                                Err(()) => {
                                    skipped_files.fetch_add(1, Ordering::AcqRel);
                                    FileOutcome::empty(path)
                                }
                            };
                        if sender.send((index, outcome)).is_err() {
                            break;
                        }
                    }
                });
            }
            drop(sender);

            let mut pending = BTreeMap::new();
            let mut next_result = 0;
            while let Ok((index, outcome)) = receiver.recv() {
                pending.insert(index, outcome);
                while let Some(outcome) = pending.remove(&next_result) {
                    if accumulator.push(outcome) {
                        finished.store(true, Ordering::Release);
                    }
                    next_result += 1;
                }
                if cancelled.load(Ordering::Acquire) {
                    finished.store(true, Ordering::Release);
                }
            }
        });

        if cancelled.load(Ordering::Acquire) {
            return Err(ContentSearchError::Cancelled);
        }
        Ok(accumulator.finish(
            searched_files.load(Ordering::Acquire) as u32,
            skipped_files.load(Ordering::Acquire) as u32,
        ))
    }

    fn candidate_paths(
        &self,
        scoped_path: Option<&str>,
        file_glob: Option<&GlobMatcher>,
        file_types: Option<&Types>,
    ) -> Result<Vec<String>, String> {
        let paths = self
            .paths
            .read()
            .map_err(|_| "The known-path set lock is poisoned.".to_owned())?;
        Ok(paths
            .iter()
            .filter(|path| path_is_in_scope(path, scoped_path, self.path_case_sensitive))
            .filter(|path| file_glob.is_none_or(|matcher| matcher.is_match(path)))
            .filter(|path| file_types.is_none_or(|types| types.matched(path, false).is_whitelist()))
            .cloned()
            .collect())
    }
}

#[derive(Debug)]
pub(crate) enum ContentSearchError {
    InvalidRequest(String),
    Cancelled,
    Internal(String),
}

#[derive(Debug, Serialize)]
#[serde(tag = "outputMode", rename_all = "snake_case")]
pub(crate) enum ContentSearchResult {
    Content {
        matches: Vec<ContentMatch>,
        #[serde(flatten)]
        metadata: SearchMetadata,
    },
    FilesWithMatches {
        files: Vec<String>,
        #[serde(flatten)]
        metadata: SearchMetadata,
    },
    Count {
        counts: Vec<FileCount>,
        #[serde(flatten)]
        metadata: SearchMetadata,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SearchMetadata {
    searched_files: u32,
    skipped_files: u32,
    index_truncated: bool,
    truncated: bool,
    next_offset: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContentMatch {
    path: String,
    line: u32,
    column: u32,
    end_line: u32,
    end_column: u32,
    line_text: String,
    matched_text: String,
    lines_before: Vec<ContentLine>,
    lines_after: Vec<ContentLine>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ContentLine {
    number: u32,
    content: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct FileCount {
    path: String,
    count: u64,
}

struct ResultAccumulator<'a> {
    params: &'a ContentSearchParams,
    index_truncated: bool,
    seen_entries: usize,
    content_bytes: usize,
    has_more: bool,
    matches: Vec<ContentMatch>,
    files: Vec<String>,
    counts: Vec<FileCount>,
}

impl<'a> ResultAccumulator<'a> {
    fn new(params: &'a ContentSearchParams, index_truncated: bool) -> Self {
        Self {
            params,
            index_truncated,
            seen_entries: 0,
            content_bytes: 0,
            has_more: false,
            matches: Vec::new(),
            files: Vec::new(),
            counts: Vec::new(),
        }
    }

    fn push(&mut self, outcome: FileOutcome) -> bool {
        match self.params.output_mode {
            ContentSearchOutputMode::Content => {
                for found in outcome.matches {
                    if self.seen_entries < self.params.offset as usize {
                        self.seen_entries += 1;
                        continue;
                    }
                    if self.matches.len() == self.params.limit as usize {
                        self.has_more = true;
                        return true;
                    }
                    let bytes = content_match_bytes(&found);
                    if self.content_bytes + bytes > MAX_RESULT_TEXT_BYTES
                        && !self.matches.is_empty()
                    {
                        self.has_more = true;
                        return true;
                    }
                    self.content_bytes += bytes;
                    self.seen_entries += 1;
                    self.matches.push(found);
                }
                if outcome.matches_truncated {
                    self.has_more = true;
                    return true;
                }
            }
            ContentSearchOutputMode::FilesWithMatches if outcome.count > 0 => {
                if self.skip_or_full() {
                    return self.has_more;
                }
                self.files.push(outcome.path);
            }
            ContentSearchOutputMode::Count if outcome.count > 0 => {
                if self.skip_or_full() {
                    return self.has_more;
                }
                self.counts.push(FileCount {
                    path: outcome.path,
                    count: outcome.count,
                });
            }
            ContentSearchOutputMode::FilesWithMatches | ContentSearchOutputMode::Count => {}
        }
        false
    }

    fn skip_or_full(&mut self) -> bool {
        if self.seen_entries < self.params.offset as usize {
            self.seen_entries += 1;
            return true;
        }
        let length = match self.params.output_mode {
            ContentSearchOutputMode::FilesWithMatches => self.files.len(),
            ContentSearchOutputMode::Count => self.counts.len(),
            ContentSearchOutputMode::Content => unreachable!(),
        };
        if length == self.params.limit as usize {
            self.has_more = true;
            return true;
        }
        self.seen_entries += 1;
        false
    }

    fn finish(self, searched_files: u32, skipped_files: u32) -> ContentSearchResult {
        let returned = match self.params.output_mode {
            ContentSearchOutputMode::Content => self.matches.len(),
            ContentSearchOutputMode::FilesWithMatches => self.files.len(),
            ContentSearchOutputMode::Count => self.counts.len(),
        } as u32;
        let metadata = SearchMetadata {
            searched_files,
            skipped_files,
            index_truncated: self.index_truncated,
            truncated: self.has_more || self.index_truncated,
            next_offset: self
                .has_more
                .then_some(self.params.offset.saturating_add(returned)),
        };
        match self.params.output_mode {
            ContentSearchOutputMode::Content => ContentSearchResult::Content {
                matches: self.matches,
                metadata,
            },
            ContentSearchOutputMode::FilesWithMatches => ContentSearchResult::FilesWithMatches {
                files: self.files,
                metadata,
            },
            ContentSearchOutputMode::Count => ContentSearchResult::Count {
                counts: self.counts,
                metadata,
            },
        }
    }
}

struct FileOutcome {
    path: String,
    matches: Vec<ContentMatch>,
    count: u64,
    matches_truncated: bool,
}

impl FileOutcome {
    fn empty(path: &str) -> Self {
        Self {
            path: path.to_owned(),
            matches: Vec::new(),
            count: 0,
            matches_truncated: false,
        }
    }
}

#[derive(Clone, Copy)]
struct LineRange {
    start: usize,
    content_end: usize,
}

fn compile_matcher(params: &ContentSearchParams) -> Result<RegexMatcher, String> {
    let mut builder = RegexMatcherBuilder::new();
    builder
        .case_insensitive(!params.case_sensitive)
        .fixed_strings(params.pattern_kind == ContentSearchPatternKind::Literal);
    if params.multiline {
        builder.multi_line(true).dot_matches_new_line(true);
    }
    builder
        .build(&params.pattern)
        .map_err(|error| format!("pattern is not a valid regular expression: {error}"))
}

fn compile_file_glob(
    pattern: Option<&str>,
    case_sensitive: bool,
) -> Result<Option<GlobMatcher>, String> {
    let Some(pattern) = pattern else {
        return Ok(None);
    };
    let normalized = if pattern.starts_with("**/") {
        pattern.to_owned()
    } else {
        format!("**/{pattern}")
    };
    GlobBuilder::new(&normalized)
        .literal_separator(true)
        .case_insensitive(!case_sensitive)
        .build()
        .map(|glob| Some(glob.compile_matcher()))
        .map_err(|error| format!("fileGlob is not a valid glob: {error}"))
}

fn compile_file_type(file_type: Option<&str>) -> Result<Option<Types>, String> {
    let Some(file_type) = file_type else {
        return Ok(None);
    };
    let mut builder = TypesBuilder::new();
    builder.add_defaults().select(file_type);
    builder
        .build()
        .map(Some)
        .map_err(|error| format!("fileType is not recognized: {error}"))
}

fn path_is_in_scope(path: &str, scope: Option<&str>, case_sensitive: bool) -> bool {
    let Some(scope) = scope else {
        return true;
    };
    if case_sensitive {
        path == scope
            || path
                .strip_prefix(scope)
                .is_some_and(|suffix| suffix.starts_with('/'))
    } else {
        let path = path.to_lowercase();
        let scope = scope.to_lowercase();
        path == scope
            || path
                .strip_prefix(&scope)
                .is_some_and(|suffix| suffix.starts_with('/'))
    }
}

fn read_searchable_file(root: &Path, relative: &str, max_file_bytes: u64) -> Result<String, ()> {
    let candidate = root.join(relative);
    let link = fs::symlink_metadata(&candidate).map_err(|_| ())?;
    if !link.is_file() || link.file_type().is_symlink() || link.len() > max_file_bytes {
        return Err(());
    }
    let canonical = fs::canonicalize(&candidate).map_err(|_| ())?;
    if canonical != candidate || !canonical.starts_with(root) {
        return Err(());
    }
    let bytes = fs::read(canonical).map_err(|_| ())?;
    if bytes.len() as u64 > max_file_bytes || bytes.contains(&0) {
        return Err(());
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        String::from_utf8(bytes[3..].to_vec()).map_err(|_| ())
    } else {
        String::from_utf8(bytes).map_err(|_| ())
    }
}

fn search_file(
    path: &str,
    text: &str,
    matcher: &RegexMatcher,
    params: &ContentSearchParams,
    match_limit: usize,
    cancelled: &AtomicBool,
) -> FileOutcome {
    let bytes = text.as_bytes();
    let lines = line_ranges(bytes);
    let mut ranges = Vec::new();
    let truncated = Cell::new(false);
    let count = Cell::new(0_u64);
    let mut record = |start: usize, end: usize| {
        if cancelled.load(Ordering::Acquire) {
            return false;
        }
        count.set(count.get().saturating_add(1));
        if params.output_mode == ContentSearchOutputMode::Content {
            if ranges.len() < match_limit {
                ranges.push((start, end));
            } else {
                truncated.set(true);
                return false;
            }
        }
        params.output_mode != ContentSearchOutputMode::FilesWithMatches
    };
    if params.multiline {
        let _ = matcher.find_iter(bytes, |found| record(found.start(), found.end()));
    } else {
        for line in &lines {
            let haystack = &bytes[line.start..line.content_end];
            let _ = matcher.find_iter(haystack, |found| {
                record(line.start + found.start(), line.start + found.end())
            });
            if cancelled.load(Ordering::Acquire)
                || (params.output_mode == ContentSearchOutputMode::FilesWithMatches
                    && count.get() > 0)
                || truncated.get()
            {
                break;
            }
        }
    }
    let matches = ranges
        .into_iter()
        .map(|(start, end)| content_match(path, text, &lines, start, end, params))
        .collect();
    FileOutcome {
        path: path.to_owned(),
        matches,
        count: count.get(),
        matches_truncated: truncated.get(),
    }
}

fn line_ranges(bytes: &[u8]) -> Vec<LineRange> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'\n' {
            let content_end = if index > start && bytes[index - 1] == b'\r' {
                index - 1
            } else {
                index
            };
            lines.push(LineRange { start, content_end });
            start = index + 1;
        } else if bytes[index] == b'\r' && bytes.get(index + 1) != Some(&b'\n') {
            lines.push(LineRange {
                start,
                content_end: index,
            });
            start = index + 1;
        }
        index += 1;
    }
    lines.push(LineRange {
        start,
        content_end: bytes.len(),
    });
    lines
}

fn content_match(
    path: &str,
    text: &str,
    lines: &[LineRange],
    start: usize,
    end: usize,
    params: &ContentSearchParams,
) -> ContentMatch {
    let start_line = line_index_at(lines, start);
    let end_line = line_index_at(lines, end);
    let start_column = text[lines[start_line].start..start].chars().count() + 1;
    let end_column = text[lines[end_line].start..end].chars().count() + 1;
    let before_start = start_line.saturating_sub(params.lines_before as usize);
    let after_end = (end_line + params.lines_after as usize + 1).min(lines.len());
    ContentMatch {
        path: path.to_owned(),
        line: start_line as u32 + 1,
        column: start_column as u32,
        end_line: end_line as u32 + 1,
        end_column: end_column as u32,
        line_text: clipped_line(text, lines[start_line]),
        matched_text: clip_utf8(&text[start..end], MAX_CAPTURE_BYTES),
        lines_before: (before_start..start_line)
            .map(|index| content_line(text, lines, index))
            .collect(),
        lines_after: ((end_line + 1)..after_end)
            .map(|index| content_line(text, lines, index))
            .collect(),
    }
}

fn line_index_at(lines: &[LineRange], offset: usize) -> usize {
    lines
        .partition_point(|line| line.start <= offset)
        .saturating_sub(1)
        .min(lines.len() - 1)
}

fn content_line(text: &str, lines: &[LineRange], index: usize) -> ContentLine {
    ContentLine {
        number: index as u32 + 1,
        content: clipped_line(text, lines[index]),
    }
}

fn clipped_line(text: &str, line: LineRange) -> String {
    clip_utf8(&text[line.start..line.content_end], MAX_LINE_BYTES)
}

fn clip_utf8(value: &str, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value.to_owned();
    }
    let mut end = maximum_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn content_match_bytes(found: &ContentMatch) -> usize {
    found.path.len()
        + found.line_text.len()
        + found.matched_text.len()
        + found
            .lines_before
            .iter()
            .chain(&found.lines_after)
            .map(|line| line.content.len())
            .sum::<usize>()
}

#[cfg(test)]
mod tests {
    use std::fs::{create_dir_all, write};

    use tempfile::tempdir;

    use super::*;

    fn parameters(output_mode: ContentSearchOutputMode) -> ContentSearchParams {
        ContentSearchParams {
            pattern: "needle".to_owned(),
            pattern_kind: ContentSearchPatternKind::Literal,
            path: None,
            file_glob: None,
            file_type: None,
            output_mode,
            lines_before: 0,
            lines_after: 0,
            case_sensitive: true,
            multiline: false,
            limit: 100,
            offset: 0,
        }
    }

    fn context(files: &[(&str, &str)]) -> (tempfile::TempDir, ContentSearchContext) {
        let directory = tempdir().expect("temporary directory should be created");
        let mut paths = BTreeSet::new();
        for (path, content) in files {
            let absolute = directory.path().join(path);
            create_dir_all(absolute.parent().expect("fixture has a parent"))
                .expect("fixture directory should be created");
            write(&absolute, content).expect("fixture should be written");
            paths.insert((*path).to_owned());
        }
        let search = ContentSearchContext::new(
            fs::canonicalize(directory.path()).expect("fixture root should canonicalize"),
            Arc::new(RwLock::new(paths)),
            Arc::new(AtomicBool::new(false)),
            true,
            1024 * 1024,
        );
        (directory, search)
    }

    #[test]
    fn searches_literal_content_with_unicode_columns_context_and_pagination() {
        let (_directory, search) = context(&[
            ("src/a.ts", "before\n🦀 needle one\nafter\nneedle two\n"),
            ("src/b.ts", "needle three\n"),
            ("README.md", "needle documentation\n"),
        ]);
        let mut params = parameters(ContentSearchOutputMode::Content);
        params.path = Some("src".to_owned());
        params.file_glob = Some("*.ts".to_owned());
        params.file_type = Some("ts".to_owned());
        params.lines_before = 1;
        params.lines_after = 1;
        params.limit = 1;
        params.offset = 1;

        let result = search
            .search(params, &AtomicBool::new(false))
            .expect("search should succeed");
        let ContentSearchResult::Content { matches, metadata } = result else {
            panic!("expected content results");
        };
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].path, "src/a.ts");
        assert_eq!(matches[0].line, 4);
        assert_eq!(matches[0].column, 1);
        assert_eq!(matches[0].lines_before[0].content, "after");
        assert!(metadata.truncated);
        assert_eq!(metadata.next_offset, Some(2));
    }

    #[test]
    fn supports_regular_expressions_case_folding_multiline_files_and_counts() {
        let (_directory, search) = context(&[
            ("src/a.ts", "Begin\nMIDDLE\nEnd\n"),
            ("src/b.js", "begin end\n"),
        ]);
        let mut params = parameters(ContentSearchOutputMode::Count);
        params.pattern = "begin.*end".to_owned();
        params.pattern_kind = ContentSearchPatternKind::RegularExpression;
        params.case_sensitive = false;
        params.multiline = true;
        params.file_type = Some("ts".to_owned());

        let result = search
            .search(params, &AtomicBool::new(false))
            .expect("search should succeed");
        let ContentSearchResult::Count { counts, metadata } = result else {
            panic!("expected count results");
        };
        assert_eq!(counts.len(), 1);
        assert_eq!(counts[0].path, "src/a.ts");
        assert_eq!(counts[0].count, 1);
        assert!(!metadata.truncated);
    }

    #[test]
    fn strips_a_utf8_byte_order_mark_before_reporting_columns() {
        let (_directory, search) = context(&[("bom.txt", "\u{feff}needle\n")]);
        let mut params = parameters(ContentSearchOutputMode::Content);
        params.path = Some("bom.txt".to_owned());

        let result = search
            .search(params, &AtomicBool::new(false))
            .expect("search should succeed");
        let ContentSearchResult::Content { matches, .. } = result else {
            panic!("expected content results");
        };
        assert_eq!(matches[0].column, 1);
        assert_eq!(matches[0].line_text, "needle");
    }

    #[test]
    fn returns_matching_files_and_skips_binary_oversized_and_symlinked_files() {
        let (directory, search) = context(&[
            ("a.txt", "needle\n"),
            ("binary.txt", "needle\0hidden"),
            ("large.txt", &"x".repeat(2_000)),
        ]);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                directory.path().join("a.txt"),
                directory.path().join("link.txt"),
            )
            .expect("symlink should be created");
            search
                .paths
                .write()
                .expect("paths lock should work")
                .insert("link.txt".to_owned());
        }
        let constrained = ContentSearchContext::new(
            search.root.clone(),
            Arc::clone(&search.paths),
            Arc::clone(&search.index_truncated),
            true,
            1_024,
        );

        let result = constrained
            .search(
                parameters(ContentSearchOutputMode::FilesWithMatches),
                &AtomicBool::new(false),
            )
            .expect("search should succeed");
        let ContentSearchResult::FilesWithMatches { files, metadata } = result else {
            panic!("expected file results");
        };
        assert_eq!(files, ["a.txt"]);
        assert!(metadata.skipped_files >= 2);
    }

    #[test]
    fn rejects_invalid_requests_and_honors_cancellation() {
        let (_directory, search) = context(&[("a.txt", "needle")]);
        let mut invalid = parameters(ContentSearchOutputMode::Content);
        invalid.pattern.clear();
        assert!(matches!(
            search.search(invalid, &AtomicBool::new(false)),
            Err(ContentSearchError::InvalidRequest(_))
        ));

        let mutations: [fn(&mut ContentSearchParams); 4] = [
            |params: &mut ContentSearchParams| params.path = Some("../outside".to_owned()),
            |params: &mut ContentSearchParams| params.file_glob = Some("[".to_owned()),
            |params: &mut ContentSearchParams| params.file_type = Some("unknown-type".to_owned()),
            |params: &mut ContentSearchParams| {
                params.pattern_kind = ContentSearchPatternKind::RegularExpression;
                params.pattern = "[".to_owned();
            },
        ];
        for mutate in mutations {
            let mut invalid = parameters(ContentSearchOutputMode::Content);
            mutate(&mut invalid);
            assert!(matches!(
                search.search(invalid, &AtomicBool::new(false)),
                Err(ContentSearchError::InvalidRequest(_))
            ));
        }

        let cancelled = AtomicBool::new(true);
        assert!(matches!(
            search.search(parameters(ContentSearchOutputMode::Content), &cancelled),
            Err(ContentSearchError::Cancelled)
        ));
    }
}
