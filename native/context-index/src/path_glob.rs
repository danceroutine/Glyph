use std::borrow::Cow;
use std::collections::BTreeSet;

use globset::GlobBuilder;
use serde::Serialize;

const MAX_PATTERN_CHARS: usize = 4_096;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlobResult {
    pub(crate) files: Vec<String>,
    pub(crate) truncated: bool,
}

pub(crate) fn find_matches(
    paths: &BTreeSet<String>,
    pattern: &str,
    target_directory: Option<&str>,
    limit: usize,
    case_sensitive: bool,
    index_truncated: bool,
) -> Result<GlobResult, String> {
    if pattern.is_empty() {
        return Err("pattern must not be empty.".to_owned());
    }
    if pattern.chars().count() > MAX_PATTERN_CHARS {
        return Err(format!(
            "pattern may contain at most {MAX_PATTERN_CHARS} characters."
        ));
    }
    let normalized_pattern = if pattern.starts_with("**/") {
        pattern.to_owned()
    } else {
        format!("**/{pattern}")
    };
    let matcher = GlobBuilder::new(&normalized_pattern)
        .literal_separator(true)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|error| format!("pattern is not a valid glob: {error}"))?
        .compile_matcher();
    let directory_prefix = target_directory.map(|directory| {
        let prefix = format!("{directory}/");
        if case_sensitive {
            prefix
        } else {
            prefix.to_lowercase()
        }
    });
    let candidates: Box<dyn Iterator<Item = &String> + '_> = match directory_prefix.as_deref() {
        Some(prefix) if case_sensitive => Box::new(paths.range(prefix.to_owned()..)),
        None => Box::new(paths.iter()),
        Some(_) => Box::new(paths.iter()),
    };
    let mut files = Vec::with_capacity(limit.min(256));
    let mut query_truncated = false;

    for path in candidates {
        let candidate = match directory_prefix.as_deref() {
            Some(prefix) if case_sensitive => {
                let Some(relative) = path.strip_prefix(prefix) else {
                    break;
                };
                Cow::Borrowed(relative)
            }
            Some(normalized_prefix) => {
                let normalized_path = path.to_lowercase();
                let Some(relative) = normalized_path.strip_prefix(normalized_prefix) else {
                    continue;
                };
                Cow::Owned(relative.to_owned())
            }
            None => Cow::Borrowed(path.as_str()),
        };
        if !matcher.is_match(candidate.as_ref()) {
            continue;
        }
        if files.len() == limit {
            query_truncated = true;
            break;
        }
        files.push(path.clone());
    }

    Ok(GlobResult {
        files,
        truncated: index_truncated || query_truncated,
    })
}

#[cfg(test)]
mod tests;
