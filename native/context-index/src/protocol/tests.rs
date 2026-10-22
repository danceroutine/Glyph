use std::io::Cursor;

use super::*;

#[test]
fn decodes_a_search_request_and_preserves_a_string_id() {
    let decoded = decode_request(
        br#"{"version":1,"id":"request-7","method":"search","params":{"query":"chat","limit":12,"generation":7}}"#,
    )
    .expect("request should decode");

    assert_eq!(decoded.id, RequestId::String("request-7".to_owned()));
    let Request::Search(params) = decoded.request else {
        panic!("expected a search request");
    };
    assert_eq!(params.query, "chat");
    assert_eq!(params.limit, 12);
    assert_eq!(params.generation, 7);
}

#[test]
fn decodes_a_glob_request_with_an_optional_target_directory() {
    let decoded = decode_request(
        br#"{"version":1,"id":8,"method":"glob","params":{"pattern":"*.tsx","targetDirectory":"src","limit":2000}}"#,
    )
    .expect("request should decode");

    let Request::Glob(params) = decoded.request else {
        panic!("expected a glob request");
    };
    assert_eq!(params.pattern, "*.tsx");
    assert_eq!(params.target_directory.as_deref(), Some("src"));
    assert_eq!(params.limit, 2_000);
}

#[test]
fn decodes_project_relative_excluded_paths_during_initialization() {
    let decoded = decode_request(
        br#"{"version":1,"id":1,"method":"initialize","params":{"root":"/project","excludedPaths":["src/generated","docs/private.md"]}}"#,
    )
    .expect("request should decode");

    let Request::Initialize(params) = decoded.request else {
        panic!("expected an initialize request");
    };
    assert_eq!(params.excluded_paths, ["src/generated", "docs/private.md"]);
}

