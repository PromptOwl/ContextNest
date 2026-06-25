/**
 * Configuration loading for .context/config.yaml and syntax.yml (§11).
 */

import yaml from "js-yaml";
import { nestConfigSchema } from "./schemas.js";
import type { NestConfig } from "./types.js";
import { ConfigError } from "./errors.js";

/**
 * Parse and validate .context/config.yaml content.
 *
 * Collapses the deprecated `sync.promptowl_data_room_id` alias into
 * `sync.external_workspace_id` when the canonical key is absent, so
 * downstream code only ever reads the new field.
 */
export function parseConfig(content: string): NestConfig {
  const raw = yaml.load(content);
  const result = nestConfigSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid config.yaml: ${messages.join("; ")}`);
  }
  const config = result.data as NestConfig;
  if (config.sync) {
    if (
      !config.sync.external_workspace_id &&
      config.sync.promptowl_data_room_id
    ) {
      config.sync.external_workspace_id = config.sync.promptowl_data_room_id;
    }
  }
  return config;
}

/** Syntax token configuration from syntax.yml (§11.2) */
export interface SyntaxConfig {
  tokens: {
    tag: string;
    pack_reference: string;
  };
}

const DEFAULT_SYNTAX: SyntaxConfig = {
  tokens: {
    tag: "#{{tag}}",
    pack_reference: "pack:{{pack_id}}",
  },
};

/**
 * Parse syntax.yml. Returns defaults if content is empty/undefined.
 */
export function parseSyntaxConfig(content?: string): SyntaxConfig {
  if (!content) return DEFAULT_SYNTAX;
  const raw = yaml.load(content) as Partial<SyntaxConfig>;
  return {
    tokens: {
      ...DEFAULT_SYNTAX.tokens,
      ...raw?.tokens,
    },
  };
}
