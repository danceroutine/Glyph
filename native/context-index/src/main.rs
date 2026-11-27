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
    glyph_filesystem_metadata::assert_host_paths(&request.paths, &request.workspace_roots)?;
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
        Some("--assert-access-metadata") => inspect(false),
        Some("--assert-replaceable-metadata") => inspect(true),
        _ => glyph_context_index::run().map_err(std::io::Error::other),
    };
    if let Err(error) = result {
        eprintln!("glyph-context-index: {error}");
        std::process::exit(1);
    }
}