#[test]
fn rejects_unknown_method_parameters_and_echoes_the_request_id() {
    let (id, error) =
        decode_request(br#"{"version":1,"id":42,"method":"refresh","params":{"unexpected":true}}"#)
            .expect_err("unknown parameter should be rejected");

    assert_eq!(id, Some(RequestId::Number(42.into())));
    assert_eq!(error.code, "INVALID_REQUEST");
    assert!(error.message.contains("unknown field"));
}

#[test]
fn a_malformed_id_is_rendered_as_null_in_the_error_response() {
    let (id, error) =
        decode_request(br#"{"version":1,"id":false,"method":"shutdown","params":{}}"#)
            .expect_err("boolean request id should be rejected");
    let response = error_response(id, error);

    let encoded = serde_json::to_value(response).expect("response should serialize");
    assert_eq!(encoded["id"], Value::Null);
    assert_eq!(encoded["error"]["code"], "INVALID_REQUEST");
}

#[test]
fn rejects_an_unsupported_protocol_version() {
    let (id, error) = decode_request(br#"{"version":2,"id":9,"method":"shutdown","params":{}}"#)
        .expect_err("version should be rejected");

    assert_eq!(id, Some(RequestId::Number(9.into())));
    assert!(error.message.contains("Unsupported protocol version 2"));
}

#[test]
fn an_oversized_line_is_drained_before_the_next_request() {
    let mut bytes = vec![b'x'; MAX_REQUEST_BYTES + 1];
    bytes.extend_from_slice(b"\n{}\n");
    let mut input = Cursor::new(bytes);

    assert!(matches!(
        read_protocol_line(&mut input).expect("line read should work"),
        ProtocolLine::TooLong
    ));
    let ProtocolLine::Line(next) = read_protocol_line(&mut input).expect("next line should work")
    else {
        panic!("expected the second request line");
    };
    assert_eq!(next, b"{}");
}

#[test]
fn search_before_initialization_returns_a_structured_error() {
    let latest = Arc::new(AtomicU64::new(1));
    let (work_sender, work_receiver) = mpsc::sync_channel(1);
    let (response_sender, response_receiver) = mpsc::sync_channel(1);
    let worker_latest = Arc::clone(&latest);
    let cancellations = Arc::new(Mutex::new(HashMap::new()));
    let worker = thread::spawn(move || {
        service_loop(
            work_receiver,
            response_sender,
            &worker_latest,
            cancellations,
            &SystemWorkers,
        )
    });

    work_sender
        .send(WorkItem::Request(DecodedRequest {
            id: RequestId::Number(1.into()),
            request: Request::Search(SearchParams {
                query: "app".to_owned(),
                limit: 20,
                generation: 1,
            }),
            cancellation: None,
        }))
        .expect("work should send");
    drop(work_sender);

    let response = response_receiver.recv().expect("response should arrive");
    let encoded = serde_json::to_value(response).expect("response should serialize");
    assert_eq!(encoded["id"], 1);
    assert_eq!(encoded["error"]["code"], "NOT_INITIALIZED");
    worker
        .join()
        .expect("worker should not panic")
        .expect("worker should stop cleanly");
}

#[test]
fn reader_publishes_the_latest_generation_before_work_is_processed() {
    let input = Cursor::new(concat!(
        "{\"version\":1,\"id\":1,\"method\":\"search\",\"params\":{\"query\":\"a\",\"generation\":4}}\n",
        "{\"version\":1,\"id\":2,\"method\":\"search\",\"params\":{\"query\":\"app\",\"generation\":9}}\n",
        "{\"version\":1,\"id\":3,\"method\":\"shutdown\",\"params\":{}}\n",
    ));
    let latest = AtomicU64::new(0);
    let cancellations = Arc::new(Mutex::new(HashMap::new()));
    let (sender, receiver) = mpsc::sync_channel(3);

    read_requests(input, &sender, &latest, &cancellations)
        .expect("reader should finish at shutdown");

    assert_eq!(latest.load(Ordering::Acquire), 9);
    assert!(matches!(
        receiver.recv().expect("first request should arrive"),
        WorkItem::Request(DecodedRequest {
            request: Request::Search(SearchParams { generation: 4, .. }),
            ..
        })
    ));
    assert!(matches!(
        receiver.recv().expect("second request should arrive"),
        WorkItem::Request(DecodedRequest {
            request: Request::Search(SearchParams { generation: 9, .. }),
            ..
        })
    ));
    assert!(matches!(
        receiver.recv().expect("shutdown should arrive"),
        WorkItem::Request(DecodedRequest {
            request: Request::Shutdown,
            ..
        })
    ));
}

#[test]
fn reader_cancels_a_content_search_before_queued_work_handles_the_cancel_request() {
    let input = Cursor::new(concat!(
        "{\"version\":1,\"id\":7,\"method\":\"contentSearch\",\"params\":{\"pattern\":\"needle\",\"patternKind\":\"literal\",\"path\":null,\"fileGlob\":null,\"fileType\":null,\"outputMode\":\"content\",\"linesBefore\":0,\"linesAfter\":0,\"caseSensitive\":true,\"multiline\":false,\"limit\":20,\"offset\":0}}\n",
        "{\"version\":1,\"id\":8,\"method\":\"cancel\",\"params\":{\"requestId\":7}}\n",
        "{\"version\":1,\"id\":9,\"method\":\"shutdown\",\"params\":{}}\n",
    ));
    let latest = AtomicU64::new(0);
    let cancellations = Arc::new(Mutex::new(HashMap::new()));
    let (sender, receiver) = mpsc::sync_channel(3);

    read_requests(input, &sender, &latest, &cancellations)
        .expect("reader should finish at shutdown");

    let WorkItem::Request(search) = receiver.recv().expect("search should arrive") else {
        panic!("expected content search");
    };
    assert!(matches!(search.request, Request::ContentSearch(_)));
    assert!(search
        .cancellation
        .expect("search should have a cancellation flag")
        .load(Ordering::Acquire));
    assert!(matches!(
        receiver.recv().expect("cancel should arrive"),
        WorkItem::Request(DecodedRequest {
            request: Request::Cancel(_),
            ..
        })
    ));
}

fn work(id: u64, request: Request) -> WorkItem {
    WorkItem::Request(DecodedRequest {
        id: RequestId::Number(id.into()),
        request,
        cancellation: None,
    })
}

fn initialize_request(root: &std::path::Path) -> Request {
    Request::Initialize(
        serde_json::from_value(serde_json::json!({ "root": root }))
            .expect("initialize parameters should decode"),
    )
}

fn content_search_request() -> Request {
    Request::ContentSearch(
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
        .expect("content search parameters should decode"),
    )
}

fn encoded(response: Response) -> Value {
    serde_json::to_value(response).expect("response should serialize")
}

fn poisoned_registry() -> CancellationRegistry {
    let registry: CancellationRegistry = Arc::new(Mutex::new(HashMap::new()));
    let poisoned = Arc::clone(&registry);
    let _ = thread::spawn(move || {
        let _guard = poisoned.lock().expect("registry lock should work");
        panic!("poison the cancellation registry");
    })
    .join();
    registry
}

fn start_service(
    response_capacity: usize,
    cancellations: CancellationRegistry,
) -> (
    SyncSender<WorkItem>,
    Receiver<Response>,
    thread::JoinHandle<Result<(), String>>,
) {
    start_service_with_workers(
        response_capacity,
        cancellations,
        failing_workers(WorkerRole::ProtocolWriter, false),
    )
}

fn start_service_with_workers(
    response_capacity: usize,
    cancellations: CancellationRegistry,
    workers: impl WorkerFactory,
) -> (
    SyncSender<WorkItem>,
    Receiver<Response>,
    thread::JoinHandle<Result<(), String>>,
) {
    let (work_sender, work_receiver) = mpsc::sync_channel(16);
    let (response_sender, response_receiver) = mpsc::sync_channel(response_capacity);
    let worker = thread::spawn(move || {
        service_loop(
            work_receiver,
            response_sender,
            &AtomicU64::new(0),
            cancellations,
            &workers,
        )
    });
    (work_sender, response_receiver, worker)
}

fn project_with_needle() -> tempfile::TempDir {
    let directory = tempfile::tempdir().expect("temporary directory should exist");
    std::fs::write(directory.path().join("notes.txt"), "needle").expect("fixture should write");
    directory
}

#[test]
fn decodes_each_method_and_rejects_invalid_parameters_with_the_request_id() {
    let filter =
        decode_request(br#"{"version":1,"id":5,"method":"filterPaths","params":["src/main.ts"]}"#)
            .expect("filterPaths should decode");
    let cancel = decode_request(
        br#"{"version":1,"id":6,"method":"cancel","params":{"requestId":"search-1"}}"#,
    )
    .expect("cancel should decode");
    let refresh = decode_request(br#"{"version":1,"id":7,"method":"refresh","params":{}}"#)
        .expect("refresh should decode");
    let content_search = decode_request(
        br#"{"version":1,"id":8,"method":"contentSearch","params":{"pattern":"needle","patternKind":"regular_expression","outputMode":"count","linesBefore":0,"linesAfter":0,"caseSensitive":false,"multiline":true,"limit":5,"offset":0}}"#,
    )
    .expect("contentSearch should decode");

    assert!(matches!(
        filter.request,
        Request::FilterPaths(paths) if paths == ["src/main.ts"]
    ));
    assert!(matches!(
        cancel.request,
        Request::Cancel(CancelParams { request_id: RequestId::String(id) }) if id == "search-1"
    ));
    assert!(matches!(refresh.request, Request::Refresh));
    assert!(matches!(
        content_search.request,
        Request::ContentSearch(params) if params.limit == 5 && params.multiline
    ));
    assert!(content_search.cancellation.is_none());

    for method in [
        "initialize",
        "search",
        "filterPaths",
        "glob",
        "contentSearch",
        "cancel",
        "shutdown",
    ] {
        let line = format!(r#"{{"version":1,"id":"bad","method":"{method}","params":{{"x":1}}}}"#);

        let (id, error) =
            decode_request(line.as_bytes()).expect_err("parameters should be rejected");

        assert_eq!(id, Some(RequestId::String("bad".to_owned())));
        assert!(error
            .message
            .starts_with(&format!("Parameters for \"{method}\" are invalid:")));
    }
}

#[test]
fn rejects_unknown_methods_and_lines_that_are_not_json() {
    let (unknown_id, unknown) =
        decode_request(br#"{"version":1,"id":3,"method":"explode","params":{}}"#)
            .expect_err("unknown methods should be rejected");
    let (malformed_id, malformed) =
        decode_request(b"{not json").expect_err("malformed JSON should be rejected");

    assert_eq!(unknown_id, Some(RequestId::Number(3.into())));
    assert_eq!(unknown.message, "Unknown method \"explode\".");
    assert_eq!(malformed_id, None);
    assert!(malformed.message.starts_with("Request is not valid JSON:"));
}

#[test]
fn reader_reports_oversized_and_malformed_lines_and_stops_at_end_of_input() {
    let text = format!(
        "{}\nnot json\n{}\n",
        "x".repeat(MAX_REQUEST_BYTES + 1),
        r#"{"version":1,"id":3,"method":"refresh","params":{}}"#
    );
    let cancellations = Arc::new(Mutex::new(HashMap::new()));
    let (sender, receiver) = mpsc::sync_channel(3);

    read_requests(
        Cursor::new(text.as_str()),
        &sender,
        &AtomicU64::new(0),
        &cancellations,
    )
    .expect("reader should finish at end of input");

    assert!(matches!(
        receiver.recv().expect("oversized line should be reported"),
        WorkItem::Invalid { id: None, error } if error.message == "Request exceeds the 1048576-byte limit."
    ));
    assert!(matches!(
        receiver.recv().expect("malformed line should be reported"),
        WorkItem::Invalid { id: None, error } if error.message.starts_with("Request is not valid JSON:")
    ));
    assert!(matches!(
        receiver.recv().expect("refresh should arrive"),
        WorkItem::Request(DecodedRequest {
            request: Request::Refresh,
            ..
        })
    ));
}

#[test]
fn reader_fails_when_cancellations_cannot_be_recorded_or_requests_cannot_be_queued() {
    let content_search = "{\"version\":1,\"id\":7,\"method\":\"contentSearch\",\"params\":{\"pattern\":\"needle\",\"patternKind\":\"literal\",\"outputMode\":\"content\",\"linesBefore\":0,\"linesAfter\":0,\"caseSensitive\":true,\"multiline\":false,\"limit\":20,\"offset\":0}}\n";
    let cancel = "{\"version\":1,\"id\":8,\"method\":\"cancel\",\"params\":{\"requestId\":7}}\n";
    let (sender, receiver) = mpsc::sync_channel(1);
    let (closed_sender, closed_receiver) = mpsc::sync_channel(1);
    drop(closed_receiver);

    let search_error = read_requests(
        Cursor::new(content_search),
        &sender,
        &AtomicU64::new(0),
        &poisoned_registry(),
    );
    let cancel_error = read_requests(
        Cursor::new(cancel),
        &sender,
        &AtomicU64::new(0),
        &poisoned_registry(),
    );
    let queue_error = read_requests(
        Cursor::new(cancel),
        &closed_sender,
        &AtomicU64::new(0),
        &Arc::new(Mutex::new(HashMap::new())),
    );

    assert_eq!(
        search_error,
        Err("The cancellation registry is poisoned.".to_owned())
    );
    assert_eq!(
        cancel_error,
        Err("The cancellation registry is poisoned.".to_owned())
    );
    assert_eq!(
        queue_error,
        Err("the context index service stopped accepting requests".to_owned())
    );
    assert!(receiver.try_recv().is_err());
}

#[test]
fn reader_reports_input_that_cannot_be_read() {
    let directory = tempfile::tempdir().expect("temporary directory should exist");
    let unreadable =
        BufReader::new(std::fs::File::open(directory.path()).expect("directory should open"));
    let (sender, _receiver) = mpsc::sync_channel(1);

    let result = read_requests(
        unreadable,
        &sender,
        &AtomicU64::new(0),
        &Arc::new(Mutex::new(HashMap::new())),
    );

    assert!(result
        .expect_err("reading a directory should fail")
        .starts_with("could not read a protocol request:"));
}

#[test]
fn lines_spanning_several_reads_are_reassembled_or_drained() {
    let mut bytes = vec![b'x'; MAX_REQUEST_BYTES + 100_000];
    bytes.extend_from_slice(b"\n{}\npartial");
    let mut input = BufReader::with_capacity(64 * 1024, Cursor::new(bytes));
    let mut unterminated =
        BufReader::with_capacity(64 * 1024, Cursor::new(vec![b'y'; MAX_REQUEST_BYTES + 1]));

    let oversized = read_protocol_line(&mut input).expect("line read should work");
    let complete = read_protocol_line(&mut input).expect("line read should work");
    let partial = read_protocol_line(&mut input).expect("line read should work");
    let finished = read_protocol_line(&mut input).expect("line read should work");
    let unterminated = read_protocol_line(&mut unterminated).expect("line read should work");

    assert!(matches!(oversized, ProtocolLine::TooLong));
    assert!(matches!(complete, ProtocolLine::Line(line) if line == b"{}"));
    assert!(matches!(partial, ProtocolLine::Line(line) if line == b"partial"));
    assert!(matches!(finished, ProtocolLine::EndOfFile));
    assert!(matches!(unterminated, ProtocolLine::TooLong));
}

#[test]
fn results_that_cannot_be_encoded_become_internal_errors() {
    let empty = success_response(
        Some(RequestId::Number(1.into())),
        std::collections::BTreeMap::<(u8, u8), u8>::new(),
    );
    let unencodable = success_response(
        Some(RequestId::Number(2.into())),
        std::collections::BTreeMap::from([((1_u8, 2_u8), 3_u8)]),
    );

    let empty = encoded(empty);
    let unencodable = encoded(unencodable);
    assert_eq!(empty["result"], serde_json::json!({}));
    assert_eq!(unencodable["id"], 2);
    assert_eq!(unencodable["error"]["code"], "INTERNAL");
    assert!(unencodable["error"]["message"]
        .as_str()
        .is_some_and(|message| message.starts_with("Could not serialize the protocol result:")));
}

#[test]
fn service_loop_answers_each_request_kind_and_finishes_searches_before_shutdown() {
    let project = project_with_needle();
    let cancellations: CancellationRegistry = Arc::new(Mutex::new(HashMap::from([(
        RequestId::Number(99.into()),
        Arc::new(AtomicBool::new(false)),
    )])));
    let observed = Arc::clone(&cancellations);
    let (work_sender, responses, worker) = start_service(1, cancellations);
    let mut answers = Vec::new();
    for item in [
        WorkItem::Invalid {
            id: Some(RequestId::Number(1.into())),
            error: ServiceError::invalid_request("rejected"),
        },
        work(2, initialize_request(project.path())),
        work(
            3,
            Request::Search(SearchParams {
                query: "notes".to_owned(),
                limit: 5,
                generation: 0,
            }),
        ),
        work(4, Request::FilterPaths(vec!["notes.txt".to_owned()])),
        work(
            5,
            Request::Glob(GlobParams {
                pattern: "*.txt".to_owned(),
                target_directory: None,
                limit: 5,
            }),
        ),
        work(6, Request::Refresh),
    ] {
        work_sender.send(item).expect("work should send");
        answers.push(encoded(responses.recv().expect("response should arrive")));
    }
    let search_cancellation = Arc::new(AtomicBool::new(false));
    for item in [
        work(
            7,
            Request::Cancel(CancelParams {
                request_id: RequestId::Number(99.into()),
            }),
        ),
        WorkItem::Request(DecodedRequest {
            id: RequestId::Number(8.into()),
            request: content_search_request(),
            cancellation: Some(Arc::clone(&search_cancellation)),
        }),
        work(9, Request::Shutdown),
    ] {
        work_sender.send(item).expect("work should send");
    }
    for _ in 0..3 {
        answers.push(encoded(responses.recv().expect("response should arrive")));
    }

    assert_eq!(worker.join().expect("worker should not panic"), Ok(()));
    assert_eq!(answers[0]["error"]["message"], "rejected");
    assert_eq!(answers[1]["result"]["fileCount"], 1);
    assert_eq!(answers[2]["result"]["matches"][0]["path"], "notes.txt");
    assert_eq!(answers[3]["result"], serde_json::json!(["notes.txt"]));
    assert_eq!(
        answers[4]["result"]["files"],
        serde_json::json!(["notes.txt"])
    );
    assert_eq!(answers[5]["result"]["fileCount"], 1);
    assert_eq!(answers[6]["result"]["cancelled"], true);
    assert_eq!(answers[7]["id"], 8);
    assert_eq!(
        answers[7]["result"]["files"],
        serde_json::json!(["notes.txt"])
    );
    assert_eq!(answers[8]["result"]["shutdown"], true);
    assert!(observed.lock().unwrap()[&RequestId::Number(99.into())].load(Ordering::Acquire));
}

#[test]
fn service_loop_collects_finished_searches_between_requests() {
    let project = project_with_needle();
    let registry: CancellationRegistry = Arc::new(Mutex::new(HashMap::new()));
    let (work_sender, responses, worker) = start_service(4, Arc::clone(&registry));
    work_sender
        .send(work(1, initialize_request(project.path())))
        .expect("work should send");
    responses.recv().expect("initialize should answer");
    work_sender
        .send(work(2, content_search_request()))
        .expect("work should send");
    let search = encoded(responses.recv().expect("search should answer"));
    while Arc::strong_count(&registry) > 2 {
        std::thread::yield_now();
    }
    for id in 3..8 {
        std::thread::sleep(std::time::Duration::from_millis(20));
        work_sender
            .send(work(
                id,
                Request::Cancel(CancelParams {
                    request_id: RequestId::Number(2.into()),
                }),
            ))
            .expect("work should send");
        responses.recv().expect("cancel should answer");
    }
    drop(work_sender);

    assert_eq!(worker.join().expect("worker should not panic"), Ok(()));
    assert_eq!(search["result"]["files"], serde_json::json!(["notes.txt"]));
}

#[test]
fn service_loop_finishes_searches_when_input_ends_without_shutdown() {
    let project = project_with_needle();
    let cancellations: CancellationRegistry = Arc::new(Mutex::new(HashMap::from([(
        RequestId::Number(99.into()),
        Arc::new(AtomicBool::new(false)),
    )])));
    let observed = Arc::clone(&cancellations);
    let (work_sender, responses, worker) = start_service(1, cancellations);
    work_sender
        .send(work(1, initialize_request(project.path())))
        .expect("work should send");
    work_sender
        .send(work(2, content_search_request()))
        .expect("work should send");
    drop(work_sender);

    let initialized = encoded(responses.recv().expect("initialize should answer"));
    let search = encoded(responses.recv().expect("search should answer"));

    assert_eq!(worker.join().expect("worker should not panic"), Ok(()));
    assert_eq!(initialized["result"]["fileCount"], 1);
    assert_eq!(search["id"], 2);
    assert!(observed.lock().unwrap()[&RequestId::Number(99.into())].load(Ordering::Acquire));
}

#[test]
fn service_loop_answers_searches_even_when_the_cancellation_registry_is_poisoned() {
    let project = project_with_needle();
    let mut outcomes = Vec::new();
    for ending in [Some(Request::Shutdown), None] {
        let (work_sender, responses, worker) = start_service(4, poisoned_registry());
        work_sender
            .send(work(1, initialize_request(project.path())))
            .expect("work should send");
        responses.recv().expect("initialize should answer");
        work_sender
            .send(work(2, content_search_request()))
            .expect("work should send");
        let search = encoded(responses.recv().expect("search should answer"));
        if let Some(request) = ending {
            work_sender
                .send(work(3, request))
                .expect("work should send");
            responses.recv().expect("shutdown should answer");
        }
        drop(work_sender);
        outcomes.push((search["result"]["files"].clone(), worker.join().unwrap()));
    }

    assert_eq!(
        outcomes,
        [
            (serde_json::json!(["notes.txt"]), Ok(())),
            (serde_json::json!(["notes.txt"]), Ok(())),
        ]
    );
}

#[test]
fn service_loop_reports_content_searches_before_initialization() {
    let (work_sender, responses, worker) = start_service(1, Arc::new(Mutex::new(HashMap::new())));

    work_sender
        .send(work(1, content_search_request()))
        .expect("work should send");
    let response = encoded(responses.recv().expect("response should arrive"));
    drop(work_sender);

    assert_eq!(response["error"]["code"], "NOT_INITIALIZED");
    assert_eq!(worker.join().expect("worker should not panic"), Ok(()));
}

#[test]
fn service_loop_stops_when_responses_cannot_be_delivered_or_cancellations_are_unreadable() {
    let mut outcomes = Vec::new();
    for (request, cancellations) in [
        (
            content_search_request(),
            Arc::new(Mutex::new(HashMap::new())),
        ),
        (Request::Refresh, Arc::new(Mutex::new(HashMap::new()))),
        (
            Request::Cancel(CancelParams {
                request_id: RequestId::Number(1.into()),
            }),
            poisoned_registry(),
        ),
    ] {
        let (work_sender, responses, worker) = start_service(1, cancellations);
        drop(responses);
        work_sender
            .send(work(1, request))
            .expect("work should send");
        drop(work_sender);
        outcomes.push(worker.join().expect("worker should not panic"));
    }

    assert_eq!(
        outcomes,
        [
            Err("the protocol response writer stopped accepting output".to_owned()),
            Err("the protocol response writer stopped accepting output".to_owned()),
            Err("The cancellation registry is poisoned.".to_owned()),
        ]
    );
}

#[test]
fn each_response_is_flushed_as_one_json_line() {
    let (sender, receiver) = mpsc::sync_channel(1);
    sender
        .send(success_response(
            Some(RequestId::String("done".to_owned())),
            serde_json::json!({ "shutdown": true }),
        ))
        .expect("response should send");
    drop(sender);
    let mut output = Vec::new();

    write_responses(receiver, &mut output).expect("responses should write");

    let text = String::from_utf8(output).expect("response should be UTF-8");
    assert_eq!(text.lines().count(), 1);
    let value: Value = serde_json::from_str(text.trim_end()).expect("JSON should parse");
    assert_eq!(value["version"], PROTOCOL_VERSION);
    assert_eq!(value["id"], "done");
    assert_eq!(value["result"]["shutdown"], true);
}

struct FailingOutput {
    bytes: Vec<u8>,
    remaining: usize,
    flushes: usize,
}

impl Write for FailingOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Err(io::Error::other("output unavailable"));
        }
        let length = bytes.len().min(self.remaining);
        self.bytes.extend_from_slice(&bytes[..length]);
        self.remaining -= length;
        Ok(length)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flushes += 1;
        Err(io::Error::other("flush unavailable"))
    }
}

#[test]
fn response_writing_propagates_json_newline_and_flush_failures() {
    let response = || success_response(Some(RequestId::Number(1.into())), true);
    let json = serde_json::to_vec(&response()).unwrap();
    for limit in [0, json.len(), json.len() + 1] {
        let (sender, receiver) = mpsc::sync_channel(2);
        sender.send(response()).unwrap();
        sender.send(response()).unwrap();
        drop(sender);
        let mut output = FailingOutput {
            bytes: Vec::new(),
            remaining: limit,
            flushes: 0,
        };

        let error = write_responses(receiver, &mut output).unwrap_err();

        let expected = [json.as_slice(), b"\n"].concat();
        assert_eq!(output.bytes, expected[..limit]);
        assert_eq!(output.flushes, usize::from(limit > json.len()));
        assert!(error.to_string().contains(if limit > json.len() {
            "flush unavailable"
        } else {
            "output unavailable"
        }));
    }
}

#[derive(Clone)]
struct FailingWorkers {
    role: WorkerRole,
    panic: bool,
    wait_for_cancellation: Option<Arc<AtomicBool>>,
    observed_cancellation: Arc<AtomicBool>,
}

impl WorkerFactory for FailingWorkers {
    fn spawn<T: Send + 'static>(
        &self,
        role: WorkerRole,
        task: impl FnOnce() -> T + Send + 'static,
    ) -> io::Result<thread::JoinHandle<T>> {
        if role != self.role {
            return SystemWorkers.spawn(role, task);
        }
        if !self.panic {
            return Err(io::Error::other("worker unavailable"));
        }
        let cancellation = self.wait_for_cancellation.clone();
        let observed = Arc::clone(&self.observed_cancellation);
        let worker = SystemWorkers.spawn(role, move || {
            if let Some(cancellation) = cancellation {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                while !cancellation.load(Ordering::Acquire) {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "service never cancelled its workers"
                    );
                    thread::yield_now();
                }
                observed.store(true, Ordering::Release);
            }
            drop(task);
            panic!("injected worker panic");
        })?;
        if role == WorkerRole::ContentSearch && self.wait_for_cancellation.is_none() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !worker.is_finished() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "worker did not finish"
                );
                thread::yield_now();
            }
        }
        Ok(worker)
    }
}

