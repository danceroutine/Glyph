use std::fs::{create_dir_all, write};

use tempfile::tempdir;

use super::*;

#[test]
fn lanes_stop_after_cancellation_or_page_completion_without_reading_another_file() {
    for cancel in [true, false] {
        let cancelled = AtomicBool::new(false);
        let finished = AtomicBool::new(false);
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut read = Vec::new();
        search_lane(
            ["first", "second"].into_iter(),
            &cancelled,
            &finished,
            sender,
            |path| {
                read.push(path.to_owned());
                if cancel { &cancelled } else { &finished }.store(true, Ordering::Release);
                FileOutcome::empty(path)
            },
        );
        assert_eq!(read, ["first"]);
        assert_eq!(receiver.recv().unwrap().path, "first");
        assert!(receiver.recv().is_err());
    }
}

#[test]
fn closing_the_consumer_ends_a_lane_after_its_in_flight_file() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let mut receiver = Some(receiver);
    let mut read = Vec::new();
    search_lane(
        ["first", "second"].into_iter(),
        &AtomicBool::new(false),
        &AtomicBool::new(false),
        sender,
        |path| {
            read.push(path.to_owned());
            drop(receiver.take());
            FileOutcome::empty(path)
        },
    );
    assert_eq!(read, ["first"]);
}

#[test]
fn a_cancelled_lane_closes_the_channel_before_the_collector_receives_a_result() {
    let (sender, receiver) = mpsc::sync_channel(1);
    let cancelled = AtomicBool::new(true);
    let finished = AtomicBool::new(false);
    search_lane(["first"].into_iter(), &cancelled, &finished, sender, |_| {
        panic!("cancelled lane read a file")
    });
    let params = parameters(ContentSearchOutputMode::Content);
    let mut accumulator = ResultAccumulator::new(&params, false);
    collect_outcomes(1, vec![receiver], &cancelled, &finished, &mut accumulator);
    assert!(!finished.load(Ordering::Acquire));
    assert!(accumulator.matches.is_empty());
}

#[test]
fn a_page_is_reduced_in_catalog_order_and_releases_all_lanes() {
    let (first_sender, first) = mpsc::sync_channel(1);
    let (second_sender, second) = mpsc::sync_channel(1);
    let found = |path| {
        let mut value = FileOutcome::empty(path);
        value.count = 1;
        value
    };
    second_sender.send(found("b.txt")).unwrap();
    first_sender.send(found("a.txt")).unwrap();
    let mut params = parameters(ContentSearchOutputMode::FilesWithMatches);
    params.limit = 1;
    let mut accumulator = ResultAccumulator::new(&params, false);
    let finished = AtomicBool::new(false);
    collect_outcomes(
        2,
        vec![first, second],
        &AtomicBool::new(false),
        &finished,
        &mut accumulator,
    );
    assert_eq!(accumulator.files, ["a.txt"]);
    assert!(accumulator.has_more);
    assert!(finished.load(Ordering::Acquire));
    assert!(first_sender.send(found("c.txt")).is_err());
    assert!(second_sender.send(found("d.txt")).is_err());
}

#[test]
fn cancellation_during_file_io_returns_cancellation_instead_of_partial_success() {
    struct CancellingFiles<'a> {
        files: &'a ContentSearchContext,
        cancelled: &'a AtomicBool,
    }
    impl SearchableFiles for CancellingFiles<'_> {
        fn read(&self, path: &str) -> Result<String, ()> {
            let result = self.files.read(path);
            self.cancelled.store(true, Ordering::Release);
            result
        }
    }
    let (_directory, search) = context(&[("a.txt", "needle")]);
    let cancelled = AtomicBool::new(false);
    let files = CancellingFiles {
        files: &search,
        cancelled: &cancelled,
    };
    assert!(matches!(
        search.search_files(
            parameters(ContentSearchOutputMode::Content),
            &cancelled,
            &files
        ),
        Err(ContentSearchError::Cancelled)
    ));
}

