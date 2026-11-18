/**
 * A host types against the plugin contract through `@promptowl/contextnest-engine/plugins`
 * alone — Community is on zod 4 and cannot take the SDK (zod 3 peer) as a direct dependency.
 */
import { describe, it, expect } from "vitest";
import { secretKeys, validateManifest, PROCESS_MODES, type NestPlugin } from "../plugins/index.js";

describe("plugins entry re-exports the SDK contract", () => {
  it("secretKeys / validateManifest / PROCESS_MODES are usable from the engine entry", () => {
    const manifest = validateManifest({
      name: "memo",
      version: "0.0.1",
      displayName: "Memo",
      description: "t",
      capabilities: ["pull"],
      itemKinds: ["document"],
      settings: { type: "object", properties: { token: { type: "string", "x-secret": true }, prefix: { type: "string" } } },
    });
    const plugin: Pick<NestPlugin, "manifest"> = { manifest };
    expect(secretKeys(plugin.manifest)).toEqual(["token"]);
    expect(PROCESS_MODES).toContain("raw");
  });
});
