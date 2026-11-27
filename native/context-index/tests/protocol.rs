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

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn verifies_metadata_for_inherited_descriptors() {
    use std::process::{Command, Stdio};
    let fixture = tempfile::NamedTempFile::new().unwrap();
    for argument in ["--assert-access-metadata", "--assert-replaceable-metadata"] {
        let result = Command::new(env!("CARGO_BIN_EXE_glyph-context-index"))
            .arg(argument)
            .stdin(Stdio::from(fixture.reopen().unwrap()))
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout, b"verified\n");
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn verifies_host_path_authority_for_complete_and_bounded_frames() {
    let root = tempfile::tempdir().unwrap();
    let input = serde_json::json!({"paths":[root.path().join("future")],"workspaceRoots":[root.path().join("workspace")]}).to_string();
    let send = |input: &str| {
        run_with_input(input, |cmd| {
            cmd.arg("--assert-host-paths");
        })
    };
    let result = send(&input);
    assert!(result.status.success());
    assert_eq!(result.stdout, b"verified\n");
    for invalid in [
        "{}".to_owned(),
        " ".repeat(2 * 1024 * 1024 + 1),
        serde_json::json!({"paths":[root.path()],"workspaceRoots":[root.path()]}).to_string(),
    ] {
        let result = send(&invalid);
        assert!(!result.status.success());
        assert!(result.stdout.is_empty());
    }
}

#[cfg(unix)]
#[test]
fn admits_a_workspace_path_and_rechecks_its_opened_identity() {
    use std::os::unix::fs::MetadataExt;
    let root = tempfile::tempdir().unwrap();
    let ordinary = root.path().join("document");
    fs::write(&ordinary, "example").unwrap();
    let meta = fs::metadata(&ordinary).unwrap();
    let request = serde_json::json!({
        "path":ordinary, "privatePaths":[root.path().join("preferences")],
        "identity":[meta.dev().to_string(),meta.ino().to_string()]
    });
    let check = |request: &Value| {
        run_with_input(&request.to_string(), |cmd| {
            cmd.arg("--assert-workspace-path");
        })
    };
    assert_eq!(check(&request).stdout, b"verified\n");
    let mut mutation = request.clone();
    mutation["managedDirectories"] = serde_json::json!([root.path()]);
    assert!(!check(&mutation).status.success());
    mutation["managedDirectories"] = serde_json::json!(["relative"]);
    assert!(!check(&mutation).status.success());
    let mut stale = request;
    stale["identity"] = serde_json::json!(["0", "0"]);
    assert!(!check(&stale).status.success());
}

#[cfg(target_os = "linux")]
#[test]
fn reports_the_visible_routes_of_an_editor_source() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().canonicalize().unwrap();
    let request = serde_json::json!([path, true]);
    let result = run_with_input(&request.to_string(), |cmd| {
        cmd.arg("--source-path-aliases");
    });
    assert!(result.status.success());
    let aliases: Vec<std::path::PathBuf> = serde_json::from_slice(&result.stdout).unwrap();
    assert!(aliases.contains(&path));
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "requires an unprivileged Linux user and mount namespace"]
fn checks_bound_private_and_ordinary_trees_through_the_cli() {
    const INSIDE: &str = "GLYPH_PRIVATE_MOUNT_CLI_FIXTURE";
    if std::env::var_os(INSIDE).is_none() {
        let output = Command::new("unshare")
            .arg("-Urm")
            .arg(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "checks_bound_private_and_ordinary_trees_through_the_cli",
                "--ignored",
            ])
            .env(INSIDE, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains("1 passed")
        );
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let base = root.path().canonicalize().unwrap();
    for (source, view, admitted) in [
        (".skill-staging", "first", false),
        ("ordinary", "second", true),
    ] {
        let source = base.join(source);
        let view = base.join(view);
        fs::create_dir(&source).unwrap();
        fs::create_dir(&view).unwrap();
        fs::write(source.join("data"), "fixture").unwrap();
        assert!(Command::new("mount")
            .args(["-o", "bind"])
            .arg(&source)
            .arg(&view)
            .status()
            .unwrap()
            .success());
        let request = serde_json::json!({"path": view.join("data"), "privatePaths": []});
        let result = run_with_input(&request.to_string(), |cmd| {
            cmd.arg("--assert-workspace-path");
        });
        assert_eq!(result.status.success(), admitted);
        let sources =
            serde_json::json!({"paths": [view.join("data")], "privatePaths":[]}).to_string();
        let inspect_origins = || {
            run_with_input(&sources, |cmd| {
                cmd.arg("--source-origins");
            })
        };
        let original = inspect_origins();
        assert_eq!(original.status.success(), admitted);
        if admitted {
            // The same directory and file inode exposed through a replacement mount is a new route.
            let original: Value = serde_json::from_slice(&original.stdout).unwrap();
            assert!(Command::new("mount")
                .args(["-o", "bind"])
                .arg(&source)
                .arg(&view)
                .status()
                .unwrap()
                .success());
            let replacement = inspect_origins();
            assert!(replacement.status.success());
            let replacement: Value = serde_json::from_slice(&replacement.stdout).unwrap();
            assert_eq!(original[0]["identity"], replacement[0]["identity"]);
            assert_ne!(original[0]["origin"], replacement[0]["origin"]);
            assert!(Command::new("umount")
                .arg(&view)
                .status()
                .unwrap()
                .success());
        }

        assert!(Command::new("umount")
            .arg(&view)
            .status()
            .unwrap()
            .success());
    }
}

