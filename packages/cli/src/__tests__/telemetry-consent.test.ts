import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { telemetryConsent } from "../telemetry/index.js";
import { CLI_VERSION } from "../version.js";
import { generateWelcomeHtml } from "../welcome-html.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliPkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8")) as { version: string };

const vault = mkdtempSync(join(tmpdir(), "cn-consent-"));
mkdirSync(join(vault, ".context"), { recursive: true });
const setConfig = (extra = "") => writeFileSync(join(vault, ".context", "config.yaml"), `version: 1\nname: T\n${extra}`);
afterAll(() => rmSync(vault, { recursive: true, force: true }));

describe("telemetry consent", () => {
  it("reports the real package version, not the old hard-coded 0.3.0", () => {
    expect(CLI_VERSION).toBe(cliPkg.version);
  });

  it("is off unless config.yaml says telemetry: true", () => {
    setConfig();
    expect(telemetryConsent(vault, {})).toBe(false);
    setConfig("telemetry: true\n");
    expect(telemetryConsent(vault, {})).toBe(true);
  });

  it.each([{ DO_NOT_TRACK: "1" }, { CONTEXTNEST_TELEMETRY: "0" }])("env %o forces it off", (env) => {
    setConfig("telemetry: true\n");
    expect(telemetryConsent(vault, env)).toBe(false);
  });

  it("DO_NOT_TRACK=0 is not an opt-out", () => {
    setConfig("telemetry: true\n");
    expect(telemetryConsent(vault, { DO_NOT_TRACK: "0" })).toBe(true);
  });
});

describe("welcome.html analytics", () => {
  const render = async (analytics?: boolean) =>
    readFileSync(
      await generateWelcomeHtml({
        vaultPath: vault,
        vaultName: "v",
        starterName: null,
        starterDisplayName: null,
        nodes: [],
        timestamp: new Date().toISOString(),
        cliVersion: "0.0.0",
        analytics,
      }),
      "utf-8",
    );

  it("by default has no GA, no web fonts, no scripts: zero network requests", async () => {
    const html = await render();
    expect(html).not.toMatch(/googletagmanager|gtag\(|fonts\.googleapis|@import|<script\b|<link\b/);
  });

  it("embeds GA only when opted in", async () => {
    expect(await render(true)).toContain("googletagmanager.com/gtag/js?id=G-2CS7MD931K");
  });
});