#[cfg(unix)]
#[test]
fn refuses_a_symlink_inserted_at_the_inspected_path_even_to_the_original_file() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("file.txt");
    let previous = directory.path().join("previous.txt");
    write(&path, "initial").unwrap();
    let expected = fs::symlink_metadata(&path).unwrap();
    fs::rename(&path, &previous).unwrap();
    std::os::unix::fs::symlink(previous, &path).unwrap();
    assert!(open_searchable_file(&path, &expected, 32).is_err());
}

#[cfg(unix)]
#[test]
fn refuses_a_fifo_inserted_at_the_inspected_path_without_waiting_for_a_writer() {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;
    use std::time::Duration;

    let directory = tempdir().unwrap();
    let path = directory.path().join("file.txt");
    write(&path, "initial").unwrap();
    let expected = fs::symlink_metadata(&path).unwrap();
    fs::remove_file(&path).unwrap();
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: the owned CString remains alive and is NUL-terminated. This
    // creates only a private empty FIFO in the disposable test directory.
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
    let (sender, receiver) = mpsc::channel();
    let worker_path = path.clone();
    let worker = thread::spawn(move || {
        sender
            .send(open_searchable_file(&worker_path, &expected, 32))
            .unwrap();
    });
    let result = receiver.recv_timeout(Duration::from_millis(500));
    if result.is_err() {
        // Unblock the old implementation so a regression reports failure
        // instead of leaving a reader thread behind or hanging the suite.
        let _rescue = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&path)
            .unwrap();
        worker.join().unwrap();
    } else {
        worker.join().unwrap();
    }
    assert_eq!(result.unwrap(), Err(()));
}

#[cfg(unix)]
#[test]
fn rejects_a_different_file_replacing_the_inspected_path_before_open() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("file.txt");
    write(&path, "initial").unwrap();
    let expected = fs::symlink_metadata(&path).unwrap();
    fs::rename(&path, directory.path().join("previous.txt")).unwrap();
    write(&path, "replacement").unwrap();
    let replacement = fs::File::open(&path).unwrap();
    assert!(read_opened_searchable_file(replacement, &expected, 32).is_err());
}

#[test]
fn stops_reading_after_the_budget_and_one_overflow_byte() {
    let mut reader = std::io::Cursor::new(vec![b'x'; 128]);
    assert!(read_searchable_text(&mut reader, 8).is_err());
    assert_eq!(reader.position(), 9);
}

#[test]
fn accepts_exactly_budgeted_text_and_rejects_overflow_without_decoding_it() {
    assert_eq!(
        read_searchable_text(&b"needle"[..], 6),
        Ok("needle".to_owned())
    );
    assert_eq!(read_searchable_text(&b""[..], 0), Ok(String::new()));
    assert!(read_searchable_text(&b"x"[..], 0).is_err());
    assert_eq!(
        read_searchable_text(&b"\xef\xbb\xbfneedle"[..], 9),
        Ok("needle".to_owned())
    );
    assert!(read_searchable_text(&b"\xef\xbb\xbfneedle"[..], 8).is_err());
    assert!(read_searchable_text(&b"bad\0text"[..], 8).is_err());
    assert!(read_searchable_text(&b"\xff"[..], 1).is_err());
}

#[test]
fn preserves_the_last_allowed_page_without_advertising_an_invalid_cursor() {
    let text = "needle\n".repeat(MAX_OFFSET as usize + 2);
    let (_directory, search) = context(&[("many.txt", &text)]);
    let mut params = parameters(ContentSearchOutputMode::Content);
    params.offset = MAX_OFFSET;
    params.limit = 1;
    let ContentSearchResult::Content { matches, metadata } =
        search.search(params, &AtomicBool::new(false)).unwrap()
    else {
        panic!("content expected");
    };
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].line, MAX_OFFSET + 1);
    assert!(metadata.truncated);
    assert_eq!(metadata.next_offset, None);
}

