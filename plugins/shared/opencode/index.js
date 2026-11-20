/**
 * Context Nest plugin for OpenCode. One default export serves both plugin APIs:
 * OpenCode 2 calls `setup(ctx)`, OpenCode 1 calls `server(input)`.
 *
 *   OpenCode 2: ~/.config/opencode/plugins/index.js → export { default } from "<this file>"
 *   OpenCode 1: opencode.json → { "plugin": ["/absolute/path/to/plugins/shared"] }
 *               (package.json "main" names this file)
 *
 * Only the default export lives here: the loader may treat any other exported
 * function as a plugin. The hooks are in adapter.js.
 */

import { getConfig, makeExec } from "../core/lib.js";
import { hooksV1, setupV2 } from "./adapter.js";

function deps(directory) {
  const cwd = directory || process.cwd();
  // getConfig reads the project settings file from CLAUDE_PROJECT_DIR.
  const env = { ...process.env, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || cwd };
  return { env, newExec: (timeout) => makeExec(getConfig(env), { cwd, env, timeout }) };
}

export default {
  id: "contextnest",
  async setup(ctx) {
    await setupV2(ctx, deps(ctx?.location?.directory));
  },
  async server({ directory } = {}) {
    return hooksV1(deps(directory));
  },
};
