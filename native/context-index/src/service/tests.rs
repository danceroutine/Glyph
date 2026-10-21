use std::fs::{create_dir_all, write};
use std::thread::sleep;

use notify::event::{CreateKind, ModifyKind};
use tempfile::tempdir;

use super::*;

#[derive(Clone)]
struct MonitorWorkers {
    available: bool,
}

impl WorkerFactory for MonitorWorkers {
    fn spawn<T: Send + 'static>(
        &self,
        role: WorkerRole,
        task: impl FnOnce() -> T + Send + 'static,
    ) -> std::io::Result<JoinHandle<T>> {
        assert_eq!(role, WorkerRole::FilesystemMonitor);
        if self.available {
            SystemWorkers.spawn(role, task)
        } else {
            Err(std::io::Error::other("thread resources exhausted"))
        }
    }
}

#[test]
fn monitor_startup_failure_does_not_publish_initialized_state_and_allows_retry() {
    let directory = tempdir().unwrap();
    write(directory.path().join("a.ts"), "").unwrap();
    let mut service = ContextIndexService::new();
    let error = service
        .initialize_with_workers(
            params(directory.path()),
            &MonitorWorkers { available: false },
        )
        .err()
        .unwrap();
    assert_eq!(error.code, "INITIALIZATION_FAILED");
    assert_eq!(
        error.message,
        "Could not start the filesystem monitor: thread resources exhausted"
    );
    assert!(service.initialized.is_none());
    assert!(service.monitor.is_none());
    assert!(!service.stop.load(Ordering::Acquire));
    assert_eq!(
        service
            .initialize(params(directory.path()))
            .unwrap()
            .file_count,
        1
    );
    assert!(service.shutdown().shutdown);
}

#[test]
fn watcher_construction_failure_uses_the_existing_unwatched_monitor_path() {
    let directory = tempdir().unwrap();
    write(directory.path().join("a.ts"), "").unwrap();
    let watcher = start_watcher_with(directory.path(), |_| {
        Err(notify::Error::generic("backend unavailable"))
    });
    assert!(watcher.is_none());
    let stop = Arc::new(AtomicBool::new(false));
    let mut state = monitor_state(directory.path(), &stop);
    state.reconcile_immediately = true;
    let known = Arc::clone(&state.known_paths);
    let monitor = spawn_monitor(state, watcher, &SystemWorkers).unwrap();
    let reconciled = wait_until(|| known.read().unwrap().contains("a.ts"));
    stop.store(true, Ordering::Release);
    monitor.join().unwrap();
    assert!(reconciled);
}

#[cfg(unix)]
#[test]
fn canonical_roots_must_have_a_lossless_protocol_representation() {
    use std::os::unix::ffi::OsStringExt;
    let path = PathBuf::from(std::ffi::OsString::from_vec(b"/project/\xff".to_vec()));
    let error = ProjectRoot::from_canonical(path).err().unwrap();
    assert_eq!(error.code, "INITIALIZATION_FAILED");
    assert_eq!(
        error.message,
        "The canonical project root is not valid UTF-8."
    );
}

#[cfg(target_os = "linux")]
#[test]
fn a_utf8_symlink_to_a_non_utf8_root_is_rejected_after_canonicalization() {
    use std::os::unix::ffi::OsStringExt;
    let directory = tempdir().unwrap();
    let target = directory
        .path()
        .join(std::ffi::OsString::from_vec(vec![0xff]));
    create_dir_all(&target).unwrap();
    let link = directory.path().join("workspace");
    std::os::unix::fs::symlink(target, &link).unwrap();
    let mut service = ContextIndexService::new();
    let error = service.initialize(params(&link)).err().unwrap();
    assert_eq!(
        error.message,
        "The canonical project root is not valid UTF-8."
    );
    assert!(service.initialized.is_none());
}

#[test]
fn shutdown_during_catalog_io_does_not_publish_the_new_snapshot() {
    struct StoppingCatalog<'a> {
        stop: &'a AtomicBool,
        during_scan: bool,
        saves: std::cell::Cell<usize>,
        storage: FilesystemCatalog<'a>,
    }
    impl CatalogRepository for StoppingCatalog<'_> {
        fn scan(&self) -> Result<ScanResult, ServiceError> {
            if self.during_scan {
                self.stop.store(true, Ordering::Release);
            }
            Ok(ScanResult {
                paths: vec!["new.ts".into()],
                truncated: true,
            })
        }
        fn save(&self, snapshot: &ScanResult) -> Result<(), String> {
            self.saves.set(self.saves.get() + 1);
            self.storage.save(snapshot)?;
            self.stop.store(true, Ordering::Release);
            Ok(())
        }
    }
    for during_scan in [true, false] {
        let directory = tempdir().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let mut state = monitor_state(directory.path(), &stop);
        let cache_path = directory.path().join("index.bin");
        state.cache_path = Some(cache_path.clone());
        let catalog = StoppingCatalog {
            stop: &stop,
            during_scan,
            saves: std::cell::Cell::new(0),
            storage: FilesystemCatalog(&state),
        };
        reconcile_catalog(&state, &catalog);
        assert_eq!(catalog.saves.get(), usize::from(!during_scan));
        assert_eq!(state.index.lock().unwrap().file_count(), 0);
        assert!(state.known_paths.read().unwrap().is_empty());
        assert!(!state.truncated.load(Ordering::Acquire));
        assert_eq!(cache_path.exists(), !during_scan);
        if !during_scan {
            let checkpoint = cache::load(&cache_path, &state.root_text, &state.policy_hash, 10)
                .unwrap()
                .unwrap();
            assert_eq!(checkpoint.paths, ["new.ts"]);
            assert!(checkpoint.truncated);
        }
    }
}

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
        max_content_search_file_bytes: DEFAULT_MAX_CONTENT_SEARCH_FILE_BYTES,
    }
}

