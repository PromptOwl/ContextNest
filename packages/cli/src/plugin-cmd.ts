/**
 * `ctx plugin` — Nest Plugins against a local vault.
 *
 *   ctx plugin add <package|path>      validate + record a plugin
 *   ctx plugin list [--json]           what's installed, settings (secrets masked)
 *   ctx plugin set <name> k=v …        settings; `x-secret` keys go to the secure credential
 *                                      store (never plugins.yaml); an env var
 *                                      CONTEXTNEST_PLUGIN_<NAME>_<KEY> always wins
 *   ctx plugin remove <name> --yes     forget the plugin (nodes stay)
 *   ctx plugin pull <name>             run pull() → upsert nodes; cursor advances on a clean run
 *   ctx plugin search <text>           federated: vault hits (governed) + live plugin hits
 *   ctx plugin promote <name> <id>     fetchOne() → upsert
 *
 * State lives in `.context/plugins.yaml` (secrets excepted — see
 * plugin-secrets.ts). The engine stores nothing itself —
 * settings are passed per call — so this file is the CLI's whole contribution:
 * an operator-owned record of which plugins run here, with what, since when.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import yaml from "js-yaml";
import type { Command } from "commander";
import chalk from "./color.js";
import { createEngineApi, type OperationContext } from "@promptowl/contextnest-engine/api";
import { NestStorage } from "@promptowl/contextnest-engine";
import { createPluginHost, loadPlugins, trimSlashes, type Distiller } from "@promptowl/contextnest-engine/plugins";
import { secretKeys, type NestPlugin } from "@promptowl/contextnest-plugin-sdk";
import { confirmOrExit } from "./safety.js";
import { PluginSecretStore, pluginEnvKey, resolvePluginSettings, splitSecretSettings } from "./plugin-secrets.js";

interface PluginEntry {
  package: string;
  /** Secret setting names, copied from the manifest at add time so `list`
   *  can mask them even when the module no longer loads. */
  secrets?: string[];
  settings?: Record<string, unknown>;
  /** Names (never values) of the secrets held in the secure store. */
  stored_secrets?: string[];
  cursor?: unknown;
  mode?: "raw" | "summary";
  folder?: string;
  last_run_at?: string;
  last_status?: string;
}
interface PluginsFile {
  version: 1;
  plugins: Record<string, PluginEntry>;
}

export interface PluginCmdDeps {
  getVaultRoot(): string;
  opContext(root: string): OperationContext;
  client(): Record<string, unknown> | undefined;
}

const FILE = path.join(".context", "plugins.yaml");
const mask = (v: unknown) => (typeof v === "string" && v.length > 4 ? `••••${v.slice(-4)}` : "••••");

function readFile(root: string): PluginsFile {
  const p = path.join(root, FILE);
  if (!fs.existsSync(p)) return { version: 1, plugins: {} };
  const raw = yaml.load(fs.readFileSync(p, "utf-8")) as Partial<PluginsFile> | null;
  return { version: 1, plugins: raw?.plugins ?? {} };
}
function writeFile(root: string, data: PluginsFile): void {
  const p = path.join(root, FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, yaml.dump(data, { lineWidth: 120 }), { mode: 0o600 });
  // `mode` on writeFileSync applies only when the file is created; an existing
  // file keeps its bits, so re-assert them (no-op on Windows).
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* windows */
  }
  // No lock on this bookkeeping file: two concurrent `ctx plugin pull`s on one
  // vault can race each other's cursor write. Node writes themselves go
  // through the engine's vault lock; this is accepted for a single-operator CLI.
}

/** Resolve a package name from the vault (then cwd), or a path relative to the vault. */
function resolveSpec(root: string, spec: string): string {
  if (spec.startsWith(".") || path.isAbsolute(spec)) return pathToFileURL(path.resolve(root, spec)).href;
  for (const base of [root, process.cwd()]) {
    try {
      return pathToFileURL(createRequire(path.join(base, "package.json")).resolve(spec)).href;
    } catch {
      /* try next */
    }
  }
  return spec; // let import() try the global resolution and report
}

async function loadOne(root: string, spec: string): Promise<NestPlugin> {
  const { plugins, errors } = await loadPlugins([spec], (s) => import(resolveSpec(root, s)));
  if (errors.length) throw new Error(`${spec}: ${errors[0].error}`);
  return plugins[0];
}

