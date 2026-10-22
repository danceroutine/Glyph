use super::*;
use std::fs::{create_dir, write};
use tempfile::tempdir;

#[test]
fn sensitive_file_policy_rejects_case_variants() {
    let policy = WorkspaceAccessPolicy::default();
    for name in [
        ".ENV",
        ".Env.production",
        "private.PEM",
        "token.PfX",
        ".NETRC",
    ] {
        assert!(
            is_sensitive_workspace_file(Path::new(name), &policy),
            "{name}"
        );
    }
    assert!(!is_sensitive_workspace_file(
        Path::new(".ENV.EXAMPLE"),
        &policy
    ));
    // Inspect policy construction only; no sandboxed command is launched.
    let fixture = tempdir().unwrap();
    let root = fixture.path().join("workspace");
    create_dir(&root).unwrap();
    for name in [".ENV", "private.PEM", ".ENV.EXAMPLE"] {
        write(root.join(name), "synthetic canary").unwrap();
    }
    let request = request(
        SandboxProfile::ReadOnly,
        &root,
        &fixture.path().join("state"),
    );
    assert_eq!(
        workspace_sensitive_paths(&request).unwrap(),
        vec![root.join(".ENV"), root.join("private.PEM")]
    );
}

fn request(profile: SandboxProfile, root: &Path, state: &Path) -> SandboxRequest {
    SandboxRequest {
        profile,
        working_directory: root.to_owned(),
        state_directory: state.to_owned(),
        workspace_roots: vec![root.to_owned()],
        protected_paths: Vec::new(),
        workspace_policy: WorkspaceAccessPolicy::default(),
        command: vec!["sh".into(), "-c".into(), "pwd".into()],
    }
}

#[test]
fn parses_a_complete_request_without_interpreting_command_arguments() {
    let parsed = parse_arguments(
        [
            "--profile",
            "workspace-write",
            "--working-directory",
            "/workspace",
            "--state-directory",
            "/state",
            "--workspace-root",
            "/workspace",
            "--workspace-root",
            "/other",
            "--protected-path",
            "/workspace/worker",
            "--workspace-policy",
            r#"{"ignoredDirectories":[".git"],"sensitiveFileNames":[".git-credentials"],"sensitiveFilePrefixes":[".env"],"sensitiveFileExtensions":[".pem"],"allowedFileNames":[".env.example"]}"#,
            "--",
            "sh",
            "-c",
            "printf --profile",
        ]
        .map(OsString::from),
    )
    .expect("arguments should parse");

    assert_eq!(parsed.profile, SandboxProfile::WorkspaceWrite);
    assert_eq!(parsed.workspace_roots.len(), 2);
    assert_eq!(
        parsed.protected_paths,
        vec![PathBuf::from("/workspace/worker")]
    );
    assert_eq!(parsed.command[2], "printf --profile");
}

#[test]
fn rejects_missing_roots_commands_and_duplicate_single_value_options() {
    let missing_root = parse_arguments(
        [
            "--profile",
            "read-only",
            "--working-directory",
            "/workspace",
            "--state-directory",
            "/state",
            "--",
            "true",
        ]
        .map(OsString::from),
    );
    assert!(matches!(missing_root, Err(SandboxError::Usage(_))));

    let missing_command = parse_arguments(
        [
            "--profile",
            "read-only",
            "--working-directory",
            "/workspace",
            "--state-directory",
            "/state",
            "--workspace-root",
            "/workspace",
            "--",
        ]
        .map(OsString::from),
    );
    assert!(matches!(missing_command, Err(SandboxError::Usage(_))));

    let duplicate_profile = parse_arguments(
        [
            "--profile",
            "read-only",
            "--profile",
            "workspace-write",
            "--working-directory",
            "/workspace",
            "--state-directory",
            "/state",
            "--workspace-root",
            "/workspace",
            "--",
            "true",
        ]
        .map(OsString::from),
    );
    assert!(matches!(duplicate_profile, Err(SandboxError::Usage(_))));
}

