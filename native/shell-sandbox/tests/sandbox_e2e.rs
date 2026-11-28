#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::fs;
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::TempDir;

const MARKER: &str = "I win";

/*
 * Selecting a source subtree as the workspace must not make the protected
 * installation writable. Launch the real platform helper against a synthetic
 * install, prove ordinary workspace writes work, then attempt only one new
 * uniquely named file containing exactly "I win" beneath the protected parent.
 * No installed application, existing file, Git data or credential is modified.
 * This records enforcement only for the current OS/backend, independently of
 * the mount-plan test. Fixture ownership and cleanup remain with TempDir.
 */
#[test]
#[ignore = "requires the host sandbox backend; run with pnpm test:security:native"]
fn security_protected_installation_ancestor_denies_fixture_marker_creation() {
    let mut fixture = Fixture::new();
    let install = fixture.workspace.clone();
    fixture.workspace = install.join("source");
    fs::create_dir(&fixture.workspace).unwrap();
    assert!(fs::canonicalize(&fixture.workspace)
        .unwrap()
        .starts_with(&fixture.root));
    let allowed = fixture.workspace.join("allowed-control.txt");
    #[cfg(target_os = "linux")]
    fs::write(&allowed, "initial").unwrap();
    let result = fixture.run(
        "workspace-write",
        "printf 'I win' > \"$GLYPH_TEST_TARGET\"",
        &[("GLYPH_TEST_TARGET", &allowed)],
    );
    assert_success(&result, "ordinary write positive control");
    assert_eq!(fs::read_to_string(allowed).unwrap(), MARKER);
    let denied = fixture.workspace.join("protected-install-marker.txt");
    assert!(!denied.exists());
    let result = fixture.run_with_protected_paths(
        "workspace-write",
        "printf 'I win' > \"$GLYPH_TEST_TARGET\"",
        &[("GLYPH_TEST_TARGET", &denied)],
        &[&install],
    );
    assert!(
        !denied.exists(),
        "protected installation admitted a fixture marker"
    );
    assert_denied(&result, "protected installation ancestor");
}

/// Fixture-only torture test governed by src/shell/test/ADVERSARIAL_TESTING_SAFETY.md.
#[test]
#[ignore = "requires the host sandbox backend; run with pnpm shell-sandbox:torture"]
fn confines_fixture_writes_reads_network_and_symlink_traversal() {
    let fixture = Fixture::new();

    let shell_probe = fixture.run("workspace-write", "pwd", &[]);
    assert_success(&shell_probe, "shell startup");

    let allowed = fixture.workspace.join("allowed.txt");
    #[cfg(target_os = "linux")]
    {
        fixture.assert_write_denied(
            "workspace-write",
            allowed.clone(),
            "Linux workspace namespace is read-only",
        );
        fs::write(&allowed, "initial").unwrap();
    }
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
        self.run_with_protected_paths(profile, script, environment, &[])
    }

    fn run_with_protected_paths(
        &self,
        profile: &str,
        script: &str,
        environment: &[(&str, &Path)],
        protected: &[&Path],
    ) -> Output {
        self.command(profile, script, environment, protected, &[])
            .output()
            .expect("run native sandbox helper")
    }

    fn command(
        &self,
        profile: &str,
        script: &str,
        environment: &[(&str, &Path)],
        protected: &[&Path],
        private: &[&Path],
    ) -> Command {
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
            ]);
        let objects = self.home.join("store/v11/files");
        if objects.is_dir() {
            command.arg("--content-store").arg(
                serde_json::json!({
                    "root": objects, "layout": "sha512-prefix-2", "executableSuffix": "-exec"
                })
                .to_string(),
            );
        }
        for path in protected {
            assert!(path.starts_with(&self.root));
            command.arg("--protected-path").arg(path);
        }
        for path in private {
            assert!(path.starts_with(&self.root));
            command.arg("--private-path").arg(path);
        }
        command
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
        command
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

