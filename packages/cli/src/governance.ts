/**
 * CLI-side governance resolution.
 *
 * Loads the deployment's governance module (RBAC hooks + provenance
 * recorder) for a vault via the engine's `loadGovernanceBundle`, falling
 * back to fully-open local behavior when nothing is configured. A
 * configured-but-broken module fails LOUD (`ConfigError` propagates) — a
 * governed vault must never silently fall open.
 */

import { loadGovernanceBundle, allowAllGovernance } from "@promptowl/contextnest-engine";
import type { GovernanceHooks, ProvenanceRecorder } from "@promptowl/contextnest-engine";

export interface ResolvedGovernance {
  hooks: GovernanceHooks;
  recorder: ProvenanceRecorder;
}

/** Best-effort sink used when no module supplies a recorder. */
const noopRecorder: ProvenanceRecorder = { record: () => {} };

/** Fully-open default for local single-user use (no module configured). */
const openGovernance: ResolvedGovernance = {
  hooks: allowAllGovernance,
  recorder: noopRecorder,
};

// Memoized per vault path per process: the module factory should run once
// per vault, not once per gated call.
const cache = new Map<string, Promise<ResolvedGovernance>>();

/**
 * Resolve the governance bundle for `vaultPath`.
 *
 * Resolution precedence lives in the engine loader: explicit module option
 * (unused here) → CONTEXTNEST_GOVERNANCE_MODULE env var → the vault's
 * `.context/config.yaml` `governance.module`. When nothing is configured,
 * returns allow-all hooks and a no-op recorder. A `ConfigError` from the
 * loader propagates to the caller — never swallowed.
 */
export async function resolveGovernance(vaultPath: string): Promise<ResolvedGovernance> {
  let pending = cache.get(vaultPath);
  if (!pending) {
    pending = loadGovernanceBundle({ vaultPath, env: process.env }).then((bundle) => {
      if (!bundle) return openGovernance;
      return {
        hooks: bundle.hooks ?? allowAllGovernance,
        recorder: bundle.recorder ?? noopRecorder,
      };
    });
    // Don't memoize failures — a fixed config on a later call in the same
    // process should get a fresh load attempt (the error itself still
    // surfaces loudly to the caller each time).
    pending.catch(() => cache.delete(vaultPath));
    cache.set(vaultPath, pending);
  }
  return pending;
}
