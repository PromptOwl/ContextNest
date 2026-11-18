/**
 * plugin-secrets.ts — where `ctx plugin` keeps a plugin's `x-secret` settings.
 *
 * Secrets go to the same secure credential store as `ctx login` (#169): the OS
 * keyring, else the AES-256-GCM file store when CONTEXTNEST_CREDENTIALS_KEY is
 * set. Never `.context/plugins.yaml` — that file holds only the non-secret
 * settings and the *names* of the secrets that are stored.
 *
 * Resolution, highest first:
 *   1. CONTEXTNEST_PLUGIN_<NAME>_<KEY> (env — the fallback when no secure store
 *      exists, and the override for CI / containers)
 *   2. the secure store
 *   3. a plaintext value an older ctx left in plugins.yaml (migrated to the
 *      store on the next write; read until then so nothing breaks)
 *
 * One store entry per (vault, plugin): account `contextnest-plugin:<h>:<name>`
 * where `<h>` is a hash of the vault's real path, so two vaults using the same
 * plugin keep separate credentials and the account name does not leak paths.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import { CredentialStore, CredentialStoreError, NO_SECURE_STORE_HELP, type CredentialStoreOptions } from "./credentials.js";

export function pluginEnvKey(plugin: string, key: string): string {
  return `CONTEXTNEST_PLUGIN_${plugin.toUpperCase().replace(/-/g, "_")}_${key.toUpperCase()}`;
}

function realRoot(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

export function pluginSecretAccount(root: string, plugin: string): string {
  const h = createHash("sha256").update(realRoot(root)).digest("hex").slice(0, 16);
  return `contextnest-plugin:${h}:${plugin}`;
}

export function splitSecretSettings(
  values: Record<string, unknown>,
  isSecret: (key: string) => boolean,
): { plain: Record<string, unknown>; secret: Record<string, string> } {
  const plain: Record<string, unknown> = {};
  const secret: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (isSecret(k)) secret[k] = String(v);
    else plain[k] = v;
  }
  return { plain, secret };
}

/** Plain settings (incl. any legacy plaintext secret) < secure store < env. */
export function resolvePluginSettings(
  plugin: string,
  keys: string[],
  stored: Record<string, unknown>,
  secrets: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...stored, ...secrets };
  for (const key of keys) {
    const v = env[pluginEnvKey(plugin, key)];
    if (v !== undefined && v !== "") out[key] = v;
  }
  return out;
}

export class PluginSecretStore {
  private readonly store: CredentialStore;

  constructor(opts: CredentialStoreOptions = {}) {
    this.store = new CredentialStore(opts);
  }

  async available(): Promise<boolean> {
    return (await this.store.describe()).kind !== "none";
  }

  /** Stored secrets for the plugin in this vault; `{}` when none or no store. */
  async load(root: string, plugin: string): Promise<Record<string, string>> {
    if (!(await this.available())) return {};
    const raw = await this.store.get(pluginSecretAccount(root, plugin));
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      throw new CredentialStoreError(`Stored secrets for plugin "${plugin}" are unreadable; set them again with ctx plugin set.`);
    }
  }

  /** Merge `secrets` into what is stored. Throws (naming the env fallback) when no secure store exists. */
  async save(root: string, plugin: string, secrets: Record<string, string>): Promise<string> {
    if (!(await this.available())) {
      const envs = Object.keys(secrets).map((k) => pluginEnvKey(plugin, k));
      throw new CredentialStoreError(
        `Refusing to store ${Object.keys(secrets).join(", ")} for plugin "${plugin}" in plaintext. ` +
          `Pass ${envs.length === 1 ? "it" : "them"} by environment instead (${envs.join(", ")}), or set up a secure store.\n` +
          NO_SECURE_STORE_HELP,
      );
    }
    const next = { ...(await this.load(root, plugin)), ...secrets };
    return this.store.set(pluginSecretAccount(root, plugin), JSON.stringify(next));
  }

  /** Forget the plugin's secrets in this vault. The store has no delete, so the entry is emptied. */
  async clear(root: string, plugin: string): Promise<void> {
    if (!(await this.available())) return;
    if ((await this.store.get(pluginSecretAccount(root, plugin))) === null) return;
    await this.store.set(pluginSecretAccount(root, plugin), "{}");
  }
}
