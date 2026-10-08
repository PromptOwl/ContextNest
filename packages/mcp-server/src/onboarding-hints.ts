/**
 * First-run guidance for MCP writes — the MCP twin of the CLI's
 * onboarding-hints (ctx add / ctx search). Pure helpers, so every branch is
 * unit-testable without a vault.
 */

import { reviewHeldMessage } from "@promptowl/contextnest-engine";

/** Folders a structured vault's discovery scans (storage.discoverDocuments). */
const DISCOVERED_ROOTS = new Set(["nodes", "sources"]);

/**
 * In a structured vault, discovery only scans root-level files, `nodes/**` and
 * `sources/**`. A document written anywhere else exists on disk but never
 * shows up in list, search or agent context. Re-root such an id under `nodes/`
 * so the write is visible; obsidian vaults discover every folder, so leave
 * them alone.
 */
export function rerootForDiscovery(
  id: string,
  layout: "structured" | "obsidian",
): { id: string; rerooted: boolean } {
  if (layout !== "structured" || !id.includes("/")) return { id, rerooted: false };
  const first = id.split("/")[0];
  if (DISCOVERED_ROOTS.has(first)) return { id, rerooted: false };
  return { id: `nodes/${id}`, rerooted: true };
}

/** The note a write result carries when its id was re-rooted. */
export function placementNote(requested: string, id: string): string {
  return `${requested} is outside nodes/ and sources/, where documents are found — created ${id} instead.`;
}

/**
 * The `review` note on a held write. The engine's message covers approval;
 * this adds why a fresh document seems to be missing: search and agent context
 * only serve published nodes.
 */
export function heldReviewNotice(id: string): string {
  return `${reviewHeldMessage(id)} Until it is approved it is not searchable and agents reading the vault will not see it.`;
}