#[test]
fn canonicalizes_and_confines_the_working_directory() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("root");
    let state = fixture.path().join("state");
    let outside = fixture.path().join("outside");
    create_dir(&root).expect("root");
    create_dir(&state).expect("state");
    create_dir(&outside).expect("outside");

    let prepared =
        prepare_request(request(SandboxProfile::ReadOnly, &root, &state)).expect("valid request");
    assert_eq!(prepared.working_directory, fs::canonicalize(&root).unwrap());

    let mut escaped = request(SandboxProfile::ReadOnly, &root, &state);
    escaped.working_directory = outside;
    assert!(matches!(
        prepare_request(escaped),
        Err(SandboxError::InvalidPath(_))
    ));

    let nested_state = root.join("state");
    create_dir(&nested_state).expect("nested state");
    assert!(matches!(
        prepare_request(request(SandboxProfile::ReadOnly, &root, &nested_state)),
        Err(SandboxError::InvalidPath(_))
    ));
    assert!(is_unsafe_workspace_root(Path::new("/private/tmp"), None));
    assert!(is_unsafe_workspace_root(Path::new("/usr/local"), None));
    assert!(is_unsafe_workspace_root(
        &home_sensitive_root(".ssh/project"),
        Some(Path::new("/synthetic/home"))
    ));
    assert!(is_unsafe_workspace_root(
        &home_sensitive_root(".config"),
        Some(Path::new("/synthetic/home"))
    ));
    assert!(is_unsafe_workspace_root(
        Path::new("/synthetic/home"),
        Some(Path::new("/synthetic/home"))
    ));
    assert!(!is_unsafe_workspace_root(
        &home_sensitive_root("projects/safe"),
        Some(Path::new("/synthetic/home"))
    ));
}

fn home_sensitive_root(path: &str) -> PathBuf {
    Path::new("/synthetic/home").join(path)
}

#[test]
fn seatbelt_policy_is_deny_default_and_preserves_read_only_boundaries() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("project");
    let state = fixture.path().join("state");
    let temporary = fixture.path().join("temporary");
    let home = fixture.path().join("home");
    create_dir(&root).expect("root");
    create_dir(&state).expect("state");
    create_dir(&temporary).expect("temporary");
    create_dir(&home).expect("home");
    create_dir(root.join(".git")).expect("git metadata");
    write(root.join(".env"), "synthetic canary").expect("workspace secret");
    write(root.join(".git-credentials"), "synthetic canary").expect("workspace credentials");
    create_dir(root.join("nested")).expect("nested directory");
    create_dir(root.join("nested/.git")).expect("nested git metadata");
    let policy = macos::seatbelt_policy(
        &request(SandboxProfile::ReadOnly, &root, &state),
        &temporary,
        Some(&home),
    )
    .expect("policy");

    assert!(policy.contains("(deny default)"));
    assert!(policy.contains("(deny network*)"));
    assert!(!policy.contains("(allow file-read*)"));
    assert!(!policy.contains("com.apple.securityd"));
    assert!(!policy.contains("com.apple.SecurityServer"));
    assert!(policy.contains(&format!("(subpath \"{}\")", root.display())));
    assert!(policy.contains(&format!("(subpath \"{}\")", temporary.display())));
    assert!(policy.contains(&format!(
        "(deny file-read* file-write* (subpath \"{}\")",
        home.join(".ssh").display()
    )));
    assert!(policy.contains(&format!(
        "(deny file-read* file-write* (subpath \"{}\"))",
        state.display()
    )));
    assert!(!policy.contains(&format!(
        "(allow file-write* (subpath \"{}\")",
        root.display()
    )));
    assert!(policy.contains(&format!(
        "(deny file-write* (subpath \"{}\")",
        root.join(".git").display()
    )));
    assert!(policy.contains(&format!(
        "(deny file-write* (subpath \"{}\")",
        root.join("nested/.git").display()
    )));
    assert!(policy.contains(&format!(
        "(deny file-read* file-write* (literal \"{}\"))",
        root.join(".env").display()
    )));
    assert!(policy.contains(&format!(
        "(literal \"{}\")",
        protected_executable().unwrap().display()
    )));

    let readable = macos::readable_paths(
        &request(SandboxProfile::ReadOnly, &root, &state),
        &temporary,
        Some(&home),
    );
    assert!(readable.contains(&root));
    assert!(readable.contains(&temporary));
    assert!(!readable.contains(&fixture.path().join("path-controlled")));
}

