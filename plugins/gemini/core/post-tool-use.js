#!/usr/bin/env node

/**
 * Antigravity PostToolUse Hook Adapter for ContextNest
 *
 * Runs after run_command tool executes. If the command modified or updated a vault node
 * (e.g. `ctx update`), runs sweep-check.js to detect any references in other vaults
 * still holding the stale fact and alerts the agent.
 */

import {
  getConfig,
  makeExec,
  readStdin,
  safeJson,
} from './lib.js';
import { run as sweepCheckRun } from './sweep-check.js';

async function main() {
  try {
    const raw = await readStdin();
    const input = raw ? safeJson(raw, {}) : {};
    const toolCall = input.toolCall;

    if (toolCall && toolCall.name === 'run_command') {
      const command = toolCall.args?.CommandLine || '';
      if (command.includes('ctx update') || command.includes('contextnest update')) {
        const env = process.env;
        const config = getConfig(env);
        const cwd = (input.workspacePaths && input.workspacePaths[0]) || process.cwd();
        const exec = makeExec(config, { cwd, env });

        sweepCheckRun({
          input: { command },
          env,
          exec,
        });
      }
    }

    // Antigravity PostToolUse expects empty JSON on stdout
    process.stdout.write(JSON.stringify({}));
  } catch (err) {
    process.stderr.write(`[contextnest-antigravity] post-tool-use error: ${err?.message || err}\n`);
    process.stdout.write(JSON.stringify({}));
  }
}

main();
