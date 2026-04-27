import { describe, it, expect } from "vitest";
import {
  getDefaultMaintenanceDirective,
  getDeveloperMaintenanceDirective,
  getPersonalMaintenanceDirective,
} from "../agent-config-base.js";
import { getStarter, listStarters } from "../index.js";

describe("maintenance directives — content shape", () => {
  it("default directive is aggressive and capture-first", () => {
    const d = getDefaultMaintenanceDirective();
    expect(d).toContain("KEEPING IT USEFUL");
    expect(d).toContain("Capture aggressively");
    expect(d).toContain("Multiple nodes per session is normal");
    expect(d).toContain("Under-capture is the failure mode");
    expect(d).toContain("You do not need permission to capture");
  });

  it("developer directive emphasizes codebase-flavored capture", () => {
    const d = getDeveloperMaintenanceDirective();
    expect(d).toContain("engineering knowledge");
    expect(d).toContain("Architecture decisions");
    expect(d).toContain("Things you learned about this codebase");
    expect(d).toContain("Capture aggressively");
  });

  it("personal directive emphasizes ideas/learning over codebase", () => {
    const d = getPersonalMaintenanceDirective();
    expect(d).toContain("personal second brain");
    expect(d).toContain("Things the user is thinking about");
    expect(d).toContain("Things they learned");
    expect(d).not.toContain("codebase");
  });
});

describe("Starter.getMaintenanceDirective() wiring", () => {
  it("developer starter returns the developer directive", () => {
    const s = getStarter("developer");
    expect(s).toBeDefined();
    expect(s!.getMaintenanceDirective()).toContain("engineering knowledge");
  });

  it("personal starter returns the personal directive", () => {
    const s = getStarter("personal");
    expect(s!.getMaintenanceDirective()).toContain("personal second brain");
  });

  it("every starter has getMaintenanceDirective and returns non-empty content", () => {
    for (const s of listStarters()) {
      const d = s.getMaintenanceDirective();
      expect(typeof d).toBe("string");
      expect(d.length).toBeGreaterThan(100);
      expect(d).toContain("Maintaining This Nest");
    }
  });

  it("non-developer / non-personal starters use the default directive", () => {
    const exec = getStarter("executive");
    expect(exec!.getMaintenanceDirective()).toBe(getDefaultMaintenanceDirective());
    const team = getStarter("team");
    expect(team!.getMaintenanceDirective()).toBe(getDefaultMaintenanceDirective());
  });
});