#[test]
fn seatbelt_workspace_write_policy_allows_roots_but_denies_metadata_and_state() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("project");
    let state = fixture.path().join("state");
    let temporary = fixture.path().join("temporary");
    create_dir(&root).expect("root");
    create_dir(&state).expect("state");
    create_dir(&temporary).expect("temporary");
    write(root.join(".git"), "gitdir: ../metadata\n").expect("worktree marker");
    create_dir(fixture.path().join("metadata")).expect("git directory");

    let policy = macos::seatbelt_policy(
        &request(SandboxProfile::WorkspaceWrite, &root, &state),
        &temporary,
        None,
    )
    .expect("policy");

    assert!(policy.contains(&format!("(subpath \"{}\")", root.display())));
    assert!(policy.contains(&format!(
        "(deny file-write* (subpath \"{}\")",
        root.join(".git").display()
    )));
    assert!(policy.contains(&format!(
        "(deny file-write* (subpath \"{}\")",
        fs::canonicalize(fixture.path().join("metadata"))
            .unwrap()
            .display()
    )));
    assert!(policy.contains(&format!(
        "(deny file-write* (subpath \"{}\")",
        state.display()
    )));
}

#[test]
fn seatbelt_policy_escapes_paths_as_strings() {
    let request = SandboxRequest {
        profile: SandboxProfile::WorkspaceWrite,
        working_directory: PathBuf::from("/tmp/project"),
        state_directory: PathBuf::from("/tmp/state\"quoted"),
        workspace_roots: vec![PathBuf::from("/tmp/project\\root")],
        protected_paths: Vec::new(),
        workspace_policy: WorkspaceAccessPolicy::default(),
        command: vec!["true".into()],
    };
    let policy = macos::seatbelt_policy(&request, Path::new("/tmp/glyph"), None).expect("policy");
    assert!(policy.contains("state\\\"quoted"));
    assert!(policy.contains("project\\\\root"));
}

#[test]
fn bubblewrap_arguments_fail_closed_and_overlay_writable_roots_safely() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("project");
    let state = fixture.path().join("state");
    let home = fixture.path().join("home");
    create_dir(&root).expect("root");
    create_dir(&state).expect("state");
    create_dir(&home).expect("home");
    create_dir(home.join(".ssh")).expect("ssh directory");
    write(home.join(".netrc"), "synthetic fixture").expect("netrc fixture");
    create_dir(root.join(".git")).expect("git metadata");
    write(root.join(".env"), "synthetic canary").expect("workspace secret");
    write(root.join(".git-credentials"), "synthetic canary").expect("workspace credentials");
    let protected = root.join("worker");
    write(&protected, "fixture worker").expect("protected fixture");

    let read_only = linux::bubblewrap_arguments(
        &request(SandboxProfile::ReadOnly, &root, &state),
        Some(&home),
    )
    .expect("arguments");
    assert!(!read_only.windows(3).any(|values| {
        values[0] == "--bind" && values[1] == root.as_os_str() && values[2] == root.as_os_str()
    }));
    assert!(read_only.iter().any(|value| value == "--unshare-all"));
    assert!(!read_only
        .windows(3)
        .any(|values| { values[0] == "--ro-bind" && values[1] == "/" && values[2] == "/" }));

    let mut writable_request = request(SandboxProfile::WorkspaceWrite, &root, &state);
    writable_request.protected_paths.push(protected.clone());
    let writable = linux::bubblewrap_arguments(&writable_request, Some(&home)).expect("arguments");
    assert!(writable.windows(3).any(|values| {
        values[0] == "--bind" && values[1] == root.as_os_str() && values[2] == root.as_os_str()
    }));
    assert!(writable.windows(3).any(|values| {
        values[0] == "--ro-bind"
            && values[1] == Path::new("/dev/null").as_os_str()
            && values[2] == root.join(".git-credentials").as_os_str()
    }));
    assert!(writable.windows(3).any(|values| {
        values[0] == "--ro-bind"
            && values[1] == Path::new("/dev/null").as_os_str()
            && values[2] == root.join(".env").as_os_str()
    }));
    assert!(writable.windows(3).any(|values| {
        values[0] == "--ro-bind"
            && values[1] == protected.as_os_str()
            && values[2] == protected.as_os_str()
    }));
    let executable = protected_executable().unwrap();
    assert!(!writable.windows(3).any(|values| {
        values[0] == "--ro-bind"
            && values[1] == executable.as_os_str()
            && values[2] == executable.as_os_str()
    }));
    assert!(writable.windows(3).any(|values| {
        values[0] == "--ro-bind"
            && values[1] == root.join(".git").as_os_str()
            && values[2] == root.join(".git").as_os_str()
    }));
    for arguments in [&read_only, &writable] {
        assert!(arguments.windows(4).any(|values| {
            values[0] == "--tmpfs"
                && values[1] == state.as_os_str()
                && values[2] == "--remount-ro"
                && values[3] == state.as_os_str()
        }));
        assert!(!arguments
            .windows(2)
            .any(|values| values[0] == "--remount-ro" && values[1] == "/tmp"));
    }

    let config_root = home.join(".config");
    let docker_root = home.join(".docker");
    create_dir(&config_root).expect("config root");
    create_dir(config_root.join("gh")).expect("GitHub CLI credentials");
    create_dir(&docker_root).expect("docker root");
    write(docker_root.join("config.json"), "synthetic fixture").expect("Docker credentials");
    let sensitive_request = SandboxRequest {
        profile: SandboxProfile::WorkspaceWrite,
        working_directory: config_root.clone(),
        state_directory: state.clone(),
        workspace_roots: vec![config_root, docker_root],
        protected_paths: Vec::new(),
        workspace_policy: WorkspaceAccessPolicy::default(),
        command: vec!["true".into()],
    };
    let sensitive =
        linux::bubblewrap_arguments(&sensitive_request, Some(&home)).expect("sensitive arguments");
    assert!(sensitive.windows(2).any(|values| {
        values[0] == "--tmpfs" && values[1] == home.join(".config/gh").as_os_str()
    }));
    assert!(sensitive.windows(3).any(|values| {
        values[0] == "--ro-bind"
            && values[1] == Path::new("/dev/null").as_os_str()
            && values[2] == home.join(".docker/config.json").as_os_str()
    }));
}

