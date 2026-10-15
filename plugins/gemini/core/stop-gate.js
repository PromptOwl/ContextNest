#!/usr/bin/env node

/**
 * Antigravity Stop Hook Adapter for ContextNest
 *
 * Runs when the execution loop terminates. Evaluates whether knowledge,
 * decisions, or bug resolutions occurred during the turn that meet the capture
 * ladder. Parks the job in the ledger so the next prompt can dispatch it.
 */

import {
  getConfig,
  makeExec,
  readStdin,
  safeJson,
} from './lib.js';
import { run as captureGateRun } from './capture-gate.js';

async function main() {
  try {
    const raw = await readStdin();
    const input = raw ? safeJson(raw, {}) : {};
    const env = process.env;
    const config = getConfig(env);
    const cwd = (input.workspacePaths && input.workspacePaths[0]) || process.cwd();
    const exec = makeExec(config, { cwd, env });

    captureGateRun({
      input: {
        transcriptPath: input.transcriptPath,
        conversationId: input.conversationId,
      },
      env,
      exec,
    });

    // Stop hook output — allow stopping unless explicit block is needed
    process.stdout.write(JSON.stringify({}));
  } catch (err) {
    process.stderr.write(`[contextnest-antigravity] stop-gate error: ${err?.message || err}\n`);
    process.stdout.write(JSON.stringify({}));
  }
}

main();
