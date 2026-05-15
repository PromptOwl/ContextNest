import { describe, it, expect } from "vitest";
import {
  parseClassificationManifest,
  extractManifestFromClaudeMd,
  classifyDocument,
  detectZoneChallenge,
} from "../classification.js";
import { ConfigError } from "../errors.js";
import type {
  ClassificationManifest,
  ClassifyInput,
  FolderPattern,
} from "../classification.js";

const MANIFEST: ClassificationManifest = {
  schema_version: "1.0",
  patterns: [
    { path: "strategy/", zone: "leadership", governance: "primary" },
    { path: "standards/", zone: "enterprise", governance: "primary" },
    { path: "client/", zone: "client-default", governance: "standard" },
    { path: "client/acme/", zone: "client-acme", governance: "primary" },
    { path: "sources/", zone: "public", governance: "standard" },
  ] as FolderPattern[],
};

describe("Classification — parse + cascade + zone challenge (spec §2)", () => {
  describe("parseClassificationManifest (§2.3)", () => {
    it("accepts a valid manifest", () => {
      const parsed = parseClassificationManifest({
        schema_version: "1.0",
        patterns: [
          { path: "strategy/", zone: "leadership", governance: "primary" },
        ],
      });
      expect(parsed.schema_version).toBe("1.0");
      expect(parsed.patterns).toHaveLength(1);
    });

    it("rejects a manifest with missing schema_version", () => {
      expect(() =>
        parseClassificationManifest({ patterns: [] }),
      ).toThrow(ConfigError);
    });

    it("rejects a folder pattern without a trailing slash", () => {
      expect(() =>
        parseClassificationManifest({
          schema_version: "1.0",
          patterns: [
            { path: "strategy", zone: "leadership", governance: "primary" },
          ],
        }),
      ).toThrow(ConfigError);
    });

    it("rejects an invalid zone ID", () => {
      expect(() =>
        parseClassificationManifest({
          schema_version: "1.0",
          patterns: [
            { path: "strategy/", zone: "Leadership!", governance: "primary" },
          ],
        }),
      ).toThrow(ConfigError);
    });

    it("rejects an unknown governance tier", () => {
      expect(() =>
        parseClassificationManifest({
          schema_version: "1.0",
          patterns: [
            { path: "strategy/", zone: "leadership", governance: "boss" },
          ],
        }),
      ).toThrow(ConfigError);
    });
  });

  describe("extractManifestFromClaudeMd (§2.3)", () => {
    it("extracts a fenced YAML manifest block", () => {
      const claudeMd = `
# Some Project

\`\`\`yaml
classification_manifest:
  schema_version: "1.0"
  patterns:
    - path: "strategy/"
      zone: "leadership"
      governance: "primary"
    - path: "client/acme/"
      zone: "client-acme"
      governance: "primary"
\`\`\`

More content.
`;
      const manifest = extractManifestFromClaudeMd(claudeMd);
      expect(manifest).not.toBeNull();
      expect(manifest?.schema_version).toBe("1.0");
      expect(manifest?.patterns).toHaveLength(2);
    });

    it("returns null when CLAUDE.md has no manifest block", () => {
      expect(extractManifestFromClaudeMd("just some markdown")).toBeNull();
    });

    it("returns null when CLAUDE.md has unrelated YAML fences", () => {
      const claudeMd = "```yaml\nsomeOtherKey: value\n```\n";
      expect(extractManifestFromClaudeMd(claudeMd)).toBeNull();
    });

    it("throws on a malformed manifest inside the fenced block", () => {
      const claudeMd = `\`\`\`yaml
classification_manifest:
  schema_version: "1.0"
  patterns:
    - path: "strategy"
      zone: "leadership"
      governance: "primary"
\`\`\`
`;
      expect(() => extractManifestFromClaudeMd(claudeMd)).toThrow(ConfigError);
    });
  });

  describe("classifyDocument cascade (§2.1)", () => {
    const base = (
      overrides: Partial<ClassifyInput> = {},
    ): ClassifyInput => ({
      documentPath: "strategy/q4-plan.md",
      frontmatter: { title: "Q4 plan" },
      manifest: MANIFEST,
      defaultZone: "enterprise",
      ...overrides,
    });

    it("L1: returns folder-pattern result when no metadata is set", () => {
      const r = classifyDocument(base());
      expect(r).toEqual({
        zone: "leadership",
        governance: "primary",
        level: 1,
        unconfirmed: false,
      });
    });

    it("L1: longest folder prefix wins (nested client/acme over client/)", () => {
      const r = classifyDocument(
        base({ documentPath: "client/acme/discovery.md" }),
      );
      expect(r.zone).toBe("client-acme");
      expect(r.governance).toBe("primary");
      expect(r.level).toBe(1);
    });

    it("L1: less-specific prefix used when a deeper one does not match", () => {
      const r = classifyDocument(
        base({ documentPath: "client/medtech/notes.md" }),
      );
      expect(r.zone).toBe("client-default");
      expect(r.governance).toBe("standard");
    });

    it("L2: metadata-declared zone overrides folder (§2.1 Level 2)", () => {
      const r = classifyDocument(
        base({
          documentPath: "strategy/exception.md",
          frontmatter: { title: "Override", zone: "client-acme" },
        }),
      );
      expect(r.zone).toBe("client-acme");
      expect(r.governance).toBe("primary"); // folder match supplies missing tier
      expect(r.level).toBe(2);
    });

    it("L2: metadata-only governance overrides folder governance", () => {
      const r = classifyDocument(
        base({
          documentPath: "strategy/note.md",
          frontmatter: { title: "Note", governance: "standard" },
        }),
      );
      expect(r.zone).toBe("leadership"); // folder zone preserved
      expect(r.governance).toBe("standard"); // metadata wins
      expect(r.level).toBe(2);
    });

    it("L2: both zone + governance from metadata used together", () => {
      const r = classifyDocument(
        base({
          documentPath: "strategy/x.md",
          frontmatter: {
            title: "X",
            zone: "client-medtech",
            governance: "standard",
          },
        }),
      );
      expect(r.zone).toBe("client-medtech");
      expect(r.governance).toBe("standard");
    });

    it("L3: no folder match + no metadata → defaultZone, unconfirmed=true", () => {
      const r = classifyDocument(
        base({ documentPath: "misc/orphan.md" }),
      );
      expect(r.zone).toBe("enterprise");
      expect(r.governance).toBe("standard");
      expect(r.level).toBe(3);
      expect(r.unconfirmed).toBe(true);
    });

    it("L3: PII signal maps to its mapped zone (§2.1 Level 3)", () => {
      const r = classifyDocument(
        base({
          documentPath: "misc/orphan.md",
          contentSignals: ["pii"],
          signalZoneMap: { pii: "enterprise" },
        }),
      );
      expect(r.zone).toBe("enterprise");
      expect(r.level).toBe(3);
      expect(r.unconfirmed).toBe(true);
    });

    it("L3: PII outranks public-facing in the signal priority order", () => {
      const r = classifyDocument(
        base({
          documentPath: "misc/orphan.md",
          contentSignals: ["public-facing", "pii"],
          signalZoneMap: { pii: "enterprise", "public-facing": "public" },
        }),
      );
      // PII is more restrictive — must win.
      expect(r.zone).toBe("enterprise");
    });

    it("L3: public-facing signal maps to public zone when no PII signal", () => {
      const r = classifyDocument(
        base({
          documentPath: "misc/orphan.md",
          contentSignals: ["public-facing"],
          signalZoneMap: { "public-facing": "public" },
        }),
      );
      expect(r.zone).toBe("public");
    });

    it("L3: signals with no zone mapping fall back to defaultZone", () => {
      const r = classifyDocument(
        base({
          documentPath: "misc/orphan.md",
          contentSignals: ["client-identifying"],
          // Spec §2.1: "client-identifying → prompt user to assign a Client
          // zone" — engine cannot pick; falls through to default.
          signalZoneMap: {},
        }),
      );
      expect(r.zone).toBe("enterprise");
      expect(r.unconfirmed).toBe(true);
    });
  });

  describe("detectZoneChallenge (§2.4)", () => {
    it("raises a challenge when metadata zone contradicts folder zone (Story 2.1)", () => {
      // Analyst embeds `zone: public` but file lives in `client/acme/`.
      const challenge = detectZoneChallenge({
        documentId: "client/acme/discovery",
        documentPath: "client/acme/discovery.md",
        frontmatter: { title: "Discovery", zone: "public" },
        manifest: MANIFEST,
      });
      expect(challenge).not.toBeNull();
      expect(challenge?.declaredZone).toBe("public");
      expect(challenge?.impliedZone).toBe("client-acme");
      expect(challenge?.documentId).toBe("client/acme/discovery");
      expect(challenge?.impliedGovernance).toBe("primary");
    });

    it("returns null when declared zone matches folder zone", () => {
      const c = detectZoneChallenge({
        documentId: "client/acme/discovery",
        documentPath: "client/acme/discovery.md",
        frontmatter: { title: "OK", zone: "client-acme" },
        manifest: MANIFEST,
      });
      expect(c).toBeNull();
    });

    it("returns null when frontmatter has no zone declaration", () => {
      const c = detectZoneChallenge({
        documentId: "client/acme/discovery",
        documentPath: "client/acme/discovery.md",
        frontmatter: { title: "No zone" },
        manifest: MANIFEST,
      });
      expect(c).toBeNull();
    });

    it("returns null when no folder pattern matches the document path", () => {
      const c = detectZoneChallenge({
        documentId: "misc/orphan",
        documentPath: "misc/orphan.md",
        frontmatter: { title: "Orphan", zone: "client-acme" },
        manifest: MANIFEST,
      });
      // No folder match → no implied zone → no challenge (§2.4 only applies
      // to L1-vs-L2 contradictions).
      expect(c).toBeNull();
    });

    it("classification still succeeds even when a challenge is raised (§2.4: doc remains injectable)", () => {
      const challenge = detectZoneChallenge({
        documentId: "client/acme/discovery",
        documentPath: "client/acme/discovery.md",
        frontmatter: { title: "Discovery", zone: "public" },
        manifest: MANIFEST,
      });
      expect(challenge).not.toBeNull();

      const cls = classifyDocument({
        documentPath: "client/acme/discovery.md",
        frontmatter: { title: "Discovery", zone: "public" },
        manifest: MANIFEST,
        defaultZone: "enterprise",
      });
      // Metadata wins for resolution; challenge is the separate audit
      // record. The doc is injectable from `public` while the Czar reviews.
      expect(cls.zone).toBe("public");
      expect(cls.level).toBe(2);
    });
  });
});