async function loadAll(root: string, file: PluginsFile): Promise<{ plugins: NestPlugin[]; errors: string[] }> {
  const plugins: NestPlugin[] = [];
  const errors: string[] = [];
  for (const [name, entry] of Object.entries(file.plugins)) {
    try {
      const p = await loadOne(root, entry.package);
      if (p.manifest.name !== name) throw new Error(`package now reports name "${p.manifest.name}", recorded as "${name}"`);
      plugins.push(p);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { plugins, errors };
}

const secrets = new PluginSecretStore();

/** Plain settings < secure-store secrets < env (CONTEXTNEST_PLUGIN_<NAME>_<KEY>). */
async function resolveSettings(root: string, plugin: NestPlugin, entry: PluginEntry): Promise<Record<string, unknown>> {
  const name = plugin.manifest.name;
  const stored = entry.stored_secrets?.length ? await secrets.load(root, name) : {};
  return resolvePluginSettings(name, Object.keys(plugin.manifest.settings.properties ?? {}), entry.settings ?? {}, stored);
}

/**
 * Move plaintext secrets an older ctx wrote into plugins.yaml to the secure
 * store. Returns true when the entry changed (caller writes the file). With no
 * secure store they stay where they are — still read, with a warning.
 */
async function migrateLegacySecrets(root: string, plugin: NestPlugin, entry: PluginEntry): Promise<boolean> {
  const isSecret = secretNamesFor(plugin, entry);
  const { plain, secret } = splitSecretSettings(entry.settings ?? {}, isSecret);
  if (Object.keys(secret).length === 0) return false;
  const name = plugin.manifest.name;
  if (!(await secrets.available())) {
    console.error(
      chalk.yellow(
        `! ${name}: ${Object.keys(secret).join(", ")} still stored in plaintext in ${FILE}; no secure store to move ${Object.keys(secret).length === 1 ? "it" : "them"} to. ` +
          `Use ${Object.keys(secret).map((k) => pluginEnvKey(name, k)).join(", ")} instead.`,
      ),
    );
    return false;
  }
  const where = await secrets.save(root, name, secret);
  entry.settings = plain;
  entry.stored_secrets = [...new Set([...(entry.stored_secrets ?? []), ...Object.keys(secret)])].sort();
  console.error(chalk.dim(`  moved ${Object.keys(secret).join(", ")} for ${name} from ${FILE} to ${where}`));
  return true;
}

/**
 * Summary mode needs an LLM. The CLI has none of its own; point
 * CONTEXTNEST_DISTILL_URL at any endpoint that accepts
 * `POST {body, kind, instructions}` and returns `{summary}` (or plain text).
 */
function distillerFromEnv(): Distiller | undefined {
  const url = process.env.CONTEXTNEST_DISTILL_URL;
  if (!url) return undefined;
  const token = process.env.CONTEXTNEST_DISTILL_TOKEN;
  return async (input) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(input),
      // An LLM call that hangs must not hang `ctx plugin pull` forever.
      signal: AbortSignal.timeout(Number(process.env.CONTEXTNEST_DISTILL_TIMEOUT_MS) || 120_000),
    });
    if (!res.ok) throw new Error(`distill endpoint returned HTTP ${res.status}`);
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return typeof j === "string" ? j : String(j.summary ?? j.text ?? text);
    } catch {
      return text;
    }
  };
}

/**
 * Where plugin nodes go. A structured vault discovers documents under
 * `nodes/`, so the folder is rooted there unless the operator already said so;
 * a flat (Obsidian-style) vault takes the folder as given. No folder → the
 * host's default (`inbox/<plugin>`), rooted the same way.
 */
async function targetFolder(root: string, folder: string | undefined, pluginName: string): Promise<string> {
  const layout = await new NestStorage(root).detectLayout();
  const f = trimSlashes(folder ?? `inbox/${pluginName}`);
  return layout === "structured" && !/^nodes(\/|$)/.test(f) ? `nodes/${f}` : f;
}

/** Names that are credentials by convention — masked when no manifest can say. */
const LOOKS_SECRET = /(token|secret|password|passwd|credential|api[-_]?key|private[-_]?key|auth)/i;

/** Setting names to mask for an entry: the manifest if it loaded, else what
 *  `add` recorded, else the credential-shaped names — never nothing. */
function secretNamesFor(plugin: NestPlugin | undefined, entry: PluginEntry): (key: string) => boolean {
  if (plugin) { const s = new Set(secretKeys(plugin.manifest)); return (k) => s.has(k); }
  if (entry.secrets) { const s = new Set(entry.secrets); return (k) => s.has(k) || LOOKS_SECRET.test(k); }
  return (k) => LOOKS_SECRET.test(k);
}

