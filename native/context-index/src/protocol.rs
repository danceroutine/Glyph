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
use crate::workers::{SystemWorkers, WorkerFactory, WorkerRole};

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
    FilterPaths(Vec<String>),
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
    serve(
        || BufReader::new(io::stdin().lock()),
        || BufWriter::new(io::stdout().lock()),
        SystemWorkers,
    )
}

/// Owns the protocol transport and worker lifetimes. Streams are opened on the
/// same threads and in the same order as the standard-I/O composition.
fn serve<R: BufRead, W: Write>(
    input: impl FnOnce() -> R,
    output: impl FnOnce() -> W + Send + 'static,
    workers: impl WorkerFactory,
) -> Result<(), String> {
    let latest_generation = Arc::new(AtomicU64::new(0));
    let cancellations: CancellationRegistry = Arc::new(Mutex::new(HashMap::new()));
    let (work_sender, work_receiver) = mpsc::sync_channel(CHANNEL_CAPACITY);
    let (response_sender, response_receiver) = mpsc::sync_channel(CHANNEL_CAPACITY);

    let writer = workers
        .spawn(WorkerRole::ProtocolWriter, move || {
            let mut output = output();
            write_responses(response_receiver, &mut output)
                .map_err(|error| format!("could not write a protocol response: {error}"))
        })
        .map_err(|error| format!("could not start the protocol writer: {error}"))?;

    let worker_latest_generation = Arc::clone(&latest_generation);
    let worker_cancellations = Arc::clone(&cancellations);
    let service_workers = workers.clone();
    let worker = match workers.spawn(WorkerRole::Service, move || {
        service_loop(
            work_receiver,
            response_sender,
            &worker_latest_generation,
            worker_cancellations,
            &service_workers,
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

    let read_result = read_requests(input(), &work_sender, &latest_generation, &cancellations);
    drop(work_sender);

    let worker_result = worker
        .join()
        .map_err(|_| "the context index service thread panicked".to_owned())?;
    let writer_result = writer
        .join()
        .map_err(|_| "the protocol writer thread panicked".to_owned())?;

    transport_result(read_result, worker_result, writer_result)
}

/// Selects the transport outcome after both workers have been joined.
fn transport_result(
    read_result: Result<(), String>,
    worker_result: Result<(), String>,
    writer_result: Result<(), String>,
) -> Result<(), String> {
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
    workers: &impl WorkerFactory,
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
                    Request::FilterPaths(paths) => {
                        (result_response(id, service.filter_paths(paths)), false)
                    }
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
                        searches.push(
                            workers
                                .spawn(WorkerRole::ContentSearch, move || {
                                    let result = context
                                        .search(params, &cancellation)
                                        .map_err(content_search_error);
                                    if let Ok(mut registry) = search_cancellations.lock() {
                                        registry.remove(&request_id);
                                    }
                                    let _ = response_sender
                                        .send(result_response(Some(request_id), result));
                                })
                                .expect("failed to spawn thread"),
                        );
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
        "filterPaths" => Request::FilterPaths(decode_params(
            "filterPaths",
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

fn write_responses(receiver: Receiver<Response>, output: &mut dyn Write) -> io::Result<()> {
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
mod tests;
