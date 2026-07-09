/**
 * Provenance recording — best-effort mirroring of engine events into a
 * deployment-supplied audit sink (`ProvenanceRecorder`).
 *
 * The engine's durable audit surfaces (history.yaml hash chains,
 * chain_events.yaml) remain the source of truth; the recorder is a live
 * mirror for deployments that aggregate provenance elsewhere (e.g. a
 * server-side api_events store). Recording is therefore strictly
 * best-effort: a broken recorder must never fail the operation it observes.
 */

import type { ProvenanceRecord, ProvenanceRecorder } from "./types.js";

/**
 * Emit a provenance record to `recorder`, if one is supplied. Awaits async
 * recorders but swallows every error (sync throw or rejection). Timestamp
 * defaults to now.
 */
export async function recordProvenance(
  recorder: ProvenanceRecorder | undefined,
  rec: Omit<ProvenanceRecord, "timestamp"> & { timestamp?: string },
): Promise<void> {
  if (!recorder) return;
  try {
    await recorder.record({
      timestamp: rec.timestamp ?? new Date().toISOString(),
      ...rec,
    } as ProvenanceRecord);
  } catch {
    // Best-effort by contract: audit mirroring never fails the operation.
  }
}