#[test]
fn scan_excludes_sensitive_names_using_filesystem_case_policy() {
    let directory = tempdir().expect("fixture directory");
    for name in [
        ".ENV",
        ".ENV.production",
        "private.PEM",
        "public.txt",
        ".ENV.EXAMPLE",
    ] {
        write(directory.path().join(name), "harmless search fixture").unwrap();
    }
    let mut input = params(directory.path());
    input.case_sensitive = false;
    input.respect_git_ignore = false;
    let policy = IndexPolicy::from(&input);
    let result = scan_paths(directory.path(), &policy, None, &AtomicBool::new(false)).unwrap();
    assert_eq!(result.paths, vec![".ENV.EXAMPLE", "public.txt"]);
    assert!(policy.excludes(".GIT/config"));
    assert!(policy.excludes("folder/private.PEM"));
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
    configuration.excluded_paths = vec!["src/generated".to_owned(), "docs/private.md".to_owned()];
    IndexPolicy::from(&configuration)
        .validate()
        .expect("normalized excluded paths should be accepted");
}

#[test]
fn excluded_paths_match_exact_paths_and_descendants_at_component_boundaries() {
    let directory = tempdir().expect("temporary directory should exist");
    let mut configuration = params(directory.path());
    configuration.excluded_paths = vec!["src/generated".to_owned(), "docs/private.md".to_owned()];
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
    write(directory.path().join("docs/public.md"), "").expect("included file fixture should write");
    let mut configuration = params(directory.path());
    configuration.excluded_paths = vec!["src/generated".to_owned(), "docs/private.md".to_owned()];
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
    write(directory.path().join("src/App.tsx"), "export {}").expect("source fixture should write");
    write(directory.path().join("node_modules/pkg/index.js"), "")
        .expect("dependency fixture should write");
    write(directory.path().join("target/release/native-artifact"), "")
        .expect("Rust build fixture should write");
    write(directory.path().join(".env"), "SECRET=1").expect("secret fixture should write");
    write(directory.path().join(".env.example"), "SECRET=").expect("allowed fixture should write");

    let policy = IndexPolicy::from(&params(directory.path()));
    let result = scan_paths(directory.path(), &policy, None, &AtomicBool::new(false))
        .expect("scan should complete");

    assert_eq!(result.paths, vec![".env.example", "src/App.tsx"]);
}

#[test]
fn scan_respects_gitignore_and_can_disable_it() {
    let directory = tempdir().expect("temporary directory should exist");
    create_dir_all(directory.path().join("generated")).expect("generated directory should exist");
    create_dir_all(directory.path().join(".git")).expect("git marker should exist");
    write(directory.path().join(".gitignore"), "generated/\n")
        .expect("ignore fixture should write");
    write(directory.path().join("generated/output.ts"), "")
        .expect("generated fixture should write");

    let respected = IndexPolicy::from(&params(directory.path()));
    let respected_paths = scan_paths(directory.path(), &respected, None, &AtomicBool::new(false))
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

    write(directory.path().join("created-after-init.ts"), "").expect("new fixture should write");

    assert!(wait_for_match(
        &service,
        "createdafter",
        "created-after-init.ts"
    ));
    let _ = service.shutdown();
}

#[test]
fn editor_paths_use_catalog_spelling_and_preserve_case_and_exclusion_policy() {
    for case_sensitive in [true, false] {
        let directory = tempdir().unwrap();
        create_dir_all(directory.path().join("src")).unwrap();
        write(directory.path().join("src/Café.ts"), "text").unwrap();
        write(directory.path().join(".env"), "secret").unwrap();
        let mut configuration = params(directory.path());
        configuration.case_sensitive = case_sensitive;
        let mut service = ContextIndexService::new();
        service.initialize(configuration).unwrap();
        let paths = service
            .filter_paths(vec!["SRC/CAFÉ.TS".to_owned(), ".env".to_owned()])
            .unwrap();
        assert_eq!(
            paths,
            if case_sensitive {
                vec![]
            } else {
                vec!["src/Café.ts"]
            }
        );
        assert!(service.filter_paths(vec!["../outside".to_owned()]).is_err());
        service.shutdown();
    }
}

#[test]
fn service_glob_uses_the_shared_filtered_path_catalog() {
    let directory = tempdir().expect("temporary directory should exist");
    create_dir_all(directory.path().join("src/nested")).expect("source directory should exist");
    create_dir_all(directory.path().join("tests")).expect("test directory should exist");
    write(directory.path().join("src/App.tsx"), "").expect("fixture should write");
    write(directory.path().join("src/nested/Card.tsx"), "").expect("fixture should write");
    write(directory.path().join("tests/App.test.tsx"), "").expect("fixture should write");
    write(directory.path().join(".env.local"), "SECRET=1").expect("sensitive fixture should write");
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

fn wait_until(condition: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        sleep(Duration::from_millis(20));
        if condition() || Instant::now() >= deadline {
            return condition();
        }
    }
}

fn poison_index(index: Arc<Mutex<SearchIndex>>) {
    let _ = thread::spawn(move || {
        let _guard = index.lock().expect("index lock should work");
        panic!("poison the file index");
    })
    .join();
}

