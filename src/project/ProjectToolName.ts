export enum ProjectToolName {
  /**
   * Finds project files whose paths match a glob pattern, optionally beneath a specific directory.
   * Results are bounded and honor the workspace's ignored, excluded, and sensitive-path rules.
   */
  LIST_FILES = 'list_project_files',

  /**
   * Reads an entire project file or a requested range of lines from its current text snapshot.
   * The result includes revision and encoding metadata needed to prepare safe edit proposals.
   */
  READ_FILE = 'read_project_file',

  /**
   * Searches current project file contents using either literal text or regular expressions.
   * Callers can constrain paths and file types, select an output mode, and request nearby context lines.
   */
  SEARCH_CONTENTS = 'search_project_contents',

  /**
   * Parses the strict patch dialect and applies the resulting file changes immediately.
   * The user can keep or revert the applied changes afterward.
   */
  PROPOSE_PATCH = 'propose_patch',

  /**
   * Applies structured, coordinate-based text and file operations with subsequent Keep/Revert review.
   * This form is intended for changes that require exact ranges, whitespace, line endings, or Unicode handling.
   */
  PROPOSE_EDITS = 'propose_edits',
}
