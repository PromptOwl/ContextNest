/**
 * Tests for the deprecated `sync.promptowl_data_room_id` → canonical
 * `sync.external_workspace_id` alias collapse in `parseConfig`.
 */

import { describe, it, expect } from "vitest";
import { parseConfig } from "../index.js";

describe("parseConfig — sync.external_workspace_id alias", () => {
  it("returns the canonical field as-is", () => {
    const config = parseConfig(`
version: 1
name: Vault
sync:
  external_workspace_id: ws_canonical
`);
    expect(config.sync?.external_workspace_id).toBe("ws_canonical");
    expect(config.sync?.promptowl_data_room_id).toBeUndefined();
  });

  it("copies the deprecated alias into the canonical field", () => {
    const config = parseConfig(`
version: 1
name: Vault
sync:
  promptowl_data_room_id: ws_legacy
`);
    expect(config.sync?.external_workspace_id).toBe("ws_legacy");
    expect(config.sync?.promptowl_data_room_id).toBe("ws_legacy");
  });

  it("prefers the canonical field when both are present", () => {
    const config = parseConfig(`
version: 1
name: Vault
sync:
  external_workspace_id: ws_new
  promptowl_data_room_id: ws_old
`);
    expect(config.sync?.external_workspace_id).toBe("ws_new");
  });

  it("leaves sync absent when neither key is set", () => {
    const config = parseConfig(`
version: 1
name: Vault
`);
    expect(config.sync).toBeUndefined();
  });
});