fn poison_known_paths(known_paths: Arc<RwLock<BTreeSet<String>>>) {
    let _ = thread::spawn(move || {
        let _guard = known_paths.write().expect("known-path lock should work");
        panic!("poison the known-path set");
    })
    .join();
}

fn initialized(service: &ContextIndexService) -> &InitializedIndex {
    service
        .initialized
        .as_ref()
        .expect("service should be initialized")
}

fn search_params(query: &str, limit: u32, generation: u64) -> SearchParams {
    SearchParams {
        query: query.to_owned(),
        limit,
        generation,
    }
}

fn monitor_state(root: &Path, stop: &Arc<AtomicBool>) -> MonitorState {
    let root = fs::canonicalize(root).expect("root should canonicalize");
    let policy = IndexPolicy::from(&params(&root));
    MonitorState {
        root_text: root.to_string_lossy().into_owned(),
        root,
        policy_hash: cache::policy_fingerprint(&policy).expect("policy should hash"),
        policy,
        cache_path: None,
        index: Arc::new(Mutex::new(SearchIndex::from_paths(Vec::new()))),
        known_paths: Arc::new(RwLock::new(BTreeSet::new())),
        truncated: Arc::new(AtomicBool::new(false)),
        stop: Arc::clone(stop),
        reconcile_immediately: false,
        reconcile_after_startup_delay: false,
    }
}

fn event(kind: EventKind, paths: Vec<PathBuf>) -> Event {
    Event {
        kind,
        paths,
        attrs: Default::default(),
    }
}

#[test]
fn index_policies_require_positive_limits_and_plain_names() {
    let directory = tempdir().expect("temporary directory should exist");
    let mut without_files = params(directory.path());
    without_files.max_files = 0;
    let mut nested_name = params(directory.path());
    nested_name.sensitive_file_names = vec!["config/.env".to_owned()];
    let mut empty_name = params(directory.path());
    empty_name.allowed_file_names = vec![String::new()];
    let mut windows_name = params(directory.path());
    windows_name.ignored_directories = vec!["build\\output".to_owned()];

    let errors = [without_files, nested_name, empty_name, windows_name]
        .iter()
        .map(|configuration| {
            IndexPolicy::from(configuration)
                .validate()
                .expect_err("policy should be rejected")
                .message
        })
        .collect::<Vec<_>>();

    assert_eq!(
        errors,
        [
            "maxFiles must be positive.",
            "sensitiveFileNames entries must be non-empty file or directory names.",
            "allowedFileNames entries must be non-empty file or directory names.",
            "ignoredDirectories entries must be non-empty file or directory names.",
        ]
    );
}

#[test]
fn initialization_rejects_unusable_roots_and_settings() {
    let directory = tempdir().expect("temporary directory should exist");
    let file = directory.path().join("file.txt");
    write(&file, "").expect("fixture should write");
    let mut invalid_policy = params(directory.path());
    invalid_policy.max_files = 0;
    let mut without_content_budget = params(directory.path());
    without_content_budget.max_content_search_file_bytes = 0;
    let mut relative_root = params(directory.path());
    relative_root.root = "relative/project".to_owned();
    let missing_root = params(&directory.path().join("missing"));
    let file_root = params(&file);
    let mut relative_cache = params(directory.path());
    relative_cache.cache_path = Some(PathBuf::from("cache/index.bin"));

    let errors = [
        invalid_policy,
        without_content_budget,
        relative_root,
        missing_root,
        file_root,
        relative_cache,
    ]
    .into_iter()
    .map(|configuration| {
        let error = ContextIndexService::new()
            .initialize(configuration)
            .expect_err("initialization should fail");
        (error.code, error.message)
    })
    .collect::<Vec<_>>();

    assert_eq!(errors[0].1, "maxFiles must be positive.");
    assert_eq!(
        errors[1],
        (
            "INVALID_REQUEST",
            "maxContentSearchFileBytes must be positive.".to_owned()
        )
    );
    assert_eq!(
        errors[2],
        (
            "INVALID_REQUEST",
            "root must be an absolute path.".to_owned()
        )
    );
    assert_eq!(errors[3].0, "INITIALIZATION_FAILED");
    assert!(errors[3]
        .1
        .starts_with("Could not resolve the project root:"));
    assert_eq!(
        errors[4],
        (
            "INVALID_REQUEST",
            "root must refer to a directory.".to_owned()
        )
    );
    assert_eq!(
        errors[5],
        (
            "INVALID_REQUEST",
            "cachePath must be absolute when provided.".to_owned()
        )
    );
}

#[test]
fn initialization_happens_only_once() {
    let directory = tempdir().expect("temporary directory should exist");
    let mut service = ContextIndexService::new();
    service
        .initialize(params(directory.path()))
        .expect("first initialization should work");

    let error = service
        .initialize(params(directory.path()))
        .expect_err("second initialization should fail");

    assert_eq!(error.code, "INVALID_REQUEST");
    assert_eq!(
        error.message,
        "The context index has already been initialized."
    );
    service.shutdown();
}

