/*
 * Copyright © 2026 Promptowl LLC. All rights reserved.
 * Commercial software — see packages/governance/LICENSE.md.
 * NOT covered by the repository's AGPL-3.0 license (see /NOTICE).
 */

/**
 * @promptowl/contextnest-governance — proprietary governance layer for
 * Context Nest: stewardship RBAC, user-level read/commit policy, and a
 * provenance store, packaged as an engine `GovernanceBundle` module.
 */

// Types & errors
export * from "./types.js";
export * from "./errors.js";

// Role algebra (pure)
export * from "./roles.js";

// Adapter contracts
export * from "./adapters.js";

// DB
export { openGovernanceDb, type GovernanceDb } from "./db/client.js";
export { bootstrapGovernanceSchema } from "./db/schema.js";

// Deployment-level access control (access.yaml)
export * from "./access-service.js";

// Nest-level permission resolution
export * from "./access.js";

// Stewardship services + permission checks
export * from "./stewardship-service.js";

// Read gating
export * from "./access-guard.js";

// Activity trace
export * from "./trace-log.js";

// Admin / seeding API
export * from "./admin.js";

// Engine bridge (GovernanceBundle factory)
export {
  createGovernance,
  buildGovernanceHooks,
  buildProvenanceRecorder,
  GOVERNANCE_DB_ENV,
  GOVERNANCE_NEST_ID_ENV,
} from "./engine-governance.js";
export { default } from "./engine-governance.js";