#[test]
fn unicode_empty_matches_never_slice_inside_a_codepoint() {
    for multiline in [false, true] {
        let mut params = parameters(ContentSearchOutputMode::Content);
        params.pattern = "a*".to_owned();
        params.pattern_kind = ContentSearchPatternKind::RegularExpression;
        params.multiline = multiline;
        let matcher = compile_matcher(&params).unwrap();
        let outcome = search_file(
            "unicode.txt",
            "é",
            &matcher,
            &params,
            100,
            &AtomicBool::new(false),
        );
        assert_eq!(outcome.count, 2);
    }
}

#[test]
fn buffers_match_locations_without_copying_megabytes_of_repeated_context() {
    let mut params = parameters(ContentSearchOutputMode::Content);
    params.lines_before = 20;
    params.lines_after = 20;
    let text = format!("needle {}\n", "x".repeat(2048)).repeat(80);
    let matcher = compile_matcher(&params).unwrap();
    let outcome = search_file(
        "context.txt",
        &text,
        &matcher,
        &params,
        100,
        &AtomicBool::new(false),
    );
    assert!(serde_json::to_vec(&outcome.matches).unwrap().len() <= MAX_RESULT_TEXT_BYTES);
}

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
        overrides: BTreeMap::new(),
    }
}

#[test]
fn budgets_escaped_context_on_the_wire_and_keeps_match_pagination() {
    for character in ['\\', '"', '\u{0001}'] {
        let block = (0..41)
            .map(|line| {
                format!(
                    "{}{}\n",
                    if line == 20 { "needle" } else { "" },
                    character.to_string().repeat(8186)
                )
            })
            .collect::<String>();
        let text = block.repeat(2);
        let (_directory, search) = context(&[("escaped.txt", &text)]);
        let mut params = parameters(ContentSearchOutputMode::Content);
        params.lines_before = 20;
        params.lines_after = 20;
        let mut locations = Vec::new();
        loop {
            let result = search
                .search(params.clone(), &AtomicBool::new(false))
                .unwrap();
            assert!(serde_json::to_vec(&result).unwrap().len() <= MAX_RESULT_TEXT_BYTES);
            let ContentSearchResult::Content { matches, metadata } = result else {
                panic!("content expected");
            };
            assert!(!matches.is_empty());
            for found in matches {
                assert_eq!(found.matched_text, "needle");
                assert_eq!(found.column, 1);
                assert_eq!(found.end_column, 7);
                assert_eq!(found.lines_before.len(), 20);
                assert_eq!(found.lines_after.len(), 20);
                assert!(found.line_text.starts_with("needle"));
                assert!(found.line_text.ends_with('…'));
                locations.push(found.line);
            }
            let Some(next) = metadata.next_offset else {
                break;
            };
            assert!(next > params.offset);
            params.offset = next;
        }
        assert_eq!(locations, vec![21, 62]);
    }
}