#[test]
fn initialization_rebuilds_unusable_caches_and_tolerates_unwritable_cache_locations() {
    let directory = tempdir().expect("temporary directory should exist");
    let cache_directory = tempdir().expect("cache directory should exist");
    write(directory.path().join("first.ts"), "").expect("fixture should write");
    let corrupt_cache = cache_directory.path().join("corrupt.bin");
    write(&corrupt_cache, "not a cache").expect("corrupt cache should write");
    let blocking_file = cache_directory.path().join("file");
    write(&blocking_file, "").expect("blocking file should write");
    let mut corrupt = params(directory.path());
    corrupt.cache_path = Some(corrupt_cache.clone());
    let mut unwritable = params(directory.path());
    unwritable.cache_path = Some(blocking_file.join("index.bin"));

    let mut corrupt_service = ContextIndexService::new();
    let rebuilt = corrupt_service
        .initialize(corrupt)
        .expect("initialization should rebuild the cache");
    corrupt_service.shutdown();
    let mut unwritable_service = ContextIndexService::new();
    let uncached = unwritable_service
        .initialize(unwritable)
        .expect("initialization should survive cache write failures");
    unwritable_service.shutdown();

    assert!(!rebuilt.from_cache);
    assert_eq!(rebuilt.file_count, 1);
    assert!(!uncached.from_cache);
    assert_eq!(uncached.file_count, 1);
    let policy = IndexPolicy::from(&params(directory.path()));
    let reloaded = cache::load(
        &corrupt_cache,
        &rebuilt.root,
        &cache::policy_fingerprint(&policy).expect("policy should hash"),
        10,
    )
    .expect("rebuilt cache should load");
    assert_eq!(
        reloaded.map(|cached| cached.paths),
        Some(vec!["first.ts".to_owned()])
    );
}

#[test]
fn search_rejects_out_of_range_limits_long_queries_and_superseded_generations() {
    let directory = tempdir().expect("temporary directory should exist");
    write(directory.path().join("app.ts"), "").expect("fixture should write");
    let mut service = ContextIndexService::new();
    service
        .initialize(params(directory.path()))
        .expect("initialization should work");
    let latest = AtomicU64::new(2);

    let errors = [
        search_params("app", 0, 2),
        search_params("app", MAX_SEARCH_LIMIT + 1, 2),
        search_params(&"a".repeat(MAX_QUERY_CHARS + 1), 20, 2),
        search_params("app", 20, 1),
    ]
    .into_iter()
    .map(|request| {
        let error = service
            .search(request, &latest)
            .expect_err("search should fail");
        (error.code, error.message)
    })
    .collect::<Vec<_>>();

    assert_eq!(
        errors,
        [
            (
                "INVALID_REQUEST",
                "limit must be between 1 and 100.".to_owned()
            ),
            (
                "INVALID_REQUEST",
                "limit must be between 1 and 100.".to_owned()
            ),
            (
                "INVALID_REQUEST",
                "query may contain at most 4096 characters.".to_owned()
            ),
            (
                "SUPERSEDED",
                "A newer file search superseded this request.".to_owned()
            ),
        ]
    );
    service.shutdown();
}

#[test]
fn content_searches_use_the_initialized_catalog() {
    let directory = tempdir().expect("temporary directory should exist");
    write(directory.path().join("notes.txt"), "needle").expect("fixture should write");
    write(directory.path().join(".env"), "needle").expect("secret should write");
    let mut service = ContextIndexService::new();
    let uninitialized = service
        .content_search_context()
        .err()
        .map(|error| error.code);
    service
        .initialize(params(directory.path()))
        .expect("initialization should work");
    let request: crate::content_search::ContentSearchParams =
        serde_json::from_value(serde_json::json!({
            "pattern": "needle",
            "patternKind": "literal",
            "outputMode": "files_with_matches",
            "linesBefore": 0,
            "linesAfter": 0,
            "caseSensitive": true,
            "multiline": false,
            "limit": 10,
            "offset": 0
        }))
        .expect("content search parameters should decode");

    let result = service
        .content_search_context()
        .expect("context should be available")
        .search(request, &AtomicBool::new(false))
        .expect("content search should succeed");

    assert_eq!(uninitialized, Some("NOT_INITIALIZED"));
    let encoded = serde_json::to_value(result).expect("result should serialize");
    assert_eq!(encoded["files"], serde_json::json!(["notes.txt"]));
    service.shutdown();
}

#[test]
fn editor_paths_matching_the_catalog_exactly_are_selected() {
    let directory = tempdir().expect("temporary directory should exist");
    write(directory.path().join("main.ts"), "").expect("fixture should write");
    let mut service = ContextIndexService::new();
    service
        .initialize(params(directory.path()))
        .expect("initialization should work");

    let selected = service
        .filter_paths(vec!["main.ts".to_owned(), "missing.ts".to_owned()])
        .expect("filtering should work");
    let oversized = service
        .filter_paths(vec!["main.ts".to_owned(); 2_001])
        .expect_err("too many paths should be rejected");

    assert_eq!(selected, ["main.ts"]);
    assert_eq!(oversized.code, "INVALID_REQUEST");
    service.shutdown();
}

#[test]
fn refresh_rescans_the_project_and_rewrites_the_cache() {
    let directory = tempdir().expect("temporary directory should exist");
    let cache_directory = tempdir().expect("cache directory should exist");
    write(directory.path().join("first.ts"), "").expect("fixture should write");
    let cache_path = cache_directory.path().join("index.bin");
    let mut configuration = params(directory.path());
    configuration.cache_path = Some(cache_path.clone());
    let mut uninitialized = ContextIndexService::new();
    let mut service = ContextIndexService::new();
    let status = service
        .initialize(configuration)
        .expect("initialization should work");
    write(directory.path().join("second.ts"), "").expect("new fixture should write");

    let refreshed = service.refresh().expect("refresh should work");

    assert_eq!(
        uninitialized
            .refresh()
            .expect_err("refresh requires initialization")
            .code,
        "NOT_INITIALIZED"
    );
    assert_eq!(status.file_count, 1);
    assert_eq!(refreshed.file_count, 2);
    assert!(!refreshed.from_cache);
    assert!(!refreshed.truncated);
    assert_eq!(refreshed.root, status.root);
    let policy = IndexPolicy::from(&params(directory.path()));
    let cached = cache::load(
        &cache_path,
        &status.root,
        &cache::policy_fingerprint(&policy).expect("policy should hash"),
        10,
    )
    .expect("cache should load");
    assert_eq!(
        cached.map(|cached| cached.paths),
        Some(vec!["first.ts".to_owned(), "second.ts".to_owned()])
    );
    service.shutdown();
}

