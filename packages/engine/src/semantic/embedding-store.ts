/**
 * The governed embedding index.
 *
 * Governance: ONLY published documents are ever sent to a provider or stored.
 * Drafts, pending/rejected/forgotten nodes and superseded versions never are —
 * each entry is keyed by (doc id, version, sha256 of the embedded text), and a
 * vector whose key no longer matches the live published document is ignored at
 * query time and dropped on the next `context_embed`. A new version therefore
 * invalidates its own vector and nothing else. Forget and delete purge the
 * document's vector at once (purgeEmbeddings).
 *
 * Storage: `.context/embeddings/<provider>--<model>[--d<dims>].vec` — a JSON
 * header with the keys (row order), then the unit-normalized vectors as
 * little-endian float32 rows. Binary because a 50k-document corpus at 1536
 * dimensions would not fit in one JSON string. One file per provider+model,
 * so switching models never mixes vector spaces. The directory
 * carries its own `.gitignore` (`*`): the index is derived data, rebuildable
 * with `ctx embed --rebuild`, and must never be committed.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextNode } from "../types.js";
import { isPublished } from "../parser.js";

export const EMBEDDINGS_DIR = ".context/embeddings";
export const DEFAULT_MAX_CHARS = 20_000;
/** Index file extension (format 2: one file; format-1 .json/.f32 pairs are ignored and rebuilt). */
export const INDEX_EXT = ".vec";

export interface EmbeddingKey {
  id: string;
  version: number;
  content_hash: string;
}

interface IndexMeta {
  format: 2;
  provider: string;
  model: string;
  dimensions: number;
  entries: EmbeddingKey[];
}