#[test]
fn materializes_only_budgeted_context_and_resumes_the_next_match() {
    let text = format!("needle {}\n", "x".repeat(2048)).repeat(80);
    let (_directory, search) = context(&[("context.txt", &text)]);
    let mut params = parameters(ContentSearchOutputMode::Content);
    params.lines_before = 20;
    params.lines_after = 20;
    let ContentSearchResult::Content { matches, metadata } = search
        .search(params.clone(), &AtomicBool::new(false))
        .unwrap()
    else {
        panic!("content expected");
    };
    assert!(serde_json::to_vec(&matches).unwrap().len() <= MAX_RESULT_TEXT_BYTES);
    assert!(metadata.truncated);
    assert!(!matches.is_empty());
    params.offset = metadata.next_offset.unwrap();
    let ContentSearchResult::Content { matches: next, .. } =
        search.search(params, &AtomicBool::new(false)).unwrap()
    else {
        panic!("content expected");
    };
    assert_eq!(next[0].line, matches.last().unwrap().line + 1);
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
fn editor_snapshots_replace_disk_before_filters_context_and_pagination() {
    let (directory, search) = context(&[
        ("a.ts", "needle disk"),
        ("b.ts", "nothing"),
        ("c.md", "needle disk"),
    ]);
    let mut params = parameters(ContentSearchOutputMode::Content);
    params.overrides = BTreeMap::from([
        ("a.ts".to_owned(), "no match".to_owned()),
        (
            "b.ts".to_owned(),
            "before\nneedle café\nneedle next\nafter".to_owned(),
        ),
        ("not-indexed.ts".to_owned(), "needle forbidden".to_owned()),
    ]);
    params.file_glob = Some("*.ts".to_owned());
    params.limit = 1;
    params.lines_before = 1;
    params.lines_after = 1;
    let ContentSearchResult::Content { matches, metadata } = search
        .search(params.clone(), &AtomicBool::new(false))
        .unwrap()
    else {
        panic!("content expected")
    };
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].path, "b.ts");
    assert_eq!(matches[0].line, 2);
    assert_eq!(matches[0].lines_before[0].content, "before");
    assert_eq!(metadata.next_offset, Some(1));
    params.offset = 1;
    let ContentSearchResult::Content { matches, metadata } = search
        .search(params.clone(), &AtomicBool::new(false))
        .unwrap()
    else {
        panic!("content expected")
    };
    assert_eq!(matches[0].line, 3);
    assert!(!metadata.truncated);
    params.offset = 0;
    params.output_mode = ContentSearchOutputMode::Count;
    let ContentSearchResult::Count { counts, .. } = search
        .search(params.clone(), &AtomicBool::new(false))
        .unwrap()
    else {
        panic!("count expected")
    };
    assert_eq!(counts.len(), 1);
    assert_eq!(counts[0].path, "b.ts");
    assert_eq!(counts[0].count, 2);
    params.output_mode = ContentSearchOutputMode::FilesWithMatches;
    let ContentSearchResult::FilesWithMatches { files, .. } = search
        .search(params.clone(), &AtomicBool::new(false))
        .unwrap()
    else {
        panic!("files expected")
    };
    assert_eq!(files, ["b.ts"]);
    assert_eq!(
        fs::read_to_string(directory.path().join("a.ts")).unwrap(),
        "needle disk"
    );
    params
        .overrides
        .insert("../outside".to_owned(), "needle".to_owned());
    assert!(matches!(
        search.search(params, &AtomicBool::new(false)),
        Err(ContentSearchError::InvalidRequest(_))
    ));
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

#[test]
fn rejects_parameters_outside_their_documented_bounds() {
    type Mutation = fn(&mut ContentSearchParams);
    let mutations: [(Mutation, &str); 10] = [
        (
            |params| params.pattern = "x".repeat(MAX_PATTERN_CHARS + 1),
            "pattern may contain at most 4096 characters.",
        ),
        (
            |params| params.limit = 0,
            "limit must be between 1 and 1000.",
        ),
        (
            |params| params.limit = MAX_RESULT_LIMIT + 1,
            "limit must be between 1 and 1000.",
        ),
        (
            |params| params.offset = MAX_OFFSET + 1,
            "offset may be at most 100000.",
        ),
        (
            |params| params.lines_after = MAX_CONTEXT_LINES + 1,
            "linesBefore and linesAfter may each be at most 20.",
        ),
        (
            |params| params.path = Some(String::new()),
            "path must not be empty when provided.",
        ),
        (
            |params| params.file_glob = Some(String::new()),
            "fileGlob must not be empty when provided.",
        ),
        (
            |params| params.file_glob = Some("*\0".to_owned()),
            "fileGlob may contain at most 4096 characters and no null bytes.",
        ),
        (
            |params| params.file_type = Some("type script".to_owned()),
            "fileType must be at most 64 characters and contain only letters, numbers, hyphens, and underscores.",
        ),
        (
            |params| params.file_type = Some("t".repeat(65)),
            "fileType must be at most 64 characters and contain only letters, numbers, hyphens, and underscores.",
        ),
    ];

    for (mutate, expected) in mutations {
        let mut params = parameters(ContentSearchOutputMode::Content);
        mutate(&mut params);

        assert_eq!(params.validate(), Err(expected.to_owned()));
    }
}