#[test]
fn bubblewrap_backend_lookup_never_uses_the_command_path() {
    assert_eq!(
        linux::bubblewrap_executable_candidates(),
        &["/usr/bin/bwrap", "/bin/bwrap"]
    );
    assert!(linux::bubblewrap_executable_candidates()
        .iter()
        .all(|candidate| Path::new(candidate).is_absolute()));
}

#[test]
fn workspace_scans_fail_closed_at_small_entry_depth_and_pointer_limits() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("project");
    create_dir(&root).expect("root");
    write(root.join("one"), "fixture").expect("first entry");
    write(root.join("two"), "fixture").expect("second entry");
    let mut visitor = |_path: &Path, file_type: fs::FileType| Ok(file_type.is_dir());
    assert!(matches!(
        visit_workspace_with_limits(&root, &WorkspaceAccessPolicy::default(), 1, 8, &mut visitor),
        Err(SandboxError::InvalidPath(_))
    ));

    let nested = root.join("nested");
    create_dir(&nested).expect("nested");
    let mut visitor = |_path: &Path, file_type: fs::FileType| Ok(file_type.is_dir());
    assert!(matches!(
        visit_workspace_with_limits(
            &root,
            &WorkspaceAccessPolicy::default(),
            16,
            0,
            &mut visitor
        ),
        Err(SandboxError::InvalidPath(_))
    ));

    write(
        root.join(".git"),
        vec![b'a'; MAX_GIT_POINTER_BYTES as usize + 1],
    )
    .expect("oversized pointer");
    assert!(matches!(
        repository_metadata_paths(&root, &WorkspaceAccessPolicy::default()),
        Err(SandboxError::InvalidPath(_))
    ));
}

#[test]
fn bubblewrap_does_not_turn_external_gitdir_targets_into_read_grants() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("project");
    let state = fixture.path().join("state");
    let external = fixture.path().join("external-metadata");
    create_dir(&root).expect("root");
    create_dir(&state).expect("state");
    create_dir(&external).expect("external metadata");
    write(root.join(".git"), "gitdir: ../external-metadata\n").expect("worktree marker");

    let arguments = linux::bubblewrap_arguments(
        &request(SandboxProfile::WorkspaceWrite, &root, &state),
        None,
    )
    .expect("arguments");
    let external = fs::canonicalize(external).expect("canonical external metadata");

    assert!(!arguments.windows(3).any(|values| {
        values[0] == "--ro-bind"
            && values[1] == external.as_os_str()
            && values[2] == external.as_os_str()
    }));
    assert!(arguments.windows(3).any(|values| {
        values[0] == "--ro-bind"
            && values[1] == root.join(".git").as_os_str()
            && values[2] == root.join(".git").as_os_str()
    }));
}

