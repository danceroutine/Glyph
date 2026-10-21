use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

use tempfile::TempDir;

const WORKSPACE_POLICY: &str = r#"{"ignoredDirectories":[".git"],"sensitiveFileNames":[".netrc"],"sensitiveFilePrefixes":[".env"],"sensitiveFileExtensions":[".pem"],"allowedFileNames":[".env.example"]}"#;

struct Workspace {
    _temporary: TempDir,
    root: PathBuf,
    state: PathBuf,
}

impl Workspace {
    fn new() -> Self {
        let temporary = tempfile::Builder::new()
            .prefix("glyph-shell-command-line-")
            .tempdir()
            .expect("create disposable fixture");
        let base = fs::canonicalize(temporary.path()).expect("canonicalize fixture");
        let root = base.join("workspace");
        let state = base.join("state");
        fs::create_dir(&root).expect("create workspace");
        fs::create_dir(&state).expect("create state directory");
        Self {
            _temporary: temporary,
            root,
            state,
        }
    }

    fn run(&self, script: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_glyph-shell-sandbox"))
            .args(["--profile", "read-only", "--working-directory"])
            .arg(&self.root)
            .arg("--state-directory")
            .arg(&self.state)
            .arg("--workspace-root")
            .arg(&self.root)
            .args(["--workspace-policy", WORKSPACE_POLICY])
            .args(["--", "/bin/sh", "-c", script])
            .output()
            .expect("run native sandbox helper")
    }
}

#[test]
fn reports_usage_and_fails_when_no_command_is_given() {
    let output = Command::new(env!("CARGO_BIN_EXE_glyph-shell-sandbox"))
        .output()
        .expect("run native sandbox helper");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1));
    assert!(stderr.starts_with("glyph-shell-sandbox: a command must follow the -- separator\n"));
    assert!(stderr.contains("Usage: glyph-shell-sandbox --profile <read-only|workspace-write>"));
    assert!(output.stdout.is_empty());
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
#[ignore = "requires the host sandbox backend; run with pnpm shell-sandbox:torture"]
fn propagates_the_exit_status_of_the_sandboxed_command() {
    let workspace = Workspace::new();

    let output = workspace.run("printf sandboxed; exit 7");

    assert_eq!(output.status.code(), Some(7));
    assert_eq!(String::from_utf8_lossy(&output.stdout), "sandboxed");
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires the host sandbox backend; run with pnpm shell-sandbox:torture"]
fn fails_when_the_sandboxed_command_is_terminated_by_a_signal() {
    let workspace = Workspace::new();

    let output = workspace.run("kill -KILL $$");

    assert_eq!(output.status.code(), Some(1));
}
