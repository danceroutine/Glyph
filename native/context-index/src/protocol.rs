use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::content_search::ContentSearchParams;
use crate::service::{
    content_search_error, ContextIndexService, GlobParams, InitializeParams, SearchParams,
    ServiceError,
};

const PROTOCOL_VERSION: u8 = 1;
const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const CHANNEL_CAPACITY: usize = 64;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
enum RequestId {
    Number(serde_json::Number),
    String(String),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestEnvelope {
    version: u8,
    id: RequestId,
    method: String,
    params: Value,
}

#[derive(Debug)]
enum Request {
    Initialize(InitializeParams),
    Search(SearchParams),
    Glob(GlobParams),
    ContentSearch(ContentSearchParams),
    Cancel(CancelParams),
    Refresh,
    Shutdown,
}

#[derive(Debug)]
struct DecodedRequest {
    id: RequestId,
    request: Request,
    cancellation: Option<Arc<AtomicBool>>,
}

#[derive(Debug)]
enum WorkItem {
    Request(DecodedRequest),
    Invalid {
        id: Option<RequestId>,
        error: ServiceError,
    },
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum Response {
    Success {
        version: u8,
        id: Option<RequestId>,
        result: Value,
    },
    Error {
        version: u8,
        id: Option<RequestId>,
        error: ErrorBody,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParams {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelParams {
    request_id: RequestId,
}

#[derive(Debug, Serialize)]
struct CancelResult {
    cancelled: bool,
}

type CancellationRegistry = Arc<Mutex<HashMap<RequestId, Arc<AtomicBool>>>>;

enum ProtocolLine {
    EndOfFile,
    Line(Vec<u8>),
    TooLong,
}

/// Runs the versioned JSON-lines protocol on standard input and standard output.
///
/// Standard output is reserved exclusively for response envelopes. Operational
/// diagnostics are emitted by the service on standard error.
pub fn run() -> Result<(), String> {
    let latest_generation = Arc::new(AtomicU64::new(0));
    let cancellations: CancellationRegistry = Arc::new(Mutex::new(HashMap::new()));
    let (work_sender, work_receiver) = mpsc::sync_channel(CHANNEL_CAPACITY);
    let (response_sender, response_receiver) = mpsc::sync_channel(CHANNEL_CAPACITY);

    let writer = thread::Builder::new()
        .name("context-index-protocol-writer".to_owned())
        .spawn(move || {
            let stdout = io::stdout();
            let mut output = BufWriter::new(stdout.lock());
            write_responses(response_receiver, &mut output)
                .map_err(|error| format!("could not write a protocol response: {error}"))
        })
        .map_err(|error| format!("could not start the protocol writer: {error}"))?;

    let worker_latest_generation = Arc::clone(&latest_generation);
    let worker_cancellations = Arc::clone(&cancellations);
    let worker = match thread::Builder::new()
        .name("context-index-service".to_owned())
        .spawn(move || {
            service_loop(
                work_receiver,
                response_sender,
                &worker_latest_generation,
                worker_cancellations,
            )
        }) {
        Ok(worker) => worker,
        Err(error) => {
            drop(work_sender);
            let _ = writer.join();
            return Err(format!(
                "could not start the context index service: {error}"
            ));
        }
    };

    let read_result = read_requests(
        BufReader::new(io::stdin().lock()),
        &work_sender,
        &latest_generation,
        &cancellations,
    );
    drop(work_sender);

    let worker_result = worker
        .join()
        .map_err(|_| "the context index service thread panicked".to_owned())?;
    let writer_result = writer
        .join()
        .map_err(|_| "the protocol writer thread panicked".to_owned())?;

    read_result?;
    worker_result?;
    writer_result
}

fn read_requests<R: BufRead>(
    mut input: R,
    sender: &SyncSender<WorkItem>,
    latest_generation: &AtomicU64,
    cancellations: &CancellationRegistry,
) -> Result<(), String> {
    loop {
        let item = match read_protocol_line(&mut input)
            .map_err(|error| format!("could not read a protocol request: {error}"))?
        {
            ProtocolLine::EndOfFile => return Ok(()),
            ProtocolLine::TooLong => WorkItem::Invalid {
                id: None,
                error: ServiceError::invalid_request(format!(
                    "Request exceeds the {MAX_REQUEST_BYTES}-byte limit."
                )),
            },
            ProtocolLine::Line(line) => match decode_request(&line) {
                Ok(mut decoded) => {
                    if let Request::Search(params) = &decoded.request {
                        latest_generation.fetch_max(params.generation, Ordering::AcqRel);
                    }
                    match &decoded.request {
                        Request::ContentSearch(_) => {
                            let cancellation = Arc::new(AtomicBool::new(false));
                            cancellations
                                .lock()
                                .map_err(|_| "The cancellation registry is poisoned.".to_owned())?
                                .insert(decoded.id.clone(), Arc::clone(&cancellation));
                            decoded.cancellation = Some(cancellation);
                        }
                        Request::Cancel(params) => {
                            if let Some(cancellation) = cancellations
                                .lock()
                                .map_err(|_| "The cancellation registry is poisoned.".to_owned())?
                                .get(&params.request_id)
                            {
                                cancellation.store(true, Ordering::Release);
                            }
                        }
                        _ => {}
                    }
                    WorkItem::Request(decoded)
                }
                Err((id, error)) => WorkItem::Invalid { id, error },
            },
        };

        let shutdown = matches!(
            &item,
            WorkItem::Request(DecodedRequest {
                request: Request::Shutdown,
                ..
            })
        );
        sender
            .send(item)
            .map_err(|_| "the context index service stopped accepting requests".to_owned())?;
        if shutdown {
            return Ok(());
        }
    }
}

fn service_loop(
    receiver: Receiver<WorkItem>,
    sender: SyncSender<Response>,
    latest_generation: &AtomicU64,
    cancellations: CancellationRegistry,
) -> Result<(), String> {
    let mut service = ContextIndexService::new();
    let mut searches: Vec<thread::JoinHandle<()>> = Vec::new();

    for item in receiver {
        let mut active_searches = Vec::with_capacity(searches.len());
        for search in searches.drain(..) {
            if search.is_finished() {
                search
                    .join()
                    .map_err(|_| "A project content search thread panicked.".to_owned())?;
            } else {
                active_searches.push(search);
            }
        }
        searches = active_searches;
        let (response, shutdown) = match item {
            WorkItem::Invalid { id, error } => (error_response(id, error), false),
            WorkItem::Request(decoded) => {
                let id = Some(decoded.id.clone());
                match decoded.request {
                    Request::Initialize(params) => {
                        (result_response(id, service.initialize(params)), false)
                    }
                    Request::Search(params) => (
                        result_response(id, service.search(params, latest_generation)),
                        false,
                    ),
                    Request::Glob(params) => (result_response(id, service.glob(params)), false),
                    Request::ContentSearch(params) => {
                        let context = match service.content_search_context() {
                            Ok(context) => context,
                            Err(error) => {
                                sender.send(error_response(id, error)).map_err(|_| {
                                    "the protocol response writer stopped accepting output"
                                        .to_owned()
                                })?;
                                continue;
                            }
                        };
                        let cancellation = decoded
                            .cancellation
                            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
                        let response_sender = sender.clone();
                        let search_cancellations = Arc::clone(&cancellations);
                        let request_id = decoded.id;
                        searches.push(thread::spawn(move || {
                            let result = context
                                .search(params, &cancellation)
                                .map_err(content_search_error);
                            if let Ok(mut registry) = search_cancellations.lock() {
                                registry.remove(&request_id);
                            }
                            let _ = response_sender.send(result_response(Some(request_id), result));
                        }));
                        continue;
                    }
                    Request::Cancel(params) => {
                        let cancelled = cancellations
                            .lock()
                            .map_err(|_| "The cancellation registry is poisoned.".to_owned())?
                            .contains_key(&params.request_id);
                        (success_response(id, CancelResult { cancelled }), false)
                    }
                    Request::Refresh => (result_response(id, service.refresh()), false),
                    Request::Shutdown => {
                        if let Ok(registry) = cancellations.lock() {
                            for cancellation in registry.values() {
                                cancellation.store(true, Ordering::Release);
                            }
                        }
                        for search in searches.drain(..) {
                            search.join().map_err(|_| {
                                "A project content search thread panicked.".to_owned()
                            })?;
                        }
                        (success_response(id, service.shutdown()), true)
                    }
                }
            }
        };

        sender
            .send(response)
            .map_err(|_| "the protocol response writer stopped accepting output".to_owned())?;
        if shutdown {
            return Ok(());
        }
    }

    if let Ok(registry) = cancellations.lock() {
        for cancellation in registry.values() {
            cancellation.store(true, Ordering::Release);
        }
    }
    for search in searches {
        search
            .join()
            .map_err(|_| "A project content search thread panicked.".to_owned())?;
    }
    Ok(())
}

fn decode_request(line: &[u8]) -> Result<DecodedRequest, (Option<RequestId>, ServiceError)> {
    let value: Value = serde_json::from_slice(line).map_err(|error| {
        (
            None,
            ServiceError::invalid_request(format!("Request is not valid JSON: {error}")),
        )
    })?;
    let id = response_id(&value);
    let envelope: RequestEnvelope = serde_json::from_value(value).map_err(|error| {
        (
            id.clone(),
            ServiceError::invalid_request(format!("Request envelope is invalid: {error}")),
        )
    })?;

    if envelope.version != PROTOCOL_VERSION {
        return Err((
            Some(envelope.id),
            ServiceError::invalid_request(format!(
                "Unsupported protocol version {}; expected {PROTOCOL_VERSION}.",
                envelope.version
            )),
        ));
    }

    let request = match envelope.method.as_str() {
        "initialize" => Request::Initialize(decode_params(
            "initialize",
            envelope.params,
            Some(envelope.id.clone()),
        )?),
        "search" => Request::Search(decode_params(
            "search",
            envelope.params,
            Some(envelope.id.clone()),
        )?),
        "glob" => Request::Glob(decode_params(
            "glob",
            envelope.params,
            Some(envelope.id.clone()),
        )?),
        "contentSearch" => Request::ContentSearch(decode_params(
            "contentSearch",
            envelope.params,
            Some(envelope.id.clone()),
        )?),
        "cancel" => Request::Cancel(decode_params(
            "cancel",
            envelope.params,
            Some(envelope.id.clone()),
        )?),
        "refresh" => {
            let _: EmptyParams =
                decode_params("refresh", envelope.params, Some(envelope.id.clone()))?;
            Request::Refresh
        }
        "shutdown" => {
            let _: EmptyParams =
                decode_params("shutdown", envelope.params, Some(envelope.id.clone()))?;
            Request::Shutdown
        }
        method => {
            return Err((
                Some(envelope.id),
                ServiceError::invalid_request(format!("Unknown method \"{method}\".")),
            ));
        }
    };

    Ok(DecodedRequest {
        id: envelope.id,
        request,
        cancellation: None,
    })
}

fn decode_params<T: DeserializeOwned>(
    method: &str,
    params: Value,
    id: Option<RequestId>,
) -> Result<T, (Option<RequestId>, ServiceError)> {
    serde_json::from_value(params).map_err(|error| {
        (
            id,
            ServiceError::invalid_request(format!(
                "Parameters for \"{method}\" are invalid: {error}"
            )),
        )
    })
}

fn response_id(value: &Value) -> Option<RequestId> {
    match value.get("id") {
        Some(Value::Number(number)) => Some(RequestId::Number(number.clone())),
        Some(Value::String(string)) => Some(RequestId::String(string.clone())),
        _ => None,
    }
}

fn result_response<T: Serialize>(
    id: Option<RequestId>,
    result: Result<T, ServiceError>,
) -> Response {
    match result {
        Ok(result) => success_response(id, result),
        Err(error) => error_response(id, error),
    }
}

fn success_response<T: Serialize>(id: Option<RequestId>, result: T) -> Response {
    match serde_json::to_value(result) {
        Ok(result) => Response::Success {
            version: PROTOCOL_VERSION,
            id,
            result,
        },
        Err(error) => error_response(
            id,
            ServiceError {
                code: "INTERNAL",
                message: format!("Could not serialize the protocol result: {error}"),
            },
        ),
    }
}

fn error_response(id: Option<RequestId>, error: ServiceError) -> Response {
    Response::Error {
        version: PROTOCOL_VERSION,
        id,
        error: ErrorBody {
            code: error.code,
            message: error.message,
        },
    }
}

fn write_responses<W: Write>(receiver: Receiver<Response>, output: &mut W) -> io::Result<()> {
    for response in receiver {
        serde_json::to_writer(&mut *output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}

fn read_protocol_line<R: BufRead>(input: &mut R) -> io::Result<ProtocolLine> {
    let mut line = Vec::new();
    let mut too_long = false;

    loop {
        let available = input.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() && !too_long {
                Ok(ProtocolLine::EndOfFile)
            } else if too_long {
                Ok(ProtocolLine::TooLong)
            } else {
                Ok(ProtocolLine::Line(line))
            };
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let payload_length = newline.unwrap_or(available.len());
        if !too_long {
            let remaining = MAX_REQUEST_BYTES.saturating_sub(line.len());
            let copied = remaining.min(payload_length);
            line.extend_from_slice(&available[..copied]);
            if copied < payload_length {
                too_long = true;
            }
        }

        let consumed = payload_length + usize::from(newline.is_some());
        input.consume(consumed);
        if newline.is_some() {
            return if too_long {
                Ok(ProtocolLine::TooLong)
            } else {
                Ok(ProtocolLine::Line(line))
            };
        }
    }
}

#[cfg(test)]
mod tests {
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
        let (id, error) = decode_request(
            br#"{"version":1,"id":42,"method":"refresh","params":{"unexpected":true}}"#,
        )
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
        let (id, error) =
            decode_request(br#"{"version":2,"id":9,"method":"shutdown","params":{}}"#)
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
        let ProtocolLine::Line(next) =
            read_protocol_line(&mut input).expect("next line should work")
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
}