fn arguments(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

fn rejection(result: Result<SandboxRequest, SandboxError>) -> SandboxError {
    result.expect_err("the request should be rejected")
}

#[test]
fn rejects_unknown_profiles() {
    let error = rejection(parse_arguments(arguments(&[
        "--profile",
        "full-access",
        "--",
        "true",
    ])));

    assert!(matches!(
        error,
        SandboxError::Usage(message) if message == "--profile must be read-only or workspace-write"
    ));
}

#[test]
fn rejects_unknown_options_and_options_without_values() {
    let unknown = rejection(parse_arguments(arguments(&[
        "--network",
        "on",
        "--",
        "true",
    ])));
    let incomplete = rejection(parse_arguments(arguments(&["--profile"])));

    assert!(matches!(
        unknown,
        SandboxError::Usage(message) if message == "unknown sandbox option: --network"
    ));
    assert!(matches!(
        incomplete,
        SandboxError::Usage(message) if message == "--profile requires a value before --"
    ));
}

#[cfg(unix)]
#[test]
fn rejects_options_and_policies_that_are_not_valid_utf8() {
    use std::os::unix::ffi::OsStringExt;

    let invalid_option = rejection(parse_arguments(vec![
        OsString::from_vec(vec![b'-', b'-', 0xff]),
        OsString::from("value"),
    ]));
    let invalid_policy = rejection(parse_arguments(vec![
        OsString::from("--workspace-policy"),
        OsString::from_vec(vec![b'{', 0xff, b'}']),
    ]));

    assert!(matches!(
        invalid_option,
        SandboxError::Usage(message) if message == "sandbox options must be valid UTF-8"
    ));
    assert!(matches!(
        invalid_policy,
        SandboxError::Usage(message) if message == "--workspace-policy must be valid UTF-8 JSON"
    ));
}

#[test]
fn rejects_workspace_policies_that_are_not_valid_json() {
    let error = rejection(parse_arguments(arguments(&[
        "--workspace-policy",
        "{\"ignoredDirectories\":",
        "--",
        "true",
    ])));

    assert!(matches!(
        error,
        SandboxError::Usage(message) if message.starts_with("invalid --workspace-policy JSON:")
    ));
}

#[test]
fn accepts_repeated_workspace_roots_and_protected_paths() {
    let parsed = parse_arguments(arguments(&[
        "--profile",
        "read-only",
        "--working-directory",
        "/workspace",
        "--state-directory",
        "/state",
        "--workspace-root",
        "/workspace",
        "--workspace-root",
        "/other",
        "--protected-path",
        "/workspace/worker",
        "--protected-path",
        "/workspace/helper",
        "--workspace-policy",
        r#"{"ignoredDirectories":[],"sensitiveFileNames":[],"sensitiveFilePrefixes":[],"sensitiveFileExtensions":[],"allowedFileNames":[]}"#,
        "--",
        "true",
    ]))
    .expect("arguments should parse");

    assert_eq!(
        parsed,
        SandboxRequest {
            profile: SandboxProfile::ReadOnly,
            working_directory: PathBuf::from("/workspace"),
            state_directory: PathBuf::from("/state"),
            workspace_roots: vec![PathBuf::from("/workspace"), PathBuf::from("/other")],
            protected_paths: vec![
                PathBuf::from("/workspace/worker"),
                PathBuf::from("/workspace/helper")
            ],
            workspace_policy: WorkspaceAccessPolicy {
                ignored_directories: Vec::new(),
                sensitive_file_names: Vec::new(),
                sensitive_file_prefixes: Vec::new(),
                sensitive_file_extensions: Vec::new(),
                allowed_file_names: Vec::new(),
            },
            command: vec![OsString::from("true")],
        }
    );
}

#[test]
fn rejects_repeated_single_value_options_and_requests_without_roots_or_commands() {
    let repeated = rejection(parse_arguments(arguments(&[
        "--state-directory",
        "/state",
        "--state-directory",
        "/other",
        "--",
        "true",
    ])));
    let without_roots = rejection(parse_arguments(arguments(&["--", "true"])));
    let without_command = rejection(parse_arguments(arguments(&[
        "--workspace-root",
        "/workspace",
        "--",
    ])));

    assert!(matches!(
        repeated,
        SandboxError::Usage(message) if message == "--state-directory may only be provided once"
    ));
    assert!(matches!(
        without_roots,
        SandboxError::Usage(message) if message == "at least one --workspace-root is required"
    ));
    assert!(matches!(
        without_command,
        SandboxError::Usage(message) if message == "a command must follow the -- separator"
    ));
}

fn descend_into_directories(_path: &Path, file_type: fs::FileType) -> Result<bool, SandboxError> {
    Ok(file_type.is_dir())
}

#[cfg(unix)]
#[test]
fn workspace_scans_skip_links_descend_directories_and_enforce_limits() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("project");
    create_dir(&root).expect("root");
    create_dir(root.join("nested")).expect("nested directory");
    write(root.join("nested/file.txt"), "fixture").expect("nested file");
    std::os::unix::fs::symlink(fixture.path(), root.join("linked")).expect("symlink");
    let policy = WorkspaceAccessPolicy::default();

    let bounded = visit_workspace_with_limits(&root, &policy, 16, 1, &mut descend_into_directories);
    let too_many_entries =
        visit_workspace_with_limits(&root, &policy, 1, 1, &mut descend_into_directories);
    let too_deep =
        visit_workspace_with_limits(&root, &policy, 16, 0, &mut descend_into_directories);

    assert!(bounded.is_ok());
    assert!(matches!(
        too_many_entries,
        Err(SandboxError::InvalidPath(message)) if message == "workspace scan exceeds the maximum entry count of 1"
    ));
    assert!(matches!(
        too_deep,
        Err(SandboxError::InvalidPath(message)) if message == "workspace scan exceeds the maximum depth of 0"
    ));
}

