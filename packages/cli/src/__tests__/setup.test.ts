import { describe, expect, it } from "vitest";
import { choicesToInitArgs, setupBaseUrl, waitForChoices } from "../setup.js";

const STARTERS = ["developer", "personal"];
const TOOLS = ["claude", "cursor"];
const ok = {
  name: "--encrypted",
  alias: "my-nest",
  description: "notes",
  layout: "structured",
  starter: "developer",
  tools: ["claude"],
  encrypted: false,
  setDefault: true,
};

describe("ctx setup", () => {
  it("maps choices to init args, with values that cannot pose as flags", () => {
    expect(choicesToInitArgs(ok, STARTERS, TOOLS)).toEqual([
      "--name=--encrypted",
      "--layout=structured",
      "--vault=my-nest",
      "--description=notes",
      "--starter=developer",
      "--tools=claude",
      "--set-default",
    ]);
    expect(choicesToInitArgs({ ...ok, starter: "", tools: [] }, STARTERS, TOOLS)).not.toContain("--tools=none");
    expect(choicesToInitArgs({ ...ok, tools: [] }, STARTERS, TOOLS)).toContain("--tools=none");
  });

  it("refuses bad input from the page", () => {
    for (const bad of [
      null,
      { ...ok, name: "" },
      { ...ok, name: "a\u001b[31m" },
      { ...ok, alias: "a b" },
      { ...ok, layout: "flat" },
      { ...ok, starter: "evil" },
      { ...ok, tools: ["rm"] },
      { ...ok, tools: "claude" },
    ]) {
      expect(() => choicesToInitArgs(bad, STARTERS, TOOLS)).toThrow();
    }
  });

  it("takes the page URL from CONTEXTNEST_SETUP_URL", () => {
    expect(setupBaseUrl({})).toBe("https://nest.promptowl.ai");
    expect(setupBaseUrl({ CONTEXTNEST_SETUP_URL: "http://localhost:5173/" })).toBe("http://localhost:5173");
    expect(() => setupBaseUrl({ CONTEXTNEST_SETUP_URL: "javascript:x" })).toThrow();
  });

  it("accepts the callback only with the right state, then redirects to the page", async () => {
    let pageUrl = "";
    const got = waitForChoices("https://page.test", (u) => (pageUrl = u));
    await new Promise((r) => setTimeout(r, 50));
    const p = new URL(pageUrl);
    const cb = p.searchParams.get("cb")!;
    expect(cb).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const wrong = await fetch(`${cb}?state=nope&config=${encodeURIComponent(JSON.stringify(ok))}`, { redirect: "manual" });
    expect(wrong.status).toBe(404);

    const q = new URLSearchParams({ state: p.searchParams.get("state")!, config: JSON.stringify(ok) });
    const res = await fetch(`${cb}?${q}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://page.test/setup?done=1");
    expect(await got).toEqual(ok);
  });
});
