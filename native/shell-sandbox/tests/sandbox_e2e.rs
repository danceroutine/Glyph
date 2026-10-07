#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::fs;
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

const MARKER: &str = "I win";

/// Fixture-only torture test governed by src/shell/test/ADVERSARIAL_TESTING_SAFETY.md.
#[test]
#[ignore = "requires the host sandbox backend; run with pnpm shell-sandbox:torture"]
fn confines_fixture_writes_reads_network_and_symlink_traversal() {
    let fixture = Fixture::new();

    let shell_probe = fixture.run("workspace-write", "pwd", &[]);
    assert_success(&shell_probe, "shell startup");

    let allowed = fixture.workspace.join("allowed.txt");
    let result = fixture.run(
        "workspace-write",
        "printf 'I win' > \"$GLYPH_TEST_TARGET\"",
        &[("GLYPH_TEST_TARGET", &allowed)],
    );
    assert_success(&result, "ordinary workspace write");
    assert_eq!(fs::read_to_string(&allowed).unwrap(), MARKER);

    let ordinary_read = fixture.run(
        "read-only",
        "cat \"$GLYPH_TEST_TARGET\"",
        &[("GLYPH_TEST_TARGET", &fixture.workspace.join("ordinary.txt"))],
    );
    assert_success(&ordinary_read, "ordinary workspace read");
    assert_eq!(
        String::from_utf8_lossy(&ordinary_read.stdout),
        "ordinary fixture"
    );

    let project_secret = fixture.run(
        "read-only",
        "cat \"$GLYPH_TEST_TARGET\"",
        &[("GLYPH_TEST_TARGET", &fixture.workspace.join(".env"))],
    );
    assert_denied(&project_secret, "synthetic project-secret read");
    assert!(!String::from_utf8_lossy(&project_secret.stdout).contains("synthetic project secret"));

    fixture.assert_write_denied(
        "read-only",
        fixture.workspace.join("read-only-escape.txt"),
        "read-only workspace write",
    );
    fixture.assert_write_denied(
        "workspace-write",
        fixture.outside.join("traversal-escape.txt"),
        "path traversal outside the workspace",
    );
    fixture.assert_write_denied(
        "workspace-write",
        fixture.workspace.join("outside-link/symlink-escape.txt"),
        "symlink traversal outside the workspace",
    );
    fixture.assert_write_denied(
        "workspace-write",
        fixture.workspace.join(".git/metadata-escape.txt"),
        "Git metadata write",
    );
    fixture.assert_write_denied(
        "workspace-write",
        fixture.workspace.join("nested/.git/metadata-escape.txt"),
        "nested Git metadata write",
    );
    fixture.assert_write_denied(
        "workspace-write",
        fixture.state.join("state-escape.txt"),
        "Glyph state write",
    );

    let state_read = fixture.run(
        "read-only",
        "cat \"$GLYPH_TEST_TARGET\"",
        &[("GLYPH_TEST_TARGET", &fixture.state.join("synthetic-canary"))],
    );
    assert_denied(&state_read, "Glyph state read");
    assert!(!String::from_utf8_lossy(&state_read.stdout).contains("synthetic canary"));

    let credential_read = fixture.run("read-only", "cat \"$HOME/.ssh/synthetic-canary\"", &[]);
    assert_denied(&credential_read, "synthetic credential read");
    assert!(!String::from_utf8_lossy(&credential_read.stdout).contains("synthetic credential"));

    let temporary_write = fixture.run(
        "read-only",
        "printf 'I win' > \"$TMPDIR/glyph-sandbox-canary\" && cat \"$TMPDIR/glyph-sandbox-canary\"",
        &[],
    );
    assert_success(&temporary_write, "private temporary write");
    assert_eq!(String::from_utf8_lossy(&temporary_write.stdout), MARKER);

    assert_loopback_network_denied(&fixture);
}