#[test]
fn requires_every_single_value_option() {
    let complete = [
        ("--profile", "read-only"),
        ("--working-directory", "/workspace"),
        ("--state-directory", "/state"),
        (
            "--workspace-policy",
            r#"{"ignoredDirectories":[],"sensitiveFileNames":[],"sensitiveFilePrefixes":[],"sensitiveFileExtensions":[],"allowedFileNames":[]}"#,
        ),
    ];
    for (missing, _) in complete {
        let mut values = vec!["--workspace-root", "/workspace"];
        for (option, value) in complete {
            if option != missing {
                values.extend([option, value]);
            }
        }
        values.extend(["--", "true"]);

        let error = rejection(parse_arguments(arguments(&values)));

        assert!(matches!(
            error,
            SandboxError::Usage(message) if message == format!("{missing} is required")
        ));
    }
}

#[test]
fn sandbox_errors_describe_themselves_and_expose_io_causes() {
    let usage = SandboxError::Usage("usage problem".to_owned());
    let invalid = SandboxError::InvalidPath("path problem".to_owned());
    let backend = SandboxError::Backend("backend problem".to_owned());
    let io = SandboxError::from(std::io::Error::other("disk problem"));

    assert_eq!(usage.to_string(), "usage problem");
    assert_eq!(invalid.to_string(), "path problem");
    assert_eq!(backend.to_string(), "backend problem");
    assert_eq!(io.to_string(), "disk problem");
    assert!(std::error::Error::source(&usage).is_none());
    assert_eq!(
        std::error::Error::source(&io).map(ToString::to_string),
        Some("disk problem".to_owned())
    );
}

#[test]
fn canonicalizes_and_deduplicates_protected_paths() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("root");
    let state = fixture.path().join("state");
    create_dir(&root).expect("root");
    create_dir(&state).expect("state");
    write(root.join("worker"), "fixture worker").expect("protected fixture");
    let mut unprepared = request(SandboxProfile::ReadOnly, &root, &state);
    unprepared.protected_paths = vec![root.join("worker"), root.join("./worker")];

    let prepared = prepare_request(unprepared).expect("valid request");

    assert_eq!(
        prepared.protected_paths,
        vec![fs::canonicalize(root.join("worker")).unwrap()]
    );
}

#[test]
fn rejects_missing_paths_non_directories_and_broad_workspace_roots() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("root");
    let state = fixture.path().join("state");
    create_dir(&root).expect("root");
    create_dir(&state).expect("state");
    write(root.join("file.txt"), "fixture").expect("file fixture");

    let mut missing_protected = request(SandboxProfile::ReadOnly, &root, &state);
    missing_protected.protected_paths = vec![root.join("missing")];
    let mut file_directory = request(SandboxProfile::ReadOnly, &root, &state);
    file_directory.working_directory = root.join("file.txt");
    let mut broad_root = request(SandboxProfile::ReadOnly, &root, &state);
    broad_root.workspace_roots = vec![PathBuf::from("/")];

    assert!(matches!(
        rejection(prepare_request(missing_protected)),
        SandboxError::InvalidPath(message) if message.starts_with("could not resolve protected path")
    ));
    assert!(matches!(
        rejection(prepare_request(file_directory)),
        SandboxError::InvalidPath(message) if message.starts_with("working directory is not a directory:")
    ));
    assert!(matches!(
        rejection(prepare_request(broad_root)),
        SandboxError::InvalidPath(message) if message.starts_with("workspace root is too broad to sandbox safely:")
    ));
}

