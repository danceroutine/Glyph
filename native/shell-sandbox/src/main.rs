use std::env;
use std::process::ExitCode;

use glyph_shell_sandbox::{execute, parse_arguments, prepare_request, usage};

fn main() -> ExitCode {
    match parse_arguments(env::args_os().skip(1))
        .and_then(prepare_request)
        .and_then(|request| execute(&request))
    {
        Ok(status) => status
            .code()
            .and_then(|code| u8::try_from(code).ok())
            .map(ExitCode::from)
            .unwrap_or(ExitCode::FAILURE),
        Err(error) => {
            eprintln!("glyph-shell-sandbox: {error}");
            eprintln!("{}", usage());
            ExitCode::FAILURE
        }
    }
}