fn failing_workers(role: WorkerRole, panic: bool) -> FailingWorkers {
    FailingWorkers {
        role,
        panic,
        wait_for_cancellation: None,
        observed_cancellation: Arc::new(AtomicBool::new(false)),
    }
}

#[test]
fn transport_reports_worker_startup_and_join_failures_without_changing_error_precedence() {
    for (role, panic, message) in [
        (
            WorkerRole::ProtocolWriter,
            false,
            "could not start the protocol writer: worker unavailable",
        ),
        (
            WorkerRole::Service,
            false,
            "could not start the context index service: worker unavailable",
        ),
        (
            WorkerRole::Service,
            true,
            "the context index service thread panicked",
        ),
        (
            WorkerRole::ProtocolWriter,
            true,
            "the protocol writer thread panicked",
        ),
    ] {
        let result = serve(
            || io::Cursor::new(Vec::<u8>::new()),
            Vec::<u8>::new,
            failing_workers(role, panic),
        );
        assert_eq!(result, Err(message.into()));
    }
}

#[test]
fn transport_propagates_a_service_error_after_joining_its_workers() {
    let project = project_with_needle();
    let initialize = serde_json::json!({
        "version": 1, "id": 1, "method": "initialize",
        "params": { "root": project.path() }
    });
    let search = serde_json::json!({
        "version": 1, "id": 2, "method": "contentSearch",
        "params": {
            "pattern": "needle", "patternKind": "literal", "outputMode": "count",
            "linesBefore": 0, "linesAfter": 0, "caseSensitive": false,
            "multiline": false, "limit": 5, "offset": 0
        }
    });
    let input = format!("{initialize}\n{search}\n");

    let result = serve(
        || io::Cursor::new(input.into_bytes()),
        Vec::<u8>::new,
        failing_workers(WorkerRole::ContentSearch, true),
    );

    assert_eq!(
        result,
        Err("A project content search thread panicked.".into())
    );
}

