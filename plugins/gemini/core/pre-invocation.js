#!/usr/bin/env node

/**
 * Antigravity PreInvocation Hook Adapter for ContextNest
 *
 * Runs before model invocation. On session start (invocationNum === 1), primes the
 * agent with vault overview + structure rules via session-start.js.
 * On every user turn, extracts the latest user prompt and runs effort-toggled
 * retrieval via retrieve.js, injecting the results as an ephemeral system message.
 */

import fs from 'node:fs';
import {
  getConfig,
  makeExec,
  readStdin,
  safeJson,
} from './lib.js';
import { run as sessionStartRun } from './session-start.js';
import { run as retrieveRun } from './retrieve.js';

function readLastUserMessage(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (item.type === 'USER_INPUT' && item.content) {
          return typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
        }
      } catch {}
    }
  } catch {}
  return '';
}

async function main() {
  try {
    const raw = await readStdin();
    const input = raw ? safeJson(raw, {}) : {};
    const env = process.env;
    const config = getConfig(env);
    const cwd = (input.workspacePaths && input.workspacePaths[0]) || process.cwd();
    const exec = makeExec(config, { cwd, env });

    const messages = [];

    // 1. Session start: prime with vault overview & structure rules
    if (input.invocationNum === 1 || !input.invocationNum) {
      const sessionOut = sessionStartRun({ env, exec });
      const text = sessionOut?.hookSpecificOutput?.additionalContext;
      if (text) {
        messages.push(text);
      }
    }

    // 2. Turn retrieval: fetch context relevant to current user prompt
    const prompt = readLastUserMessage(input.transcriptPath);
    if (prompt) {
      const retrieveOut = retrieveRun({
        input: { prompt },
        env,
        exec,
      });
      const text = retrieveOut?.hookSpecificOutput?.additionalContext;
      if (text) {
        messages.push(text);
      }
    }

    if (messages.length > 0) {
      const combined = messages.join('\n\n---\n\n');
      process.stdout.write(
        JSON.stringify({
          injectSteps: [
            {
              ephemeralMessage: combined,
            },
          ],
        })
      );
    } else {
      process.stdout.write(JSON.stringify({}));
    }
  } catch (err) {
    process.stderr.write(`[contextnest-antigravity] pre-invocation error: ${err?.message || err}\n`);
    process.stdout.write(JSON.stringify({}));
  }
}

main();