/** The exact text embedded for a document: title, description, body. */
export function embeddingText(doc: ContextNode, maxChars = DEFAULT_MAX_CHARS): string {
  const parts = [doc.frontmatter.title, doc.frontmatter.description ?? "", doc.body ?? ""];
  return parts.filter((p) => p && p.trim()).join("\n\n").slice(0, maxChars);
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function keyFor(doc: ContextNode, maxChars?: number): EmbeddingKey {
  return {
    id: doc.id,
    version: Number(doc.frontmatter.version ?? 0),
    content_hash: contentHash(embeddingText(doc, maxChars)),
  };
}

function slug(provider: string, model: string, dimensions?: number): string {
  const s = `${provider}--${model}${dimensions ? `--d${dimensions}` : ""}`;
  return s.replace(/[^A-Za-z0-9._-]+/g, "_");
}

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let n = 0;
  for (let i = 0; i < out.length; i++) n += out[i] * out[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

export class EmbeddingStore {
  private rows = new Map<string, { key: EmbeddingKey; vector: Float32Array }>();
  dimensions = 0;

  private constructor(
    readonly root: string,
    public provider: string,
    public model: string,
    readonly fileStem: string,
  ) {}

  static load(root: string, provider: string, model: string, dimensions?: number): Promise<EmbeddingStore> {
    return EmbeddingStore.read(new EmbeddingStore(root, provider, model, slug(provider, model, dimensions)));
  }

  /** The index stored as `<stem>.vec`, provider and model taken from its header. */
  static loadStem(root: string, stem: string): Promise<EmbeddingStore> {
    return EmbeddingStore.read(new EmbeddingStore(root, "", "", stem));
  }

  private static async read(store: EmbeddingStore): Promise<EmbeddingStore> {
    let buf: Buffer;
    try {
      buf = await readFile(store.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return store;
      throw err;
    }
    // [u32 LE header length][JSON header, space-padded to 4 bytes][float32 LE rows].
    // One file, swapped by one rename, so a reader never pairs one run's keys
    // with another run's vectors.
    let meta: IndexMeta;
    try {
      const len = buf.readUInt32LE(0);
      meta = JSON.parse(buf.subarray(4, 4 + len).toString("utf-8"));
      buf = buf.subarray(4 + len);
    } catch {
      return store; // unreadable index: treat as empty, the next embed rebuilds it
    }
    const dims = meta?.dimensions;
    if (
      meta?.format !== 2 ||
      !Number.isInteger(dims) ||
      dims <= 0 ||
      !Array.isArray(meta.entries) ||
      buf.byteLength !== meta.entries.length * dims * 4
    ) {
      return store;
    }
    store.dimensions = dims;
    store.provider ||= meta.provider;
    store.model ||= meta.model;
    const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    meta.entries.forEach((key, i) => {
      store.rows.set(key.id, { key, vector: all.subarray(i * dims, (i + 1) * dims) });
    });
    return store;
  }

  get dir(): string {
    return join(this.root, EMBEDDINGS_DIR);
  }
  get path(): string {
    return join(this.dir, `${this.fileStem}${INDEX_EXT}`);
  }
  /** Vault-relative path of the index (for reporting). */
  get relativePath(): string {
    return `${EMBEDDINGS_DIR}/${this.fileStem}${INDEX_EXT}`;
  }

  get size(): number {
    return this.rows.size;
  }

  ids(): string[] {
    return [...this.rows.keys()];
  }

  /** The stored vector, only if it was computed from exactly this key. */
  vectorFor(key: EmbeddingKey): Float32Array | null {
    const row = this.rows.get(key.id);
    if (!row) return null;
    const k = row.key;
    return k.version === key.version && k.content_hash === key.content_hash ? row.vector : null;
  }

  set(key: EmbeddingKey, vector: ArrayLike<number>): void {
    const v = normalize(vector);
    if (v.length === 0 || !v.every(Number.isFinite)) {
      throw new Error(`embedding for ${key.id} is empty or has non-finite values — the provider returned a bad vector`);
    }
    if (this.dimensions && v.length !== this.dimensions) {
      throw new Error(`embedding for ${key.id} has ${v.length} dimensions, index has ${this.dimensions}`);
    }
    this.dimensions = v.length;
    this.rows.set(key.id, { key, vector: v });
  }

  delete(id: string): void {
    this.rows.delete(id);
  }

  /** Drop every row not computed from the current published state of its document. */
  retainCurrent(docs: ContextNode[], maxChars?: number): void {
    const live = new Map(embeddable(docs).map((d) => [d.id, keyFor(d, maxChars)]));
    for (const id of this.ids()) {
      const key = live.get(id);
      if (!key || !this.vectorFor(key)) this.rows.delete(id);
    }
  }

  clear(): void {
    this.rows.clear();
    this.dimensions = 0;
  }

  /** Write the index atomically (tmp + one rename), plus the self-ignoring .gitignore. */
  async save(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, ".gitignore"), "*\n");
    const entries: EmbeddingKey[] = [];
    const dims = this.dimensions;
    const all = new Float32Array(this.rows.size * dims);
    let i = 0;
    for (const { key, vector } of this.rows.values()) {
      entries.push(key);
      all.set(vector, i * dims);
      i++;
    }
    const meta: IndexMeta = { format: 2, provider: this.provider, model: this.model, dimensions: dims, entries };
    let json = Buffer.from(JSON.stringify(meta), "utf-8");
    json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, " ")]);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(json.length, 0);
    const tmp = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tmp, Buffer.concat([head, json, Buffer.from(all.buffer, all.byteOffset, all.byteLength)]));
    await rename(tmp, this.path);
  }
}

/**
 * Remove these documents' vectors from every index in the vault (forget,
 * delete): erased content must not live on as a derived copy until the next
 * `context_embed`. Callers hold the vault lock, as `context_embed` does when
 * it saves, so the two never interleave.
 */
export async function purgeEmbeddings(root: string, ids: string[]): Promise<void> {
  let files: string[];
  try {
    files = await readdir(join(root, EMBEDDINGS_DIR));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const f of files.filter((f) => f.endsWith(INDEX_EXT))) {
    const stem = f.slice(0, -INDEX_EXT.length);
    const store = await EmbeddingStore.loadStem(root, stem);
    const held = new Set(store.ids());
    if (!ids.some((id) => held.has(id))) continue;
    for (const id of ids) store.delete(id);
    await store.save();
  }
}

/** Published documents only — the single gate every embedding path goes through. */
export function embeddable(docs: ContextNode[]): ContextNode[] {
  return docs.filter(isPublished);
}
