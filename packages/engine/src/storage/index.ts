/**
 * Storage barrel — single import surface for every backend.
 */

export {
  BaseNestStorage,
  UNSTAGED_DRIFT_SENTINEL,
} from "./base.js";
export type { LayoutMode, ReadDocumentOptions } from "./base.js";

export { NestStorage } from "./file.js";

export { MongoNestStorage } from "./mongo.js";
export type { CollectionMap, MongoStorageConfig } from "./mongo.js";

export { GcsNestStorage } from "./gcs.js";
export type { GcsStorageConfig } from "./gcs.js";
