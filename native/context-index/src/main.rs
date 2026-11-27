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
        Some("--assert-access-metadata") => inspect(false),
        Some("--assert-replaceable-metadata") => inspect(true),
        _ => glyph_context_index::run().map_err(std::io::Error::other),
    };
    if let Err(error) = result {
        eprintln!("glyph-context-index: {error}");
        std::process::exit(1);
    }
}
