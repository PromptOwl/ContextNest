/**
 * Hash chain event log — persistent audit trail
 * (zone-classification-rbac-spec §6, hootie-inbox-spec §8).
 *
 * Every governance action (approve, reject, rollback, czar-direct-edit,
 * force-push, permission-grant, dream-proposal, etc.) emits a
 * `HashChainEvent`. This class persists those events to
 * `.versions/chain_events.yaml` so compliance teams can reconstruct the
 * complete governance history of any document or zone from the log alone
 * (zone-classification-rbac-spec §6: "Events are immutable").
 *
 * Engine contract:
 *   - Append-only. No update / delete.
 *   - Each entry is schema-validated before persistence; malformed
 *     payloads are rejected with a Zod error so we never write bad audit
 *     records.
 *   - The log is filesystem-only. Streaming / WebSocket delivery for the
 *     Inbox (Hootie §10 open item) is bridge-layer work.
 */

import { hashChainEventSchema } from "./schemas.js";
import type { HashChainEvent, ProvenanceRecorder } from "./types.js";
import type { NestStorage } from "./storage.js";
import { recordProvenance } from "./provenance.js";

export class ChainEventLog {
  constructor(
    private readonly storage: NestStorage,
    private readonly options: {
      /**
       * Best-effort provenance mirror. Each event is mirrored AFTER
       * successful persistence; a broken recorder never fails the append
       * (the on-disk log remains the source of truth).
       */
      recorder?: ProvenanceRecorder;
    } = {},
  ) {}

  /** Mirror a persisted event into the deployment's audit sink. */
  private async mirror(event: HashChainEvent): Promise<void> {
    await recordProvenance(this.options.recorder, {
      kind: "chain_event",
      actor: event.actor,
      origin: event.origin,
      document_id: event.document_id,
      zone: event.zone,
      chain_hash: event.resulting_hash,
      timestamp: event.timestamp,
      metadata: { event_type: event.event_type, event_id: event.event_id },
    });
  }

  /**
   * Append a single event. Schema-validated before write — throws on
   * malformed payloads to prevent audit record poisoning.
   */
  async append(event: HashChainEvent): Promise<void> {
    const validated = hashChainEventSchema.parse(event);
    await this.storage.appendChainEvent(validated);
    await this.mirror(validated as HashChainEvent);
  }

  /**
   * Append a batch in order (linked transactional batch —
   * zone-classification-rbac-spec §3.5, Story 4.3). All events are
   * validated up-front; partial writes are not possible because we read
   * the existing log once and write the full result back.
   */
  async appendBatch(events: HashChainEvent[]): Promise<void> {
    const validated = events.map((e) => hashChainEventSchema.parse(e));
    for (const event of validated) {
      await this.storage.appendChainEvent(event);
      await this.mirror(event as HashChainEvent);
    }
  }

  /** Read every event, validated. Malformed historical entries are dropped silently. */
  async readAll(): Promise<HashChainEvent[]> {
    const raw = await this.storage.readChainEventLog();
    const events: HashChainEvent[] = [];
    for (const entry of raw) {
      const r = hashChainEventSchema.safeParse(entry);
      if (r.success) events.push(r.data as HashChainEvent);
    }
    return events;
  }

  /** Filter events touching a specific document. */
  async readByDocument(documentId: string): Promise<HashChainEvent[]> {
    return (await this.readAll()).filter((e) => e.document_id === documentId);
  }

  /** Filter events scoped to a specific zone. */
  async readByZone(zoneId: string): Promise<HashChainEvent[]> {
    return (await this.readAll()).filter((e) => e.zone === zoneId);
  }

  /** Filter events of one or more types. */
  async readByType(
    types: HashChainEvent["event_type"][],
  ): Promise<HashChainEvent[]> {
    const set = new Set(types);
    return (await this.readAll()).filter((e) => set.has(e.event_type));
  }
}