#[test]
fn skips_editor_snapshots_that_exceed_the_file_budget_or_contain_nul_bytes() {
    let (_directory, search) = context(&[("large.ts", ""), ("binary.ts", ""), ("ok.ts", "")]);
    let constrained = ContentSearchContext::new(
        search.root.clone(),
        Arc::clone(&search.paths),
        Arc::clone(&search.index_truncated),
        true,
        16,
    );
    let mut params = parameters(ContentSearchOutputMode::FilesWithMatches);
    params.overrides = BTreeMap::from([
        ("large.ts".to_owned(), format!("needle{}", "x".repeat(16))),
        ("binary.ts".to_owned(), "needle\0".to_owned()),
        ("ok.ts".to_owned(), "needle".to_owned()),
    ]);

    let result = constrained
        .search(params, &AtomicBool::new(false))
        .expect("search should succeed");

    assert!(matches!(
        result,
        ContentSearchResult::FilesWithMatches { files, metadata }
            if files == ["ok.ts"] && metadata.skipped_files == 2 && metadata.searched_files == 1
    ));
}

#[cfg(unix)]
#[test]
fn skips_files_reached_through_symbolically_linked_directories() {
    let (directory, search) = context(&[("real/a.txt", "needle\n")]);
    std::os::unix::fs::symlink(directory.path().join("real"), directory.path().join("link"))
        .expect("symlink should be created");
    search
        .paths
        .write()
        .expect("paths lock should work")
        .insert("link/a.txt".to_owned());

    let result = search
        .search(
            parameters(ContentSearchOutputMode::FilesWithMatches),
            &AtomicBool::new(false),
        )
        .expect("search should succeed");

    assert!(matches!(
        result,
        ContentSearchResult::FilesWithMatches { files, metadata }
            if files == ["real/a.txt"] && metadata.skipped_files == 1
    ));
}

#[test]
fn reports_an_internal_error_when_the_path_catalog_is_poisoned() {
    let (_directory, search) = context(&[("a.txt", "needle")]);
    let paths = Arc::clone(&search.paths);
    let _ = thread::spawn(move || {
        let _guard = paths.write().expect("paths lock should work");
        panic!("poison the path catalog");
    })
    .join();

    let result = search.search(
        parameters(ContentSearchOutputMode::Content),
        &AtomicBool::new(false),
    );

    assert!(matches!(
        result,
        Err(ContentSearchError::Internal(message)) if message == "The known-path set lock is poisoned."
    ));
}

#[test]
fn paginates_matching_files_and_counts() {
    let (_directory, search) = context(&[
        ("a.txt", "needle\n"),
        ("b.txt", "needle\nneedle\n"),
        ("c.txt", "needle\n"),
    ]);
    let mut files_params = parameters(ContentSearchOutputMode::FilesWithMatches);
    files_params.offset = 1;
    files_params.limit = 1;
    let mut count_params = parameters(ContentSearchOutputMode::Count);
    count_params.offset = 1;
    count_params.limit = 1;

    let files = search
        .search(files_params, &AtomicBool::new(false))
        .expect("search should succeed");
    let counts = search
        .search(count_params, &AtomicBool::new(false))
        .expect("search should succeed");

    assert!(matches!(
        files,
        ContentSearchResult::FilesWithMatches { files, metadata }
            if files == ["b.txt"] && metadata.truncated && metadata.next_offset == Some(2)
    ));
    assert!(matches!(
        counts,
        ContentSearchResult::Count { counts, metadata }
            if counts.len() == 1
                && counts[0].path == "b.txt"
                && counts[0].count == 2
                && metadata.truncated
                && metadata.next_offset == Some(2)
    ));
}

