/**
 * keyring.ts — OS credential stores, reached by shelling out to the tools each
 * OS already ships. Zero npm dependencies (see CHANGELOG for why we did not
 * take @napi-rs/keyring).
 *
 *   macOS    /usr/bin/security    (login Keychain, generic password)
 *   Linux    secret-tool          (libsecret → Secret Service: GNOME Keyring, KWallet, KeePassXC)
 *   Windows  powershell.exe       (Credential Manager via advapi32 CredRead/CredWrite)
 *
 * The secret NEVER goes on argv — argv is readable by every process on the
 * box. It travels over stdin in every backend:
 *   - macOS: `security -i` reads its command line from stdin.
 *   - Linux: `secret-tool store` reads the secret from stdin.
 *   - Windows: the script (argv, via -EncodedCommand) holds no secret; the
 *     secret is read with [Console]::In.
 *
 * Every process spawn goes through an injectable `CommandRunner`, which is
 * what the tests mock.
 */

import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `cmd args`, writing `input` to stdin. Rejects only when the binary cannot be spawned. */
export type CommandRunner = (cmd: string, args: string[], input?: string) => Promise<RunResult>;

export const KEYRING_SERVICE = "contextnest-cli";
const RUN_TIMEOUT_MS = 15_000;

export const defaultRunner: CommandRunner = (cmd, args, input) =>
  new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (c: string) => (stdout += c));
    child.stderr?.on("data", (c: string) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });

export interface KeyringBackend {
  /** Human name, shown by `ctx doctor`. */
  readonly name: string;
  /** Can this backend be used right now (tool present, service reachable)? */
  available(): Promise<boolean>;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
}

async function tryRun(runner: CommandRunner, cmd: string, args: string[], input?: string): Promise<RunResult | null> {
  try {
    return await runner(cmd, args, input);
  } catch {
    return null;
  }
}

// Secrets are base64'd on macOS/Linux so arbitrary bytes (newlines, quotes,
// spaces) survive `security -i`'s tokenizer and secret-tool's line handling.
const B64_PREFIX = "cnb64:";
const encode = (s: string) => B64_PREFIX + Buffer.from(s, "utf-8").toString("base64");
const decode = (s: string) =>
  s.startsWith(B64_PREFIX) ? Buffer.from(s.slice(B64_PREFIX.length), "base64").toString("utf-8") : s;

// ─── macOS ───────────────────────────────────────────────────────────────────

export function macKeychain(runner: CommandRunner = defaultRunner): KeyringBackend {
  const SECURITY = "/usr/bin/security";
  return {
    name: "macOS Keychain",
    async available() {
      const r = await tryRun(runner, SECURITY, ["default-keychain"]);
      return r !== null && r.code === 0;
    },
    async get(account) {
      const r = await tryRun(runner, SECURITY, ["find-generic-password", "-s", KEYRING_SERVICE, "-a", account, "-w"]);
      if (!r) throw new Error("macOS Keychain unavailable: could not run /usr/bin/security");
      // 44 = errSecItemNotFound
      if (r.code !== 0) return null;
      return decode(r.stdout.replace(/\r?\n$/, ""));
    },
    async set(account, secret) {
      // `security -i` reads commands from stdin — keeps the secret off argv.
      const line = `add-generic-password -U -s ${KEYRING_SERVICE} -a ${account} -l ${KEYRING_SERVICE} -w ${encode(secret)}\n`;
      const r = await tryRun(runner, SECURITY, ["-i"], line);
      if (!r || r.code !== 0 || /error|failed/i.test(r.stderr)) {
        throw new Error(`Could not write to the macOS Keychain: ${r?.stderr.trim() || "security failed"}`);
      }
    },
  };
}

// ─── Linux (Secret Service) ──────────────────────────────────────────────────

