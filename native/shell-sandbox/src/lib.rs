use std::ffi::{OsStr, OsString};
use std::fmt::{Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SandboxProfile {
    ReadOnly,
    WorkspaceWrite,
}

impl SandboxProfile {
    fn parse(value: &OsStr) -> Result<Self, SandboxError> {
        match value.to_str() {
            Some("read-only") => Ok(Self::ReadOnly),
            Some("workspace-write") => Ok(Self::WorkspaceWrite),
            _ => Err(SandboxError::Usage(
                "--profile must be read-only or workspace-write".to_owned(),
            )),
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct SandboxRequest {
    pub profile: SandboxProfile,
    pub working_directory: PathBuf,
    pub state_directory: PathBuf,
    pub workspace_roots: Vec<PathBuf>,
    pub protected_paths: Vec<PathBuf>,
    pub workspace_policy: WorkspaceAccessPolicy,
    pub command: Vec<OsString>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkspaceAccessPolicy {
    pub ignored_directories: Vec<String>,
    pub sensitive_file_names: Vec<String>,
    pub sensitive_file_prefixes: Vec<String>,
    pub sensitive_file_extensions: Vec<String>,
    pub allowed_file_names: Vec<String>,
}

impl Default for WorkspaceAccessPolicy {
    fn default() -> Self {
        Self {
            ignored_directories: strings(&[
                ".git",
                ".next",
                "coverage",
                "dist",
                "node_modules",
                "target",
            ]),
            sensitive_file_names: strings(&[".git-credentials", ".netrc", ".npmrc", ".pypirc"]),
            sensitive_file_prefixes: strings(&[".env"]),
            sensitive_file_extensions: strings(&[".key", ".pem", ".p12", ".pfx"]),
            allowed_file_names: strings(&[".env.example"]),
        }
    }
}

#[derive(Debug)]
pub enum SandboxError {
    Usage(String),
    InvalidPath(String),
    Backend(String),
    Io(std::io::Error),
}

impl Display for SandboxError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Usage(message) | Self::InvalidPath(message) | Self::Backend(message) => {
                formatter.write_str(message)
            }
            Self::Io(error) => Display::fmt(error, formatter),
        }
    }
}

impl std::error::Error for SandboxError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for SandboxError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

pub fn parse_arguments<I>(arguments: I) -> Result<SandboxRequest, SandboxError>
where
    I: IntoIterator<Item = OsString>,
{
    let arguments = arguments.into_iter().collect::<Vec<_>>();
    let mut profile = None;
    let mut working_directory = None;
    let mut state_directory = None;
    let mut workspace_roots = Vec::new();
    let mut protected_paths = Vec::new();
    let mut workspace_policy = None;
    let mut index = 0;

    while index < arguments.len() {
        if arguments[index] == "--" {
            index += 1;
            break;
        }

        let option = arguments[index]
            .to_str()
            .ok_or_else(|| SandboxError::Usage("sandbox options must be valid UTF-8".to_owned()))?;
        index += 1;
        let value = arguments
            .get(index)
            .ok_or_else(|| SandboxError::Usage(format!("{option} requires a value before --")))?;
        index += 1;

        match option {
            "--profile" if profile.is_none() => profile = Some(SandboxProfile::parse(value)?),
            "--working-directory" if working_directory.is_none() => {
                working_directory = Some(PathBuf::from(value))
            }
            "--state-directory" if state_directory.is_none() => {
                state_directory = Some(PathBuf::from(value))
            }
            "--workspace-root" => workspace_roots.push(PathBuf::from(value)),
            "--protected-path" => protected_paths.push(PathBuf::from(value)),
            "--workspace-policy" if workspace_policy.is_none() => {
                workspace_policy = Some(
                    serde_json::from_str(value.to_str().ok_or_else(|| {
                        SandboxError::Usage(
                            "--workspace-policy must be valid UTF-8 JSON".to_owned(),
                        )
                    })?)
                    .map_err(|error| {
                        SandboxError::Usage(format!("invalid --workspace-policy JSON: {error}"))
                    })?,
                )
            }
            "--profile" | "--working-directory" | "--state-directory" | "--workspace-policy" => {
                return Err(SandboxError::Usage(format!(
                    "{option} may only be provided once"
                )))
            }
            _ => {
                return Err(SandboxError::Usage(format!(
                    "unknown sandbox option: {option}"
                )))
            }
        }
    }

    let command = arguments[index..].to_vec();
    if command.is_empty() {
        return Err(SandboxError::Usage(
            "a command must follow the -- separator".to_owned(),
        ));
    }
    if workspace_roots.is_empty() {
        return Err(SandboxError::Usage(
            "at least one --workspace-root is required".to_owned(),
        ));
    }

    Ok(SandboxRequest {
        profile: profile.ok_or_else(|| SandboxError::Usage("--profile is required".to_owned()))?,
        working_directory: working_directory
            .ok_or_else(|| SandboxError::Usage("--working-directory is required".to_owned()))?,
        state_directory: state_directory
            .ok_or_else(|| SandboxError::Usage("--state-directory is required".to_owned()))?,
        workspace_roots,
        protected_paths,
        workspace_policy: workspace_policy
            .ok_or_else(|| SandboxError::Usage("--workspace-policy is required".to_owned()))?,
        command,
    })
}

pub fn prepare_request(mut request: SandboxRequest) -> Result<SandboxRequest, SandboxError> {
    request.working_directory =
        canonical_directory(&request.working_directory, "working directory")?;
    request.state_directory = canonical_directory(&request.state_directory, "state directory")?;
    request.workspace_roots = request
        .workspace_roots
        .iter()
        .map(|root| canonical_directory(root, "workspace root"))
        .collect::<Result<Vec<_>, _>>()?;
    request.workspace_roots.sort();
    request.workspace_roots.dedup();
    request.protected_paths = request
        .protected_paths
        .iter()
        .map(|path| canonical_path(path, "protected path"))
        .collect::<Result<Vec<_>, _>>()?;
    request.protected_paths.sort();
    request.protected_paths.dedup();

    let home_directory = std::env::var_os("HOME").and_then(|path| fs::canonicalize(path).ok());
    for root in &request.workspace_roots {
        if is_unsafe_workspace_root(root, home_directory.as_deref()) {
            return Err(SandboxError::InvalidPath(format!(
                "workspace root is too broad to sandbox safely: {}",
                root.display()
            )));
        }
        if root.starts_with(&request.state_directory) || request.state_directory.starts_with(root) {
            return Err(SandboxError::InvalidPath(
                "state directory and workspace roots must not overlap".to_owned(),
            ));
        }
    }

    if !request
        .workspace_roots
        .iter()
        .any(|root| request.working_directory.starts_with(root))
    {
        return Err(SandboxError::InvalidPath(
            "working directory must be inside a workspace root".to_owned(),
        ));
    }

    Ok(request)
}

fn is_unsafe_workspace_root(root: &Path, home_directory: Option<&Path>) -> bool {
    if root.parent().is_none() || home_directory.is_some_and(|home| home.starts_with(root)) {
        return true;
    }
    [
        "/Applications",
        "/Library",
        "/System",
        "/Users/Shared",
        "/home",
        "/opt",
        "/opt/homebrew",
        "/private",
        "/private/tmp",
        "/private/var",
        "/root",
        "/tmp",
        "/usr",
        "/usr/local",
        "/var",
    ]
    .iter()
    .any(|unsafe_root| root == Path::new(unsafe_root))
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, SandboxError> {
    let canonical = canonical_path(path, label)?;
    if !canonical.is_dir() {
        return Err(SandboxError::InvalidPath(format!(
            "{label} is not a directory: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn canonical_path(path: &Path, label: &str) -> Result<PathBuf, SandboxError> {
    fs::canonicalize(path).map_err(|error| {
        SandboxError::InvalidPath(format!(
            "could not resolve {label} {}: {error}",
            path.display()
        ))
    })
}

fn repository_metadata_paths(
    root: &Path,
    policy: &WorkspaceAccessPolicy,
) -> Result<Vec<PathBuf>, SandboxError> {
    let mut paths = Vec::new();
    if !root.exists() {
        return Ok(paths);
    }
    visit_workspace(root, policy, &mut |path, file_type| {
        if path.file_name() != Some(OsStr::new(".git")) {
            return Ok(file_type.is_dir());
        }
        paths.push(path.to_owned());
        if file_type.is_file() {
            let contents = fs::read_to_string(path)?;
            if let Some(value) = contents.strip_prefix("gitdir:") {
                let linked = Path::new(value.trim());
                let resolved = if linked.is_absolute() {
                    linked.to_owned()
                } else {
                    path.parent().unwrap_or(root).join(linked)
                };
                if let Ok(canonical) = fs::canonicalize(resolved) {
                    paths.push(canonical);
                }
            }
        }
        Ok(false)
    })?;
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn workspace_sensitive_paths(request: &SandboxRequest) -> Result<Vec<PathBuf>, SandboxError> {
    let mut paths = Vec::new();
    for root in &request.workspace_roots {
        if !root.exists() {
            continue;
        }
        visit_workspace(root, &request.workspace_policy, &mut |path, file_type| {
            if file_type.is_file() && is_sensitive_workspace_file(path, &request.workspace_policy) {
                paths.push(path.to_owned());
            }
            Ok(file_type.is_dir())
        })?;
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn visit_workspace(
    directory: &Path,
    policy: &WorkspaceAccessPolicy,
    visitor: &mut impl FnMut(&Path, fs::FileType) -> Result<bool, SandboxError>,
) -> Result<(), SandboxError> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        let descend = visitor(&path, file_type)?;
        if descend && !is_ignored_directory(&path, policy) {
            visit_workspace(&path, policy, visitor)?;
        }
    }
    Ok(())
}

fn is_ignored_directory(path: &Path, policy: &WorkspaceAccessPolicy) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| {
            policy
                .ignored_directories
                .iter()
                .any(|ignored| ignored == name)
        })
}

fn is_sensitive_workspace_file(path: &Path, policy: &WorkspaceAccessPolicy) -> bool {
    let Some(name) = path.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    if policy
        .allowed_file_names
        .iter()
        .any(|allowed| allowed == name)
    {
        return false;
    }
    policy
        .sensitive_file_names
        .iter()
        .any(|sensitive| sensitive == name)
        || policy
            .sensitive_file_prefixes
            .iter()
            .any(|prefix| name.starts_with(prefix))
        || policy
            .sensitive_file_extensions
            .iter()
            .any(|extension| name.ends_with(extension))
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

fn protected_executable() -> Result<PathBuf, SandboxError> {
    Ok(fs::canonicalize(std::env::current_exe()?)?)
}

fn protected_paths(request: &SandboxRequest) -> Result<Vec<PathBuf>, SandboxError> {
    let mut paths = request.protected_paths.clone();
    paths.push(protected_executable()?);
    paths.sort();
    paths.dedup();
    Ok(paths)
}

#[cfg(target_os = "macos")]
pub fn execute(request: &SandboxRequest) -> Result<ExitStatus, SandboxError> {
    let temporary_directory = tempfile::Builder::new().prefix("glyph-shell-").tempdir()?;
    let temporary_path = fs::canonicalize(temporary_directory.path())?;
    let home_directory = std::env::var_os("HOME").and_then(|path| fs::canonicalize(path).ok());
    let policy = macos::seatbelt_policy(request, &temporary_path, home_directory.as_deref())?;
    Command::new("/usr/bin/sandbox-exec")
        .arg("-p")
        .arg(policy)
        .arg("--")
        .args(&request.command)
        .current_dir(&request.working_directory)
        .env("TMPDIR", &temporary_path)
        .status()
        .map_err(|error| {
            SandboxError::Backend(format!(
                "could not start the macOS sandbox backend: {error}"
            ))
        })
}

#[cfg(target_os = "linux")]
pub fn execute(request: &SandboxRequest) -> Result<ExitStatus, SandboxError> {
    let home_directory = std::env::var_os("HOME").and_then(|path| fs::canonicalize(path).ok());
    let arguments = linux::bubblewrap_arguments(request, home_directory.as_deref())?;
    Command::new(linux::bubblewrap_executable()?)
        .args(arguments)
        .args(&request.command)
        .current_dir(&request.working_directory)
        .env("TMPDIR", "/tmp")
        .status()
        .map_err(|error| {
            SandboxError::Backend(format!(
                "could not start the Linux sandbox backend `bwrap`; install Bubblewrap before running sandboxed commands: {error}"
            ))
        })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn execute(_request: &SandboxRequest) -> Result<ExitStatus, SandboxError> {
    Err(SandboxError::Backend(
        "shell sandboxing is not supported on this operating system".to_owned(),
    ))
}

#[cfg(any(target_os = "macos", test))]
pub mod macos {
    use super::{SandboxError, SandboxProfile, SandboxRequest};
    use std::fs;
    use std::path::{Path, PathBuf};

    pub fn seatbelt_policy(
        request: &SandboxRequest,
        temporary_directory: &Path,
        home_directory: Option<&Path>,
    ) -> Result<String, SandboxError> {
        let mut policy = String::from(
            r#"(version 1)
(deny default)
(deny network*)
(allow process-exec)
(allow process-fork)
(allow process-info* (target same-sandbox))
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup
    (global-name "com.apple.bsd.dirhelper")
    (global-name "com.apple.cfprefsd.agent")
    (global-name "com.apple.cfprefsd.daemon")
    (global-name "com.apple.CoreServices.coreservicesd")
    (global-name "com.apple.system.logger")
    (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow ipc-posix-shm)
(allow file-read* file-test-existence (literal "/"))
(allow file-read-data file-test-existence file-write-data (subpath "/dev/fd"))
(allow file-read* file-test-existence (literal "/dev/random") (literal "/dev/urandom"))
(allow file-read* file-write* (literal "/dev/null") (literal "/dev/tty"))
(allow file-read-metadata (literal "/dev") (regex #"^/dev/.*$"))
"#,
        );

        policy.push_str("(allow file-read* file-test-existence");
        for path in readable_paths(request, temporary_directory, home_directory) {
            policy.push_str(&format!(" (subpath {})", seatbelt_string(&path)));
        }
        policy.push_str(")\n");
        policy.push_str(&format!(
            "(deny file-read* file-write* (subpath {}))\n",
            seatbelt_string(&request.state_directory)
        ));
        for path in sensitive_paths(home_directory) {
            policy.push_str(&format!(
                "(deny file-read* file-write* (subpath {}) (literal {}))\n",
                seatbelt_string(&path),
                seatbelt_string(&path)
            ));
        }
        for path in super::workspace_sensitive_paths(request)? {
            policy.push_str(&format!(
                "(deny file-read* file-write* (literal {}))\n",
                seatbelt_string(&path)
            ));
        }
        policy.push_str(&format!(
            "(allow file-write* (literal \"/dev/null\") (literal \"/dev/tty\") (subpath {}))\n",
            seatbelt_string(temporary_directory)
        ));

        if request.profile == SandboxProfile::WorkspaceWrite {
            policy.push_str("(allow file-write*");
            for root in &request.workspace_roots {
                policy.push_str(&format!(" (subpath {})", seatbelt_string(root)));
            }
            policy.push_str(")\n");
        }

        policy.push_str("(deny file-write* (regex #\"/\\.git(?:/|$)\"))\n");

        for root in &request.workspace_roots {
            for metadata in super::repository_metadata_paths(root, &request.workspace_policy)? {
                policy.push_str(&format!(
                    "(deny file-write* (subpath {}) (literal {}))\n",
                    seatbelt_string(&metadata),
                    seatbelt_string(&metadata)
                ));
            }
        }
        for path in super::protected_paths(request)? {
            policy.push_str(&format!(
                "(deny file-write* (subpath {}) (literal {}))\n",
                seatbelt_string(&path),
                seatbelt_string(&path)
            ));
        }
        policy.push_str(&format!(
            "(deny file-write* (subpath {}) (literal {}))\n",
            seatbelt_string(&request.state_directory),
            seatbelt_string(&request.state_directory)
        ));
        Ok(policy)
    }

    fn readable_paths(
        request: &SandboxRequest,
        temporary_directory: &Path,
        home_directory: Option<&Path>,
    ) -> Vec<PathBuf> {
        let mut paths = [
            "/System",
            "/usr",
            "/bin",
            "/sbin",
            "/Library",
            "/private/etc",
            "/private/var/db",
            "/private/var/run",
            "/private/var/select",
            "/opt/homebrew",
            "/usr/local",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
        paths.extend(request.workspace_roots.iter().cloned());
        paths.push(temporary_directory.to_owned());
        paths.extend(toolchain_paths(home_directory));
        if let Some(search_path) = std::env::var_os("PATH") {
            for path in std::env::split_paths(&search_path) {
                if path != Path::new("/") && home_directory != Some(path.as_path()) {
                    paths.push(fs::canonicalize(&path).unwrap_or(path));
                }
            }
        }
        paths.sort();
        paths.dedup();
        paths
    }

    fn seatbelt_string(path: &Path) -> String {
        let value = path.to_string_lossy();
        let mut escaped = String::with_capacity(value.len() + 2);
        escaped.push('"');
        for character in value.chars() {
            match character {
                '\\' => escaped.push_str("\\\\"),
                '"' => escaped.push_str("\\\""),
                '\n' => escaped.push_str("\\n"),
                '\r' => escaped.push_str("\\r"),
                '\t' => escaped.push_str("\\t"),
                character => escaped.push(character),
            }
        }
        escaped.push('"');
        escaped
    }

    fn toolchain_paths(home_directory: Option<&Path>) -> Vec<PathBuf> {
        super::home_toolchain_paths(home_directory)
            .into_iter()
            .filter(|path| path.exists())
            .collect()
    }

    fn sensitive_paths(home_directory: Option<&Path>) -> Vec<PathBuf> {
        super::home_sensitive_paths(home_directory)
    }
}

#[cfg(any(target_os = "linux", test))]
pub mod linux {
    use super::{SandboxError, SandboxProfile, SandboxRequest};
    use std::ffi::OsString;
    use std::path::Path;

    const BUBBLEWRAP_EXECUTABLES: [&str; 2] = ["/usr/bin/bwrap", "/bin/bwrap"];

    pub fn bubblewrap_executable() -> Result<std::path::PathBuf, SandboxError> {
        for candidate in BUBBLEWRAP_EXECUTABLES.map(Path::new) {
            if candidate.is_file() {
                return std::fs::canonicalize(candidate).map_err(SandboxError::from);
            }
        }
        Err(SandboxError::Backend(
            "could not find Bubblewrap at a trusted system path; install it as /usr/bin/bwrap or /bin/bwrap"
                .to_owned(),
        ))
    }

    pub fn bubblewrap_executable_candidates() -> &'static [&'static str] {
        &BUBBLEWRAP_EXECUTABLES
    }

    pub fn bubblewrap_arguments(
        request: &SandboxRequest,
        home_directory: Option<&Path>,
    ) -> Result<Vec<OsString>, SandboxError> {
        let mut arguments = strings(&[
            "--die-with-parent",
            "--new-session",
            "--unshare-all",
            "--tmpfs",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/tmp",
        ]);

        for path in [
            "/usr",
            "/bin",
            "/sbin",
            "/lib",
            "/lib64",
            "/etc",
            "/opt",
            "/nix/store",
        ] {
            let path = Path::new(path);
            if path.exists() {
                push_path_mount(&mut arguments, "--ro-bind", path, path);
            }
        }

        for path in super::home_toolchain_paths(home_directory) {
            if path.exists() {
                push_path_mount(&mut arguments, "--ro-bind", &path, &path);
            }
        }

        for root in &request.workspace_roots {
            let option = if request.profile == SandboxProfile::WorkspaceWrite {
                "--bind"
            } else {
                "--ro-bind"
            };
            push_path_mount(&mut arguments, option, root, root);
        }

        for root in &request.workspace_roots {
            for metadata in super::repository_metadata_paths(root, &request.workspace_policy)? {
                push_path_mount(&mut arguments, "--ro-bind", &metadata, &metadata);
            }
        }
        for path in super::protected_paths(request)? {
            push_path_mount(&mut arguments, "--ro-bind", &path, &path);
        }
        for path in super::workspace_sensitive_paths(request)? {
            push_path_mount(&mut arguments, "--ro-bind", Path::new("/dev/null"), &path);
        }

        if request.state_directory.exists() {
            arguments.push("--tmpfs".into());
            arguments.push(request.state_directory.as_os_str().to_owned());
        }
        for path in super::home_sensitive_paths(home_directory) {
            let exposed = request
                .workspace_roots
                .iter()
                .any(|root| path.starts_with(root));
            if !exposed {
                continue;
            }
            if path.is_dir() {
                arguments.push("--tmpfs".into());
                arguments.push(path.as_os_str().to_owned());
            } else if path.is_file() {
                push_path_mount(&mut arguments, "--ro-bind", Path::new("/dev/null"), &path);
            }
        }
        arguments.push("--chdir".into());
        arguments.push(request.working_directory.as_os_str().to_owned());
        arguments.push("--".into());
        Ok(arguments)
    }

    fn strings(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    fn push_path_mount(arguments: &mut Vec<OsString>, option: &str, source: &Path, target: &Path) {
        arguments.push(option.into());
        arguments.push(source.as_os_str().to_owned());
        arguments.push(target.as_os_str().to_owned());
    }
}

fn home_toolchain_paths(home_directory: Option<&Path>) -> Vec<PathBuf> {
    let Some(home) = home_directory else {
        return Vec::new();
    };
    [
        ".cargo/bin",
        ".cargo/git",
        ".cargo/registry",
        ".rustup/toolchains",
        ".local/bin",
        ".volta",
        ".nvm",
        ".asdf",
        ".bun/bin",
        ".pnpm",
        "Library/pnpm",
        "Library/Application Support/fnm",
        ".cache/fnm",
        ".cache/node/corepack",
    ]
    .into_iter()
    .map(|path| home.join(path))
    .collect()
}

fn home_sensitive_paths(home_directory: Option<&Path>) -> Vec<PathBuf> {
    let Some(home) = home_directory else {
        return Vec::new();
    };
    [
        ".ssh",
        ".aws",
        ".azure",
        ".config/gcloud",
        ".config/gh",
        ".config/glab",
        ".kube",
        ".docker/config.json",
        ".npmrc",
        ".netrc",
        ".pypirc",
        ".git-credentials",
        "Library/Keychains",
        ".local/share/keyrings",
    ]
    .into_iter()
    .map(|path| home.join(path))
    .collect()
}

pub fn usage() -> &'static str {
    "Usage: glyph-shell-sandbox --profile <read-only|workspace-write> --working-directory <path> --state-directory <path> --workspace-root <path> [--workspace-root <path> ...] [--protected-path <path> ...] --workspace-policy <json> -- <command> [arguments ...]"
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir, write};
    use tempfile::tempdir;

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

        let prepared = prepare_request(request(SandboxProfile::ReadOnly, &root, &state))
            .expect("valid request");
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
        let policy =
            macos::seatbelt_policy(&request, Path::new("/tmp/glyph"), None).expect("policy");
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

        let writable = linux::bubblewrap_arguments(
            &request(SandboxProfile::WorkspaceWrite, &root, &state),
            Some(&home),
        )
        .expect("arguments");
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
        let executable = protected_executable().unwrap();
        assert!(writable.windows(3).any(|values| {
            values[0] == "--ro-bind"
                && values[1] == executable.as_os_str()
                && values[2] == executable.as_os_str()
        }));
        assert!(writable.windows(3).any(|values| {
            values[0] == "--ro-bind"
                && values[1] == root.join(".git").as_os_str()
                && values[2] == root.join(".git").as_os_str()
        }));
        assert!(writable
            .windows(2)
            .any(|values| { values[0] == "--tmpfs" && values[1] == state.as_os_str() }));

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
        let sensitive = linux::bubblewrap_arguments(&sensitive_request, Some(&home))
            .expect("sensitive arguments");
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
}