#[test]
fn scopes_paths_case_insensitively_at_component_boundaries() {
    let (_directory, search) = context(&[
        ("Src/a.ts", "needle\n"),
        ("src-other/b.ts", "needle\n"),
        ("SRC.ts", "needle\n"),
    ]);
    let insensitive = ContentSearchContext::new(
        search.root.clone(),
        Arc::clone(&search.paths),
        Arc::clone(&search.index_truncated),
        false,
        1024,
    );
    let mut scoped = parameters(ContentSearchOutputMode::FilesWithMatches);
    scoped.path = Some("src".to_owned());
    let mut exact = parameters(ContentSearchOutputMode::FilesWithMatches);
    exact.path = Some("src.TS".to_owned());

    let scoped = insensitive
        .search(scoped, &AtomicBool::new(false))
        .expect("search should succeed");
    let exact = insensitive
        .search(exact, &AtomicBool::new(false))
        .expect("search should succeed");

    assert!(matches!(
        scoped,
        ContentSearchResult::FilesWithMatches { files, .. } if files == ["Src/a.ts"]
    ));
    assert!(matches!(
        exact,
        ContentSearchResult::FilesWithMatches { files, .. } if files == ["SRC.ts"]
    ));
}

#[test]
fn treats_carriage_returns_as_line_breaks() {
    let (_directory, search) = context(&[("lines.txt", "one\r\nneedle\rthree\n")]);
    let mut params = parameters(ContentSearchOutputMode::Content);
    params.lines_before = 1;
    params.lines_after = 1;

    let result = search
        .search(params, &AtomicBool::new(false))
        .expect("search should succeed");

    assert!(matches!(
        result,
        ContentSearchResult::Content { matches, .. }
            if matches.len() == 1
                && matches[0].line == 2
                && matches[0].line_text == "needle"
                && matches[0].lines_before[0].content == "one"
                && matches[0].lines_after[0].content == "three"
    ));
}

#[test]
fn accepts_explicitly_recursive_file_globs() {
    let (_directory, search) = context(&[("src/a.ts", "needle\n"), ("b.md", "needle\n")]);
    let mut params = parameters(ContentSearchOutputMode::FilesWithMatches);
    params.file_glob = Some("**/*.ts".to_owned());

    let result = search
        .search(params, &AtomicBool::new(false))
        .expect("search should succeed");

    assert!(matches!(
        result,
        ContentSearchResult::FilesWithMatches { files, .. } if files == ["src/a.ts"]
    ));
}

#[test]
fn stops_scanning_a_file_once_cancelled_or_once_enough_matches_are_found() {
    let params = parameters(ContentSearchOutputMode::Content);
    let matcher = compile_matcher(&params).unwrap();

    let cancelled = search_file(
        "a.txt",
        "needle\nneedle\n",
        &matcher,
        &params,
        100,
        &AtomicBool::new(true),
    );
    let limited = search_file(
        "a.txt",
        "needle needle\n",
        &matcher,
        &params,
        1,
        &AtomicBool::new(false),
    );

    assert_eq!(cancelled.count, 0);
    assert!(cancelled.matches.is_empty());
    assert_eq!(limited.matches.len(), 1);
    assert!(limited.matches_truncated);
}

#[test]
fn a_truncated_file_outcome_ends_the_page_without_a_next_offset() {
    let params = parameters(ContentSearchOutputMode::Content);
    let mut accumulator = ResultAccumulator::new(&params, false);
    let mut outcome = FileOutcome::empty("a.txt");
    outcome.matches_truncated = true;

    let full = accumulator.push(outcome);
    let result = accumulator.finish(1, 0);

    assert!(full);
    assert!(matches!(
        result,
        ContentSearchResult::Content { matches, metadata }
            if matches.is_empty() && metadata.truncated && metadata.next_offset.is_none()
    ));
}

#[test]
#[should_panic(expected = "internal error: entered unreachable code")]
fn file_and_count_pagination_rejects_content_mode() {
    let params = parameters(ContentSearchOutputMode::Content);
    let mut accumulator = ResultAccumulator::new(&params, false);

    accumulator.skip_or_full();
}

fn run_lane(
    paths: Vec<&str>,
    cancelled: &AtomicBool,
    finished: &AtomicBool,
    sender: mpsc::SyncSender<FileOutcome>,
    search: &mut dyn FnMut(&str) -> FileOutcome,
) {
    search_lane(paths.into_iter(), cancelled, finished, sender, search);
}