export function linuxSecretService(
  runner: CommandRunner = defaultRunner,
  env: NodeJS.ProcessEnv = process.env,
): KeyringBackend {
  const attrs = (account: string) => ["service", KEYRING_SERVICE, "account", account];
  return {
    name: "Secret Service (secret-tool)",
    async available() {
      // No session bus → no Secret Service (headless boxes, CI, Docker).
      if (!env.DBUS_SESSION_BUS_ADDRESS) return false;
      // lookup of a missing item: exit 1 with empty stderr. A missing daemon
      // or bus prints an error to stderr.
      const r = await tryRun(runner, "secret-tool", ["lookup", ...attrs("__probe__")]);
      if (!r) return false;
      return r.code === 0 || (r.code === 1 && r.stderr.trim() === "");
    },
    async get(account) {
      const r = await tryRun(runner, "secret-tool", ["lookup", ...attrs(account)]);
      if (!r) throw new Error("Secret Service unavailable: could not run secret-tool");
      if (r.code !== 0 || r.stdout === "") return null;
      return decode(r.stdout.replace(/\r?\n$/, ""));
    },
    async set(account, secret) {
      const r = await tryRun(
        runner,
        "secret-tool",
        ["store", `--label=Context Nest CLI (${account})`, ...attrs(account)],
        encode(secret),
      );
      if (!r || r.code !== 0) {
        throw new Error(`Could not write to the Secret Service: ${r?.stderr.trim() || "secret-tool failed"}`);
      }
    },
  };
}

// ─── Windows (Credential Manager) ────────────────────────────────────────────

/** Generic credential blobs are capped at 5 × 512 bytes by the OS. */
export const WINDOWS_CRED_BLOB_MAX = 2560;

const WIN_CS = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class CnCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static string Read(string target) {
    IntPtr p; if (!CredReadW(target, 1, 0, out p)) return null;
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
      return Encoding.UTF8.GetString(b);
    } finally { CredFree(p); }
  }
  public static bool Write(string target, string user, string secret) {
    byte[] b = Encoding.UTF8.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    try { Marshal.Copy(b, 0, c.CredentialBlob, b.Length); return CredWriteW(ref c, 0); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
}`;

/** Build the PowerShell script for one operation. The target is a constant-ish id, never a secret. */
export function windowsScript(op: "probe" | "get" | "set", target: string): string {
  const t = target.replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::InputEncoding = [Text.Encoding]::UTF8",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    `Add-Type -TypeDefinition @'\n${WIN_CS}\n'@`,
    `$target = '${t}'`,
    op === "probe" ? "exit 0" : "",
    op === "get" ? "$v = [CnCred]::Read($target); if ($null -eq $v) { exit 3 }; [Console]::Out.Write($v)" : "",
    op === "set" ? "$s = [Console]::In.ReadToEnd(); if (-not [CnCred]::Write($target, 'contextnest', $s)) { exit 4 }" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function windowsCredentialManager(runner: CommandRunner = defaultRunner): KeyringBackend {
  const target = (account: string) => `${KEYRING_SERVICE}:${account}`;
  const ps = (script: string, input?: string) =>
    tryRun(
      runner,
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      input,
    );
  return {
    name: "Windows Credential Manager",
    async available() {
      const r = await ps(windowsScript("probe", target("__probe__")));
      return r !== null && r.code === 0;
    },
    async get(account) {
      const r = await ps(windowsScript("get", target(account)));
      if (!r) throw new Error("Windows Credential Manager unavailable: could not run powershell.exe");
      if (r.code !== 0) return null;
      return r.stdout;
    },
    async set(account, secret) {
      if (Buffer.byteLength(secret, "utf-8") > WINDOWS_CRED_BLOB_MAX) {
        throw new Error(
          `Credential is larger than Windows Credential Manager allows (${WINDOWS_CRED_BLOB_MAX} bytes). ` +
            "Set CONTEXTNEST_CREDENTIALS_BACKEND=file and CONTEXTNEST_CREDENTIALS_KEY to use the encrypted file store.",
        );
      }
      const r = await ps(windowsScript("set", target(account)), secret);
      if (!r || r.code !== 0) {
        throw new Error(`Could not write to Windows Credential Manager: ${r?.stderr.trim() || "powershell failed"}`);
      }
    },
  };
}

/** The native keyring for `platform`, or null where we have none. */
export function platformKeyring(
  platform: NodeJS.Platform = process.platform,
  runner: CommandRunner = defaultRunner,
  env: NodeJS.ProcessEnv = process.env,
): KeyringBackend | null {
  if (platform === "darwin") return macKeychain(runner);
  if (platform === "win32") return windowsCredentialManager(runner);
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") return linuxSecretService(runner, env);
  return null;
}
