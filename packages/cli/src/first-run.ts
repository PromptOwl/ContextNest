/**
 * First-run onboarding for bare `ctx`. `shouldOnboard` and the copy are pure;
 * `runOnboarding` takes every side effect as a dependency so each branch is
 * unit-tested without a terminal, a registry or a network (first-run.test.ts).
 *
 * The flow drives the real `init` and `login` commands (via `deps.run`) rather
 * than re-implementing them, so onboarding and the commands cannot drift.
 */

export const DEFAULT_SERVER = "https://nest.promptowl.ai";
// The plugin's /contextnest:setup uses the same three; plugins/__tests__ guards the match.
export const DEFAULT_ALIAS = "main";
export const DEFAULT_STARTER = "developer";

export interface OnboardingState {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** stdin and stdout are both terminals. */
  tty: boolean;
  registry: { vaults: object; remotes?: object; onboarded_at?: string; skipped_at?: string };
  /** A vault resolves for this directory (local .context/, env path, ...). */
  vaultResolves: boolean;
}

export type OnboardingDecision =
  | { action: "onboard" }
  | { action: "help"; markOnboarded: boolean; hint?: string };

/** True when `argv` is bare `ctx`: no subcommand, no flags. */
export const isBareInvocation = (argv: string[]): boolean => argv.length <= 2;

export function shouldOnboard(s: OnboardingState): OnboardingDecision {
  if (!isBareInvocation(s.argv)) return { action: "help", markOnboarded: false };
  const r = s.registry;
  const hasVault = Object.keys(r.vaults).length > 0 || Object.keys(r.remotes ?? {}).length > 0;
  const hasEnvVault = Boolean(s.env.CONTEXTNEST_VAULT || s.env.CONTEXTNEST_VAULT_PATH);
  // Existing users: a vault exists but nothing recorded it. Never welcome them.
  if (hasVault || s.vaultResolves || hasEnvVault) {
    return { action: "help", markOnboarded: !r.onboarded_at && !r.skipped_at };
  }
  if (r.onboarded_at || r.skipped_at) return { action: "help", markOnboarded: false };
  if (s.env.CI || !s.tty) {
    return { action: "help", markOnboarded: false, hint: "Run `ctx` in a terminal to get set up." };
  }
  return { action: "onboard" };
}

/** Linux without a display, or an SSH session: there is no local browser to open. */
export function isHeadless(env: NodeJS.ProcessEnv, platform: string = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/** Emoji and box art only where the terminal can show them. */
export function plainTerminal(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NO_COLOR) || env.TERM === "dumb";
}

export const NO_VAULT_LINE =
  `No notes yet. \`ctx init\` makes a private notes folder on this computer; \`ctx login ${DEFAULT_SERVER}\` puts them online.`;

export function bannerText(env: NodeJS.ProcessEnv): string {
  return [
    plainTerminal(env) ? "Welcome to Context Nest!" : "🪺 Welcome to Context Nest!",
    "",
    "Give your AI tools notes they check before they answer.",
    "Enter accepts the default. Ctrl-C quits.",
    "",
    "Where should your AI tools keep their notes?",
    "  1) On this computer   private, works offline  (recommended)",
    "  2) Online             nest.promptowl.ai, needs an account; your team can share",
    "  3) Both",
    "  4) Skip               just show me the commands",
  ].join("\n");
}

export const LATER_COMMANDS = [
  "ctx init                 a private notes folder on this computer",
  `ctx login ${DEFAULT_SERVER}   your notes online`,
];

export interface OnboardingDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  /** Ask one question; returns the default on empty input. */
  ask(question: string, defaultValue: string): Promise<string>;
  /** Run a ctx command in-process, e.g. ["init", "--starter", "developer"]. Throws on failure. */
  run(args: string[], cwd?: string): Promise<void>;
  log(line: string): void;
  /** Absolute paths whose existence blocks `ctx init` from creating a vault there. */
  exists(path: string): boolean;
  joinPath(...parts: string[]): string;
  markOnboarding(kind: "onboarded" | "skipped"): void;
  /** Agent tool ids detected on this machine, for `init --tools`. */
  detectedTools(): string[];
  /** A key for this server is already saved on this machine. */
  signedIn(server: string): Promise<boolean>;
}

export type OnboardingResult = "onboarded" | "skipped" | "failed";

