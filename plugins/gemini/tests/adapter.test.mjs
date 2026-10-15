#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coreDir = path.join(__dirname, '..', 'core');

console.log('Testing ContextNest Antigravity plugin adapters...');

// 1. Test pre-invocation adapter on startup (invocationNum: 1)
{
  const script = path.join(coreDir, 'pre-invocation.js');
  const payload = JSON.stringify({
    invocationNum: 1,
    workspacePaths: [process.cwd()],
  });

  const res = spawnSync('node', [script], { input: payload, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `pre-invocation failed: ${res.stderr}`);
  const out = JSON.parse(res.stdout || '{}');
  console.log('✔ pre-invocation adapter returned valid JSON:', Object.keys(out));
}

// 2. Test post-tool-use adapter
{
  const script = path.join(coreDir, 'post-tool-use.js');
  const payload = JSON.stringify({
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'echo "test"' },
    },
  });

  const res = spawnSync('node', [script], { input: payload, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `post-tool-use failed: ${res.stderr}`);
  const out = JSON.parse(res.stdout || '{}');
  assert.deepStrictEqual(out, {}, 'post-tool-use should output empty JSON');
  console.log('✔ post-tool-use adapter returned valid {} response');
}

// 3. Test stop-gate adapter
{
  const script = path.join(coreDir, 'stop-gate.js');
  const payload = JSON.stringify({
    executionNum: 1,
    terminationReason: 'model_stop',
  });

  const res = spawnSync('node', [script], { input: payload, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `stop-gate failed: ${res.stderr}`);
  const out = JSON.parse(res.stdout || '{}');
  assert.deepStrictEqual(out, {}, 'stop-gate should output empty JSON on default');
  console.log('✔ stop-gate adapter returned valid {} response');
}

console.log('\nAll adapter tests passed successfully!');