#[test]
fn refresh_tolerates_unwritable_cache_locations() {
    let directory = tempdir().expect("temporary directory should exist");
    let cache_directory = tempdir().expect("cache directory should exist");
    write(directory.path().join("first.ts"), "").expect("fixture should write");
    let blocking_file = cache_directory.path().join("file");
    write(&blocking_file, "").expect("blocking file should write");
    let mut configuration = params(directory.path());
    configuration.cache_path = Some(blocking_file.join("index.bin"));
    let mut service = ContextIndexService::new();
    service
        .initialize(configuration)
        .expect("initialization should work");

    let refreshed = service.refresh().expect("refresh should work");

    assert_eq!(refreshed.file_count, 1);
    service.shutdown();
}

#[test]
fn poisoned_shared_state_is_reported_as_an_internal_error() {
    let directory = tempdir().expect("temporary directory should exist");
    write(directory.path().join("main.ts"), "").expect("fixture should write");
    let mut index_service = ContextIndexService::new();
    index_service
        .initialize(params(directory.path()))
        .expect("initialization should work");
    poison_index(Arc::clone(&initialized(&index_service).index));
    let mut paths_service = ContextIndexService::new();
    paths_service
        .initialize(params(directory.path()))
        .expect("initialization should work");
    poison_known_paths(Arc::clone(&initialized(&paths_service).known_paths));

    let search = index_service
        .search(search_params("main", 20, 1), &AtomicU64::new(1))
        .expect_err("search should fail");
    let index_refresh = index_service.refresh().expect_err("refresh should fail");
    let filter = paths_service
        .filter_paths(vec!["main.ts".to_owned()])
        .expect_err("filtering should fail");
    let glob = paths_service
        .glob(GlobParams {
            pattern: "*.ts".to_owned(),
            target_directory: None,
            limit: 20,
        })
        .expect_err("glob should fail");
    let paths_refresh = paths_service.refresh().expect_err("refresh should fail");

    assert_eq!(
        [&search, &index_refresh, &filter, &glob, &paths_refresh].map(|error| error.code),
        ["INTERNAL"; 5]
    );
    assert_eq!(search.message, "The file index lock is poisoned.");
    assert_eq!(index_refresh.message, "The file index lock is poisoned.");
    assert_eq!(filter.message, "The known-path set lock is poisoned.");
    assert_eq!(glob.message, "The known-path set lock is poisoned.");
    assert_eq!(
        paths_refresh.message,
        "The known-path set lock is poisoned."
    );
    index_service.shutdown();
    paths_service.shutdown();
}

#[test]
fn content_search_failures_map_to_protocol_error_codes() {
    let errors = [
        ContentSearchError::InvalidRequest("bad pattern".to_owned()),
        ContentSearchError::Cancelled,
        ContentSearchError::Internal("broken".to_owned()),
    ]
    .map(content_search_error)
    .map(|error| (error.code, error.message));

    assert_eq!(
        errors,
        [
            ("INVALID_REQUEST", "bad pattern".to_owned()),
            (
                "CANCELLED",
                "The project content search was cancelled.".to_owned()
            ),
            ("INTERNAL", "broken".to_owned()),
        ]
    );
}

#[test]
fn glob_requests_default_to_the_standard_result_limit() {
    let params: GlobParams = serde_json::from_value(serde_json::json!({ "pattern": "*.ts" }))
        .expect("glob parameters should decode");

    assert_eq!(params.limit, DEFAULT_GLOB_LIMIT);
    assert_eq!(params.target_directory, None);
}

#[test]
fn watching_a_missing_root_is_unavailable() {
    let directory = tempdir().expect("temporary directory should exist");

    assert!(start_watcher(&directory.path().join("missing")).is_none());
}

#[test]
fn monitor_without_a_watcher_reconciles_after_the_startup_delay() {
    let directory = tempdir().expect("temporary directory should exist");
    write(directory.path().join("main.ts"), "").expect("fixture should write");
    let stop = Arc::new(AtomicBool::new(false));
    let mut state = monitor_state(directory.path(), &stop);
    state.reconcile_after_startup_delay = true;
    let known_paths = Arc::clone(&state.known_paths);

    let monitor = spawn_monitor(state, None, &SystemWorkers).expect("monitor should start");
    let reconciled = wait_until(|| known_paths.read().unwrap().contains("main.ts"));
    stop.store(true, Ordering::Release);
    monitor.join().expect("monitor should stop");

    assert!(reconciled);
}

