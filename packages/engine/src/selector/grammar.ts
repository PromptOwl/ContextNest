/**
 * The ONE selector grammar line (§2), rendered verbatim by every surface that
 * teaches the grammar: `ctx query --help`, `ctx resolve --help`, the
 * `ctx init` banner, the CLI README, the generated CLAUDE.md block and the
 * `context_query` / `context_resolve` MCP tool descriptions.
 * ASCII only: the line is printed to legacy Windows consoles (cp437/cp850).
 * Structural tests in the CLI package assert each of them contains it, so
 * change it here and nowhere else. [CU-wdqcq01c5x]
 */
export const SELECTOR_GRAMMAR =
  "Atoms: #tag  type:X  status:X  pack:id  nodes/<id>  sources/<id>   Operators: space or + = AND, | = OR, - = NOT, ( ) to group";

/** Every `word:` filter the lexer accepts, in the order the error message lists them. */
export const SELECTOR_FILTERS = ["type", "status", "tag", "pack", "transport", "server"] as const;