#[test]
fn a_lane_sends_every_file_until_it_is_cancelled_finished_or_disconnected() {
    let idle = AtomicBool::new(false);
    let (sender, receiver) = mpsc::sync_channel(2);
    let mut searched = Vec::new();
    run_lane(vec!["a.txt", "b.txt"], &idle, &idle, sender, &mut |path| {
        searched.push(path.to_owned());
        FileOutcome::empty(path)
    });
    let delivered = receiver
        .iter()
        .map(|outcome| outcome.path)
        .collect::<Vec<_>>();

    let cancelled = AtomicBool::new(false);
    let (sender, _receiver) = mpsc::sync_channel(2);
    let mut cancelled_reads = 0;
    run_lane(
        vec!["a.txt", "b.txt"],
        &cancelled,
        &idle,
        sender,
        &mut |path| {
            cancelled_reads += 1;
            cancelled.store(true, Ordering::Release);
            FileOutcome::empty(path)
        },
    );

    let finished = AtomicBool::new(false);
    let (sender, _receiver) = mpsc::sync_channel(2);
    let mut finished_reads = 0;
    run_lane(
        vec!["a.txt", "b.txt"],
        &idle,
        &finished,
        sender,
        &mut |path| {
            finished_reads += 1;
            finished.store(true, Ordering::Release);
            FileOutcome::empty(path)
        },
    );

    let (sender, receiver) = mpsc::sync_channel(2);
    drop(receiver);
    let mut disconnected_reads = 0;
    run_lane(vec!["a.txt", "b.txt"], &idle, &idle, sender, &mut |path| {
        disconnected_reads += 1;
        FileOutcome::empty(path)
    });

    assert_eq!(searched, ["a.txt", "b.txt"]);
    assert_eq!(delivered, ["a.txt", "b.txt"]);
    assert_eq!(cancelled_reads, 1);
    assert_eq!(finished_reads, 1);
    assert_eq!(disconnected_reads, 1);
}

struct ObservedFiles<'a> {
    files: &'a ContentSearchContext,
    cancel_on_read: Option<&'a AtomicBool>,
}

impl SearchableFiles for ObservedFiles<'_> {
    fn read(&self, path: &str) -> Result<String, ()> {
        let result = self.files.read(path);
        if let Some(cancelled) = self.cancel_on_read {
            cancelled.store(true, Ordering::Release);
        }
        result
    }
}

#[test]
fn searching_a_content_source_reports_admission_and_in_flight_cancellation_or_results() {
    let (_directory, search) = context(&[("a.txt", "needle")]);
    let already_cancelled = AtomicBool::new(true);
    let cancelled_during_read = AtomicBool::new(false);
    let idle = AtomicBool::new(false);
    let mut invalid = parameters(ContentSearchOutputMode::Content);
    invalid.pattern.clear();

    let rejected = search.search_files(
        invalid,
        &idle,
        &ObservedFiles {
            files: &search,
            cancel_on_read: None,
        },
    );
    let refused = search.search_files(
        parameters(ContentSearchOutputMode::Content),
        &already_cancelled,
        &ObservedFiles {
            files: &search,
            cancel_on_read: None,
        },
    );
    let interrupted = search.search_files(
        parameters(ContentSearchOutputMode::Content),
        &cancelled_during_read,
        &ObservedFiles {
            files: &search,
            cancel_on_read: Some(&cancelled_during_read),
        },
    );
    let found = search.search_files(
        parameters(ContentSearchOutputMode::FilesWithMatches),
        &idle,
        &ObservedFiles {
            files: &search,
            cancel_on_read: None,
        },
    );

    assert!(matches!(
        rejected,
        Err(ContentSearchError::InvalidRequest(_))
    ));
    assert!(matches!(refused, Err(ContentSearchError::Cancelled)));
    assert!(matches!(interrupted, Err(ContentSearchError::Cancelled)));
    assert!(matches!(
        found,
        Ok(ContentSearchResult::FilesWithMatches { files, metadata })
            if files == ["a.txt"] && metadata.searched_files == 1
    ));
}