#[test]
fn monitor_reconciles_after_catalog_changes_and_watch_errors_but_not_file_access() {
    let directory = tempdir().expect("temporary directory should exist");
    write(directory.path().join("main.ts"), "").expect("fixture should write");
    let stop = Arc::new(AtomicBool::new(false));
    let state = monitor_state(directory.path(), &stop);
    let known_paths = Arc::clone(&state.known_paths);
    let created = state.root.join("main.ts");
    let (backend_sender, _backend_events) = mpsc::channel();
    let (event_sender, events) = mpsc::channel();
    for message in [
        Ok(event(
            EventKind::Access(notify::event::AccessKind::Any),
            vec![created.clone()],
        )),
        Ok(event(EventKind::Create(CreateKind::File), vec![created])),
        Err(notify::Error::generic("synthetic watch failure")),
    ] {
        event_sender.send(message).expect("event should send");
    }
    let watcher = FilesystemWatcher {
        _watcher: notify::recommended_watcher(backend_sender).expect("watcher should start"),
        events,
        started_at: Instant::now(),
    };

    let monitor =
        spawn_monitor(state, Some(watcher), &SystemWorkers).expect("monitor should start");
    let reconciled = wait_until(|| known_paths.read().unwrap().contains("main.ts"));
    stop.store(true, Ordering::Release);
    monitor.join().expect("monitor should stop");
    drop(event_sender);

    assert!(reconciled);
}

#[test]
fn monitor_falls_back_to_periodic_reconciliation_when_the_watch_stream_closes() {
    let directory = tempdir().expect("temporary directory should exist");
    write(directory.path().join("main.ts"), "").expect("fixture should write");
    let stop = Arc::new(AtomicBool::new(false));
    let mut state = monitor_state(directory.path(), &stop);
    state.reconcile_after_startup_delay = true;
    let known_paths = Arc::clone(&state.known_paths);
    let (backend_sender, _backend_events) = mpsc::channel();
    let (_, events) = mpsc::channel();
    let watcher = FilesystemWatcher {
        _watcher: notify::recommended_watcher(backend_sender).expect("watcher should start"),
        events,
        started_at: Instant::now(),
    };

    let monitor =
        spawn_monitor(state, Some(watcher), &SystemWorkers).expect("monitor should start");
    let reconciled = wait_until(|| known_paths.read().unwrap().contains("main.ts"));
    stop.store(true, Ordering::Release);
    monitor.join().expect("monitor should stop");

    assert!(reconciled);
}

#[test]
fn background_reconciliation_publishes_scans_and_survives_unusable_state() {
    let directory = tempdir().expect("temporary directory should exist");
    let cache_directory = tempdir().expect("cache directory should exist");
    write(directory.path().join("main.ts"), "").expect("fixture should write");
    let blocking_file = cache_directory.path().join("file");
    write(&blocking_file, "").expect("blocking file should write");
    let running = Arc::new(AtomicBool::new(false));
    let stopped = Arc::new(AtomicBool::new(true));
    let mut published = monitor_state(directory.path(), &running);
    published.cache_path = Some(blocking_file.join("index.bin"));
    let cancelled = monitor_state(directory.path(), &stopped);
    let poisoned_index = monitor_state(directory.path(), &running);
    poison_index(Arc::clone(&poisoned_index.index));
    let poisoned_paths = monitor_state(directory.path(), &running);
    poison_known_paths(Arc::clone(&poisoned_paths.known_paths));

    for state in [&published, &cancelled, &poisoned_index, &poisoned_paths] {
        reconcile_shared(state);
    }

    assert!(published.known_paths.read().unwrap().contains("main.ts"));
    assert!(cancelled.known_paths.read().unwrap().is_empty());
    assert!(poisoned_index.known_paths.read().unwrap().is_empty());
    assert!(poisoned_paths.known_paths.is_poisoned());
    assert_eq!(
        poisoned_paths
            .index
            .lock()
            .expect("index should remain usable")
            .file_count(),
        1
    );
}

#[cfg(unix)]
#[test]
fn watch_events_require_reconciliation_only_for_catalog_changes() {
    let directory = tempdir().expect("temporary directory should exist");
    let root = fs::canonicalize(directory.path()).expect("root should canonicalize");
    create_dir_all(root.join("src")).expect("source directory should exist");
    write(root.join("file.txt"), "").expect("fixture should write");
    std::os::unix::fs::symlink(root.join("file.txt"), root.join("link.txt"))
        .expect("symlink should be created");
    let cache_path = root.join("index.bin");
    let policy = IndexPolicy::from(&params(&root));
    let known = RwLock::new(BTreeSet::from([
        "deleted.ts".to_owned(),
        "removed/inner.ts".to_owned(),
    ]));
    let created = |path: PathBuf| event(EventKind::Create(CreateKind::Any), vec![path]);
    let cases = [
        (
            event(EventKind::Access(notify::event::AccessKind::Any), vec![]),
            false,
        ),
        (event(EventKind::Any, vec![]), true),
        (created(cache_path.clone()), false),
        (created(PathBuf::from("/outside/project.ts")), true),
        (created(root.join("src")), true),
        (created(root.join("link.txt")), false),
        (created(root.join("deleted.ts")), true),
        (created(root.join("removed")), true),
        (created(root.join("never-indexed.ts")), false),
        (created(root.join("file.txt/child")), true),
    ];

    let decisions = cases
        .iter()
        .map(|(event, _)| {
            event_requires_reconcile(event, &root, &policy, Some(&cache_path), &known)
        })
        .collect::<Vec<_>>();

    assert_eq!(
        decisions,
        cases
            .iter()
            .map(|(_, expected)| *expected)
            .collect::<Vec<_>>()
    );
}

