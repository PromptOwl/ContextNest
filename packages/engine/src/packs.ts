/**
 * Context Pack loading and expansion (§3).
 */

import type { Pack } from "./types.js";
import { parseSelector } from "./selector/parser.js";

/**
 * Parse every pack's `query` and return the ones that don't parse. A pack
 * with a bad selector only fails when someone queries it, so `ctx validate`
 * runs this to catch it up front (e.g. `#a OR #b` written for another tool).
 */
export function invalidPackSelectors(packs: Pack[]): Array<{ id: string; query: string; message: string }> {
  const bad: Array<{ id: string; query: string; message: string }> = [];
  for (const pack of packs) {
    if (!pack.query) continue;
    try {
      parseSelector(pack.query);
    } catch (err) {
      bad.push({ id: pack.id, query: pack.query, message: (err as Error).message });
    }
  }
  return bad;
}

/**
 * PackLoader manages loading and resolving packs.
 */
export class PackLoader {
  private packs: Map<string, Pack>;

  constructor(packs: Pack[]) {
    this.packs = new Map();
    for (const pack of packs) {
      this.packs.set(pack.id, pack);
    }
  }

  /** Get a pack by id */
  get(id: string): Pack | undefined {
    return this.packs.get(id);
  }

  /** List all packs */
  list(): Pack[] {
    return [...this.packs.values()];
  }

  /** Check if a pack exists */
  has(id: string): boolean {
    return this.packs.has(id);
  }
}
