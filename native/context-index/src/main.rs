fn main() {
    if let Err(error) = harness_context_index::run() {
        eprintln!("harness-context-index: {error}");
        std::process::exit(1);
    }
}