#[test]
fn watch_events_require_reconciliation_when_known_paths_are_unreadable() {
    let directory = tempdir().expect("temporary directory should exist");
    let known = Arc::new(RwLock::new(BTreeSet::new()));
    poison_known_paths(Arc::clone(&known));
    let policy = IndexPolicy::from(&params(directory.path()));

    assert!(event_requires_reconcile(
        &event(EventKind::Any, vec![directory.path().join("a.ts")]),
        directory.path(),
        &policy,
        None,
        &known,
    ));
}

#[test]
fn cache_artifacts_are_the_cache_and_its_temporary_siblings() {
    let cache_path = Path::new("/cache/index.bin");

    assert!(is_cache_artifact(cache_path, cache_path));
    assert!(is_cache_artifact(
        Path::new("/cache/.index.bin.42.7.tmp"),
        cache_path
    ));
    assert!(!is_cache_artifact(
        Path::new("/cache/.index.bin.42.7"),
        cache_path
    ));
    assert!(!is_cache_artifact(
        Path::new("/elsewhere/.index.bin.42.7.tmp"),
        cache_path
    ));
    assert!(!is_cache_artifact(
        Path::new("/cache/index.bin"),
        Path::new("/")
    ));
}

#[test]
fn scans_stop_when_cancelled_and_truncate_at_the_file_limit() {
    let directory = tempdir().expect("temporary directory should exist");
    write(directory.path().join("a.ts"), "").expect("fixture should write");
    write(directory.path().join("b.ts"), "").expect("fixture should write");
    let mut limited = params(directory.path());
    limited.max_files = 1;
    let policy = IndexPolicy::from(&params(directory.path()));

    let cancelled = scan_paths(directory.path(), &policy, None, &AtomicBool::new(true))
        .err()
        .map(|error| (error.code, error.message));
    let truncated = scan_paths(
        directory.path(),
        &IndexPolicy::from(&limited),
        None,
        &AtomicBool::new(false),
    )
    .expect("scan should complete");

    assert_eq!(
        cancelled,
        Some((
            "INITIALIZATION_FAILED",
            "File indexing was cancelled.".to_owned()
        ))
    );
    assert!(truncated.truncated);
    assert_eq!(truncated.paths.len(), 1);
}

#[test]
fn scans_skip_cache_artifacts_and_find_nothing_under_missing_or_file_roots() {
    let directory = tempdir().expect("temporary directory should exist");
    let root = directory.path().join("project");
    create_dir_all(root.join("sub")).expect("subdirectory should exist");
    write(root.join("sub/kept.ts"), "").expect("fixture should write");
    let cache_path = root.join("index.bin");
    write(&cache_path, "").expect("cache fixture should write");
    let policy = IndexPolicy::from(&params(&root));

    let scanned = scan_paths(&root, &policy, Some(&cache_path), &AtomicBool::new(false))
        .expect("scan should complete");
    let file_root = scan_paths(
        &root.join("sub/kept.ts"),
        &policy,
        None,
        &AtomicBool::new(false),
    )
    .expect("scan should complete");
    let missing_root = scan_paths(
        &directory.path().join("missing"),
        &policy,
        None,
        &AtomicBool::new(false),
    )
    .expect("scan should complete");

    assert_eq!(scanned.paths, ["sub/kept.ts"]);
    assert!(file_root.paths.is_empty());
    assert!(missing_root.paths.is_empty());
    assert!(!missing_root.truncated);
}

#[test]
fn refresh_after_shutdown_reports_cancelled_indexing() {
    let directory = tempdir().expect("temporary directory should exist");
    let mut service = ContextIndexService::new();
    service
        .initialize(params(directory.path()))
        .expect("initialization should work");
    service.shutdown();

    let error = service.refresh().expect_err("refresh should be cancelled");

    assert_eq!(error.code, "INITIALIZATION_FAILED");
    assert_eq!(error.message, "File indexing was cancelled.");
}

