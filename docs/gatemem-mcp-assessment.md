# GateMem × ContextNest MCP — Feasibility Assessment

> Can an agent whose **only** capability is the ContextNest MCP server satisfy
> the [GateMem](https://github.com/rzhub/GateMem) benchmark? This document maps
> every GateMem criterion to concrete MCP/engine capabilities, and records the
> change made in this branch to close the one gap that existed.

## What GateMem measures

GateMem evaluates memory-augmented agents in **multi-principal shared-memory**
settings and scores them with the **Memory Governance Score**:

```
MGS = U * (1 - A) * (1 - F)
```

| Term | Name | Meaning |
|------|------|---------|
| `U` | Utility | Correct answers on **authorized** requests. |
| `A` | Access-control violation rate | Leakage to unauthorized / over-scoped requesters. |
| `F` | Active-forgetting failure rate | Recovery of information after an explicit deletion. |

Agents integrate by subclassing `BaseMemoryAgent` and implementing:

- `reset(episode)` — start-of-episode initialization.
- `ingest(turn)` — one call per turn. `Turn = {turn_id, speaker_principal_id, speaker_role, text, timestamp, record_refs, memory_ops}`.
- `query(checkpoint)` — at each hidden checkpoint. `Checkpoint = {checkpoint_id, asker_principal_id, asker_role, query_type, query_text, ...}`. Returns `{action, answer, answer_structured, used_record_ids}`, where `action ∈ {answer, refuse, ...}`.

Scale: 91 episodes, 2,218 hidden checkpoints, 4 domains (medical, office,
education, household).

## Criterion-by-criterion mapping

### Utility — achievable (recall caveat)

- **Store:** `ingest` → `create_document` (auto-publishes v1). Governance
  metadata rides in frontmatter.
- **Retrieve:** `query` → `search` / `resolve` / `read_document`.
- **Caveat:** search is MiniSearch keyword/fuzzy/prefix — **no embeddings /
  semantic search** (`packages/engine/src/selector/index-evaluator.ts`,
  `packages/engine/src/resolver.ts`). Index mode indexes only
  `title`/`description`/`tags` (no body); full mode (`full: true`) indexes the
  body but only for `published` docs. Paraphrased natural-language queries risk
  missed recall versus embedding-based RAG baselines. Mitigation: author strong
  `title`/`description`/`tags` per ingested turn, prefer `full: true`, and fall
  back to `list_documents` + `read_document` scans.

### Active Forgetting — achievable

- `delete_document` → `storage.deleteDocument` (`packages/engine/src/storage.ts`)
  unlinks the document **and** recursively removes its `.versions/<doc>` history.
- Nest checkpoints store only `document_chain_hashes`, **not bodies**
  (`packages/engine/src/checkpoint.ts`), so nothing is recoverable through any
  read tool (`read_document`, `read_version`, `search`, `resolve`,
  `list_documents`) after deletion.
- **Requirement:** use the hard `delete_document` path — **not** the drift /
  reject flow, which archives content under `_archive/` and would leave it
  recoverable.

### Access Control — **now enforceable by the MCP** (this branch)

**Before this change:** the read tools never accepted a per-query requester —
`actor` is *attribution only, explicitly NOT authentication* — and the RBAC /
governance module is fixed at **startup** (`CONTEXTNEST_GOVERNANCE_MODULE`,
default `allowAllGovernance`). The DB-backed proprietary governance package
(`packages/governance`) *can* gate reads, but it requires **out-of-band SQLite
seeding**, which an agent wired to nothing but the MCP cannot do. So access
control could only be *reasoned* by the LLM — the soft posture GateMem penalizes.

**After this change:** access control travels **with the document** and is
enforced **per query**, entirely through MCP tools:

1. **Writers attach an ACL.** `create_document` / `update_document` accept an
   optional `access` argument, persisted verbatim under `metadata.access`:

   ```yaml
   metadata:
     access:
       visibility: private          # "public" (default) | "private"
       readers: ["alice@clinic"]     # principal ids allowed to read
       roles: ["doctor"]             # roles allowed to read
   ```

2. **Readers present a requester.** `read_document`, `resolve`, `search`,
   `list_documents`, and `read_version` accept optional `asker` +
   `asker_role`. When supplied, the read is gated by the document's ACL,
   evaluated against that principal / role
   (`packages/mcp-server/src/acl-governance.ts`).

3. **The policy.** A document is **public** unless restricted. Restricted =
   `visibility: private` OR a non-empty `readers`/`roles` list. A restricted
   document admits an asker whose principal id is in `readers` **OR** whose role
   is in `roles`; everyone else is denied. Hard reads (`read_document`,
   `read_version`) raise `UnauthorizedActionError` (surfaced as an MCP
   `isError`); set-returning reads (`resolve`, `search`, `list_documents`)
   silently elide documents the asker cannot read.

The enforcement **layers on top of** whatever base governance is configured — it
only ever *narrows* access, never widens it (a base denial always wins). With no
`asker` supplied, behavior is byte-for-byte unchanged (legacy single-principal).

This keeps the AGPL engine identity-agnostic: the ACL is opaque `metadata` to the
engine; interpretation lives in the MCP layer's `makeAclGovernance` hook, which
plugs into the engine's existing `GovernanceHooks.canRead` seam.

## Bottom line

| Criterion | Verdict |
|-----------|---------|
| Utility (`U`) | Achievable; keyword-only search caps recall on paraphrased queries. |
| Access control (`A`) | **Enforceable by the MCP** via per-query `asker`/`asker_role` + frontmatter ACLs (this branch). |
| Active forgetting (`F`) | Achievable via `delete_document` (purges history; checkpoints hold hashes only). |

An MCP-only agent can therefore address all three GateMem axes. The dominant
residual risk to `MGS` is `U`, bounded by the lack of semantic search — a
separate potential engine feature, out of scope here.

## Using the access control (agent recipe)

- **Ingest** sensitive turns with an ACL:
  `create_document(path, title, body, access={visibility:"private", readers:[...], roles:[...]})`.
- **Answer a checkpoint** as the requester:
  `search(query, asker=<asker_principal_id>, asker_role=<asker_role>)` then
  `read_document(id, asker=..., asker_role=...)`. If nothing readable is
  returned (or a hard read is denied), the agent returns `action: "refuse"`.
- **Honor a deletion** turn with `delete_document(path)` — after which the
  content is unrecoverable through every read tool.

Reference: the ACL policy is unit- and integration-tested in
`packages/mcp-server/src/__tests__/acl-governance*.test.ts`; the
frontmatter/tool shapes are described by the `document_format` MCP tool.