#[test]
fn records_git_metadata_from_absolute_and_unresolvable_pointers() {
    let fixture = tempdir().expect("fixture");
    let absolute_target = fs::canonicalize(fixture.path()).unwrap().join("metadata");
    create_dir(&absolute_target).expect("metadata directory");
    let absolute = fixture.path().join("absolute");
    create_dir(&absolute).expect("absolute fixture");
    write(
        absolute.join(".git"),
        format!("gitdir: {}\n", absolute_target.display()),
    )
    .expect("absolute pointer");
    let unresolvable = fixture.path().join("unresolvable");
    create_dir(&unresolvable).expect("unresolvable fixture");
    write(unresolvable.join(".git"), "gitdir: ../missing\n").expect("missing pointer");
    let unrecognized = fixture.path().join("unrecognized");
    create_dir(&unrecognized).expect("unrecognized fixture");
    write(unrecognized.join(".git"), "not a pointer\n").expect("plain marker");
    let policy = WorkspaceAccessPolicy::default();
    let mut expected_absolute = vec![absolute_target, absolute.join(".git")];
    expected_absolute.sort();

    assert_eq!(
        repository_metadata_paths(&absolute, &policy).unwrap(),
        expected_absolute
    );
    assert_eq!(
        repository_metadata_paths(&unresolvable, &policy).unwrap(),
        vec![unresolvable.join(".git")]
    );
    assert_eq!(
        repository_metadata_paths(&unrecognized, &policy).unwrap(),
        vec![unrecognized.join(".git")]
    );
    assert!(
        repository_metadata_paths(&fixture.path().join("missing"), &policy)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn rejects_git_metadata_pointers_that_are_not_valid_utf8() {
    let fixture = tempdir().expect("fixture");
    write(fixture.path().join(".git"), [b'g', 0xff]).expect("invalid pointer");

    let result = repository_metadata_paths(fixture.path(), &WorkspaceAccessPolicy::default());

    assert!(matches!(
        result,
        Err(SandboxError::InvalidPath(message)) if message.starts_with("Git metadata pointer is not valid UTF-8")
    ));
}

#[cfg(unix)]
#[test]
fn workspace_scans_do_not_follow_symbolic_links() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("project");
    let outside = fixture.path().join("outside");
    create_dir(&root).expect("root");
    create_dir(&outside).expect("outside");
    write(outside.join(".env"), "synthetic canary").expect("outside secret");
    std::os::unix::fs::symlink(&outside, root.join("linked")).expect("symlink");
    std::os::unix::fs::symlink(outside.join(".env"), root.join(".env")).expect("symlink");
    let request = request(
        SandboxProfile::ReadOnly,
        &root,
        &fixture.path().join("state"),
    );

    assert!(workspace_sensitive_paths(&request).unwrap().is_empty());
}

#[test]
fn workspace_secret_scans_fail_closed_beyond_the_maximum_depth() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("project");
    let mut deepest = root.clone();
    for _ in 0..=MAX_WORKSPACE_SCAN_DEPTH + 1 {
        deepest.push("d");
    }
    fs::create_dir_all(&deepest).expect("deep fixture");
    let request = request(
        SandboxProfile::ReadOnly,
        &root,
        &fixture.path().join("state"),
    );

    assert!(matches!(
        workspace_sensitive_paths(&request),
        Err(SandboxError::InvalidPath(message)) if message == "workspace scan exceeds the maximum depth of 64"
    ));
}

#[test]
fn paths_without_file_names_are_not_sensitive() {
    assert!(!is_sensitive_workspace_file(
        Path::new(".."),
        &WorkspaceAccessPolicy::default()
    ));
}