struct Fixture {
    _temporary: TempDir,
    root: PathBuf,
    workspace: PathBuf,
    state: PathBuf,
    outside: PathBuf,
    home: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::Builder::new()
            .prefix("glyph-shell-torture-")
            .tempdir()
            .expect("create disposable fixture");
        let root = fs::canonicalize(temporary.path()).expect("canonicalize disposable fixture");
        let workspace = root.join("workspace");
        let state = root.join("state");
        let outside = root.join("outside");
        let home = root.join("synthetic-home");
        for path in [
            &workspace,
            &state,
            &outside,
            &home,
            &workspace.join(".git"),
            &workspace.join("nested/.git"),
            &home.join(".ssh"),
        ] {
            fs::create_dir_all(path).expect("create fixture directory");
        }
        fs::write(workspace.join("ordinary.txt"), "ordinary fixture")
            .expect("write ordinary fixture");
        fs::write(workspace.join(".env"), "synthetic project secret")
            .expect("write project secret canary");
        fs::write(state.join("synthetic-canary"), "synthetic canary").expect("write state canary");
        fs::write(home.join(".ssh/synthetic-canary"), "synthetic credential")
            .expect("write credential canary");
        symlink(&outside, workspace.join("outside-link")).expect("create fixture symlink");
        Self {
            _temporary: temporary,
            root,
            workspace,
            state,
            outside,
            home,
        }
    }

    fn run(&self, profile: &str, script: &str, environment: &[(&str, &Path)]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_glyph-shell-sandbox"));
        command
            .args(["--profile", profile, "--working-directory"])
            .arg(&self.workspace)
            .arg("--state-directory")
            .arg(&self.state)
            .arg("--workspace-root")
            .arg(&self.workspace)
            .args([
                "--workspace-policy",
                r#"{"ignoredDirectories":[".git",".next","coverage","dist","node_modules","target"],"sensitiveFileNames":[".git-credentials",".netrc",".npmrc",".pypirc"],"sensitiveFilePrefixes":[".env"],"sensitiveFileExtensions":[".key",".pem",".p12",".pfx"],"allowedFileNames":[".env.example"]}"#,
            ])
            .args(["--", "/bin/sh", "-c", script])
            .env_clear()
            .env("HOME", &self.home)
            .env("PATH", "/usr/bin:/bin")
            .env("SHELL", "/bin/sh")
            .env("TERM", "dumb")
            .env("NO_COLOR", "1");
        for (name, value) in environment {
            command.env(name, value);
        }
        command.output().expect("run native sandbox helper")
    }

    fn assert_write_denied(&self, profile: &str, target: PathBuf, description: &str) {
        assert!(
            target.starts_with(&self.root),
            "target must remain in the disposable fixture"
        );
        let result = self.run(
            profile,
            "printf 'I win' > \"$GLYPH_TEST_TARGET\"",
            &[("GLYPH_TEST_TARGET", &target)],
        );
        assert_denied(&result, description);
        assert!(
            !target.exists(),
            "{description} created its harmless escape marker"
        );
    }
}

fn assert_loopback_network_denied(fixture: &Fixture) {
    assert!(
        Path::new("/usr/bin/curl").is_file(),
        "torture test requires /usr/bin/curl"
    );
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture-only loopback server");
    listener
        .set_nonblocking(true)
        .expect("configure fixture listener");
    let url = format!("http://{}", listener.local_addr().unwrap());
    let result = fixture.run_with_text_environment(
        "read-only",
        "/usr/bin/curl --silent --show-error --max-time 1 \"$GLYPH_TEST_URL\"",
        &[("GLYPH_TEST_URL", &url)],
    );
    assert_denied(&result, "loopback network access");
    assert!(
        listener.accept().is_err(),
        "sandbox contacted the fixture-only server"
    );
}

impl Fixture {
    fn run_with_text_environment(
        &self,
        profile: &str,
        script: &str,
        environment: &[(&str, &str)],
    ) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_glyph-shell-sandbox"));
        command
            .args(["--profile", profile, "--working-directory"])
            .arg(&self.workspace)
            .arg("--state-directory")
            .arg(&self.state)
            .arg("--workspace-root")
            .arg(&self.workspace)
            .args(["--", "/bin/sh", "-c", script])
            .env_clear()
            .env("HOME", &self.home)
            .env("PATH", "/usr/bin:/bin")
            .env("SHELL", "/bin/sh")
            .env("TERM", "dumb")
            .env("NO_COLOR", "1");
        for (name, value) in environment {
            command.env(name, value);
        }
        command.output().expect("run native sandbox helper")
    }
}

fn assert_success(output: &Output, description: &str) {
    assert!(
        output.status.success(),
        "{description} unexpectedly failed with {}. stdout: {} stderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_denied(output: &Output, description: &str) {
    assert!(
        !output.status.success(),
        "{description} unexpectedly escaped the sandbox"
    );
}
