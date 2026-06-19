/**
 * Back-compat shim. Storage code now lives under `storage/`.
 *
 * Existing imports `import { NestStorage } from "./storage.js"` continue to
 * resolve through this re-export. New consumers can import from the storage
 * barrel directly: `import { BaseNestStorage, MongoNestStorage } from "./storage/index.js"`.
 */

export { NestStorage } from "./storage/file.js";
export {
  BaseNestStorage,
  UNSTAGED_DRIFT_SENTINEL,
} from "./storage/base.js";
export type { LayoutMode, ReadDocumentOptions } from "./storage/base.js";
