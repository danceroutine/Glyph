use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
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
// Upper bounds for JSON keys, punctuation, and u32 coordinates. Reserve the
// envelope separately so text escaping cannot exhaust the response budget.
const MATCH_JSON_OVERHEAD: usize = 256;
const CONTEXT_LINE_JSON_OVERHEAD: usize = 64;
const RESULT_JSON_OVERHEAD: usize = 1_024;
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
    #[serde(default)]
    pub(crate) overrides: BTreeMap<String, String>,
}

impl ContentSearchParams {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.overrides.len() > 2_000
            || self
                .overrides
                .keys()
                .any(|path| !is_normalized_project_relative_path(path))
            || self
                .overrides
                .iter()
                .map(|(path, text)| path.len() + text.len())
                .sum::<usize>()
                > 768 * 1024
        {
            return Err(
                "Editor search snapshots exceed the budget or contain invalid paths.".to_owned(),
            );
        }
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

/// Reads a catalog-relative file under the workspace's content access policy.
/// Editor overrides are applied by the search operation before consulting disk.
trait SearchableFiles: Sync {
    fn read(&self, path: &str) -> Result<String, ()>;
}

impl SearchableFiles for ContentSearchContext {
    fn read(&self, path: &str) -> Result<String, ()> {
        read_searchable_file(&self.root, path, self.max_file_bytes)
    }
}

/// A lane preserves catalog order and owns backpressure through its bounded
/// sender. Closing the consumer ends the lane without another file read.
fn search_lane<'a>(
    paths: impl Iterator<Item = &'a str>,
    cancelled: &AtomicBool,
    finished: &AtomicBool,
    sender: mpsc::SyncSender<FileOutcome>,
    mut search: impl FnMut(&str) -> FileOutcome,
) {
    for path in paths {
        if cancelled.load(Ordering::Acquire) || finished.load(Ordering::Acquire) {
            break;
        }
        let outcome = search(path);
        if sender.send(outcome).is_err() {
            break;
        }
    }
}