#[test]
fn seatbelt_policy_escapes_control_characters_in_paths() {
    let request = SandboxRequest {
        profile: SandboxProfile::ReadOnly,
        working_directory: PathBuf::from("/tmp/project"),
        state_directory: PathBuf::from("/tmp/state\nline\rreturn\ttab"),
        workspace_roots: vec![PathBuf::from("/tmp/project")],
        protected_paths: Vec::new(),
        workspace_policy: WorkspaceAccessPolicy::default(),
        command: vec!["true".into()],
    };

    let policy = macos::seatbelt_policy(&request, Path::new("/tmp/glyph"), None).expect("policy");

    assert!(policy.contains("state\\nline\\rreturn\\ttab"));
}

#[test]
fn bubblewrap_exposes_existing_home_toolchains_read_only() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("project");
    let home = fixture.path().join("home");
    create_dir(&root).expect("root");
    fs::create_dir_all(home.join(".cargo/bin")).expect("toolchain directory");

    let arguments = linux::bubblewrap_arguments(
        &request(
            SandboxProfile::ReadOnly,
            &root,
            &fixture.path().join("state"),
        ),
        Some(&home),
    )
    .expect("arguments");

    let toolchain = home.join(".cargo/bin");
    let expected = [
        OsString::from("--ro-bind"),
        toolchain.clone().into_os_string(),
        toolchain.into_os_string(),
    ];
    assert!(arguments.windows(3).any(|values| values == expected));
}

#[cfg(target_os = "macos")]
#[test]
fn reports_that_bubblewrap_is_unavailable_on_hosts_without_it() {
    assert!(matches!(
        linux::bubblewrap_executable(),
        Err(SandboxError::Backend(message)) if message.contains("/usr/bin/bwrap or /bin/bwrap")
    ));
}

#[test]
fn reports_a_backend_error_when_the_sandboxed_command_cannot_start() {
    let fixture = tempdir().expect("fixture");
    let root = fixture.path().join("missing-project");
    let state = fixture.path().join("state");
    create_dir(&state).expect("state");

    let result = execute(&request(SandboxProfile::ReadOnly, &root, &state));

    assert!(matches!(result, Err(SandboxError::Backend(_))));
}
#[test]
fn bubblewrap_discovery_preserves_trusted_order_and_canonicalization_errors() {
    use std::cell::RefCell;
    struct Files {
        present: &'static [&'static str],
        fail_resolution: bool,
        inspected: RefCell<Vec<String>>,
    }
    impl linux::ExecutableFiles for Files {
        fn is_file(&self, path: &std::path::Path) -> bool {
            self.inspected
                .borrow_mut()
                .push(path.to_string_lossy().into_owned());
            self.present
                .iter()
                .any(|candidate| path == std::path::Path::new(candidate))
        }
        fn canonicalize(&self, path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
            self.inspected
                .borrow_mut()
                .push(format!("canonicalize:{}", path.display()));
            if self.fail_resolution {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "candidate disappeared",
                ))
            } else {
                Ok("/trusted/canonical/bwrap".into())
            }
        }
    }
    for present in [&["/usr/bin/bwrap", "/bin/bwrap"][..], &["/bin/bwrap"][..]] {
        let files = Files {
            present,
            fail_resolution: false,
            inspected: RefCell::new(Vec::new()),
        };
        assert_eq!(
            linux::discover_bubblewrap(&files).unwrap(),
            std::path::Path::new("/trusted/canonical/bwrap")
        );
        let mut expected = vec!["/usr/bin/bwrap".to_owned()];
        if present[0] == "/bin/bwrap" {
            expected.push("/bin/bwrap".into());
        }
        expected.push(format!("canonicalize:{}", present[0]));
        assert_eq!(*files.inspected.borrow(), expected);
    }
    let files = Files {
        present: &["/usr/bin/bwrap", "/bin/bwrap"],
        fail_resolution: true,
        inspected: RefCell::new(Vec::new()),
    };
    assert!(linux::discover_bubblewrap(&files).is_err());
    assert_eq!(
        *files.inspected.borrow(),
        ["/usr/bin/bwrap", "canonicalize:/usr/bin/bwrap"]
    );
    let absent = Files {
        present: &[],
        fail_resolution: false,
        inspected: RefCell::new(Vec::new()),
    };
    assert!(matches!(
        linux::discover_bubblewrap(&absent),
        Err(SandboxError::Backend(_))
    ));
    assert_eq!(*absent.inspected.borrow(), ["/usr/bin/bwrap", "/bin/bwrap"]);
}