#[test]
#[ignore = "requires the host sandbox backend; run with pnpm test:security:native"]
fn security_admitted_package_is_readable_but_immutable_outside_the_workspace() {
    let fixture = Fixture::new();
    let toolchain = fixture.home.join(".cargo/bin");
    let package = toolchain.join("first/.glyph-skill-run");
    let sibling = toolchain.join("other/.glyph-skill-run");
    fs::create_dir_all(&package).unwrap();
    fs::create_dir_all(&sibling).unwrap();
    fs::write(sibling.join("unrelated"), "other run").unwrap();
    let script = package.join("task.sh");
    fs::write(&script, "echo pinned").unwrap();
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let directory = package.join("templates");
        let template = directory.join("example");
        fs::create_dir(&directory).unwrap();
        fs::write(&template, "reviewed").unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o750)).unwrap();
        fs::set_permissions(&template, fs::Permissions::from_mode(0o640)).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let run = |admit: bool, code: &str| {
        let mut command = Command::new(env!("CARGO_BIN_EXE_glyph-shell-sandbox"));
        command
            .args(["--profile", "workspace-write", "--working-directory"])
            .arg(&fixture.workspace)
            .arg("--state-directory")
            .arg(&fixture.state)
            .arg("--workspace-root")
            .arg(&fixture.workspace)
            .arg("--workspace-policy")
            .arg(
                serde_json::to_string(&glyph_shell_sandbox::WorkspaceAccessPolicy::default())
                    .unwrap(),
            );
        if admit {
            command.arg("--read-only-path").arg(&package);
        }
        command
            .args(["--", "/bin/sh", "-c", code])
            .env_clear()
            .env("HOME", &fixture.home)
            .env("PATH", "/usr/bin:/bin")
            .env("GLYPH_RESOURCE", &script)
            .env("GLYPH_SIBLING", sibling.join("unrelated"))
            .env(
                "GLYPH_FOLDED",
                toolchain.join("other/.glyph-ſkill-run/unrelated"),
            )
            .env(
                "GLYPH_UPPER",
                toolchain.join("other/.GLYPH-SKILL-RUN/unrelated"),
            )
            .env("GLYPH_OUTPUT", fixture.workspace.join("result.txt"))
            .output()
            .unwrap()
    };
    assert_denied(
        &run(false, "cat \"$GLYPH_RESOURCE\""),
        "unadmitted package read",
    );
    assert_denied(
        &run(true, r#"cat "$GLYPH_SIBLING""#),
        "another pending run in the same toolchain",
    );
    #[cfg(target_os = "macos")]
    {
        for (spelling, variable) in [
            (".glyph-ſkill-run", "GLYPH_FOLDED"),
            (".GLYPH-SKILL-RUN", "GLYPH_UPPER"),
        ] {
            let alias = toolchain.join("other").join(spelling).join("unrelated");
            if alias.exists() {
                use std::os::unix::fs::MetadataExt;
                assert_eq!(
                    fs::metadata(&alias).unwrap().ino(),
                    fs::metadata(sibling.join("unrelated")).unwrap().ino()
                );
                assert_denied(
                    &run(true, &format!(r#"cat "${variable}""#)),
                    "another run through an equivalent filesystem spelling",
                );
            }
        }
    }
    #[cfg(target_os = "linux")]
    fs::write(fixture.workspace.join("result.txt"), "initial").unwrap();
    #[cfg(target_os = "linux")]
    {
        let modes = run(
            true,
            r#"dir=${GLYPH_RESOURCE%/*}/templates; stat -c '%a' "$dir" "$dir/example" "$GLYPH_RESOURCE"; printf changed >"$dir/example""#,
        );
        assert!(!modes.status.success());
        assert_eq!(
            String::from_utf8(modes.stdout).unwrap(),
            "750\n640\n755\n",
            "{}",
            String::from_utf8_lossy(&modes.stderr)
        );
        assert!(String::from_utf8_lossy(&modes.stderr)
            .to_lowercase()
            .contains("read-only"));
        assert_eq!(
            fs::read(package.join("templates/example")).unwrap(),
            b"reviewed"
        );
    }
    let output = run(
        true,
        "cat \"$GLYPH_RESOURCE\"; printf 'I win' > \"$GLYPH_OUTPUT\"",
    );
    assert_success(
        &output,
        "admitted package read and ordinary workspace write",
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("echo pinned"));
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("result.txt")).unwrap(),
        MARKER
    );
    assert_denied(
        &run(true, "printf 'I win' > \"$GLYPH_RESOURCE\""),
        "pinned package replacement",
    );
    assert_eq!(fs::read_to_string(script).unwrap(), "echo pinned");
}

