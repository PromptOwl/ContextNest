/**
 * Detection of agentic dev tools installed on the machine.
 *
 * Context Nest can auto-generate a config file for a fixed set of agentic tools
 * (CLAUDE.md, .cursorrules, etc. — see the engine's `generateAgentConfigs`).
 * This module probes the system to guess which of those tools the user has, so
 * `ctx init` can pre-select them in the tool picker. Detection is best-effort
 * and platform-tolerant (macOS primary); a miss is recoverable because the
 * picker still lets the user check the tool. No child processes are spawned —
 * only synchronous filesystem + PATH probes — so it stays fast.
 */

import fs from "node:fs";
import os from "node:os";
import pathMod from "node:path";

/**
 * A supported agentic dev tool. `id` matches the tool tag the engine's
 * `generateAgentConfigs` uses to map it to a config file. `detected` seeds the
 * picker's initial checked state.
 */
export interface AgentTool {
  id: string;
  name: string;
  hint: string;
  detected: boolean;
}

/**
 * True if `bin` is found in any directory on the PATH. Scans PATH entries with
 * existsSync rather than spawning a process. On Windows, also probes the common
 * executable extensions.
 */
export function isOnPath(bin: string): boolean {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return false;
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of pathEnv.split(pathMod.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.existsSync(pathMod.join(dir, bin + ext))) return true;
      } catch {
        // unreadable PATH entry — ignore
      }
    }
  }
  return false;
}

/**
 * True if any directory entry inside `dir` starts with `prefix` (used to spot
 * versioned VS Code extension folders like `github.copilot-1.2.3`).
 */
export function hasDirWithPrefix(dir: string, prefix: string): boolean {
  try {
    return fs.readdirSync(dir).some((entry) => entry.startsWith(prefix));
  } catch {
    return false;
  }
}

/**
 * Inspect the machine for the agentic dev tools Context Nest can generate config
 * for, returning each with a `detected` flag.
 */
export function detectAgentTools(projectRoot: string): AgentTool[] {
  const home = os.homedir();
  const exists = (...parts: string[]): boolean => {
    try {
      return fs.existsSync(pathMod.join(...parts));
    } catch {
      return false;
    }
  };

  return [
    {
      id: "claude",
      name: "Claude Code",
      hint: "CLAUDE.md",
      detected:
        exists(home, ".claude") || isOnPath("claude") || exists(projectRoot, ".claude"),
    },
    {
      id: "cursor",
      name: "Cursor",
      hint: ".cursorrules",
      detected:
        exists("/Applications/Cursor.app") || exists(home, ".cursor") || isOnPath("cursor"),
    },
    {
      id: "windsurf",
      name: "Windsurf",
      hint: ".windsurfrules",
      detected:
        exists("/Applications/Windsurf.app") ||
        exists(home, ".codeium", "windsurf") ||
        isOnPath("windsurf"),
    },
    {
      id: "copilot",
      name: "GitHub Copilot",
      hint: ".github/copilot-instructions.md",
      detected:
        exists(home, ".config", "github-copilot") ||
        exists(home, ".local", "share", "gh", "extensions", "gh-copilot") ||
        hasDirWithPrefix(pathMod.join(home, ".vscode", "extensions"), "github.copilot"),
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      hint: "GEMINI.md",
      detected: isOnPath("gemini") || exists(home, ".gemini"),
    },
  ];
}
