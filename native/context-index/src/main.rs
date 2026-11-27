#[cfg(target_os = "linux")]
fn source_path_aliases() -> std::io::Result<()> {
    use std::path::PathBuf;
    let (path, descendants): (PathBuf, bool) = serde_json::from_reader(std::io::stdin().lock())?;
    let table = std::fs::read("/proc/self/mountinfo")?;
    let aliases = glyph_filesystem_metadata::mount_table::MountTable::parse(&table)?
        .visible_aliases(&path, descendants)?;
    serde_json::to_writer(std::io::stdout().lock(), &aliases)?;
    Ok(())
}

fn inspect_workspace_path() -> std::io::Result<()> {
    use std::path::PathBuf;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        path: PathBuf,
        private_paths: Vec<PathBuf>,
        identity: Option<[String; 2]>,
    }
    let req: Request = serde_json::from_reader(std::io::stdin().lock())?;
    let access =
        glyph_filesystem_metadata::workspace_paths::WorkspacePaths::current(&req.private_paths)?;
    access.assert_path(
        &req.path,
        req.identity
            .as_ref()
            .map(|[dev, ino]| (dev.as_str(), ino.as_str())),
    )?;
    println!("verified");
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn inspect(replacement: bool) -> std::io::Result<()> {
    if replacement {
        glyph_filesystem_metadata::assert_replaceable(std::io::stdin())?
    } else {
        glyph_filesystem_metadata::assert_access_metadata(std::io::stdin())?
    }
    println!("verified");
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn inspect(_: bool) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Descriptor metadata inspection is unavailable.",
    ))
}

fn main() {
    let result = match std::env::args_os()
        .nth(1)
        .as_deref()
        .and_then(|arg| arg.to_str())
    {
        #[cfg(target_os = "linux")]
        Some("--source-path-aliases") => source_path_aliases(),
        Some("--assert-workspace-path") => inspect_workspace_path(),
        Some("--assert-access-metadata") => inspect(false),
        Some("--assert-replaceable-metadata") => inspect(true),
        _ => glyph_context_index::run().map_err(std::io::Error::other),
    };
    if let Err(error) = result {
        eprintln!("glyph-context-index: {error}");
        std::process::exit(1);
    }
}
