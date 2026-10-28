/**
 * hints.ts — the persisted on/off switch for `ctx` hints (`ctx hints off|on`).
 * One plain file, `<registry>/hints.json`; CONTEXTNEST_NO_HINTS=1 overrides it per run.
 */
import fs from "node:fs";
import pathMod from "node:path";
import { getRegistryDir } from "@promptowl/contextnest-engine";

function hintsPath(): string {
  return pathMod.join(getRegistryDir(), "hints.json");
}

export function hintsDisabled(): boolean {
  try {
    return (JSON.parse(fs.readFileSync(hintsPath(), "utf-8")) as { hints?: unknown }).hints === false;
  } catch {
    return false;
  }
}

export function setHintsEnabled(enabled: boolean): void {
  fs.mkdirSync(getRegistryDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(hintsPath(), JSON.stringify({ hints: enabled }), { mode: 0o600 });
}