#[test]
#[ignore = "requires the host sandbox backend; run with pnpm test:security:native"]
fn security_private_staging_and_project_package_paths_stay_reserved() {
    let fixture = Fixture::new();
    for namespace in [".glyph", ".CuRsOr"] {
        let package = fixture
            .workspace
            .join("nested")
            .join(namespace)
            .join("sKiLLs/example");
        fs::create_dir_all(&package).unwrap();
        let file = package.join("SKILL.md");
        fs::write(&file, "reviewed").unwrap();
        assert_denied(
            &fixture.run(
                "workspace-write",
                "printf altered > \"$FILE\"",
                &[("FILE", &file)],
            ),
            "managed content",
        );
        assert_eq!(fs::read_to_string(file).unwrap(), "reviewed");
    }
    let staging = fixture.workspace.join("nested/.skill-staging");
    fs::create_dir_all(&staging).unwrap();
    let marker = staging.join("private");
    fs::write(&marker, "private").unwrap();
    for profile in ["read-only", "workspace-write"] {
        assert_denied(
            &fixture.run(profile, "cat \"$FILE\"", &[("FILE", &marker)]),
            "private staging",
        );
    }
    assert_denied(
        &fixture.run(
            "workspace-write",
            "printf altered > \"$FILE\"",
            &[("FILE", &marker)],
        ),
        "private staging write",
    );
    assert_eq!(fs::read_to_string(marker).unwrap(), "private");
    for (name, op) in [
        ("nested/.glyph/skills/future", "mkdir \"$DEST\""),
        ("nested", ". /dev/null && mv \"$DEST\" \"$DEST-moved\""),
    ] {
        assert_denied(
            &fixture.run(
                "workspace-write",
                op,
                &[("DEST", &fixture.workspace.join(name))],
            ),
            "managed namespace or ancestor",
        );
    }
}

