/**
 * welcome-html.ts — Generates a branded onboarding HTML page after ctx init.
 * Opens in the user's browser as the first visual touchpoint with PromptOwl.
 */

import fs from "node:fs";
import pathMod from "node:path";
import { exec } from "node:child_process";

interface WelcomeNode {
  path: string;
  title: string;
  type: string;
  tags: string[];
}

interface WelcomeOptions {
  vaultPath: string;
  vaultName: string;
  starterName: string | null;
  starterDisplayName: string | null;
  nodes: WelcomeNode[];
  timestamp: string;
  cliVersion: string;
}

/** Generate the branded welcome HTML and write to .context/welcome.html */
export async function generateWelcomeHtml(opts: WelcomeOptions): Promise<string> {
  const outputPath = pathMod.join(opts.vaultPath, ".context", "welcome.html");

  const nodeRows = opts.nodes
    .map(
      (n) =>
        `<tr><td><code>${escHtml(n.path)}.md</code></td><td>${escHtml(n.title)}</td><td><span class="tag">${escHtml(n.type)}</span></td><td>${n.tags.map((t) => `<span class="tag tag-sm">${escHtml(t)}</span>`).join(" ")}</td></tr>`,
    )
    .join("\n");

  const folderSet = new Set(opts.nodes.map((n) => n.path.split("/").slice(0, -1).join("/")));
  const folders = [...folderSet].filter(Boolean).sort();

  const treeLines = buildTreeLines(opts.nodes.map((n) => n.path + ".md"));

  const starterBadge = opts.starterName
    ? `<span class="starter-badge">${escHtml(opts.starterDisplayName || opts.starterName)} starter</span>`
    : `<span class="starter-badge empty">No starter applied</span>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your Vault Is Ready — Context Nest by PromptOwl</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Open+Sans:wght@700;800&display=swap');
:root {
  --primary: #2B1C50;
  --secondary: #6366F1;
  --accent: #F36F21;
  --accent-hover: #EA580C;
  --midnight: #1E1B4B;
  --violet-echo: #A78BFA;
  --bg: #ffffff;
  --bg-alt: #F8FAFC;
  --body-text: #334155;
  --text-light: #64748B;
  --border: #E2E8F0;
  --border-light: #F1F5F9;
  --green: #10B981;
  --green-bg: #ECFDF5;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; color: var(--body-text); background: var(--bg-alt); line-height: 1.6; }

/* Header */
.hero {
  background: linear-gradient(135deg, var(--midnight) 0%, #312E81 50%, var(--secondary) 100%);
  color: white;
  padding: 3rem 2rem 2.5rem;
  text-align: center;
  position: relative;
  overflow: hidden;
}
.hero::before {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle at 30% 70%, rgba(163,130,250,0.15) 0%, transparent 50%),
              radial-gradient(circle at 70% 30%, rgba(243,111,33,0.1) 0%, transparent 50%);
  pointer-events: none;
}
.hero * { position: relative; }
.hero .logo { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-bottom: 1rem; opacity: 0.9; }
.hero .logo svg { width: 36px; height: 28px; }
.hero .logo .brand-text { font-family: 'Open Sans', sans-serif; font-size: 1.1rem; font-weight: 800; letter-spacing: -0.5px; color: white; }
.hero .logo .brand-text span { color: var(--accent); }
.hero h1 { font-family: 'Open Sans', sans-serif; font-size: 2.25rem; font-weight: 800; letter-spacing: -0.025em; margin-bottom: 0.5rem; }
.hero p { font-size: 1.05rem; opacity: 0.85; max-width: 500px; margin: 0 auto; }
.hero .check-icon { display: inline-block; width: 48px; height: 48px; background: var(--green); border-radius: 50%; line-height: 48px; font-size: 1.5rem; margin-bottom: 1rem; }

/* Layout */
.container { max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem; }
.card { background: white; border-radius: 1rem; border: 1px solid var(--border-light); padding: 1.5rem 2rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
.card h2 { font-family: 'Open Sans', sans-serif; font-size: 1.2rem; font-weight: 700; color: var(--primary); margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }
.card h2 .icon { font-size: 1.3rem; }

/* Stats bar */
.stats { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
.stat { background: white; border-radius: 0.75rem; border: 1px solid var(--border-light); padding: 1rem 1.25rem; flex: 1; min-width: 140px; text-align: center; }
.stat .value { font-family: 'Open Sans', sans-serif; font-size: 1.5rem; font-weight: 800; color: var(--primary); }
.stat .label { font-size: 0.8rem; color: var(--text-light); margin-top: 0.25rem; }

/* Starter badge */
.starter-badge { display: inline-block; background: linear-gradient(135deg, var(--secondary), var(--violet-echo)); color: white; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 600; }
.starter-badge.empty { background: var(--border); color: var(--text-light); }

/* Tags */
.tag { display: inline-block; background: var(--bg-alt); border: 1px solid var(--border); padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; color: var(--primary); font-weight: 500; }
.tag-sm { font-size: 0.7rem; padding: 0.1rem 0.4rem; }

/* Table */
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 2px solid var(--border); color: var(--text-light); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
td { padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--border-light); }
tr:hover td { background: var(--bg-alt); }

/* Tree */
.tree { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 0.85rem; background: var(--midnight); color: #E2E8F0; padding: 1.25rem 1.5rem; border-radius: 0.75rem; line-height: 1.6; overflow-x: auto; }
.tree .folder { color: var(--violet-echo); font-weight: 600; }
.tree .file { color: #94A3B8; }
.tree .highlight { color: var(--accent); font-weight: 600; }

/* Timeline */
.timeline { padding-left: 1.5rem; border-left: 2px solid var(--secondary); }
.timeline-item { position: relative; padding: 0.4rem 0 0.4rem 1rem; font-size: 0.9rem; }
.timeline-item::before { content: ''; position: absolute; left: -1.65rem; top: 0.7rem; width: 10px; height: 10px; background: var(--secondary); border-radius: 50%; border: 2px solid white; }
.timeline-item:last-child::before { background: var(--green); }
.timeline-item .time { color: var(--text-light); font-size: 0.8rem; font-family: monospace; }

/* Checklist */
.checklist { list-style: none; padding: 0; }
.checklist li { padding: 0.6rem 0; border-bottom: 1px solid var(--border-light); display: flex; align-items: flex-start; gap: 0.75rem; font-size: 0.95rem; }
.checklist li:last-child { border-bottom: none; }
.check-box { width: 20px; height: 20px; border: 2px solid var(--border); border-radius: 4px; flex-shrink: 0; margin-top: 2px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
.check-box:hover { border-color: var(--secondary); }
.check-box.checked { background: var(--green); border-color: var(--green); }
.check-box.checked::after { content: '\\2713'; color: white; font-size: 0.75rem; font-weight: 700; }

/* Surface cards */
.surfaces { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
.surface-card { background: white; border: 1px solid var(--border-light); border-radius: 0.75rem; padding: 1.25rem; text-align: center; transition: all 0.3s cubic-bezier(0.4,0,0.2,1); cursor: pointer; text-decoration: none; color: inherit; display: block; }
.surface-card:hover { transform: translateY(-3px); box-shadow: 0 8px 25px rgba(0,0,0,0.08); border-color: rgba(99,102,241,0.3); }
.surface-card .surface-icon { font-size: 2rem; margin-bottom: 0.5rem; }
.surface-card h3 { font-family: 'Open Sans', sans-serif; font-size: 0.95rem; font-weight: 700; color: var(--primary); margin-bottom: 0.25rem; }
.surface-card p { font-size: 0.8rem; color: var(--text-light); }

/* CTA */
.cta-bar { background: linear-gradient(135deg, var(--midnight), #312E81); border-radius: 1rem; padding: 1.5rem 2rem; text-align: center; color: white; margin-top: 1.5rem; }
.cta-bar h3 { font-family: 'Open Sans', sans-serif; font-size: 1.1rem; margin-bottom: 0.5rem; }
.cta-bar p { font-size: 0.9rem; opacity: 0.8; margin-bottom: 1rem; }
.cta-btn { display: inline-block; background: var(--accent); color: white; padding: 0.6rem 1.5rem; border-radius: 9999px; font-weight: 700; text-decoration: none; transition: all 0.2s; font-size: 0.9rem; }
.cta-btn:hover { background: var(--accent-hover); transform: scale(1.05); }

/* Footer */
.footer { text-align: center; padding: 2rem; color: var(--text-light); font-size: 0.8rem; }
.footer a { color: var(--secondary); text-decoration: none; }
.footer a:hover { text-decoration: underline; }

/* Responsive */
@media (max-width: 640px) {
  .hero h1 { font-size: 1.5rem; }
  .stats { flex-direction: column; }
  .surfaces { grid-template-columns: 1fr; }
  .card { padding: 1rem 1.25rem; }
}
</style>
<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-2CS7MD931K"></script>
<script>
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', 'G-2CS7MD931K');
gtag('event', 'vault_init', {
  starter: '${escHtml(opts.starterName || "none")}',
  cli_version: '${escHtml(opts.cliVersion)}',
  doc_count: ${opts.nodes.length}
});
</script>
</head>
<body>

<!-- Hero -->
<div class="hero">
  <div class="logo">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 135 100"><defs><style>.lo1{fill:#fff}.lo2{fill:#ff6500}</style></defs><path class="lo2" d="M66.79,43.23s0-4.26-6.62-8.84c-3.85-2.66-8.45-3.21-10.23-3.32-.21-.01-.26-.29-.08-.39,1.87-.92,7.62-3.3,16.93-3.3,9.31,0,15.05,2.38,16.93,3.3.19.09.13.37-.08.39-1.78.11-6.39.66-10.23,3.32-6.63,4.58-6.62,8.84-6.62,8.84Z"/><g><path class="lo1" d="M66.44,66.86l-3.4,3.4c-.27.27-.32.69-.11,1.01l3.18,5.04c.32.51,1.06.51,1.38,0l3.18-5.04c.2-.32.16-.74-.11-1.01l-3.4-3.4c-.19-.19-.51-.19-.71,0Z"/><path class="lo1" d="M107.85,21.18c-2.32,2.21-9.94,8.98-17.33,10.09h-.02c-.48.08-.58.72-.14.94.05.02.11.05.16.08.2.09.4.19.6.3.45.23.31.91-.19.94-.14.01-.27.02-.41.03-3.96.28-7.32,1.05-9.59,1.71h-.01c-1.05.26-2.08.6-3.06,1.03-.03.02-.05.02-.06.03h-.01c-2.51,1.11-4.74,2.75-6.54,4.77-1.8,2.03-3.17,4.44-3.98,7.11-.14.47-.81.47-.95,0-1.61-5.33-5.5-9.66-10.52-11.88h-.01s-.04,0-.07-.03c-.98-.43-2-.77-3.05-1.03h-.01c-2.27-.66-5.63-1.43-9.59-1.71-.14-.01-.27-.02-.41-.03-.5-.03-.64-.71-.2-.94.21-.11.41-.21.61-.3.05-.03.11-.06.16-.08.44-.22.34-.86-.14-.94h-.02c-7.39-1.11-15.01-7.88-17.33-10.09-.28-.27-.74-.07-.74.32v.02c.01,3.37.9,13.99,11.45,17.25,2.58.8,4.76,1.35,6.62,1.76,7.11,1.57,9.58,1.09,12.62,4.83-.48-.48-3.03-2.33-12.62-2.01-1.66.05-3.54.17-5.64.37-1.57.16-3.04-.02-4.42-.45-.35-.11-.73.03-.93.34-1.84,2.92-2.9,6.38-2.9,10.09,0,8.72,5.88,16.06,13.89,18.29,1.61.45,3.32.69,5.08.69,8.57,0,15.81-5.68,18.17-13.49.14-.47.81-.47.95,0,2.36,7.81,9.6,13.49,18.17,13.49,1.76,0,3.46-.24,5.08-.69,8.01-2.23,13.89-9.57,13.89-18.29,0-3.71-1.07-7.17-2.91-10.09-.19-.31-.57-.45-.92-.34-1.38.43-2.85.61-4.42.45-2.11-.2-3.98-.32-5.64-.37-9.59-.32-12.14,1.53-12.63,2.01,3.05-3.74,5.51-3.26,12.63-4.83,1.86-.41,4.04-.96,6.62-1.76,5.28-1.63,8.14-5.1,9.68-8.58,1.54-3.49,1.76-6.99,1.77-8.67v-.02c0-.39-.46-.59-.74-.32ZM54.89,52.46c-.03.08-.09.14-.18.18l-.77.3c-.11.09-.2.18-.29.29l-.3.77c-.05.12-.16.2-.29.2-.13,0-.24-.08-.29-.2l-.3-.77c-.09-.11-.18-.2-.29-.29l-.77-.3c-.16-.06-.24-.24-.18-.4.03-.08.09-.14.18-.18l.77-.3c.11-.09.2-.18.29-.29l.29-.76c.04-.11.14-.19.25-.2.14-.02.27.06.32.19l.3.77c.09.11.18.2.29.29l.77.3c.16.06.24.24.18.4ZM89.84,52.46c-.03.08-.09.14-.18.18l-.77.3c-.11.09-.2.18-.29.29l-.3.77c-.05.12-.16.2-.29.2-.13,0-.24-.08-.29-.2l-.3-.77c-.09-.11-.18-.2-.29-.29l-.77-.3c-.16-.06-.24-.24-.18-.4.03-.08.09-.14.18-.18l.77-.3c.11-.09.2-.18.29-.29l.29-.76c.04-.11.14-.19.25-.2.14-.02.27.06.32.19l.3.77c.09.11.18.2.29.29l.77.3c.16.06.24.24.18.4Z"/></g></svg>
    <span class="brand-text">Prompt<span>Owl</span></span>
  </div>
  <div class="check-icon">&#10003;</div>
  <h1>Your Vault Is Ready</h1>
  <p>${escHtml(opts.vaultName)} &mdash; initialized at ${escHtml(new Date(opts.timestamp).toLocaleString())}</p>
</div>

<div class="container">

  <!-- Stats -->
  <div class="stats">
    <div class="stat">
      <div class="value">${opts.nodes.length}</div>
      <div class="label">Documents</div>
    </div>
    <div class="stat">
      <div class="value">${folders.length}</div>
      <div class="label">Folders</div>
    </div>
    <div class="stat">
      <div class="value">${starterBadge}</div>
      <div class="label">Recipe</div>
    </div>
  </div>

  <!-- Activity Log -->
  <div class="card">
    <h2><span class="icon">&#128337;</span> What Just Happened</h2>
    <div class="timeline">
      <div class="timeline-item">
        <span class="time">${escHtml(opts.timestamp)}</span>
        <div>Initialized vault structure at <code>${escHtml(opts.vaultPath)}</code></div>
      </div>
      <div class="timeline-item">
        <span class="time">${escHtml(opts.timestamp)}</span>
        <div>Created directories: <code>nodes/</code>, <code>packs/</code>, <code>sources/</code>, <code>.context/</code></div>
      </div>
      ${
        opts.starterName
          ? `<div class="timeline-item">
        <span class="time">${escHtml(opts.timestamp)}</span>
        <div>Applied <strong>${escHtml(opts.starterDisplayName || opts.starterName)}</strong> starter template</div>
      </div>
      <div class="timeline-item">
        <span class="time">${escHtml(opts.timestamp)}</span>
        <div>Created ${opts.nodes.length} documents across ${folders.length} folders</div>
      </div>`
          : ""
      }
      <div class="timeline-item">
        <span class="time">${escHtml(opts.timestamp)}</span>
        <div>Generated <code>CONTEXT.md</code>, <code>context.yaml</code>, and INDEX files</div>
      </div>
      <div class="timeline-item">
        <span class="time">${escHtml(opts.timestamp)}</span>
        <div><strong>Vault ready!</strong></div>
      </div>
    </div>
  </div>

  <!-- Vault Structure -->
  <div class="card">
    <h2><span class="icon">&#128193;</span> Vault Structure</h2>
    <div class="tree">${treeLines}</div>
  </div>

  <!-- Documents -->
  ${
    opts.nodes.length > 0
      ? `<div class="card">
    <h2><span class="icon">&#128196;</span> Documents (${opts.nodes.length})</h2>
    <table>
      <thead><tr><th>Path</th><th>Title</th><th>Type</th><th>Tags</th></tr></thead>
      <tbody>${nodeRows}</tbody>
    </table>
  </div>`
      : ""
  }

  <!-- What To Do Next -->
  <div class="card">
    <h2><span class="icon">&#127919;</span> What To Do Next</h2>
    <ul class="checklist">
      <li><div class="check-box" onclick="this.classList.toggle('checked')"></div><div><strong>Open this project in your AI assistant</strong> &mdash; it reads your vault automatically via CONTEXT.md</div></li>
      <li><div class="check-box" onclick="this.classList.toggle('checked')"></div><div><strong>Try searching:</strong> <code>ctx search "your topic"</code></div></li>
      <li><div class="check-box" onclick="this.classList.toggle('checked')"></div><div><strong>Add your first document:</strong> <code>ctx add nodes/my-doc --title "My Document"</code></div></li>
      <li><div class="check-box" onclick="this.classList.toggle('checked')"></div><div><strong>Explore a cloud pack:</strong> <code>ctx query @promptowl/starter-pack</code></div></li>
      <li><div class="check-box" onclick="this.classList.toggle('checked')"></div><div><strong>Share your vault</strong> with a teammate &mdash; they just need the folder</div></li>
    </ul>
  </div>

  <!-- Explore PromptOwl -->
  <div class="card">
    <h2><span class="icon">&#129417;</span> Explore PromptOwl</h2>
    <div class="surfaces">
      <a class="surface-card" href="https://promptowl.ai/integrations" target="_blank">
        <div class="surface-icon">&#9000;</div>
        <h3>AI Integrations</h3>
        <p>Works with Claude, Cursor, Copilot, GPT &amp; more</p>
      </a>
      <a class="surface-card" href="https://promptowl.ai/mcp" target="_blank">
        <div class="surface-icon">&#128421;</div>
        <h3>MCP Server</h3>
        <p>15 vault tools for any MCP-compatible AI</p>
      </a>
      <a class="surface-card" href="https://promptowl.ai/chat" target="_blank">
        <div class="surface-icon">&#128172;</div>
        <h3>Hootie Web Chat</h3>
        <p>Talk to your knowledge in the browser</p>
      </a>
      <a class="surface-card" href="https://promptowl.ai/publish" target="_blank">
        <div class="surface-icon">&#128640;</div>
        <h3>Publish</h3>
        <p>Turn your vault into a product</p>
      </a>
    </div>
  </div>

  <!-- CTA -->
  <div class="cta-bar">
    <h3>Ready for more?</h3>
    <p>Cloud packs give you curated expertise from domain experts. 50 free queries/month.</p>
    <a class="cta-btn" href="https://promptowl.ai/marketplace" target="_blank">Browse Cloud Packs</a>
  </div>

</div>

<div class="footer">
  Context Nest v${escHtml(opts.cliVersion)} &mdash; Built by <a href="https://promptowl.ai">PromptOwl</a>
  &mdash; <a href="https://github.com/PromptOwl/ContextNest">GitHub</a>
  &mdash; <a href="https://github.com/PromptOwl/context-nest-starters">Starters</a>
</div>

</body>
</html>`;

  await fs.promises.mkdir(pathMod.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, html, "utf-8");
  return outputPath;
}

