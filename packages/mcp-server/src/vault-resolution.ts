/**
 * Vault resolution for the MCP server.
 *
 * Kept in its own module (not inline in index.ts) so it can be unit-tested:
 * importing index.ts boots the stdio server as a top-level side effect, which a
 * test cannot do, whereas this module is pure aside from the stderr advisory.
 */

import { assertVaultRoot, resolveVaultPath } from "@promptowl/contextnest-engine";

/**
 * Resolve which vault to serve via the engine resolver, which owns the full
 * precedence: CONTEXTNEST_VAULT (alias) → CONTEXTNEST_VAULT_PATH (path) →
 * positional arg (alias or absolute path) → local walk-up → registry default →
 * cwd. The positional arg is threaded in as `argPath`, so a stale env alias no
 * longer hides it, and a typo'd arg surfaces a clear error instead of becoming
 * a bogus relative path.
 *
 * `argPath` defaults to the CLI positional (`contextnest-mcp <arg>`); it is a
 * parameter so tests can drive it directly without mutating `process.argv`.
 */
export function resolveMcpVaultPath(argPath: string | undefined = process.argv[2]): string {
  const resolved = resolveVaultPath({ argPath });
  if (resolved.warning) {
    process.stderr.write(`contextnest-mcp: ${resolved.warning}\n`);
  }
  // The cwd fallback is refused unless cwd is a real vault (NO_VAULT): serving
  // an arbitrary directory would let context_list / context_search / context_query
  // walk its .md files as documents. The bootstrap catches this, prints the
  // message and exits non-zero. Same engine guard as the CLI.
  return assertVaultRoot(resolved).path;
}
