use std::io;

fn main() -> io::Result<()> {
    glyph_workspace_mutations::serve(io::stdin().lock(), io::stdout().lock())
}
