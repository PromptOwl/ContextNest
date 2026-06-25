/**
 * Abstract steward-store contract.
 *
 * Two concrete implementations ship with the engine:
 *   - `SingleUserStewardStore` (`./mongo-single.js`)
 *   - `MultiUserStewardStore`  (`./mongo-multi.js`)
 *
 * Both expose `resolveStewards` returning the same flattened shape so
 * permission code is store-agnostic. CRUD differs per store (single-user
 * works one row per user; multi-user adds/removes users inside an
 * embedded array) and is defined on the concrete classes — not here.
 */

import type { ResolvedStewardEntry, ResolveStewardsInput } from "./types.js";

export abstract class BaseStewardStore {
  /**
   * Resolve every active steward grant that applies for the given inputs.
   * Output is ordered by priority ascending (document > tag > nest) and
   * stable on email/teamId so callers can dedupe deterministically.
   *
   * When `nodeId` is omitted, only nest-scope rows match. When `tags` is
   * omitted, tag-scope rows are skipped.
   */
  abstract resolveStewards(
    nestId: string,
    input?: ResolveStewardsInput,
  ): Promise<ResolvedStewardEntry[]>;
}
