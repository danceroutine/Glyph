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
use crate::content_search::{ContentSearchContext, ContentSearchError};
use crate::index::{SearchFailure, SearchIndex, SearchResult};
use crate::path_glob::{find_matches, GlobResult};
use crate::workers::{SystemWorkers, WorkerFactory, WorkerRole};

const DEFAULT_MAX_FILES: u32 = 2_000_000;
const DEFAULT_SEARCH_LIMIT: u32 = 20;
const MAX_SEARCH_LIMIT: u32 = 100;
const DEFAULT_GLOB_LIMIT: u32 = 2_000;
const MAX_GLOB_LIMIT: u32 = 10_000;
const MAX_QUERY_CHARS: usize = 4_096;
const DEFAULT_MAX_CONTENT_SEARCH_FILE_BYTES: u64 = 8 * 1_024 * 1_024;
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
    #[serde(default = "default_max_content_search_file_bytes")]
    pub(crate) max_content_search_file_bytes: u64,
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
        // Normalize policy and candidates alike; walking, watch updates, and
        // cache validation must agree with the workspace reader's case policy.
        let normalize = |values: &[String]| -> Vec<String> {
            values
                .iter()
                .map(|value| {
                    if params.case_sensitive {
                        value.clone()
                    } else {
                        value.to_lowercase()
                    }
                })
                .collect()
        };
        Self {
            ignored_directories: normalize(&params.ignored_directories),
            sensitive_file_names: normalize(&params.sensitive_file_names),
            sensitive_file_prefixes: normalize(&params.sensitive_file_prefixes),
            sensitive_file_extensions: normalize(&params.sensitive_file_extensions),
            allowed_file_names: normalize(&params.allowed_file_names),
            excluded_paths: normalize(&params.excluded_paths),
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
        let folded;
        let relative_path = if self.case_sensitive {
            relative_path
        } else {
            folded = relative_path.to_lowercase();
            &folded
        };
        if self
            .excluded_paths
            .iter()
            .any(|excluded| path_is_excluded(relative_path, excluded))
        {
            return true;
        }
        let name = relative_path
            .rsplit_once('/')
            .map_or(relative_path, |(_, name)| name);
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

/// The native path and its protocol representation refer to the same canonical directory.
struct ProjectRoot {
    path: PathBuf,
    text: String,
}

impl ProjectRoot {
    fn resolve(input: &Path) -> Result<Self, ServiceError> {
        let path = fs::canonicalize(input).map_err(|error| {
            ServiceError::initialization(format!("Could not resolve the project root: {error}"))
        })?;
        if !path.is_dir() {
            return Err(ServiceError::invalid_request(
                "root must refer to a directory.",
            ));
        }
        Self::from_canonical(path)
    }

    fn from_canonical(path: PathBuf) -> Result<Self, ServiceError> {
        let text = path
            .to_str()
            .ok_or_else(|| {
                ServiceError::initialization("The canonical project root is not valid UTF-8.")
            })?
            .to_owned();
        Ok(Self { path, text })
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
    max_content_search_file_bytes: u64,
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
        self.initialize_with_workers(params, &SystemWorkers)
    }

    fn initialize_with_workers(
        &mut self,
        params: InitializeParams,
        workers: &impl WorkerFactory,
    ) -> Result<IndexStatus, ServiceError> {
        if self.initialized.is_some() {
            return Err(ServiceError::invalid_request(
                "The context index has already been initialized.",
            ));
        }
        let started = Instant::now();
        let policy = IndexPolicy::from(&params);
        policy.validate()?;
        if params.max_content_search_file_bytes == 0 {
            return Err(ServiceError::invalid_request(
                "maxContentSearchFileBytes must be positive.",
            ));
        }
        let root_input = Path::new(&params.root);
        if !root_input.is_absolute() {
            return Err(ServiceError::invalid_request(
                "root must be an absolute path.",
            ));
        }
        let ProjectRoot {
            path: root,
            text: root_text,
        } = ProjectRoot::resolve(root_input)?;
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
        let index = SearchIndex::from_paths(paths);
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
            max_content_search_file_bytes: params.max_content_search_file_bytes,
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
            workers,
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

    pub(crate) fn content_search_context(&self) -> Result<ContentSearchContext, ServiceError> {
        let initialized = self
            .initialized
            .as_ref()
            .ok_or_else(ServiceError::not_initialized)?;
        Ok(ContentSearchContext::new(
            initialized.root.clone(),
            Arc::clone(&initialized.known_paths),
            Arc::clone(&initialized.truncated),
            initialized.policy.case_sensitive,
            initialized.max_content_search_file_bytes,
        ))
    }

    pub(crate) fn filter_paths(&self, paths: Vec<String>) -> Result<Vec<String>, ServiceError> {
        if paths.len() > 2_000
            || paths
                .iter()
                .any(|path| !is_normalized_project_relative_path(path))
        {
            return Err(ServiceError::invalid_request(
                "Expected at most 2000 normalized editor paths.",
            ));
        }
        let initialized = self
            .initialized
            .as_ref()
            .ok_or_else(ServiceError::not_initialized)?;
        let known = initialized
            .known_paths
            .read()
            .map_err(|_| ServiceError::internal("The known-path set lock is poisoned."))?;
        let mut selected = BTreeSet::new();
        let mut aliases = HashSet::new();
        for path in paths {
            if known.contains(&path) {
                selected.insert(path);
            } else if !initialized.policy.case_sensitive {
                aliases.insert(path.to_lowercase());
            }
        }
        // Keep the catalog spelling so the replacement targets the same candidate
        // even when a case-insensitive editor URI used another spelling.
        if !aliases.is_empty() {
            for path in known.iter() {
                if aliases.contains(&path.to_lowercase()) {
                    selected.insert(path.clone());
                }
            }
        }
        Ok(selected.into_iter().collect())
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
        let index = SearchIndex::from_paths(scan.paths);
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
    start_watcher_with(root, |sender| {
        notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
    })
}

fn start_watcher_with(
    root: &Path,
    create: impl FnOnce(
        mpsc::Sender<notify::Result<Event>>,
    ) -> notify::Result<notify::RecommendedWatcher>,
) -> Option<FilesystemWatcher> {
    let (event_sender, events) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = match create(event_sender) {
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
    workers: &impl WorkerFactory,
) -> Result<JoinHandle<()>, ServiceError> {
    workers.spawn(WorkerRole::FilesystemMonitor, move || {
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

/// The authoritative catalog scan and its optional durable checkpoint form the
/// repository boundary. Publication to live readers remains the service's job.
trait CatalogRepository {
    fn scan(&self) -> Result<ScanResult, ServiceError>;
    fn save(&self, snapshot: &ScanResult) -> Result<(), String>;
}

struct FilesystemCatalog<'a>(&'a MonitorState);

impl CatalogRepository for FilesystemCatalog<'_> {
    fn scan(&self) -> Result<ScanResult, ServiceError> {
        scan_paths(
            &self.0.root,
            &self.0.policy,
            self.0.cache_path.as_deref(),
            &self.0.stop,
        )
    }

    fn save(&self, snapshot: &ScanResult) -> Result<(), String> {
        if let Some(path) = self.0.cache_path.as_deref() {
            cache::store(
                path,
                &self.0.root_text,
                &self.0.policy_hash,
                &snapshot.paths,
                snapshot.truncated,
            )?;
        }
        Ok(())
    }
}

fn reconcile_shared(state: &MonitorState) {
    reconcile_catalog(state, &FilesystemCatalog(state));
}

fn reconcile_catalog(state: &MonitorState, catalog: &impl CatalogRepository) {
    let Ok(scan) = catalog.scan() else {
        // The scan's only failure is cancellation; stop is never cleared.
        return;
    };
    if state.stop.load(Ordering::Acquire) {
        return;
    }
    let known_paths: BTreeSet<_> = scan.paths.iter().cloned().collect();
    let index = SearchIndex::from_paths(scan.paths.clone());
    if let Err(error) = catalog.save(&scan) {
        eprintln!("glyph-context-index: cache write failed: {error}");
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

    // WalkParallel::run joins its visitors before returning. Borrow the local
    // accumulator so no shared owner or fallible ownership recovery is needed.
    let paths = Mutex::new(Vec::new());
    let observed = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));
    let policy = Arc::new(policy.clone());
    let root = Arc::new(root.to_path_buf());
    let cache_path = cache_path.map(Path::to_path_buf).map(Arc::new);

    builder.build_parallel().run(|| {
        let paths = &paths;
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
            // Only Vec<String>::push runs under this private lock; no callback
            // can unwind while holding it.
            paths
                .lock()
                .expect("scan accumulator cannot be poisoned")
                .push(relative);
            WalkState::Continue
        })
    });

    if stop.load(Ordering::Acquire) {
        return Err(ServiceError::initialization("File indexing was cancelled."));
    }
    let mut paths = paths
        .into_inner()
        .expect("scan accumulator cannot be poisoned");
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
    [".git-credentials", ".netrc", ".npmrc", ".pypirc"]
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

fn default_max_content_search_file_bytes() -> u64 {
    DEFAULT_MAX_CONTENT_SEARCH_FILE_BYTES
}

pub(crate) fn content_search_error(error: ContentSearchError) -> ServiceError {
    match error {
        ContentSearchError::InvalidRequest(message) => ServiceError::invalid_request(message),
        ContentSearchError::Cancelled => ServiceError {
            code: "CANCELLED",
            message: "The project content search was cancelled.".to_owned(),
        },
        ContentSearchError::Internal(message) => ServiceError::internal(message),
    }
}

fn default_search_limit() -> u32 {
    DEFAULT_SEARCH_LIMIT
}

#[cfg(test)]
mod tests;
