//! One host-authorized mutation per invocation. Directory descriptors and their lifetimes stay inside this process.
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod filesystem;
#[cfg(test)]
mod tests;

const MAX_REQUEST_BYTES: u64 = 32 * 1024;
const MAX_PACKAGE_REQUEST_BYTES: u64 = 24 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StagedDirectory {
    path: String,
    mode: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StagedFile {
    path: String,
    mode: u32,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    root: String,
    root_identity: Identity,
    #[serde(flatten)]
    operation: Operation,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    device: String,
    inode: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Operation {
    AssertReplaceableMetadata {
        relative: String,
        recursive: bool,
        ownership_reference: Option<String>,
    },
    EnsureDirectory {
        relative: String,
        mode: Option<u32>,
    },
    CreateStage {
        relative: String,
    },
    StagePackage {
        relative: String,
        directories: Vec<StagedDirectory>,
        files: Vec<StagedFile>,
    },
    RenameExclusive {
        source_relative: String,
        target_relative: String,
    },
    RemoveTree {
        relative: String,
    },
}

#[derive(Serialize, Debug)]
struct Failure {
    code: &'static str,
    message: String,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn invalid() -> Self {
        Self::new(
            "INVALID_INPUT",
            "Expected one bounded workspace mutation with normalized paths.",
        )
    }
}

/// Reads one bounded request through EOF and writes one JSON reply. An I/O error writing the reply propagates.
pub fn serve(input: impl Read, mut output: impl Write) -> io::Result<()> {
    let mut bytes = Vec::new();
    let result = input
        .take(MAX_PACKAGE_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::invalid())
        .and_then(|_| {
            if bytes.len() as u64 > MAX_PACKAGE_REQUEST_BYTES {
                return Err(Failure::invalid());
            }
            let request =
                serde_json::from_slice::<Request>(&bytes).map_err(|_| Failure::invalid())?;
            if bytes.len() as u64 > MAX_REQUEST_BYTES
                && !matches!(request.operation, Operation::StagePackage { .. })
            {
                return Err(Failure::invalid());
            }
            execute(&request)
        });
    let reply = match result {
        Ok(Some(digest)) => serde_json::json!({ "ok": true, "digest": digest }),
        Ok(None) => serde_json::json!({ "ok": true }),
        Err(error) => {
            serde_json::json!({ "ok": false, "code": error.code, "message": error.message })
        }
    };
    serde_json::to_writer(&mut output, &reply)?;
    output.write_all(b"\n")
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
use filesystem::execute;

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn execute(_: &Request) -> Result<Option<String>, Failure> {
    Err(Failure::new(
        "ENOTSUP",
        "Descriptor-relative package mutations are unavailable on this platform.",
    ))
}
