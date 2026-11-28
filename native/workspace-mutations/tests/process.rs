use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn emits_only_a_single_bounded_json_reply_over_standard_streams() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_glyph-workspace-mutations"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"{}\n").unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(result.status.success());
    assert!(result.stderr.is_empty());
    let body: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(body["code"], "INVALID_INPUT");
}
