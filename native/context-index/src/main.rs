#[cfg(unix)]
mod source_origins;

#[cfg(target_os = "linux")]
fn source_path_aliases() -> std::io::Result<()> {
    use std::path::PathBuf;
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum Paths {
        One(PathBuf),
        Many(Vec<PathBuf>),
    }
    let (paths, descendants): (Paths, bool) = serde_json::from_reader(std::io::stdin().lock())?;
    let paths = match paths {
        Paths::One(path) => vec![path],
        Paths::Many(paths) => paths,
    };
    let mountinfo = std::fs::read("/proc/self/mountinfo")?;
    let table = glyph_filesystem_metadata::mount_table::MountTable::parse(&mountinfo)?;
    let mut aliases = std::collections::BTreeSet::new();
    for path in paths {
        aliases.extend(table.visible_aliases(&path, descendants)?);
    }
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
        managed_directories: Option<Vec<PathBuf>>,
        identity: Option<[String; 2]>,
    }
    let req: Request = serde_json::from_reader(std::io::stdin().lock())?;
    let access = glyph_filesystem_metadata::workspace_paths::WorkspacePaths::for_operation(
        &req.private_paths,
        req.managed_directories.as_deref(),
    )?;
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

fn inspect_host_paths() -> std::io::Result<()> {
    use std::io::Read;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        paths: Vec<std::path::PathBuf>,
        workspace_roots: Vec<std::path::PathBuf>,
        #[serde(default)]
        sockets: Vec<std::path::PathBuf>,
    }
    const FRAME_LIMIT: u64 = 2 * 1024 * 1024;
    let mut frame = Vec::new();
    std::io::stdin()
        .take(FRAME_LIMIT + 1)
        .read_to_end(&mut frame)?;
    if frame.len() as u64 > FRAME_LIMIT {
        return Err(std::io::Error::other("Host authority frame is too large."));
    }
    let request: Request = serde_json::from_slice(&frame)?;
    glyph_filesystem_metadata::assert_host_paths_with_sockets(
        &request.paths,
        &request.workspace_roots,
        &request.sockets,
    )?;
    println!("verified");
    Ok(())
}

fn main() {
    let result = match std::env::args_os()
        .nth(1)
        .as_deref()
        .and_then(|arg| arg.to_str())
    {
        Some("--assert-host-paths") => inspect_host_paths(),
        #[cfg(target_os = "linux")]
        Some("--source-path-aliases") => source_path_aliases(),
        #[cfg(unix)]
        Some("--assert-unlinked-directory") => source_origins::assert_unlinked_directory(),
        #[cfg(unix)]
        Some("--source-origins") => source_origins::inspect(),
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