/** key=value pairs, coerced by the setting's declared type: a field declared
 *  boolean / integer / number parses; a string field — or one the schema
 *  doesn't name — keeps "12345" / "true" as text, so numeric ids and PATs
 *  survive. */
function parseKv(pairs: string[], schema: { properties?: Record<string, { type?: string }> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0) throw new Error(`expected key=value, got "${p}"`);
    const k = p.slice(0, i);
    const raw = p.slice(i + 1);
    const type = schema.properties?.[k]?.type;
    if (type === "boolean") {
      if (raw !== "true" && raw !== "false") throw new Error(`${k} must be true or false`);
      out[k] = raw === "true";
    } else if (type === "integer" || type === "number") {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error(`${k} must be a number`);
      out[k] = Number(raw);
    } else out[k] = raw;
  }
  return out;
}

export function registerPluginCommands(program: Command, deps: PluginCmdDeps): void {
  const cmd = program.command("plugin").description("Nest Plugins — connect outside sources (GitHub, Gong, Slack, email…) to this vault");

  cmd
    .command("add <package>")
    .description("Validate a plugin package (name or path) and record it for this vault")
    .action(async (spec: string) => {
      const root = deps.getVaultRoot();
      const plugin = await loadOne(root, spec);
      const file = readFile(root);
      const name = plugin.manifest.name;
      if (file.plugins[name] && file.plugins[name].package !== spec) {
        await confirmOrExit(`Plugin "${name}" is already recorded from ${file.plugins[name].package}. Replace with ${spec}?`);
      }
      file.plugins[name] = { ...(file.plugins[name] ?? {}), package: spec, secrets: secretKeys(plugin.manifest) };
      writeFile(root, file);
      console.log(`${chalk.green("✓")} ${chalk.bold(name)} v${plugin.manifest.version} — ${plugin.manifest.description}`);
      console.log(chalk.dim(`  faces: ${plugin.manifest.capabilities.join(", ")}`));
      const req = ((plugin.manifest.settings as { required?: string[] }).required ?? []).join(", ");
      const secretNames = secretKeys(plugin.manifest);
      console.log(chalk.dim(`  configure: ctx plugin set ${name} ${req ? req.split(", ").map((k) => `${k}=…`).join(" ") : "key=value"}`));
      if (secretNames.length) console.log(chalk.dim(`  secrets (${secretNames.join(", ")}) are kept in the secure credential store; ${secretNames.map((k) => pluginEnvKey(name, k)).join(", ")} override${secretNames.length === 1 ? "s" : ""} them`));
    });

  cmd
    .command("list")
    .description("List the plugins recorded for this vault")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const root = deps.getVaultRoot();
      const file = readFile(root);
      const { plugins, errors } = await loadAll(root, file);
      const rows = Object.entries(file.plugins).map(([name, entry]) => {
        const p = plugins.find((x) => x.manifest.name === name);
        const isSecret = secretNamesFor(p, entry);
        const settings: Record<string, unknown> = Object.fromEntries(Object.entries(entry.settings ?? {}).map(([k, v]) => [k, isSecret(k) ? mask(v) : v]));
        for (const k of entry.stored_secrets ?? []) settings[k] = "•••• (secure store)";
        return { name, package: entry.package, version: p?.manifest.version, capabilities: p?.manifest.capabilities, mode: entry.mode ?? "raw", folder: entry.folder, settings, cursor: entry.cursor, last_run_at: entry.last_run_at, last_status: entry.last_status, error: errors.find((e) => e.startsWith(`${name}:`)) };
      });
      if (opts.json) {
        console.log(JSON.stringify({ plugins: rows }, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.dim(`No plugins. Add one with: ${chalk.yellow("ctx plugin add <package>")}`));
        return;
      }
      for (const r of rows) {
        console.log(`${chalk.bold(r.name)} ${r.version ? chalk.dim(`v${r.version}`) : ""} ${r.error ? chalk.red(`✗ ${r.error}`) : chalk.dim(`[${(r.capabilities ?? []).join(", ")}]`)}`);
        console.log(chalk.dim(`  package: ${r.package}  mode: ${r.mode}${r.folder ? `  folder: ${r.folder}` : ""}${r.last_run_at ? `  last run: ${r.last_run_at} (${r.last_status})` : ""}`));
        const s = Object.entries(r.settings);
        if (s.length) console.log(chalk.dim(`  settings: ${s.map(([k, v]) => `${k}=${String(v)}`).join("  ")}`));
      }
    });

  cmd
    .command("set <name> [pairs...]")
    .description("Set plugin settings as key=value pairs; --mode and --folder set run options")
    .option("--mode <mode>", "raw | summary")
    .option("--folder <folder>", "Folder prefix for nodes this plugin writes")
    .action(async (name: string, pairs: string[], opts: { mode?: string; folder?: string }) => {
      const root = deps.getVaultRoot();
      const file = readFile(root);
      const entry = file.plugins[name];
      if (!entry) throw new Error(`No plugin "${name}" — add it first: ctx plugin add <package>`);
      const plugin = await loadOne(root, entry.package);
      const kv = parseKv(pairs, plugin.manifest.settings as { properties?: Record<string, { type?: string }> });
      const isSecret = secretNamesFor(plugin, entry);
      const { plain, secret } = splitSecretSettings(kv, isSecret);
      const nextPlain = { ...(entry.settings ?? {}), ...plain };
      const stored = entry.stored_secrets?.length ? await secrets.load(root, name) : {};
      if (plugin.validateSettings) {
        const keys = Object.keys(plugin.manifest.settings.properties ?? {});
        await plugin.validateSettings(resolvePluginSettings(name, keys, nextPlain, { ...stored, ...secret }));
      }
      // Secrets first: if there is no secure store this throws before anything is written.
      if (Object.keys(secret).length) {
        const where = await secrets.save(root, name, secret);
        entry.stored_secrets = [...new Set([...(entry.stored_secrets ?? []), ...Object.keys(secret)])].sort();
        console.log(chalk.dim(`  ${Object.keys(secret).join(", ")} → ${where}`));
      }
      entry.settings = nextPlain;
      await migrateLegacySecrets(root, plugin, entry);
      if (opts.mode) {
        if (opts.mode !== "raw" && opts.mode !== "summary") throw new Error("--mode must be raw or summary");
        entry.mode = opts.mode;
      }
      if (opts.folder !== undefined) entry.folder = opts.folder;
      entry.secrets = secretKeys(plugin.manifest);
      writeFile(root, file);
      console.log(`${chalk.green("✓")} ${name}: ${Object.keys(kv).join(", ") || "options"} saved`);
    });

  cmd
    .command("remove <name>")
    .description("Forget a plugin (its nodes stay in the vault)")
    .action(async (name: string) => {
      const root = deps.getVaultRoot();
      const file = readFile(root);
      if (!file.plugins[name]) throw new Error(`No plugin "${name}"`);
      await confirmOrExit(`Remove plugin "${name}" from this vault? Its settings and cursor are forgotten; nodes stay.`, { destructive: true });
      delete file.plugins[name];
      writeFile(root, file);
      try {
        await secrets.clear(root, name);
      } catch (e) {
        console.error(chalk.yellow(`! ${name}: could not clear its stored secrets: ${(e as Error).message}`));
      }
      console.log(`${chalk.green("✓")} removed ${name}`);
    });

  cmd
    .command("pull <name>")
    .description("Run the plugin's pull() and upsert what it returns into this vault")
    .option("--mode <mode>", "raw | summary (overrides the stored mode)")
    .option("--folder <folder>", "Folder prefix (overrides the stored folder)")
    .option("--reset", "Ignore the stored cursor and pull from the beginning")
    .option("--json", "Output as JSON")
    .action(async (name: string, opts: { mode?: string; folder?: string; reset?: boolean; json?: boolean }) => {
      const root = deps.getVaultRoot();
      const file = readFile(root);
      const entry = file.plugins[name];
      if (!entry) throw new Error(`No plugin "${name}" — add it first: ctx plugin add <package>`);
      const plugin = await loadOne(root, entry.package);
      if (await migrateLegacySecrets(root, plugin, entry)) writeFile(root, file);
      const host = createPluginHost({ plugins: [plugin], distill: distillerFromEnv(), log: (l, m) => l !== "debug" && console.error(chalk.dim(`[${l}] ${m}`)) });
      const api = createEngineApi({ extensions: [host.extension] });
      const mode = (opts.mode ?? entry.mode ?? "raw") as "raw" | "summary";
      const input: Record<string, unknown> = {
        plugin: name,
        settings: await resolveSettings(root, plugin, entry),
        cursor: opts.reset ? undefined : entry.cursor,
        mode,
        target: { folder: await targetFolder(root, opts.folder ?? entry.folder, name) },
        ...(deps.client() ? { client: deps.client() } : {}),
      };
      const result = await api.run<{ created: number; updated: number; unchanged: number; conflicts: Array<{ externalId: string; id: string }>; failed: Array<{ externalId: string; error: string }>; clean: boolean; nextCursor?: unknown; results: unknown[] }>("context_ingest", input, deps.opContext(root));
      if (result.clean && result.nextCursor !== undefined) entry.cursor = result.nextCursor;
      entry.last_run_at = new Date().toISOString();
      entry.last_status = result.clean ? "clean" : result.failed.length ? "failed" : "conflicts";
      writeFile(root, file);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`${result.clean ? chalk.green("✓") : chalk.yellow("!")} ${name}: ${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged${result.conflicts.length ? `, ${chalk.yellow(`${result.conflicts.length} kept (local edits)`)}` : ""}${result.failed.length ? `, ${chalk.red(`${result.failed.length} failed`)}` : ""}`);
      for (const c of result.conflicts) console.log(chalk.yellow(`  kept ${c.id} — edited locally since the last pull; delete it to let the plugin recreate it`));
      for (const f of result.failed) console.log(chalk.red(`  ${f.externalId}: ${f.error}`));
      if (!result.clean) console.log(chalk.dim("  cursor not advanced — the next pull retries these"));
    });

  cmd
    .command("search <text>")
    .description("Search this vault and every plugin with a search() face; live hits are ungoverned until promoted")
    .option("--plugin <name>", "Only this plugin")
    .option("--limit <n>", "Max hits per source", "10")
    .option("--no-nest", "Skip vault hits")
    .option("--json", "Output as JSON")
    .action(async (text: string, opts: { plugin?: string; limit: string; nest: boolean; json?: boolean }) => {
      const root = deps.getVaultRoot();
      const file = readFile(root);
      const { plugins, errors } = await loadAll(root, file);
      const host = createPluginHost({ plugins });
      const api = createEngineApi({ extensions: [host.extension] });
      const targets = await Promise.all(
        plugins
          .filter((p) => p.search && (!opts.plugin || p.manifest.name === opts.plugin))
          .map(async (p) => ({ plugin: p.manifest.name, settings: await resolveSettings(root, p, file.plugins[p.manifest.name]) })),
      );
      const result = await api.run<{ nest: Array<{ id: string; title: string; score?: number }>; live: Array<{ plugin: string; hits: Array<{ title: string; snippet: string; externalId: string; url?: string }> }>; errors: Array<{ plugin: string; error: string }> }>(
        "context_search_federated",
        { text, limit: Number(opts.limit), include_nest: opts.nest, plugins: targets, ...(deps.client() ? { client: deps.client() } : {}) },
        deps.opContext(root),
      );
      for (const e of errors) result.errors.push({ plugin: e.split(":")[0], error: e });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (opts.nest) {
        console.log(chalk.bold(`Vault (governed) — ${result.nest.length}`));
        for (const h of result.nest) console.log(`  ${h.id}  ${chalk.dim(h.title)}`);
      }
      for (const src of result.live) {
        console.log(chalk.bold(`\n${src.plugin} (live · not governed) — ${src.hits.length}`));
        for (const h of src.hits) console.log(`  ${h.externalId}  ${h.title}  ${chalk.dim(h.snippet.slice(0, 80))}\n    ${chalk.dim(`promote: ctx plugin promote ${src.plugin} ${h.externalId}`)}`);
      }
      for (const e of result.errors) console.log(chalk.red(`\n${e.plugin}: ${e.error}`));
    });

  cmd
    .command("promote <name> <externalId>")
    .description("Fetch one live hit from a plugin and land it in this vault")
    .option("--mode <mode>", "raw | summary")
    .option("--json", "Output as JSON")
    .action(async (name: string, externalId: string, opts: { mode?: string; json?: boolean }) => {
      const root = deps.getVaultRoot();
      const file = readFile(root);
      const entry = file.plugins[name];
      if (!entry) throw new Error(`No plugin "${name}"`);
      const plugin = await loadOne(root, entry.package);
      if (await migrateLegacySecrets(root, plugin, entry)) writeFile(root, file);
      const host = createPluginHost({ plugins: [plugin], distill: distillerFromEnv() });
      const api = createEngineApi({ extensions: [host.extension] });
      const result = await api.run<{ id: string; outcome: string }>(
        "context_promote",
        { plugin: name, settings: await resolveSettings(root, plugin, entry), externalId, mode: opts.mode ?? entry.mode ?? "raw", target: { folder: await targetFolder(root, entry.folder, name) }, ...(deps.client() ? { client: deps.client() } : {}) },
        deps.opContext(root),
      );
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`${chalk.green("✓")} ${result.outcome}: ${result.id}`);
    });
}
