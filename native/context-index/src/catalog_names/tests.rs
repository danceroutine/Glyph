use super::*;
use std::fs;
#[test]
fn recognizes_only_resolvable_equivalent_entries_and_keeps_distinct_hardlink_names() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    fs::write(root.join("AGENTſ.md"), "g").unwrap();
    let mut names = CatalogNames::new(root);
    assert!(names.matches(Path::new("any"), "any"));
    assert!(!names.matches(Path::new("/"), "any"));
    assert!(!names.matches(Path::new("café"), "CAFE"));
    assert!(!names.matches(Path::new("else"), "AGENTS.md"));
    assert_eq!(
        names.matches(Path::new("AGENTſ.md"), "AGENTS.md"),
        root.join("AGENTS.md").exists()
    );
    assert_eq!(
        names.matches(Path::new("agentſ.md"), "AGENTS.md"),
        root.join("agentſ.md").exists() && root.join("AGENTS.md").exists()
    );
    fs::hard_link(root.join("AGENTſ.md"), root.join("same-data")).unwrap();
    let mut linked = CatalogNames::new(root);
    assert_eq!(
        linked.matches(Path::new("AGENTſ.md"), "AGENTS.md"),
        root.join("AGENTS.md").exists()
    );
    if !root.join("AGENTS.md").exists() {
        fs::hard_link(root.join("AGENTſ.md"), root.join("AGENTS.md")).unwrap();
        assert!(!CatalogNames::new(root).matches(Path::new("AGENTſ.md"), "AGENTS.md"));
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("target", root.join("link")).unwrap();
        if !root.join("LINK").is_symlink() {
            fs::hard_link(root.join("link"), root.join("LINK")).unwrap();
        }
        assert!(names.matches(Path::new("link"), "LINK"));
    }
}

#[test]
fn preserves_the_indexed_role_and_its_parent_scope() {
    let temp = tempfile::tempdir().unwrap();
    let mut names = CatalogNames::new(temp.path());
    let query = InstructionQuery::from_pattern("**/.cursor/rules/*.mdc").unwrap();
    assert!(!query.matches(&mut names, "/"));
    assert!(!query.matches(&mut names, "a"));
    assert!(!query.matches(&mut names, "../.."));
    assert!(!query.matches(&mut names, ".cursor/rules/README"));
    assert!(query.matches(&mut names, "app/.cursor/rules/guide.mdc"));
    assert!(!InstructionQuery::from_pattern("**/?*/AGENTS.md")
        .unwrap()
        .matches(&mut names, "AGENTS.md"));
    assert!(InstructionQuery::from_pattern("AGENTS.md")
        .unwrap()
        .matches(&mut names, "AGENTS.md"));
    assert!(InstructionQuery::from_pattern("*.md").is_none());
}