#[test]
fn a_finished_panicked_search_is_reported_before_the_next_request_is_executed() {
    let project = project_with_needle();
    let registry = Arc::new(Mutex::new(HashMap::new()));
    let (sender, responses, service) = start_service_with_workers(
        4,
        registry,
        failing_workers(WorkerRole::ContentSearch, true),
    );
    sender
        .send(work(1, initialize_request(project.path())))
        .unwrap();
    assert_eq!(encoded(responses.recv().unwrap())["id"], 1);
    sender.send(work(2, content_search_request())).unwrap();
    sender.send(work(3, Request::Refresh)).unwrap();
    drop(sender);
    assert_eq!(
        service.join().unwrap(),
        Err("A project content search thread panicked.".into())
    );
    assert!(
        responses.recv().is_err(),
        "the next request must not publish a response"
    );
}

#[test]
fn shutdown_and_input_eof_cancel_and_join_pending_panicked_searches() {
    for shutdown in [true, false] {
        let project = project_with_needle();
        let cancelled = Arc::new(AtomicBool::new(false));
        let registry = Arc::new(Mutex::new(HashMap::from([(
            RequestId::Number(2.into()),
            Arc::clone(&cancelled),
        )])));
        let mut workers = failing_workers(WorkerRole::ContentSearch, true);
        workers.wait_for_cancellation = Some(cancelled);
        let observed = Arc::clone(&workers.observed_cancellation);
        let (sender, responses, service) = start_service_with_workers(4, registry, workers);
        sender
            .send(work(1, initialize_request(project.path())))
            .unwrap();
        responses.recv().unwrap();
        sender.send(work(2, content_search_request())).unwrap();
        if shutdown {
            sender.send(work(3, Request::Shutdown)).unwrap();
        }
        drop(sender);
        assert_eq!(
            service.join().unwrap(),
            Err("A project content search thread panicked.".into())
        );
        assert!(
            observed.load(Ordering::Acquire),
            "the failure must occur after the final cancellation, not during reaping"
        );
        assert!(
            responses.recv().is_err(),
            "a failed shutdown must not emit success"
        );
    }
}