#[test]
#[ignore = "requires the host sandbox backend; run with pnpm test:security:native"]
fn enforces_stored_unicode_reservations_with_an_ordinary_workspace_control() {
    let fixture = Fixture::new();
    let stored = fixture.workspace.join("nested/.ſkill-ﬆaging");
    fs::create_dir_all(&stored).unwrap();
    let marker = stored.join("record");
    fs::write(&marker, "fixture record").unwrap();
    let ordinary = fixture.workspace.join("ordinary.txt");
    assert_success(
        &fixture.run("read-only", r#"test -f "$FILE""#, &[("FILE", &ordinary)]),
        "ordinary sibling",
    );
    // Seatbelt normalizes path filters on APFSX too. Linux reads distinct spellings
    // according to their actual directory identity.
    let reserved =
        cfg!(target_os = "macos") || fixture.workspace.join("nested/.skill-staging").exists();
    let visible = fixture
        .run("read-only", r#"test -f "$FILE""#, &[("FILE", &marker)])
        .status
        .success();
    assert_eq!(visible, !reserved);
    let managed = fixture.workspace.join("nested/.glyph/ſKills");
    fs::create_dir_all(&managed).unwrap();
    let file = managed.join("sample");
    fs::write(&file, "fixture record").unwrap();
    let write = fixture
        .run(
            "workspace-write",
            r#"printf 'I win' > "$FILE""#,
            &[("FILE", &file)],
        )
        .status
        .success();
    assert_eq!(
        write,
        !(cfg!(target_os = "macos") || fixture.workspace.join("nested/.glyph/skills").exists())
    );
}

#[test]
#[ignore = "requires the host sandbox backend; run with pnpm test:security:native"]
fn security_running_shell_keeps_existing_and_future_host_files_private() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::process::Stdio;
    let fixture = Fixture::new();
    #[cfg(target_os = "macos")]
    let folded = fixture.workspace.join("folding-probe");
    #[cfg(target_os = "macos")]
    fs::write(&folded, "").unwrap();
    #[cfg(target_os = "macos")]
    let staging = if fixture.workspace.join("FOLDING-PROBE").exists() {
        ".ſkill-ﬅaging"
    } else {
        ".skill-staging"
    };
    #[cfg(target_os = "linux")]
    let staging = ".skill-staging";
    let future = fixture
        .workspace
        .join("nested")
        .join(staging)
        .join("transaction");
    let runtime = fixture.home.join(".cargo/bin");
    fs::create_dir_all(&runtime).unwrap();
    let ordinary = runtime.join("public");
    let existing = runtime.join("provider.log");
    let new_trace = runtime.join("later.log");
    fs::write(&ordinary, "public control").unwrap();
    fs::write(&existing, "private marker").unwrap();
    let mut command = fixture.command(
        "workspace-write",
        r#"echo ready; read line; cat "$PUBLIC" || exit 1; ! cat "$TRACE" && ! cat "$NEW_TRACE" && ! cat "$FILE""#,
        &[("FILE", &future), ("PUBLIC", &ordinary), ("TRACE", &existing), ("NEW_TRACE", &new_trace)],
        &[],
        &[&existing, &new_trace],
    );
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    output.read_line(&mut ready).unwrap();
    assert_eq!(ready.trim(), "ready");
    fs::create_dir_all(future.parent().unwrap()).unwrap();
    fs::write(&future, "private").unwrap();
    fs::write(&new_trace, "new private marker").unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"continue\n")
        .unwrap();
    let mut content = String::new();
    output.read_to_string(&mut content).unwrap();
    assert_eq!(content, "public control");
    assert!(child.wait().unwrap().success());
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires the host sandbox backend; run with pnpm test:security:native"]
fn admits_large_workspaces_without_per_file_arguments_or_open_descriptors() {
    let fixture = Fixture::new();
    let files = fixture.workspace.join("vendor");
    fs::create_dir(&files).unwrap();
    for index in 0..4096 {
        fs::write(files.join(index.to_string()), b"existing").unwrap();
    }
    let target = files.join("4095");
    let output = fixture.run(
        "workspace-write",
        "printf updated > \"$FILE\"",
        &[("FILE", &target)],
    );
    assert_success(
        &output,
        "in-place update beyond the Bubblewrap argument limit",
    );
    assert_eq!(fs::read(target).unwrap(), b"updated");
}

#[test]
#[ignore = "requires the host sandbox backend; run with pnpm test:security:native"]
fn security_private_data_stays_hidden_through_sibling_and_toolchain_paths() {
    let fixture = Fixture::new();
    let outside = fixture.outside.join("other/.skill-staging");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("private"), "private").unwrap();
    std::os::unix::fs::symlink(&outside, fixture.workspace.join("alias")).unwrap();
    for path in [
        outside.join("private"),
        fixture.workspace.join("alias/private"),
    ] {
        assert_denied(
            &fixture.run("read-only", "cat \"$FILE\"", &[("FILE", &path)]),
            "separate project transaction",
        );
    }
    let alias = fixture.home.join(".cargo/bin");
    fs::create_dir_all(alias.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(fixture.home.join(".ssh"), &alias).unwrap();
    assert_denied(
        &fixture.run(
            "read-only",
            "cat \"$FILE\"",
            &[("FILE", &alias.join("synthetic-canary"))],
        ),
        "toolchain alias to private home storage",
    );
    fs::remove_file(&alias).unwrap();
    let toolchain = fixture.home.join(".local/bin");
    fs::create_dir_all(toolchain.join("another/.skill-staging")).unwrap();
    let public = toolchain.join("public-tool");
    fs::write(&public, "public").unwrap();
    fs::write(toolchain.join("another/.skill-staging/private"), "private").unwrap();
    assert_success(
        &fixture.run("read-only", "cat \"$FILE\"", &[("FILE", &public)]),
        "ordinary admitted toolchain",
    );
    fs::create_dir(&alias).unwrap();
    fs::create_dir(alias.join("other")).unwrap();
    fs::write(alias.join("other/public"), "tool").unwrap();
    let duplicate = fixture.home.join(".bun/bin");
    fs::create_dir_all(duplicate.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(alias.join("other"), &duplicate).unwrap();
    assert_success(
        &fixture.run(
            "read-only",
            "cat \"$FILE\"",
            &[("FILE", &duplicate.join("public"))],
        ),
        "two admitted toolchain aliases",
    );
    #[cfg(target_os = "linux")]
    {
        fs::remove_file(&duplicate).unwrap();
        let hidden = alias.join("other/.skill-staging");
        fs::create_dir(&hidden).unwrap();
        fs::write(hidden.join("private"), "fixture").unwrap();
        std::os::unix::fs::symlink(&hidden, &duplicate).unwrap();
        assert_success(
            &fixture.run(
                "read-only",
                "cat ordinary.txt && test ! -e \"$FILE\"",
                &[("FILE", &duplicate.join("private"))],
            ),
            "an omitted runtime alias must not prevent unrelated commands",
        );
    }
    assert_denied(
        &fixture.run(
            "read-only",
            "cat \"$FILE\"",
            &[("FILE", &toolchain.join("another/.skill-staging/private"))],
        ),
        "private data under admitted toolchain",
    );
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires the Linux sandbox backend"]
fn verified_dependency_hardlinks_are_readable_immutable_copies() {
    use sha2::{Digest, Sha512};
    use std::os::unix::fs::MetadataExt;
    let fixture = Fixture::new();
    let dependency = fixture.workspace.join("node_modules/example");
    fs::create_dir_all(&dependency).unwrap();
    let payload = "package fixture";
    let digest = format!("{:x}", Sha512::digest(payload.as_bytes()));
    let objects = fixture.home.join("store/v11/files").join(&digest[..2]);
    fs::create_dir_all(&objects).unwrap();
    let object = objects.join(&digest[2..]);
    fs::write(&object, payload).unwrap();
    let installed = dependency.join("index.js");
    fs::hard_link(&object, &installed).unwrap();
    for (directory, filename) in [
        (".skill-staging", "private"),
        (".glyph/skills/example", "managed"),
    ] {
        let directory = fixture.workspace.join(directory);
        fs::create_dir_all(&directory).unwrap();
        let source = directory.join(filename);
        // Identical contents are insufficient when the trusted store name designates a different inode.
        fs::write(&source, payload).unwrap();
        fs::hard_link(&source, dependency.join(filename)).unwrap();
    }
    for profile in ["read-only", "workspace-write"] {
        let read = fixture.run(profile, "cat node_modules/example/index.js", &[]);
        assert_success(&read, "copy of verified package file");
        assert_eq!(read.stdout, payload.as_bytes());
        let object_info = fs::metadata(&object).unwrap();
        let inode = fixture.run(profile, "stat -c %d:%i node_modules/example/index.js", &[]);
        assert_success(&inode, "private file inode");
        assert_ne!(
            String::from_utf8_lossy(&inode.stdout).trim(),
            format!("{}:{}", object_info.dev(), object_info.ino())
        );
        assert_denied(
            &fixture.run(profile, "printf x > node_modules/example/index.js", &[]),
            "immutable dependency",
        );
        for filename in ["private", "managed"] {
            let probe = fixture.run(
                profile,
                &format!("test ! -e node_modules/example/{filename}"),
                &[],
            );
            assert_success(&probe, "unverified alias stays absent");
        }
        assert_eq!(fs::read_to_string(&object).unwrap(), payload);
    }
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires Bubblewrap and a disposable user namespace"]
fn bounded_toolchain_and_dependency_views_admit_unrelated_commands() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let tools = fixture.home.join(".local/bin");
    let dependencies = fixture.workspace.join("node_modules");
    fs::create_dir_all(tools.join(".skill-staging")).unwrap();
    let blocked_tool = tools.join("unreadable-tool");
    fs::write(&blocked_tool, "fixture").unwrap();
    fs::set_permissions(&blocked_tool, fs::Permissions::from_mode(0o000)).unwrap();
    fs::create_dir(&dependencies).unwrap();
    let hidden = fixture.workspace.join("private-build-dir");
    fs::create_dir(&hidden).unwrap();
    fs::write(hidden.join("file"), "fixture").unwrap();
    fs::set_permissions(&hidden, fs::Permissions::from_mode(0o400)).unwrap();
    let unreadable = fixture.workspace.join("private-build-output");
    fs::write(&unreadable, "fixture").unwrap();
    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();
    for i in 0..52_000 {
        fs::File::create_new(tools.join(i.to_string())).unwrap();
    }
    for i in 0..100_100 {
        fs::File::create_new(dependencies.join(i.to_string())).unwrap();
    }
    let output = fixture.run(
        "workspace-write",
        r#"set -ex
test -f "$TOOLS/17"
test ! -e "$TOOLS/.skill-staging"
test ! -e "$TOOLS/unreadable-tool"
test ! -e private-build-output
test ! -e private-build-dir/file
test ! -e .env
printf updated > ordinary.txt
wc -l </proc/self/mountinfo"#,
        &[("TOOLS", &tools)],
    );
    assert_success(&output, "large optional trees and unreadable file");
    let mounts: usize = String::from_utf8(output.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(mounts < 32_000, "unexpected mount count: {mounts}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("snapshot reached its resource limit"));
    assert_eq!(
        fs::read_to_string(fixture.workspace.join("ordinary.txt")).unwrap(),
        "updated"
    );
    fs::set_permissions(&hidden, fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires Bubblewrap and a disposable user namespace"]
fn preserves_protection_when_the_workspace_starts_below_a_managed_directory() {
    let mut fixture = Fixture::new();
    let parent = fixture.workspace;
    for suffix in [".glyph/skills/package", ".cursor/skills", ".git/objects"] {
        fixture.workspace = parent.join(suffix);
        fs::create_dir_all(&fixture.workspace).unwrap();
        fs::write(fixture.workspace.join("resource"), "fixture").unwrap();
        let output = fixture.run(
            "workspace-write",
            "cat resource && if printf changed > resource; then exit 32; fi",
            &[],
        );
        assert_success(&output, "protected workspace ancestry");
        assert_eq!(
            fs::read_to_string(fixture.workspace.join("resource")).unwrap(),
            "fixture"
        );
    }
}

#[test]
#[ignore = "requires the platform sandbox"]
fn shell_reserves_personal_sources_and_keeps_ordinary_files_readable() {
    let fixture = Fixture::new();
    let rules = fixture.workspace.join("personal/rules");
    fs::create_dir_all(&rules).unwrap();
    let selected = rules.join("selected.mdc");
    fs::write(&selected, "personal fixture").unwrap();
    for profile in ["read-only", "workspace-write"] {
        let check = |path: &Path| {
            fixture
                .command(
                    profile,
                    "cat \"$GLYPH_TEST_TARGET\"",
                    &[("GLYPH_TEST_TARGET", path)],
                    &[],
                    &[&rules],
                )
                .output()
                .unwrap()
        };
        let ordinary = check(&fixture.workspace.join("ordinary.txt"));
        assert_success(&ordinary, "ordinary workspace file");
        assert_eq!(ordinary.stdout, b"ordinary fixture");
        let reserved = check(&selected);
        assert_denied(&reserved, "personal source");
        assert!(reserved.stdout.is_empty());
    }
}
