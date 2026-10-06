use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use ignore::{WalkBuilder, WalkState};
use notify::{Event, EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};

use crate::cache::{self, CachedPaths};
use crate::index::{SearchFailure, SearchIndex, SearchResult};
use crate::path_glob::{find_matches, GlobResult};

const DEFAULT_MAX_FILES: u32 = 2_000_000;
const DEFAULT_SEARCH_LIMIT: u32 = 20;
const MAX_SEARCH_LIMIT: u32 = 100;
const DEFAULT_GLOB_LIMIT: u32 = 2_000;
const MAX_GLOB_LIMIT: u32 = 10_000;
const MAX_QUERY_CHARS: usize = 4_096;
const WATCH_POLL_INTERVAL: Duration = Duration::from_millis(100);
const WATCH_DEBOUNCE: Duration = Duration::from_millis(250);
const WATCH_MAX_DEBOUNCE: Duration = Duration::from_secs(2);
const WATCH_STARTUP_RECONCILE_DELAY: Duration = Duration::from_millis(500);
const WATCH_BACKEND_WARMUP: Duration = Duration::from_secs(1);
const WATCH_SAFETY_RECONCILE: Duration = Duration::from_secs(5 * 60);
const WATCH_FALLBACK_RECONCILE: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InitializeParams {
    pub(crate) root: String,
    #[serde(default)]
    pub(crate) cache_path: Option<PathBuf>,
    #[serde(default = "default_ignored_directories")]
    pub(crate) ignored_directories: Vec<String>,
    #[serde(default = "default_sensitive_file_names")]
    pub(crate) sensitive_file_names: Vec<String>,
    #[serde(default = "default_sensitive_file_prefixes")]
    pub(crate) sensitive_file_prefixes: Vec<String>,
    #[serde(default = "default_sensitive_file_extensions")]
    pub(crate) sensitive_file_extensions: Vec<String>,
    #[serde(default = "default_allowed_file_names")]
    pub(crate) allowed_file_names: Vec<String>,
    #[serde(default)]
    pub(crate) excluded_paths: Vec<String>,
    #[serde(default = "default_true")]
    pub(crate) respect_git_ignore: bool,
    #[serde(default = "default_max_files")]
    pub(crate) max_files: u32,
    #[serde(default = "default_case_sensitive")]
    pub(crate) case_sensitive: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexPolicy {
    ignored_directories: Vec<String>,
    sensitive_file_names: Vec<String>,
    sensitive_file_prefixes: Vec<String>,
    sensitive_file_extensions: Vec<String>,
    allowed_file_names: Vec<String>,
    excluded_paths: Vec<String>,
    respect_git_ignore: bool,
    max_files: u32,
    case_sensitive: bool,
}

impl From<&InitializeParams> for IndexPolicy {
    fn from(params: &InitializeParams) -> Self {
        Self {
            ignored_directories: params.ignored_directories.clone(),
            sensitive_file_names: params.sensitive_file_names.clone(),
            sensitive_file_prefixes: params.sensitive_file_prefixes.clone(),
            sensitive_file_extensions: params.sensitive_file_extensions.clone(),
            allowed_file_names: params.allowed_file_names.clone(),
            excluded_paths: params.excluded_paths.clone(),
            respect_git_ignore: params.respect_git_ignore,
            max_files: params.max_files,
            case_sensitive: params.case_sensitive,
        }
    }
}

impl IndexPolicy {
    fn validate(&self) -> Result<(), ServiceError> {
        if self.max_files == 0 {
            return Err(ServiceError::invalid_request("maxFiles must be positive."));
        }
        for (label, values) in [
            ("ignoredDirectories", &self.ignored_directories),
            ("sensitiveFileNames", &self.sensitive_file_names),
            ("sensitiveFilePrefixes", &self.sensitive_file_prefixes),
            ("sensitiveFileExtensions", &self.sensitive_file_extensions),
            ("allowedFileNames", &self.allowed_file_names),
        ] {
            if values
                .iter()
                .any(|value| value.is_empty() || value.contains('/') || value.contains('\\'))
            {
                return Err(ServiceError::invalid_request(format!(
                    "{label} entries must be non-empty file or directory names."
                )));
            }
        }
        if self
            .excluded_paths
            .iter()
            .any(|path| !is_normalized_project_relative_path(path))
        {
            return Err(ServiceError::invalid_request(
                "excludedPaths entries must be normalized project-relative paths.",
            ));
        }
        Ok(())
    }

    fn excludes(&self, relative_path: &str) -> bool {
        if self
            .excluded_paths
            .iter()
            .any(|excluded| path_is_excluded(relative_path, excluded))
        {
            return true;
        }
        let mut parts = relative_path.split('/');
        let Some(name) = parts.next_back() else {
            return true;
        };
        if relative_path.split('/').any(|part| {
            self.ignored_directories
                .iter()
                .any(|ignored| ignored == part)
        }) {
            return true;
        }
        if self
            .allowed_file_names
            .iter()
            .any(|allowed| allowed == name)
        {
            return false;
        }
        self.sensitive_file_names
            .iter()
            .any(|sensitive| sensitive == name)
            || self
                .sensitive_file_prefixes
                .iter()
                .any(|prefix| name.starts_with(prefix))
            || self
                .sensitive_file_extensions
                .iter()
                .any(|extension| name.ends_with(extension))
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

fn path_is_excluded(relative_path: &str, excluded_path: &str) -> bool {
    relative_path == excluded_path
        || relative_path
            .strip_prefix(excluded_path)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SearchParams {
    pub(crate) query: String,
    #[serde(default = "default_search_limit")]
    pub(crate) limit: u32,
    pub(crate) generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GlobParams {
    pub(crate) pattern: String,
    #[serde(default)]
    pub(crate) target_directory: Option<String>,
    #[serde(default = "default_glob_limit")]
    pub(crate) limit: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IndexStatus {
    pub(crate) root: String,
    pub(crate) file_count: u32,
    pub(crate) from_cache: bool,
    pub(crate) truncated: bool,
    pub(crate) duration_milliseconds: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShutdownResult {
    pub(crate) shutdown: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct ServiceError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ServiceError {
    pub(crate) fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_REQUEST",
            message: message.into(),
        }
    }

    fn initialization(message: impl Into<String>) -> Self {
        Self {
            code: "INITIALIZATION_FAILED",
            message: message.into(),
        }
    }

    fn not_initialized() -> Self {
        Self {
            code: "NOT_INITIALIZED",
            message: "Initialize the context index before using it.".to_owned(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "INTERNAL",
            message: message.into(),
        }
    }

    fn superseded() -> Self {
        Self {
            code: "SUPERSEDED",
            message: "A newer file search superseded this request.".to_owned(),
        }
    }
}

struct ScanResult {
    paths: Vec<String>,
    truncated: bool,
}

struct InitializedIndex {
    root: PathBuf,
    root_text: String,
    policy: IndexPolicy,
    policy_hash: [u8; 32],
    cache_path: Option<PathBuf>,
    index: Arc<Mutex<SearchIndex>>,
    known_paths: Arc<RwLock<BTreeSet<String>>>,
    truncated: Arc<AtomicBool>,
}

pub(crate) struct ContextIndexService {
    initialized: Option<InitializedIndex>,
    monitor: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
}

impl ContextIndexService {
    pub(crate) fn new() -> Self {
        Self {
            initialized: None,
            monitor: None,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn initialize(
        &mut self,
        params: InitializeParams,
    ) -> Result<IndexStatus, ServiceError> {
        if self.initialized.is_some() {
            return Err(ServiceError::invalid_request(
                "The context index has already been initialized.",
            ));
        }
        let started = Instant::now();
        let policy = IndexPolicy::from(&params);
        policy.validate()?;
        let root_input = Path::new(&params.root);
        if !root_input.is_absolute() {
            return Err(ServiceError::invalid_request(
                "root must be an absolute path.",
            ));
        }
        let root = fs::canonicalize(root_input).map_err(|error| {
            ServiceError::initialization(format!("Could not resolve the project root: {error}"))
        })?;
        if !root.is_dir() {
            return Err(ServiceError::invalid_request(
                "root must refer to a directory.",
            ));
        }
        let root_text = root
            .to_str()
            .ok_or_else(|| {
                ServiceError::initialization("The canonical project root is not valid UTF-8.")
            })?
            .to_owned();
        if params
            .cache_path
            .as_ref()
            .is_some_and(|path| !path.is_absolute())
        {
            return Err(ServiceError::invalid_request(
                "cachePath must be absolute when provided.",
            ));
        }
        let policy_hash =
            cache::policy_fingerprint(&policy).map_err(ServiceError::initialization)?;
        // Install the watcher before reading the cache or walking the tree. Events
        // that race with initial indexing are buffered and handled by the monitor.
        let watcher = start_watcher(&root);

        let cached = params.cache_path.as_deref().and_then(|path| {
            match cache::load(path, &root_text, &policy_hash, policy.max_files as usize) {
                Ok(value) => value,
                Err(error) => {
                    eprintln!("glyph-context-index: ignoring unusable cache: {error}");
                    None
                }
            }
        });

        let (paths, truncated, from_cache) = match cached {
            Some(cached) if cached_paths_are_allowed(&cached, &policy) => {
                (cached.paths, cached.truncated, true)
            }
            _ => {
                let scan = scan_paths(&root, &policy, params.cache_path.as_deref(), &self.stop)?;
                if let Some(cache_path) = params.cache_path.as_deref() {
                    if let Err(error) = cache::store(
                        cache_path,
                        &root_text,
                        &policy_hash,
                        &scan.paths,
                        scan.truncated,
                    ) {
                        eprintln!("glyph-context-index: cache write failed: {error}");
                    }
                }
                (scan.paths, scan.truncated, false)
            }
        };

        let known_paths = Arc::new(RwLock::new(paths.iter().cloned().collect()));
        let index = SearchIndex::from_paths(paths).map_err(ServiceError::initialization)?;
        let file_count = index.file_count();
        let shared = Arc::new(Mutex::new(index));
        let truncated_state = Arc::new(AtomicBool::new(truncated));
        let initialized = InitializedIndex {
            root: root.clone(),
            root_text: root_text.clone(),
            policy: policy.clone(),
            policy_hash,
            cache_path: params.cache_path.clone(),
            index: Arc::clone(&shared),
            known_paths: Arc::clone(&known_paths),
            truncated: Arc::clone(&truncated_state),
        };
        // Some watcher backends report successful registration just before
        // their event stream becomes active. Tiny repositories can finish the
        // initial walk inside that window, so reconcile once more in the
        // background. Large walks naturally outlive the warm-up and avoid the
        // duplicate work.
        let reconcile_after_startup_delay = !from_cache
            && watcher
                .as_ref()
                .is_none_or(|watcher| watcher.started_at.elapsed() < WATCH_BACKEND_WARMUP);
        let monitor = spawn_monitor(
            MonitorState {
                root,
                root_text: root_text.clone(),
                policy,
                policy_hash,
                cache_path: params.cache_path,
                index: shared,
                known_paths,
                truncated: truncated_state,
                stop: Arc::clone(&self.stop),
                reconcile_immediately: from_cache,
                reconcile_after_startup_delay,
            },
            watcher,
        )?;
        self.initialized = Some(initialized);
        self.monitor = Some(monitor);

        Ok(IndexStatus {
            root: root_text,
            file_count,
            from_cache,
            truncated,
            duration_milliseconds: elapsed_millis(started),
        })
    }

    pub(crate) fn search(
        &self,
        params: SearchParams,
        latest_generation: &AtomicU64,
    ) -> Result<SearchResult, ServiceError> {
        if params.limit == 0 || params.limit > MAX_SEARCH_LIMIT {
            return Err(ServiceError::invalid_request(format!(
                "limit must be between 1 and {MAX_SEARCH_LIMIT}."
            )));
        }
        if params.query.chars().count() > MAX_QUERY_CHARS {
            return Err(ServiceError::invalid_request(format!(
                "query may contain at most {MAX_QUERY_CHARS} characters."
            )));
        }
        let initialized = self
            .initialized
            .as_ref()
            .ok_or_else(ServiceError::not_initialized)?;
        let mut index = initialized
            .index
            .lock()
            .map_err(|_| ServiceError::internal("The file index lock is poisoned."))?;
        index
            .search(
                params.query,
                params.limit as usize,
                params.generation,
                latest_generation,
            )
            .map_err(|failure| match failure {
                SearchFailure::Superseded => ServiceError::superseded(),
            })
    }

    pub(crate) fn glob(&self, params: GlobParams) -> Result<GlobResult, ServiceError> {
        if params.limit == 0 || params.limit > MAX_GLOB_LIMIT {
            return Err(ServiceError::invalid_request(format!(
                "limit must be between 1 and {MAX_GLOB_LIMIT}."
            )));
        }
        if params
            .target_directory
            .as_deref()
            .is_some_and(|directory| !is_normalized_project_relative_path(directory))
        {
            return Err(ServiceError::invalid_request(
                "targetDirectory must be a normalized project-relative directory.",
            ));
        }
        let initialized = self
            .initialized
            .as_ref()
            .ok_or_else(ServiceError::not_initialized)?;
        let paths = initialized
            .known_paths
            .read()
            .map_err(|_| ServiceError::internal("The known-path set lock is poisoned."))?;
        find_matches(
            &paths,
            &params.pattern,
            params.target_directory.as_deref(),
            params.limit as usize,
            initialized.policy.case_sensitive,
            initialized.truncated.load(Ordering::Acquire),
        )
        .map_err(ServiceError::invalid_request)
    }

    pub(crate) fn refresh(&mut self) -> Result<IndexStatus, ServiceError> {
        let initialized = self
            .initialized
            .as_ref()
            .ok_or_else(ServiceError::not_initialized)?;
        let started = Instant::now();
        let scan = scan_paths(
            &initialized.root,
            &initialized.policy,
            initialized.cache_path.as_deref(),
            &self.stop,
        )?;
        if let Some(cache_path) = initialized.cache_path.as_deref() {
            if let Err(error) = cache::store(
                cache_path,
                &initialized.root_text,
                &initialized.policy_hash,
                &scan.paths,
                scan.truncated,
            ) {
                eprintln!("glyph-context-index: cache write failed: {error}");
            }
        }
        let known_paths: BTreeSet<_> = scan.paths.iter().cloned().collect();
        let index = SearchIndex::from_paths(scan.paths).map_err(ServiceError::internal)?;
        let file_count = index.file_count();
        *initialized
            .index
            .lock()
            .map_err(|_| ServiceError::internal("The file index lock is poisoned."))? = index;
        *initialized
            .known_paths
            .write()
            .map_err(|_| ServiceError::internal("The known-path set lock is poisoned."))? =
            known_paths;
        initialized
            .truncated
            .store(scan.truncated, Ordering::Release);

        Ok(IndexStatus {
            root: initialized.root_text.clone(),
            file_count,
            from_cache: false,
            truncated: scan.truncated,
            duration_milliseconds: elapsed_millis(started),
        })
    }

    pub(crate) fn shutdown(&mut self) -> ShutdownResult {
        self.stop.store(true, Ordering::Release);
        self.join_monitor();
        ShutdownResult { shutdown: true }
    }

    fn join_monitor(&mut self) {
        if let Some(handle) = self.monitor.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for ContextIndexService {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

struct MonitorState {
    root: PathBuf,
    root_text: String,
    policy: IndexPolicy,
    policy_hash: [u8; 32],
    cache_path: Option<PathBuf>,
    index: Arc<Mutex<SearchIndex>>,
    known_paths: Arc<RwLock<BTreeSet<String>>>,
    truncated: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    reconcile_immediately: bool,
    reconcile_after_startup_delay: bool,
}

struct FilesystemWatcher {
    _watcher: notify::RecommendedWatcher,
    events: mpsc::Receiver<notify::Result<Event>>,
    started_at: Instant,
}

fn start_watcher(root: &Path) -> Option<FilesystemWatcher> {
    let (event_sender, events) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = match notify::recommended_watcher(move |event| {
        let _ = event_sender.send(event);
    }) {
        Ok(watcher) => watcher,
        Err(error) => {
            eprintln!(
                "glyph-context-index: filesystem watch unavailable; using periodic reconciliation: {error}"
            );
            return None;
        }
    };
    if let Err(error) = watcher.watch(root, RecursiveMode::Recursive) {
        eprintln!(
            "glyph-context-index: filesystem watch unavailable; using periodic reconciliation: {error}"
        );
        return None;
    }
    Some(FilesystemWatcher {
        _watcher: watcher,
        events,
        started_at: Instant::now(),
    })
}

fn spawn_monitor(
    state: MonitorState,
    mut watcher: Option<FilesystemWatcher>,
) -> Result<JoinHandle<()>, ServiceError> {
    thread::Builder::new()
        .name("context-index-monitor".to_owned())
        .spawn(move || {
            if state.reconcile_immediately {
                reconcile_shared(&state);
            }

            let mut dirty_since = None;
            let mut last_dirty = None;
            let mut startup_reconcile_at = state
                .reconcile_after_startup_delay
                .then(|| Instant::now() + WATCH_STARTUP_RECONCILE_DELAY);
            let mut next_safety_reconcile = Instant::now()
                + if watcher.is_some() {
                    WATCH_SAFETY_RECONCILE
                } else {
                    WATCH_FALLBACK_RECONCILE
                };

            while !state.stop.load(Ordering::Acquire) {
                let mut watcher_disconnected = false;
                if let Some(active_watcher) = watcher.as_ref() {
                    match active_watcher.events.recv_timeout(WATCH_POLL_INTERVAL) {
                        Ok(Ok(event)) => {
                            if event_requires_reconcile(
                                &event,
                                &state.root,
                                &state.policy,
                                state.cache_path.as_deref(),
                                &state.known_paths,
                            ) {
                                let now = Instant::now();
                                dirty_since.get_or_insert(now);
                                last_dirty = Some(now);
                            }
                        }
                        Ok(Err(error)) => {
                            eprintln!("glyph-context-index: filesystem watch error: {error}");
                            let now = Instant::now();
                            dirty_since.get_or_insert(now);
                            last_dirty = Some(now);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            eprintln!(
                                "glyph-context-index: filesystem watch stopped; using periodic reconciliation"
                            );
                            watcher_disconnected = true;
                            next_safety_reconcile =
                                Instant::now() + WATCH_FALLBACK_RECONCILE;
                        }
                    }
                } else {
                    thread::sleep(WATCH_POLL_INTERVAL);
                }
                if watcher_disconnected {
                    watcher = None;
                }

                let now = Instant::now();
                let debounce_elapsed = last_dirty
                    .is_some_and(|last| now.duration_since(last) >= WATCH_DEBOUNCE);
                let maximum_elapsed = dirty_since
                    .is_some_and(|first| now.duration_since(first) >= WATCH_MAX_DEBOUNCE);
                let startup_elapsed = startup_reconcile_at.is_some_and(|at| now >= at);
                if debounce_elapsed
                    || maximum_elapsed
                    || startup_elapsed
                    || now >= next_safety_reconcile
                {
                    reconcile_shared(&state);
                    dirty_since = None;
                    last_dirty = None;
                    startup_reconcile_at = None;
                    next_safety_reconcile = now
                        + if watcher.is_some() {
                            WATCH_SAFETY_RECONCILE
                        } else {
                            WATCH_FALLBACK_RECONCILE
                        };
                }
            }
        })
        .map_err(|error| {
            ServiceError::initialization(format!(
                "Could not start the filesystem monitor: {error}"
            ))
        })
}

fn reconcile_shared(state: &MonitorState) {
    let scan = match scan_paths(
        &state.root,
        &state.policy,
        state.cache_path.as_deref(),
        &state.stop,
    ) {
        Ok(scan) => scan,
        Err(error) => {
            if !state.stop.load(Ordering::Acquire) {
                eprintln!(
                    "glyph-context-index: background reconcile failed: {}",
                    error.message
                );
            }
            return;
        }
    };
    if state.stop.load(Ordering::Acquire) {
        return;
    }
    let known_paths: BTreeSet<_> = scan.paths.iter().cloned().collect();
    let index = match SearchIndex::from_paths(scan.paths.clone()) {
        Ok(index) => index,
        Err(error) => {
            eprintln!("glyph-context-index: background index build failed: {error}");
            return;
        }
    };
    if let Some(path) = state.cache_path.as_deref() {
        if let Err(error) = cache::store(
            path,
            &state.root_text,
            &state.policy_hash,
            &scan.paths,
            scan.truncated,
        ) {
            eprintln!("glyph-context-index: cache write failed: {error}");
        }
    }
    if state.stop.load(Ordering::Acquire) {
        return;
    }
    match state.index.lock() {
        Ok(mut current) => *current = index,
        Err(_) => {
            eprintln!("glyph-context-index: background index lock is poisoned");
            return;
        }
    }
    match state.known_paths.write() {
        Ok(mut current) => *current = known_paths,
        Err(_) => {
            eprintln!("glyph-context-index: background known-path lock is poisoned");
            return;
        }
    }
    state.truncated.store(scan.truncated, Ordering::Release);
}

fn event_requires_reconcile(
    event: &Event,
    root: &Path,
    policy: &IndexPolicy,
    cache_path: Option<&Path>,
    known_paths: &RwLock<BTreeSet<String>>,
) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }

    let known_paths = match known_paths.read() {
        Ok(known_paths) => known_paths,
        Err(_) => return true,
    };
    if event.paths.is_empty() {
        return true;
    }

    event.paths.iter().any(|path| {
        if cache_path.is_some_and(|cache_path| is_cache_artifact(path, cache_path)) {
            return false;
        }
        let Some(relative) = normalize_relative_path(root, path) else {
            return true;
        };
        if is_ignore_control_file(&relative) {
            return true;
        }
        if policy.excludes(&relative) {
            return false;
        }

        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => true,
            Ok(metadata) if metadata.file_type().is_file() => !known_paths.contains(&relative),
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if known_paths.contains(&relative) {
                    return true;
                }
                let prefix = format!("{relative}/");
                known_paths.iter().any(|known| known.starts_with(&prefix))
            }
            Err(_) => true,
        }
    })
}

fn is_ignore_control_file(relative_path: &str) -> bool {
    relative_path == ".ignore"
        || relative_path.ends_with("/.ignore")
        || relative_path == ".gitignore"
        || relative_path.ends_with("/.gitignore")
        || relative_path == ".git/info/exclude"
}

fn is_cache_artifact(path: &Path, cache_path: &Path) -> bool {
    if path == cache_path {
        return true;
    }
    let Some(cache_name) = cache_path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    path.parent() == cache_path.parent()
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.starts_with(&format!(".{cache_name}.")) && name.ends_with(".tmp")
            })
}

fn scan_paths(
    root: &Path,
    policy: &IndexPolicy,
    cache_path: Option<&Path>,
    stop: &AtomicBool,
) -> Result<ScanResult, ServiceError> {
    let ignored: HashSet<_> = policy.ignored_directories.iter().cloned().collect();
    let excluded_paths = policy.excluded_paths.clone();
    let filter_root = root.to_path_buf();
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .follow_links(false)
        .git_ignore(policy.respect_git_ignore)
        .git_global(policy.respect_git_ignore)
        .git_exclude(policy.respect_git_ignore)
        .ignore(policy.respect_git_ignore)
        .parents(policy.respect_git_ignore)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let is_directory = entry.file_type().is_some_and(|kind| kind.is_dir());
            if !is_directory {
                return true;
            }
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| ignored.contains(name))
            {
                return false;
            }
            normalize_relative_path(&filter_root, entry.path()).is_none_or(|relative| {
                !excluded_paths
                    .iter()
                    .any(|excluded| path_is_excluded(&relative, excluded))
            })
        });

    let paths = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));
    let policy = Arc::new(policy.clone());
    let root = Arc::new(root.to_path_buf());
    let cache_path = cache_path.map(Path::to_path_buf).map(Arc::new);

    builder.build_parallel().run(|| {
        let paths = Arc::clone(&paths);
        let observed = Arc::clone(&observed);
        let truncated = Arc::clone(&truncated);
        let policy = Arc::clone(&policy);
        let root = Arc::clone(&root);
        let cache_path = cache_path.clone();
        Box::new(move |entry| {
            if stop.load(Ordering::Acquire) {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                return WalkState::Continue;
            }
            if cache_path
                .as_ref()
                .is_some_and(|path| is_cache_artifact(entry.path(), path.as_path()))
            {
                return WalkState::Continue;
            }
            let Some(relative) = normalize_relative_path(&root, entry.path()) else {
                return WalkState::Continue;
            };
            if policy.excludes(&relative) {
                return WalkState::Continue;
            }
            let position = observed.fetch_add(1, Ordering::AcqRel);
            if position >= policy.max_files as usize {
                truncated.store(true, Ordering::Release);
                return WalkState::Quit;
            }
            match paths.lock() {
                Ok(mut paths) => paths.push(relative),
                Err(_) => return WalkState::Quit,
            }
            WalkState::Continue
        })
    });

    if stop.load(Ordering::Acquire) {
        return Err(ServiceError::initialization("File indexing was cancelled."));
    }
    let mut paths = Arc::try_unwrap(paths)
        .map_err(|_| ServiceError::internal("File scan paths are still shared."))?
        .into_inner()
        .map_err(|_| ServiceError::internal("The file scan lock is poisoned."))?;
    paths.sort_unstable();
    paths.dedup();
    Ok(ScanResult {
        paths,
        truncated: truncated.load(Ordering::Acquire),
    })
}

fn normalize_relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_str()?),
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn cached_paths_are_allowed(cached: &CachedPaths, policy: &IndexPolicy) -> bool {
    cached.paths.iter().all(|path| !policy.excludes(path))
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn default_ignored_directories() -> Vec<String> {
    [
        ".git",
        ".next",
        "coverage",
        "dist",
        "node_modules",
        "target",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

fn default_sensitive_file_names() -> Vec<String> {
    [".netrc", ".npmrc", ".pypirc"]
        .into_iter()
        .map(str::to_owned)
        .collect()
}

fn default_sensitive_file_prefixes() -> Vec<String> {
    vec![".env".to_owned()]
}

fn default_sensitive_file_extensions() -> Vec<String> {
    [".key", ".pem", ".p12", ".pfx"]
        .into_iter()
        .map(str::to_owned)
        .collect()
}

fn default_allowed_file_names() -> Vec<String> {
    vec![".env.example".to_owned()]
}

fn default_true() -> bool {
    true
}

fn default_max_files() -> u32 {
    DEFAULT_MAX_FILES
}

fn default_glob_limit() -> u32 {
    DEFAULT_GLOB_LIMIT
}

fn default_case_sensitive() -> bool {
    !cfg!(any(target_os = "windows", target_os = "macos"))
}

fn default_search_limit() -> u32 {
    DEFAULT_SEARCH_LIMIT
}

#[cfg(test)]
mod tests {
    use std::fs::{create_dir_all, write};
    use std::thread::sleep;

    use notify::event::{CreateKind, ModifyKind};
    use tempfile::tempdir;

    use super::*;

    fn params(root: &Path) -> InitializeParams {
        InitializeParams {
            root: root.to_string_lossy().into_owned(),
            cache_path: None,
            ignored_directories: default_ignored_directories(),
            sensitive_file_names: default_sensitive_file_names(),
            sensitive_file_prefixes: default_sensitive_file_prefixes(),
            sensitive_file_extensions: default_sensitive_file_extensions(),
            allowed_file_names: default_allowed_file_names(),
            excluded_paths: Vec::new(),
            respect_git_ignore: true,
            max_files: DEFAULT_MAX_FILES,
            case_sensitive: default_case_sensitive(),
        }
    }

    #[test]
    fn excluded_paths_require_normalized_project_relative_paths() {
        let directory = tempdir().expect("temporary directory should exist");
        for invalid in [
            "",
            "/src/generated",
            "C:/src/generated",
            "src/generated/",
            "src//generated",
            ".",
            "..",
            "src/./generated",
            "src/../generated",
            "src\\generated",
            "src\0generated",
        ] {
            let mut configuration = params(directory.path());
            configuration.excluded_paths = vec![invalid.to_owned()];
            let error = IndexPolicy::from(&configuration)
                .validate()
                .expect_err("invalid excluded path should be rejected");
            assert_eq!(error.code, "INVALID_REQUEST", "accepted {invalid:?}");
            assert!(error.message.contains("excludedPaths"));
        }

        let mut configuration = params(directory.path());
        configuration.excluded_paths =
            vec!["src/generated".to_owned(), "docs/private.md".to_owned()];
        IndexPolicy::from(&configuration)
            .validate()
            .expect("normalized excluded paths should be accepted");
    }

    #[test]
    fn excluded_paths_match_exact_paths_and_descendants_at_component_boundaries() {
        let directory = tempdir().expect("temporary directory should exist");
        let mut configuration = params(directory.path());
        configuration.excluded_paths =
            vec!["src/generated".to_owned(), "docs/private.md".to_owned()];
        let policy = IndexPolicy::from(&configuration);

        assert!(policy.excludes("src/generated"));
        assert!(policy.excludes("src/generated/client/api.ts"));
        assert!(policy.excludes("docs/private.md"));
        assert!(!policy.excludes("src/generated-client/api.ts"));
        assert!(!policy.excludes("docs/private.md.backup"));
    }

    #[test]
    fn excluded_paths_change_the_cache_policy_fingerprint() {
        let directory = tempdir().expect("temporary directory should exist");
        let baseline = IndexPolicy::from(&params(directory.path()));
        let mut configuration = params(directory.path());
        configuration.excluded_paths = vec!["src/generated".to_owned()];
        let excluded = IndexPolicy::from(&configuration);

        assert_ne!(
            cache::policy_fingerprint(&baseline).expect("baseline policy should hash"),
            cache::policy_fingerprint(&excluded).expect("excluded policy should hash")
        );
    }

    #[test]
    fn scan_prunes_excluded_files_and_subtrees() {
        let directory = tempdir().expect("temporary directory should exist");
        create_dir_all(directory.path().join("src/generated/nested"))
            .expect("excluded directory should exist");
        create_dir_all(directory.path().join("src/generated-client"))
            .expect("included sibling directory should exist");
        create_dir_all(directory.path().join("docs")).expect("docs should exist");
        write(directory.path().join("src/generated/nested/api.ts"), "")
            .expect("excluded subtree fixture should write");
        write(directory.path().join("src/generated-client/api.ts"), "")
            .expect("included sibling fixture should write");
        write(directory.path().join("docs/private.md"), "")
            .expect("excluded file fixture should write");
        write(directory.path().join("docs/public.md"), "")
            .expect("included file fixture should write");
        let mut configuration = params(directory.path());
        configuration.excluded_paths =
            vec!["src/generated".to_owned(), "docs/private.md".to_owned()];
        let policy = IndexPolicy::from(&configuration);

        let result = scan_paths(directory.path(), &policy, None, &AtomicBool::new(false))
            .expect("scan should complete");

        assert_eq!(
            result.paths,
            vec!["docs/public.md", "src/generated-client/api.ts"]
        );
    }

    #[test]
    fn watcher_ignores_events_inside_excluded_subtrees() {
        let directory = tempdir().expect("temporary directory should exist");
        create_dir_all(directory.path().join("src/generated"))
            .expect("excluded directory should exist");
        let path = directory.path().join("src/generated/new.ts");
        write(&path, "").expect("excluded fixture should write");
        let known = RwLock::new(BTreeSet::new());
        let mut configuration = params(directory.path());
        configuration.excluded_paths = vec!["src/generated".to_owned()];
        let policy = IndexPolicy::from(&configuration);
        let event = Event {
            kind: EventKind::Create(CreateKind::File),
            paths: vec![path],
            attrs: Default::default(),
        };

        assert!(!event_requires_reconcile(
            &event,
            directory.path(),
            &policy,
            None,
            &known,
        ));
    }

    #[test]
    fn scan_respects_project_and_sensitive_file_exclusions() {
        let directory = tempdir().expect("temporary directory should exist");
        create_dir_all(directory.path().join("src")).expect("src should exist");
        create_dir_all(directory.path().join("node_modules/pkg"))
            .expect("dependency directory should exist");
        create_dir_all(directory.path().join("target/release"))
            .expect("Rust build directory should exist");
        write(directory.path().join("src/App.tsx"), "export {}")
            .expect("source fixture should write");
        write(directory.path().join("node_modules/pkg/index.js"), "")
            .expect("dependency fixture should write");
        write(directory.path().join("target/release/native-artifact"), "")
            .expect("Rust build fixture should write");
        write(directory.path().join(".env"), "SECRET=1").expect("secret fixture should write");
        write(directory.path().join(".env.example"), "SECRET=")
            .expect("allowed fixture should write");

        let policy = IndexPolicy::from(&params(directory.path()));
        let result = scan_paths(directory.path(), &policy, None, &AtomicBool::new(false))
            .expect("scan should complete");

        assert_eq!(result.paths, vec![".env.example", "src/App.tsx"]);
    }

    #[test]
    fn scan_respects_gitignore_and_can_disable_it() {
        let directory = tempdir().expect("temporary directory should exist");
        create_dir_all(directory.path().join("generated"))
            .expect("generated directory should exist");
        create_dir_all(directory.path().join(".git")).expect("git marker should exist");
        write(directory.path().join(".gitignore"), "generated/\n")
            .expect("ignore fixture should write");
        write(directory.path().join("generated/output.ts"), "")
            .expect("generated fixture should write");

        let respected = IndexPolicy::from(&params(directory.path()));
        let respected_paths =
            scan_paths(directory.path(), &respected, None, &AtomicBool::new(false))
                .expect("scan should complete")
                .paths;
        let mut disabled_params = params(directory.path());
        disabled_params.respect_git_ignore = false;
        let disabled = IndexPolicy::from(&disabled_params);
        let disabled_paths = scan_paths(directory.path(), &disabled, None, &AtomicBool::new(false))
            .expect("scan should complete")
            .paths;

        assert!(!respected_paths.contains(&"generated/output.ts".to_owned()));
        assert!(disabled_paths.contains(&"generated/output.ts".to_owned()));
    }

    #[test]
    fn service_loads_cache_then_reconciles_it() {
        let directory = tempdir().expect("temporary directory should exist");
        let cache_directory = tempdir().expect("cache directory should exist");
        write(directory.path().join("first.ts"), "").expect("fixture should write");
        let cache_path = cache_directory.path().join("index.bin");

        let mut first_service = ContextIndexService::new();
        let mut first_params = params(directory.path());
        first_params.cache_path = Some(cache_path.clone());
        let first = first_service
            .initialize(first_params)
            .expect("first initialization should work");
        assert!(!first.from_cache);
        let _ = first_service.shutdown();

        write(directory.path().join("second.ts"), "").expect("new fixture should write");
        let mut second_service = ContextIndexService::new();
        let mut second_params = params(directory.path());
        second_params.cache_path = Some(cache_path);
        let second = second_service
            .initialize(second_params)
            .expect("cached initialization should work");
        assert!(second.from_cache);
        assert_eq!(second.file_count, 1);

        assert!(wait_for_match(&second_service, "second", "second.ts"));
        let _ = second_service.shutdown();
    }

    #[test]
    fn monitor_adds_a_file_created_after_initialization() {
        let directory = tempdir().expect("temporary directory should exist");
        write(directory.path().join("first.ts"), "").expect("fixture should write");
        let mut service = ContextIndexService::new();
        service
            .initialize(params(directory.path()))
            .expect("initialization should work");

        write(directory.path().join("created-after-init.ts"), "")
            .expect("new fixture should write");

        assert!(wait_for_match(
            &service,
            "createdafter",
            "created-after-init.ts"
        ));
        let _ = service.shutdown();
    }

    #[test]
    fn service_glob_uses_the_shared_filtered_path_catalog() {
        let directory = tempdir().expect("temporary directory should exist");
        create_dir_all(directory.path().join("src/nested")).expect("source directory should exist");
        create_dir_all(directory.path().join("tests")).expect("test directory should exist");
        write(directory.path().join("src/App.tsx"), "").expect("fixture should write");
        write(directory.path().join("src/nested/Card.tsx"), "").expect("fixture should write");
        write(directory.path().join("tests/App.test.tsx"), "").expect("fixture should write");
        write(directory.path().join(".env.local"), "SECRET=1")
            .expect("sensitive fixture should write");
        let mut configuration = params(directory.path());
        configuration.case_sensitive = true;
        let mut service = ContextIndexService::new();
        service
            .initialize(configuration)
            .expect("initialization should work");

        let result = service
            .glob(GlobParams {
                pattern: "*.tsx".to_owned(),
                target_directory: Some("src".to_owned()),
                limit: 20,
            })
            .expect("glob should work");
        let secrets = service
            .glob(GlobParams {
                pattern: ".env*".to_owned(),
                target_directory: None,
                limit: 20,
            })
            .expect("glob should work");

        assert_eq!(
            result.files,
            ["src/App.tsx".to_owned(), "src/nested/Card.tsx".to_owned()]
        );
        assert!(!result.truncated);
        assert!(secrets.files.is_empty());
        let _ = service.shutdown();
    }

    #[test]
    fn service_glob_rejects_unsafe_target_directories_and_limits() {
        let directory = tempdir().expect("temporary directory should exist");
        let mut service = ContextIndexService::new();
        service
            .initialize(params(directory.path()))
            .expect("initialization should work");

        for params in [
            GlobParams {
                pattern: "*.ts".to_owned(),
                target_directory: Some("../outside".to_owned()),
                limit: 20,
            },
            GlobParams {
                pattern: "*.ts".to_owned(),
                target_directory: None,
                limit: 0,
            },
        ] {
            assert_eq!(
                service
                    .glob(params)
                    .expect_err("invalid glob request should fail")
                    .code,
                "INVALID_REQUEST"
            );
        }
        let _ = service.shutdown();
    }

    #[test]
    fn content_changes_do_not_require_a_path_reconcile() {
        let directory = tempdir().expect("temporary directory should exist");
        let path = directory.path().join("src.ts");
        write(&path, "before").expect("fixture should write");
        let known = RwLock::new(BTreeSet::from(["src.ts".to_owned()]));
        let policy = IndexPolicy::from(&params(directory.path()));
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            paths: vec![path],
            attrs: Default::default(),
        };

        assert!(!event_requires_reconcile(
            &event,
            directory.path(),
            &policy,
            None,
            &known,
        ));
    }

    #[test]
    fn ignore_file_content_changes_require_a_reconcile() {
        let directory = tempdir().expect("temporary directory should exist");
        let path = directory.path().join(".gitignore");
        write(&path, "generated/\n").expect("fixture should write");
        let known = RwLock::new(BTreeSet::new());
        let policy = IndexPolicy::from(&params(directory.path()));
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            paths: vec![path],
            attrs: Default::default(),
        };

        assert!(event_requires_reconcile(
            &event,
            directory.path(),
            &policy,
            None,
            &known,
        ));
    }

    fn wait_for_match(service: &ContextIndexService, query: &str, expected_path: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut generation = 0;
        while Instant::now() < deadline {
            generation += 1;
            let latest = AtomicU64::new(generation);
            let result = service
                .search(
                    SearchParams {
                        query: query.to_owned(),
                        limit: 20,
                        generation,
                    },
                    &latest,
                )
                .expect("search should work while waiting for reconciliation");
            if result.matches.iter().any(|item| item.path == expected_path) {
                return true;
            }
            sleep(Duration::from_millis(50));
        }
        false
    }
}