#[test]
fn relative_paths_must_stay_beneath_the_root() {
    assert_eq!(
        normalize_relative_path(Path::new("/project"), Path::new("/project/../outside")),
        None
    );
    assert_eq!(
        normalize_relative_path(Path::new("/project"), Path::new("/project/src/main.ts")),
        Some("src/main.ts".to_owned())
    );
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

#[test]
fn initialization_through_a_worker_factory_validates_caches_and_starts_the_monitor() {
    let directory = tempdir().expect("temporary directory should exist");
    let cache_directory = tempdir().expect("cache directory should exist");
    write(directory.path().join("a.ts"), "").expect("fixture should write");
    let blocking_file = cache_directory.path().join("file");
    write(&blocking_file, "").expect("blocking file should write");
    let cache_path = cache_directory.path().join("index.bin");
    let available = MonitorWorkers { available: true };
    let initialize = |configuration: InitializeParams, workers: &MonitorWorkers| {
        let mut service = ContextIndexService::new();
        let result = service.initialize_with_workers(configuration, workers);
        service.shutdown();
        result.map_err(|error| error.message)
    };
    let mut without_files = params(directory.path());
    without_files.max_files = 0;
    let mut without_content_budget = params(directory.path());
    without_content_budget.max_content_search_file_bytes = 0;
    let mut relative_root = params(directory.path());
    relative_root.root = "relative".to_owned();
    let mut relative_cache = params(directory.path());
    relative_cache.cache_path = Some(PathBuf::from("index.bin"));
    let mut unwritable_cache = params(directory.path());
    unwritable_cache.cache_path = Some(blocking_file.join("index.bin"));
    let mut fresh_cache = params(directory.path());
    fresh_cache.cache_path = Some(cache_path.clone());
    let mut warm_cache = params(directory.path());
    warm_cache.cache_path = Some(cache_path);
    let mut twice = ContextIndexService::new();
    let first = twice.initialize_with_workers(params(directory.path()), &available);
    let repeated = twice
        .initialize_with_workers(params(directory.path()), &available)
        .err()
        .map(|error| error.message);
    twice.shutdown();

    let rejected = [
        without_files,
        without_content_budget,
        relative_root,
        params(&directory.path().join("missing")),
        relative_cache,
    ]
    .map(|configuration| initialize(configuration, &available).err());
    let uncached = initialize(unwritable_cache, &available).map(|status| status.from_cache);
    let stored = initialize(fresh_cache, &available).map(|status| status.from_cache);
    let loaded = initialize(warm_cache, &available).map(|status| status.from_cache);
    let unavailable = initialize(
        params(directory.path()),
        &MonitorWorkers { available: false },
    );

    assert_eq!(first.map(|status| status.file_count).ok(), Some(1));
    assert_eq!(
        repeated.as_deref(),
        Some("The context index has already been initialized.")
    );
    assert_eq!(rejected[0].as_deref(), Some("maxFiles must be positive."));
    assert_eq!(
        rejected[1].as_deref(),
        Some("maxContentSearchFileBytes must be positive.")
    );
    assert_eq!(
        rejected[2].as_deref(),
        Some("root must be an absolute path.")
    );
    assert!(rejected[3]
        .as_deref()
        .is_some_and(|message| message.starts_with("Could not resolve the project root:")));
    assert_eq!(
        rejected[4].as_deref(),
        Some("cachePath must be absolute when provided.")
    );
    assert_eq!(uncached, Ok(false));
    assert_eq!(stored, Ok(false));
    assert_eq!(loaded, Ok(true));
    assert_eq!(
        unavailable.err().as_deref(),
        Some("Could not start the filesystem monitor: thread resources exhausted")
    );
}

type WatcherFactory =
    fn(mpsc::Sender<notify::Result<Event>>) -> notify::Result<notify::RecommendedWatcher>;

fn unavailable_watcher(
    _: mpsc::Sender<notify::Result<Event>>,
) -> notify::Result<notify::RecommendedWatcher> {
    Err(notify::Error::generic("backend unavailable"))
}

#[test]
fn watcher_startup_reports_unavailable_backends_and_unwatchable_roots() {
    let directory = tempdir().expect("temporary directory should exist");
    let backend: WatcherFactory =
        notify::recommended_watcher::<mpsc::Sender<notify::Result<Event>>>;
    let unavailable: WatcherFactory = unavailable_watcher;

    let watched = start_watcher_with(directory.path(), backend);
    let missing = start_watcher_with(&directory.path().join("missing"), backend);
    let failed = start_watcher_with(directory.path(), unavailable);

    assert!(watched.is_some());
    assert!(missing.is_none());
    assert!(failed.is_none());
}

struct ScriptedCatalog<'a> {
    stop: &'a AtomicBool,
    scan_succeeds: bool,
    stop_during_scan: bool,
    save_succeeds: bool,
    stop_during_save: bool,
}

impl CatalogRepository for ScriptedCatalog<'_> {
    fn scan(&self) -> Result<ScanResult, ServiceError> {
        if self.stop_during_scan {
            self.stop.store(true, Ordering::Release);
        }
        if !self.scan_succeeds {
            return Err(ServiceError::initialization("File indexing was cancelled."));
        }
        Ok(ScanResult {
            paths: vec!["new.ts".to_owned()],
            truncated: true,
        })
    }

    fn save(&self, _snapshot: &ScanResult) -> Result<(), String> {
        if self.stop_during_save {
            self.stop.store(true, Ordering::Release);
        }
        if self.save_succeeds {
            Ok(())
        } else {
            Err("disk unavailable".to_owned())
        }
    }
}

#[test]
fn reconciliation_publishes_only_complete_uninterrupted_snapshots() {
    let directory = tempdir().expect("temporary directory should exist");
    let scripts = [
        (false, false, true, false, None),
        (true, true, true, false, None),
        (true, false, true, true, None),
        (true, false, true, false, Some(true)),
        (true, false, true, false, Some(false)),
        (true, false, false, false, None),
    ];
    let mut outcomes = Vec::new();
    for (scan_succeeds, stop_during_scan, save_succeeds, stop_during_save, poisoned_index) in
        scripts
    {
        let stop = Arc::new(AtomicBool::new(false));
        let state = monitor_state(directory.path(), &stop);
        match poisoned_index {
            Some(true) => poison_index(Arc::clone(&state.index)),
            Some(false) => poison_known_paths(Arc::clone(&state.known_paths)),
            None => {}
        }
        let catalog = ScriptedCatalog {
            stop: &stop,
            scan_succeeds,
            stop_during_scan,
            save_succeeds,
            stop_during_save,
        };

        reconcile_catalog(&state, &catalog);

        outcomes.push((
            state.index.lock().map(|index| index.file_count()).ok(),
            state
                .known_paths
                .read()
                .map(|known| known.contains("new.ts"))
                .ok(),
            state.truncated.load(Ordering::Acquire),
        ));
    }

    assert_eq!(
        outcomes,
        [
            (Some(0), Some(false), false),
            (Some(0), Some(false), false),
            (Some(0), Some(false), false),
            (None, Some(false), false),
            (Some(1), None, false),
            (Some(1), Some(true), true),
        ]
    );
}
