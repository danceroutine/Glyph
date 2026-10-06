fn main() {
    if let Err(error) = glyph_context_index::run() {
        eprintln!("glyph-context-index: {error}");
        std::process::exit(1);
    }
}