/** Open the welcome HTML in the default browser */
export function openInBrowser(filePath: string): void {
  // Opt-out for CI / headless / tests where popping a browser is unwanted.
  if (process.env.CONTEXTNEST_NO_BROWSER) {
    return;
  }

  const absPath = pathMod.resolve(filePath);
  const url = `file://${absPath.replace(/\\/g, "/")}`;

  const platform = process.platform;
  let cmd: string;
  if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }

  exec(cmd, (err) => {
    // Silently fail — not critical if browser doesn't open
    if (err && process.env.DEBUG) {
      console.error(`Could not open browser: ${err.message}`);
    }
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildTreeLines(paths: string[]): string {
  // Build a simple tree visualization
  const lines: string[] = [];
  lines.push(`<span class="folder">my-vault/</span>`);
  lines.push(`├── <span class="highlight">CONTEXT.md</span>`);
  lines.push(`├── <span class="highlight">context.yaml</span>`);
  lines.push(`├── <span class="folder">nodes/</span>`);

  // Group by first folder
  const grouped = new Map<string, string[]>();
  for (const p of paths) {
    const parts = p.split("/");
    if (parts.length >= 2) {
      const folder = parts[0];
      if (!grouped.has(folder)) grouped.set(folder, []);
      grouped.get(folder)!.push(parts.slice(1).join("/"));
    }
  }

  const folderEntries = [...grouped.entries()];
  for (let i = 0; i < folderEntries.length; i++) {
    const [folder, files] = folderEntries[i];
    const isLastFolder = i === folderEntries.length - 1;
    const prefix = isLastFolder ? "│   └──" : "│   ├──";
    lines.push(`${prefix} <span class="folder">${escHtml(folder)}/</span>`);
    for (let j = 0; j < files.length; j++) {
      const filePrefix = isLastFolder ? "│       " : "│   │   ";
      const connector = j === files.length - 1 ? "└──" : "├──";
      lines.push(`${filePrefix}${connector} <span class="file">${escHtml(files[j])}</span>`);
    }
  }

  lines.push(`├── <span class="folder">packs/</span>`);
  lines.push(`├── <span class="folder">sources/</span>`);
  lines.push(`└── <span class="folder">.context/</span>`);
  lines.push(`    └── <span class="highlight">welcome.html</span> <span class="file">(this page)</span>`);

  return lines.join("\n");
}
