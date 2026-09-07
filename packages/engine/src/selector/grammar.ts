/**
 * The ONE selector grammar line (§2), rendered verbatim by every surface that
 * teaches the grammar: `ctx query --help`, `ctx resolve --help`, the
 * `ctx init` banner, the CLI README and the generated CLAUDE.md block.
 * Structural tests in the CLI package assert each of them contains it, so
 * change it here and nowhere else. [CU-wdqcq01c5x]
 */
export const SELECTOR_GRAMMAR =
  "#tag  type:X  status:X  pack:id  nodes/<id>   ·   space or + = AND, | = OR, - = NOT, ( ) to group";

/** Every `word:` filter the lexer accepts, in the order the error message lists them. */
export const SELECTOR_FILTERS = ["type", "status", "tag", "pack", "transport", "server"] as const;