#[cfg(unix)]
#[test]
fn pins_source_locations_across_regular_saves_and_checks_current_reservations() {
    use std::os::unix::fs::symlink;
    let project = tempfile::tempdir().unwrap();
    let rules = project.path().join("rules");
    fs::create_dir(&rules).unwrap();
    let file = rules.join("one.md");
    let other = rules.join("two.md");
    fs::write(&file, "one").unwrap();
    fs::write(&other, "two").unwrap();
    let inspect = |paths: &[&std::path::Path], private: &[&std::path::Path]| {
        run_with_input(
            &serde_json::json!({"paths":paths,"privatePaths":private}).to_string(),
            |cmd| {
                cmd.arg("--source-origins");
            },
        )
    };
    let pins = |paths: &[&std::path::Path]| {
        let output = inspect(paths, &[]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let original = pins(&[&file, &other]);
    assert_ne!(original[0]["origin"], original[1]["origin"]);
    fs::rename(&other, &file).unwrap();
    let saved = pins(&[&file]);
    assert_eq!(original[0]["origin"], saved[0]["origin"]);
    assert_ne!(original[0]["identity"], saved[0]["identity"]);
    assert!(!inspect(&[&file], &[&rules]).status.success());
    fs::rename(&rules, project.path().join("old")).unwrap();
    fs::create_dir(&rules).unwrap();
    fs::write(&file, "new").unwrap();
    assert_ne!(original[0]["origin"], pins(&[&file])[0]["origin"]);
    assert!(!inspect(&[&rules], &[]).status.success());
    assert!(!inspect(&[&other], &[]).status.success());
    symlink(&file, &other).unwrap();
    assert!(!inspect(&[&other], &[]).status.success());
    fs::remove_file(&other).unwrap();
    fs::hard_link(&file, &other).unwrap();
    assert!(!inspect(&[&file], &[]).status.success());
}

#[cfg(unix)]
#[test]
fn distinguishes_removed_and_renamed_import_sources_and_pins_their_parent() {
    use std::fs::{self, File};
    let base = tempfile::tempdir().unwrap();
    let parent = base.path().canonicalize().unwrap();
    let directory = parent.join("source");
    fs::create_dir(&directory).unwrap();
    let held = File::open(&directory).unwrap();
    let inspect = |file: File| {
        Command::new(env!("CARGO_BIN_EXE_glyph-context-index"))
            .arg("--assert-unlinked-directory")
            .stdin(file)
            .output()
            .unwrap()
    };
    assert!(!inspect(held.try_clone().unwrap()).status.success());
    let moved = parent.join("moved");
    fs::rename(&directory, &moved).unwrap();
    assert!(!inspect(held.try_clone().unwrap()).status.success());
    fs::remove_dir(&moved).unwrap();
    assert!(inspect(held).status.success());
    let ordinary = parent.join("ordinary");
    fs::write(&ordinary, b"fixture").unwrap();
    assert!(!inspect(File::open(&ordinary).unwrap()).status.success());
    let directories = serde_json::json!({"paths":[parent], "privatePaths":[], "directories":true});
    assert!(run_with_input(&directories.to_string(), |cmd| {
        cmd.arg("--source-origins");
    })
    .status
    .success());
    let files = serde_json::json!({"paths":[ordinary], "privatePaths":[], "directories":true});
    assert!(!run_with_input(&files.to_string(), |cmd| {
        cmd.arg("--source-origins");
    })
    .status
    .success());
}