export async function runOnboarding(deps: OnboardingDeps): Promise<OnboardingResult> {
  const { log } = deps;
  log(`\n${bannerText(deps.env)}\n`);
  const choice = ((await deps.ask("Choose 1-4", "1")) || "1").trim();

  if (choice === "4" || choice.toLowerCase().startsWith("s")) {
    log("\nNo problem. Whenever you're ready:");
    for (const l of LATER_COMMANDS) log(`  ${l}`);
    deps.markOnboarding("skipped");
    return "skipped";
  }

  const wantLocal = choice === "1" || choice === "3";
  const wantRemote = choice === "2" || choice === "3";
  if (!wantLocal && !wantRemote) {
    log("\nThat wasn't one of the options. Run `ctx` again to restart setup.");
    return "failed";
  }

  let registered = 0;
  // Agent tools `init` wrote config for; null when there is no local vault.
  const localTools = wantLocal ? await setupLocal(deps) : null;
  if (localTools) registered++;
  else if (wantLocal && !wantRemote) return "failed";
  if (wantRemote) {
    if (wantLocal) log("\nNow the online notes.");
    // The server is the default unless a local vault already took that role.
    if (await setupRemote(deps, !localTools)) registered++;
  }
  if (registered === 0) {
    log("\nNothing was set up. Run `ctx` again to retry, or:");
    for (const l of LATER_COMMANDS) log(`  ${l}`);
    return "failed";
  }

  deps.markOnboarding("onboarded");
  log(`\nYou're all set!\n`);
  try {
    await deps.run(["vault", "list"]);
  } catch {
    /* the summary is a courtesy; setup already succeeded */
  }
  log("\nHere's what's in your notes:");
  try {
    await deps.run(["list"]);
  } catch {
    log("  (couldn't list it just now; try `ctx list`)");
  }
  log("\nNext: `ctx search <word>` to find things, `ctx add` to save a note.");
  if (deps.detectedTools().includes("claude")) {
    // Claude Code runs in the user's repo, not in the notes folder, so the agent config
    // `init` wrote there doesn't reach it; the plugin does.
    log("Using Claude Code? Add the Context Nest plugin and it finds these notes by itself:");
    log("  /plugin marketplace add promptowl/contextnest");
    log("  /plugin install contextnest");
  } else if (localTools?.length) {
    log("Your agent is ready: `ctx init` wrote CLAUDE.md / agent config into the notes folder.");
  }
  log("See all commands any time with `ctx --help`.");
  return "onboarded";
}

/** Returns the agent tools `init` wrote config for, or null when no vault was created. */
async function setupLocal(deps: OnboardingDeps): Promise<string[] | null> {
  const { log } = deps;
  let alias = DEFAULT_ALIAS;
  let starter = DEFAULT_STARTER;
  let dir = deps.joinPath(deps.home, "ContextNest", alias);

  const answer = (
    await deps.ask(`\nCreate your notes in ${dir} (pre-filled pages for a software project)? [Y/n/customize]`, "y")
  ).trim().toLowerCase();
  if (answer.startsWith("n")) {
    log("Skipped the notes on this computer.");
    return null;
  }
  if (answer.startsWith("c")) {
    starter = (await deps.ask("Template (developer, personal, executive, analyst, team, sales)", starter)).trim();
    alias = (await deps.ask("Name", alias)).trim() || alias;
    dir = (await deps.ask("Folder", deps.joinPath(deps.home, "ContextNest", alias))).trim();
  }
  if (deps.exists(deps.joinPath(dir, ".context", "config.yaml"))) {
    log(`Notes already exist at ${dir}. Add them with: ctx vault add ${alias} ${dir}`);
    return null;
  }
  const tools = deps.detectedTools();
  log(`  Running: ctx init --starter ${starter} (in ${dir})`);
  try {
    await deps.run(
      ["--yes", "--vault", alias, "init", "--starter", starter, "--name", alias, "--set-default", "--tools", tools.length ? tools.join(",") : "none"],
      dir,
    );
  } catch (err) {
    log(`Couldn't create the vault: ${(err as Error).message}`);
    return null;
  }
  return tools;
}

async function setupRemote(deps: OnboardingDeps, setDefault: boolean): Promise<boolean> {
  const { log } = deps;
  const alias = "promptowl";
  const def = setDefault ? ["--set-default"] : [];
  try {
    // Already signed in on this machine: reuse the saved key, no browser.
    if (await deps.signedIn(DEFAULT_SERVER)) {
      log(`\nAlready signed in to ${DEFAULT_SERVER}. Connecting it.`);
      await deps.run(["vault", "add", alias, "--url", `${DEFAULT_SERVER}/mcp`, ...def]);
      return true;
    }
    if (isHeadless(deps.env)) {
      log("\nNo browser here. Open the link below on any device and approve it.");
    } else {
      log("\nYour browser will open for a quick approval.");
    }
    log(`  Running: ctx login ${DEFAULT_SERVER} --as ${alias}`);
    // --yes: choosing the server option already confirmed registering it.
    await deps.run(["--yes", "login", DEFAULT_SERVER, "--as", alias, ...def]);
  } catch (err) {
    log(`Sign-in didn't finish: ${(err as Error).message}`);
    log("Nothing was changed on your account. Retry any time with:");
    log(`  ctx login ${DEFAULT_SERVER} --as ${alias}`);
    return false;
  }
  return true;
}
