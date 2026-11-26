use super::*;
use serde_json::{json, Value};

fn reply(input: impl Read) -> Value {
    let mut output = Vec::new();
    serve(input, &mut output).unwrap();
    assert!(output.len() <= 1024);
    serde_json::from_slice(&output).unwrap()
}

#[test]
fn rejects_malformed_oversized_and_incomplete_messages_without_echoing_input() {
    for input in [b"{{".as_slice(), b"{}", b"{} {}", br#"{"root":"x"}"#] {
        assert_eq!(reply(input)["code"], "INVALID_INPUT");
    }
    assert_eq!(
        reply(vec![b'x'; MAX_REQUEST_BYTES as usize + 1].as_slice())["code"],
        "INVALID_INPUT"
    );
    struct Broken;
    impl Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("injected failure"))
        }
    }
    assert_eq!(reply(Broken)["code"], "INVALID_INPUT");
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod supported {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    use std::path::Path;
    use tempfile::tempdir;

    fn request(root: &Path, operation: Value) -> Value {
        let metadata = fs::symlink_metadata(root).unwrap();
        let mut request = operation;
        request["root"] = json!(root);
        request["rootIdentity"] =
            json!({"device":metadata.dev().to_string(),"inode":metadata.ino().to_string()});
        request
    }
    fn run(request: &Value) -> Value {
        reply(serde_json::to_vec(request).unwrap().as_slice())
    }
    fn ensure(path: &str) -> Value {
        json!({"operation":"ensure_directory","relative":path})
    }
    fn remove(path: &str) -> Value {
        json!({"operation":"remove_tree","relative":path})
    }
    fn rename(source: &str, target: &str) -> Value {
        json!({"operation":"rename_exclusive","sourceRelative":source,"targetRelative":target})
    }

    #[test]
    fn rejects_ambiguous_or_unexpected_paths_and_fields() {
        let dir = tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for name in [
            "",
            ".",
            "..",
            "/absolute",
            "prefix/",
            "a//b",
            "a/../b",
            "./b",
            "a\0b",
            "a\\b",
            &"x".repeat(4097),
        ] {
            assert_eq!(
                run(&request(&root, ensure(name)))["code"],
                "INVALID_INPUT",
                "{name:?}"
            );
        }
        for (field, value) in [
            ("extra", json!(1)),
            ("operation", json!("unknown")),
            ("sourceRelative", json!("a")),
            ("rootIdentity", json!({"device":1,"inode":2})),
            ("root", json!("relative")),
        ] {
            let mut input = request(&root, ensure("a"));
            input[field] = value;
            assert_eq!(run(&input)["code"], "INVALID_INPUT");
        }
        for field in ["device", "inode"] {
            let mut input = request(&root, ensure("a"));
            input["rootIdentity"][field] = json!("wrong");
            assert_eq!(run(&input)["code"], "ESTALE");
        }
        assert!(!root.join("a").exists());
    }

    #[test]
    fn creates_private_directories_and_never_replaces_a_destination() {
        let dir = tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let run_op = |op| run(&request(&root, op));
        assert_eq!(run_op(ensure("stage/next"))["ok"], true);
        assert_eq!(run_op(ensure("stage/next"))["ok"], true);
        assert_eq!(
            fs::metadata(root.join("stage/next"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        fs::write(root.join("stage/next/file"), "candidate").unwrap();
        fs::create_dir(root.join("install")).unwrap();
        fs::create_dir(root.join("install/pkg")).unwrap();
        assert_eq!(
            run_op(rename("stage/next", "install/pkg"))["code"],
            "EEXIST"
        );
        assert_eq!(
            fs::read_to_string(root.join("stage/next/file")).unwrap(),
            "candidate"
        );
        fs::remove_dir(root.join("install/pkg")).unwrap();
        assert_eq!(run_op(rename("stage/next", "install/pkg"))["ok"], true);
        assert_eq!(
            run_op(rename("stage/next", "install/none"))["code"],
            "ENOENT"
        );
        assert_eq!(
            fs::read_to_string(root.join("install/pkg/file")).unwrap(),
            "candidate"
        );
    }

    #[test]
    fn stages_immutable_files_and_empty_directories_and_requires_private_transaction_storage() {
        let dir = tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let op = |op| run(&request(&root, op));
        let stage = || json!({"operation":"create_stage", "relative":".skill-staging/id"});
        let package = || {
            json!({"operation":"stage_package","relative":".skill-staging/id/package",
            "directories":[{"path":"empty","mode":0o555},{"path":"","mode":0o755}],
            "files":[{"path":"SKILL.md","mode":0o640,"content":"YWJj"}]})
        };
        assert_eq!(op(stage())["ok"], true);
        assert_eq!(op(stage())["code"], "EEXIST");
        assert_eq!(op(package())["ok"], true);
        assert_eq!(op(package())["code"], "EEXIST");
        let installed = root.join(".skill-staging/id/package");
        assert_eq!(fs::read(installed.join("SKILL.md")).unwrap(), b"abc");
        for (path, expected) in [
            (installed.clone(), 0o755),
            (installed.join("empty"), 0o555),
            (installed.join("SKILL.md"), 0o640),
        ] {
            assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, expected);
        }
        assert_eq!(op(remove(".skill-staging/id"))["ok"], true);
        let mut invalid = stage();
        invalid["relative"] = json!("other/id");
        assert_eq!(op(invalid)["code"], "INVALID_INPUT");
        let mut invalid = package();
        invalid["relative"] = json!("other/id/package");
        assert_eq!(op(invalid)["code"], "INVALID_INPUT");
        fs::set_permissions(
            root.join(".skill-staging"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        assert_eq!(op(stage())["code"], "EACCES");
    }

    #[test]
    fn refuses_unreadable_ambiguous_and_oversize_staged_entries() {
        let dir = tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let op = |op| run(&request(&root, op));
        let directory = json!({"path":"","mode":0o755});
        let file = json!({"path":"SKILL.md","mode":0o644,"content":"YQ=="});
        assert_eq!(
            op(json!({"operation":"create_stage","relative":".skill-staging/id"}))["ok"],
            true
        );
        for (directories, files, code) in [
            (json!([]), json!([file]), "INVALID_INPUT"),
            (
                json!([directory, directory]),
                json!([file]),
                "INVALID_INPUT",
            ),
            (json!([directory]), json!([]), "INVALID_INPUT"),
            (json!([{"path":"","mode":0o200}]), json!([file]), "EACCES"),
            (
                json!([{"path":"","mode":0o4755}]),
                json!([file]),
                "INVALID_INPUT",
            ),
            (
                json!([directory]),
                json!([{"path":"a","mode":0o200,"content":""}]),
                "EACCES",
            ),
            (
                json!([directory]),
                json!([{"path":"a","mode":0o644,"content":"#"}]),
                "INVALID_INPUT",
            ),
            (
                json!([directory]),
                json!([{"path":"a","mode":0o644,"content":"A".repeat(1_398_105)}]),
                "INVALID_INPUT",
            ),
            (
                json!([directory]),
                json!([{"path":"a","mode":0o644,"content":"A".repeat(1_398_104)}]),
                "INVALID_INPUT",
            ),
            (json!([directory]), json!([file, file]), "EEXIST"),
            (
                json!([directory]),
                json!([{"path":"../a","mode":0o644,"content":""}]),
                "INVALID_INPUT",
            ),
        ] {
            let result = op(
                json!({"operation":"stage_package","relative":".skill-staging/id/package","directories":directories,"files":files}),
            );
            assert_eq!(result["code"], code);
            assert_eq!(op(remove(".skill-staging/id/package"))["ok"], true);
        }
        let mut oversized = serde_json::to_vec(&request(&root, ensure("regular"))).unwrap();
        oversized.resize(MAX_REQUEST_BYTES as usize + 1, b' ');
        assert_eq!(reply(&oversized[..])["code"], "INVALID_INPUT");
        oversized.resize(MAX_PACKAGE_REQUEST_BYTES as usize + 1, b' ');
        assert_eq!(reply(&oversized[..])["code"], "INVALID_INPUT");
    }

    #[test]
    fn refuses_symlink_ancestors_and_unlinks_only_the_selected_leaf() {
        let dir = tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let root = base.join("workspace");
        let external = base.join("external");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&external).unwrap();
        fs::write(external.join("outside.txt"), "untouched").unwrap();
        symlink(&external, root.join("alias")).unwrap();
        fs::write(root.join("source.txt"), "workspace").unwrap();
        let operations = [
            ensure("alias/new/sub"),
            rename("alias/outside.txt", "received"),
            rename("source.txt", "alias/new"),
            remove("alias/outside.txt"),
        ];
        for op in operations {
            let answer = run(&request(&root, op));
            assert!(
                matches!(answer["code"].as_str(), Some("ENOTDIR" | "ELOOP")),
                "{answer}"
            );
        }
        symlink(&root, base.join("root-alias")).unwrap();
        let mut input = request(&root, ensure("other"));
        input["root"] = json!(base.join("root-alias"));
        assert_eq!(run(&input)["ok"], false);
        assert_eq!(run(&request(&root, remove("alias")))["ok"], true);
        assert!(!root.join("alias").exists());
        assert_eq!(
            fs::read_to_string(external.join("outside.txt")).unwrap(),
            "untouched"
        );
        assert_eq!(
            fs::read_to_string(root.join("source.txt")).unwrap(),
            "workspace"
        );
    }

    #[test]
    fn recursive_cleanup_is_idempotent_and_preserves_symlink_targets_and_non_unicode_names() {
        #[cfg(target_os = "linux")]
        use std::os::unix::ffi::OsStringExt;
        let dir = tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("stage/old/deeper")).unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        fs::write(root.join("outside/saved"), "original").unwrap();
        symlink(root.join("outside"), root.join("stage/old/link")).unwrap();
        symlink(root.join("missing"), root.join("stage/old/broken")).unwrap();
        #[cfg(target_os = "linux")]
        let raw = std::ffi::OsString::from_vec(vec![0xff]);
        #[cfg(target_os = "macos")]
        let raw = "雪";
        fs::write(root.join("stage/old/deeper").join(raw), "old").unwrap();
        fs::set_permissions(
            root.join("stage/old/deeper"),
            fs::Permissions::from_mode(0o555),
        )
        .unwrap();
        fs::set_permissions(root.join("stage/old"), fs::Permissions::from_mode(0o500)).unwrap();
        for path in ["stage/old", "stage/old", "stage/missing/child"] {
            assert_eq!(run(&request(&root, remove(path)))["ok"], true);
        }
        assert!(!root.join("stage/old").exists());
        assert_eq!(
            fs::read_to_string(root.join("outside/saved")).unwrap(),
            "original"
        );
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn only_one_concurrent_publisher_can_claim_an_empty_destination() {
    use std::os::unix::fs::MetadataExt;
    use std::sync::{Arc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let stat = std::fs::metadata(&root).unwrap();
    let gate = Arc::new(Barrier::new(2));
    let mut workers = Vec::new();
    for source in ["a", "b"] {
        std::fs::create_dir(root.join(source)).unwrap();
        std::fs::write(root.join(source).join("file"), source).unwrap();
        let request = json!({"operation":"rename_exclusive", "sourceRelative":source, "targetRelative":"destination",
            "root": root, "rootIdentity":{"device":stat.dev().to_string(), "inode":stat.ino().to_string()}});
        let gate = Arc::clone(&gate);
        workers.push(std::thread::spawn(move || {
            gate.wait();
            (
                source,
                reply(serde_json::to_vec(&request).unwrap().as_slice()),
            )
        }));
    }
    let results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    let winner = std::fs::read_to_string(root.join("destination/file")).unwrap();
    for (source, result) in results {
        if source == winner {
            assert_eq!(result["ok"], true);
            assert!(!root.join(source).exists());
        } else {
            assert_eq!(result["code"], "EEXIST");
            assert_eq!(
                std::fs::read_to_string(root.join(source).join("file")).unwrap(),
                source
            );
        }
    }
}
