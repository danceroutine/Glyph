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
   * Parses the strict patch dialect and stages the resulting file changes for human review.
   * It does not write to the workspace until the corresponding review items are accepted.
   */
  PROPOSE_PATCH = 'propose_patch',

  /**
   * Stages structured, coordinate-based text and file operations for human review.
   * This form is intended for changes that require exact ranges, whitespace, line endings, or Unicode handling.
   */
  PROPOSE_EDITS = 'propose_edits',
}
