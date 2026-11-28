use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

/// Resolve reserved catalog names in the directory that owns each entry. The resident index
/// supplies stored spellings; two roots or mount points can have different filename semantics.
pub(crate) struct CatalogNames<'a> {
    root: &'a Path,
    aliases: HashMap<(PathBuf, String), bool>,
}

impl<'a> CatalogNames<'a> {
    pub(crate) fn new(root: &'a Path) -> Self {
        Self {
            root,
            aliases: HashMap::new(),
        }
    }

    pub(crate) fn matches(&mut self, path: &Path, expected: &str) -> bool {
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            return false;
        };
        if name == expected {
            return true;
        }
        if name.is_ascii() && expected.is_ascii() {
            if !name.eq_ignore_ascii_case(expected) {
                return false;
            }
        } else if !name
            .chars()
            .flat_map(char::to_lowercase)
            .flat_map(char::to_uppercase)
            .eq(expected
                .chars()
                .flat_map(char::to_lowercase)
                .flat_map(char::to_uppercase))
        {
            return false;
        }
        *self
            .aliases
            .entry((path.to_owned(), expected.to_owned()))
            .or_insert_with(|| {
                let stored = self.root.join(path);
                let canonical = stored.with_file_name(expected);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    std::fs::symlink_metadata(&stored).is_ok_and(|a| {
                        std::fs::symlink_metadata(&canonical).is_ok_and(|b| {
                            a.dev() == b.dev()
                                && a.ino() == b.ino()
                                && (!a.is_file()
                                    || a.nlink() == 1
                                    || stored.canonicalize().ok() == canonical.canonicalize().ok())
                        })
                    })
                }
                #[cfg(not(unix))]
                {
                    stored
                        .canonicalize()
                        .is_ok_and(|a| canonical.canonicalize().is_ok_and(|b| a == b))
                }
            })
    }
}

pub(crate) enum InstructionQuery {
    Guidance { nested: bool },
    Rules(&'static str),
}
impl InstructionQuery {
    pub(crate) fn from_pattern(pattern: &str) -> Option<Self> {
        match pattern {
            "AGENTS.md" => Some(Self::Guidance { nested: false }),
            "**/?*/AGENTS.md" => Some(Self::Guidance { nested: true }),
            "**/.glyph/rules/*.mdc" => Some(Self::Rules(".glyph")),
            "**/.cursor/rules/*.mdc" => Some(Self::Rules(".cursor")),
            _ => None,
        }
    }

    pub(crate) fn matches(&self, names: &mut CatalogNames<'_>, relative: &str) -> bool {
        let path = Path::new(relative);
        match self {
            Self::Guidance { nested } => {
                (!nested || relative.contains('/')) && names.matches(path, "AGENTS.md")
            }
            Self::Rules(marker) => {
                let Some(parent) = path.parent() else {
                    return false;
                };
                let Some(container) = parent.parent() else {
                    return false;
                };
                let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
                    return false;
                };
                let Some((stem, extension)) = name.rsplit_once('.') else {
                    return false;
                };
                extension.eq_ignore_ascii_case("mdc")
                    && names.matches(container, marker)
                    && names.matches(parent, "rules")
                    && names.matches(path, &format!("{stem}.mdc"))
            }
        }
    }
}

#[cfg(test)]
mod tests;
