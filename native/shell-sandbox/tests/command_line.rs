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

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_glyph-shell-sandbox"));
        command
            .args(["--profile", "read-only", "--working-directory"])
            .arg(&self.root)
            .arg("--state-directory")
            .arg(&self.state)
            .arg("--workspace-root")
            .arg(&self.root)
            .args(["--workspace-policy", WORKSPACE_POLICY]);
        command
    }

    fn run(&self, script: &str) -> Output {
        self.command()
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

    assert_eq!(
        output.status.code(),
        Some(7),
        "sandbox stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
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

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires the Linux sandbox backend"]
fn reads_ordinary_files_across_two_projected_workspace_roots() {
    let workspace = Workspace::new();
    let private = workspace.root.join("personal");
    fs::create_dir(&private).unwrap();
    let nested = workspace.root.join("nested");
    fs::create_dir(&nested).unwrap();
    fs::write(nested.join("file"), "projected fixture").unwrap();
    std::os::unix::fs::symlink("nested/file", workspace.root.join("link")).unwrap();

    let second = workspace.root.with_file_name("second");
    let second_private = second.join("personal");
    fs::create_dir_all(&second_private).unwrap();
    let second_file = second.join("file");
    fs::write(&second_file, " and second fixture").unwrap();

    let output = workspace
        .command()
        .arg("--workspace-root")
        .arg(&second)
        .arg("--private-path")
        .arg(private)
        .arg("--private-path")
        .arg(second_private)
        .args(["--", "/bin/cat", "link"])
        .arg(second_file)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"projected fixture and second fixture");
}