/// Consume the lanes in file order, releasing blocked sends before workers join.
fn collect_outcomes(
    file_count: usize,
    receivers: Vec<mpsc::Receiver<FileOutcome>>,
    cancelled: &AtomicBool,
    finished: &AtomicBool,
    accumulator: &mut ResultAccumulator,
) {
    for index in 0..file_count {
        let Ok(outcome) = receivers[index % receivers.len()].recv() else {
            break;
        };
        if cancelled.load(Ordering::Acquire) || accumulator.push(outcome) {
            finished.store(true, Ordering::Release);
            break;
        }
    }
    drop(receivers);
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
        self.search_files(params, cancelled, self)
    }

    fn search_files(
        &self,
        params: ContentSearchParams,
        cancelled: &AtomicBool,
        files: &impl SearchableFiles,
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
        let worker_count = thread::available_parallelism()
            .map_or(1, usize::from)
            .min(MAX_WORKERS)
            .min(candidates.len().max(1));
        let target_entries = params.offset as usize + params.limit as usize + 1;
        let mut accumulator = ResultAccumulator::new(&params, index_truncated);

        thread::scope(|scope| {
            // One bounded lane per worker lets the reducer consume file order
            // without an unbounded map of results behind a slow earlier file.
            let mut receivers = Vec::new();
            for lane in 0..worker_count {
                let (sender, receiver) = mpsc::sync_channel(1);
                receivers.push(receiver);
                let matcher = matcher.clone();
                let params = &params;
                let candidates = &candidates;
                let searched_files = &searched_files;
                let skipped_files = &skipped_files;
                let finished = &finished;
                scope.spawn(move || {
                    search_lane(
                        (lane..candidates.len())
                            .step_by(worker_count)
                            .map(|index| candidates[index].as_str()),
                        cancelled,
                        finished,
                        sender,
                        |path| match params.overrides.get(path).map_or_else(
                            || files.read(path),
                            |text| {
                                if text.len() as u64 > self.max_file_bytes || text.contains('\0') {
                                    Err(())
                                } else {
                                    Ok(text.clone())
                                }
                            },
                        ) {
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
                        },
                    );
                });
            }
            collect_outcomes(
                candidates.len(),
                receivers,
                cancelled,
                &finished,
                &mut accumulator,
            );
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
                for (start, end) in outcome.matches {
                    if self.seen_entries < self.params.offset as usize {
                        self.seen_entries += 1;
                        continue;
                    }
                    if self.matches.len() == self.params.limit as usize {
                        self.has_more = true;
                        return true;
                    }
                    // Size borrowed slices before allocating duplicated context.
                    let bytes = content_match_size(
                        &outcome.path,
                        &outcome.text,
                        &outcome.lines,
                        start,
                        end,
                        self.params,
                    );
                    if self.content_bytes + bytes > MAX_RESULT_TEXT_BYTES - RESULT_JSON_OVERHEAD {
                        self.has_more = true;
                        return true;
                    }
                    self.content_bytes += bytes;
                    self.seen_entries += 1;
                    let found = content_match(
                        &outcome.path,
                        &outcome.text,
                        &outcome.lines,
                        start,
                        end,
                        self.params,
                    );
                    debug_assert!(serde_json::to_vec(&found).unwrap().len() <= bytes);
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
                .then_some(self.params.offset.saturating_add(returned))
                .filter(|next| returned > 0 && *next <= MAX_OFFSET),
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
    text: String,
    lines: Vec<LineRange>,
    matches: Vec<(usize, usize)>,
    count: u64,
    matches_truncated: bool,
}

impl FileOutcome {
    fn empty(path: &str) -> Self {
        Self {
            path: path.to_owned(),
            text: String::new(),
            lines: Vec::new(),
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
    open_searchable_file(&canonical, &link, max_file_bytes)
}

fn open_searchable_file(
    path: &Path,
    expected: &fs::Metadata,
    max_file_bytes: u64,
) -> Result<String, ()> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Path inspection cannot prevent a later replacement. Do not follow a
        // replacement symlink or wait on a replacement FIFO before fstat can
        // reject it. O_NONBLOCK does not change regular-file read semantics.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| ())?;
    read_opened_searchable_file(file, expected, max_file_bytes)
}

fn read_opened_searchable_file(
    file: fs::File,
    _expected: &fs::Metadata,
    max_file_bytes: u64,
) -> Result<String, ()> {
    let opened = file.metadata().map_err(|_| ())?;
    if !opened.is_file() || opened.len() > max_file_bytes {
        return Err(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // The path may have been replaced after inspection. Never read bytes
        // from a different file merely because it occupies the same pathname.
        if opened.dev() != _expected.dev() || opened.ino() != _expected.ino() {
            return Err(());
        }
    }
    read_searchable_text(file, max_file_bytes)
}

fn read_searchable_text(reader: impl Read, max_file_bytes: u64) -> Result<String, ()> {
    let mut bytes = Vec::new();
    // Descriptor metadata is only an early rejection: a file can grow during
    // this read. One extra byte detects overflow without loading the remainder.
    reader
        .take(max_file_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
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
        // grep's byte matcher permits empty matches inside UTF-8 codepoints.
        // Such offsets are not valid text matches or safe Rust string slices.
        if !text.is_char_boundary(start) || !text.is_char_boundary(end) {
            return true;
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
    FileOutcome {
        path: path.to_owned(),
        text: if ranges.is_empty() {
            String::new()
        } else {
            text.to_owned()
        },
        lines: if ranges.is_empty() { Vec::new() } else { lines },
        matches: ranges,
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
        matched_text: clip_json_text(&text[start..end], MAX_CAPTURE_BYTES),
        lines_before: (before_start..start_line)
            .map(|index| content_line(text, lines, index))
            .collect(),
        lines_after: ((end_line + 1)..after_end)
            .map(|index| content_line(text, lines, index))
            .collect(),
    }
}

fn content_match_size(
    path: &str,
    text: &str,
    lines: &[LineRange],
    start: usize,
    end: usize,
    params: &ContentSearchParams,
) -> usize {
    let first = line_index_at(lines, start);
    let last = line_index_at(lines, end);
    let line_bytes = |index: usize| {
        clipped_json_text_size(
            &text[lines[index].start..lines[index].content_end],
            MAX_LINE_BYTES,
        )
    };
    MATCH_JSON_OVERHEAD
        + path.chars().map(json_character_bytes).sum::<usize>()
        + line_bytes(first)
        + clipped_json_text_size(&text[start..end], MAX_CAPTURE_BYTES)
        + (first.saturating_sub(params.lines_before as usize)..first)
            .map(|index| CONTEXT_LINE_JSON_OVERHEAD + line_bytes(index))
            .sum::<usize>()
        + ((last + 1)..(last + params.lines_after as usize + 1).min(lines.len()))
            .map(|index| CONTEXT_LINE_JSON_OVERHEAD + line_bytes(index))
            .sum::<usize>()
}

fn json_character_bytes(character: char) -> usize {
    match character {
        '"' | '\\' | '\u{0008}' | '\u{000c}' | '\n' | '\r' | '\t' => 2,
        '\u{0000}'..='\u{001f}' => 6,
        _ => character.len_utf8(),
    }
}

// Bound the serialized string, retaining UTF-8 boundaries and a visible
// clipping marker. Even a full 40-line context then fits in one response.
fn json_text_prefix(value: &str, maximum: usize) -> (&str, usize) {
    let mut bytes = 0;
    for (index, character) in value.char_indices() {
        let next = bytes + json_character_bytes(character);
        if next > maximum {
            return (&value[..index], bytes);
        }
        bytes = next;
    }
    (value, bytes)
}

fn clipped_json_text_size(value: &str, maximum: usize) -> usize {
    let (prefix, bytes) = json_text_prefix(value, maximum);
    bytes
        + if prefix.len() < value.len() {
            '…'.len_utf8()
        } else {
            0
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
    clip_json_text(&text[line.start..line.content_end], MAX_LINE_BYTES)
}

fn clip_json_text(value: &str, maximum_bytes: usize) -> String {
    let (prefix, _) = json_text_prefix(value, maximum_bytes);
    if prefix.len() == value.len() {
        prefix.to_owned()
    } else {
        format!("{prefix}…")
    }
}

#[cfg(test)]
mod tests;
