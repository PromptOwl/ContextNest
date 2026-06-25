/**
 * Steward stores — single import surface for both shapes.
 */

export { BaseStewardStore } from "./base.js";

export {
  SingleUserStewardStore,
} from "./mongo-single.js";
export type {
  SingleUserStewardStoreConfig,
  AssignSingleUserStewardInput,
  UpdateSingleUserStewardInput,
  ListSingleUserStewardsInput,
} from "./mongo-single.js";

export {
  MultiUserStewardStore,
} from "./mongo-multi.js";
export type {
  MultiUserStewardStoreConfig,
  CreateMultiStewardInput,
  ResolveMultiStewardsInput,
} from "./mongo-multi.js";

export type {
  StewardRole,
  StewardshipScope,
  StewardAddedType,
  SingleUserSteward,
  MultiUserSteward,
  StewardUserEntry,
  StewardTeamEntry,
  ResolvedStewardEntry,
  ResolveStewardsInput,
} from "./types.js";
