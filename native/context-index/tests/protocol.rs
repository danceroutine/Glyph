use std::fs;
use std::io::{Read, Write};
use std::process::{Command, Output, Stdio};

use serde_json::Value;

fn run_with_input(input: &str, configure: impl FnOnce(&mut Command)) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_glyph-context-index"));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure(&mut command);
    let mut child = command.spawn().expect("start the context index");
    child
        .stdin
        .take()
        .expect("standard input should be piped")
        .write_all(input.as_bytes())
        .expect("write protocol requests");
    child
        .wait_with_output()
        .expect("wait for the context index")
}

#[test]
fn answers_requests_over_standard_streams_until_shutdown() {
    let project = tempfile::tempdir().expect("create project fixture");
    fs::write(project.path().join("main.ts"), "export {}").expect("write project file");
    let initialize = serde_json::json!({
        "version": 1,
        "id": 1,
        "method": "initialize",
        "params": { "root": project.path() }
    });
    let input = format!(
        "{initialize}\n{}\n{}\n",
        r#"{"version":1,"id":2,"method":"search","params":{"query":"main","generation":1}}"#,
        r#"{"version":1,"id":3,"method":"shutdown","params":{}}"#
    );

    let output = run_with_input(&input, |_| {});

    assert!(output.status.success());
    let responses = String::from_utf8(output.stdout)
        .expect("responses should be UTF-8")
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("response should be JSON"))
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 3);
    assert_eq!(responses[0]["result"]["fileCount"], 1);
    assert_eq!(responses[1]["result"]["matches"][0]["path"], "main.ts");
    assert_eq!(responses[2]["result"]["shutdown"], true);
}

#[test]
fn fails_when_standard_input_cannot_be_read() {
    let directory = tempfile::tempdir().expect("create fixture directory");
    let unreadable = fs::File::open(directory.path()).expect("open the fixture directory");

    let output = Command::new(env!("CARGO_BIN_EXE_glyph-context-index"))
        .stdin(unreadable)
        .output()
        .expect("run the context index");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr)
        .starts_with("glyph-context-index: could not read a protocol request:"));
}

#[test]
fn fails_when_responses_cannot_be_written() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_glyph-context-index"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start the context index");
    drop(child.stdout.take());
    child
        .stdin
        .take()
        .expect("standard input should be piped")
        .write_all(
            concat!(
                "{\"version\":1,\"id\":1,\"method\":\"refresh\",\"params\":{}}\n",
                "{\"version\":1,\"id\":2,\"method\":\"refresh\",\"params\":{}}\n",
            )
            .as_bytes(),
        )
        .expect("write protocol requests");

    let status = child.wait().expect("wait for the context index");
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .expect("standard error should be piped")
        .read_to_string(&mut stderr)
        .expect("read standard error");

    assert_eq!(status.code(), Some(1));
    assert!(stderr.starts_with("glyph-context-index: "));
}

#[cfg(target_os = "macos")]
#[test]
fn fails_to_start_when_the_response_writer_thread_cannot_be_created() {
    let output = run_with_input("", |command| {
        command.env("RUST_MIN_STACK", (1_u64 << 60).to_string());
    });

    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr)
        .starts_with("glyph-context-index: could not start the protocol writer:"));
}

#[cfg(target_os = "macos")]
#[test]
fn fails_to_start_when_the_service_thread_cannot_be_created() {
    let mut fits_twice = 1_u64 << 30;
    let mut fits_never = 1_u64 << 60;
    let mut service_failure = None;
    for _ in 0..64 {
        let stack_size = fits_twice + (fits_never - fits_twice) / 2;
        let output = run_with_input("", |command| {
            command.env("RUST_MIN_STACK", stack_size.to_string());
        });
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        if output.status.success() {
            fits_twice = stack_size;
        } else if stderr.starts_with("glyph-context-index: could not start the protocol writer:") {
            fits_never = stack_size;
        } else {
            service_failure = Some((output.status.code(), stderr));
            break;
        }
    }

    let (code, stderr) = service_failure.expect("a stack size should admit only one thread");
    assert_eq!(code, Some(1));
    assert!(stderr.starts_with("glyph-context-index: could not start the context index service:"));
}
