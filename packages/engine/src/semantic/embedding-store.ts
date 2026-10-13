/**
 * The governed embedding index.
 *
 * Governance: ONLY published documents are ever sent to a provider or stored.
 * Drafts, pending/rejected/forgotten nodes and superseded versions never are —
 * each entry is keyed by (doc id, version, sha256 of the embedded text), and a
 * vector whose key no longer matches the live published document is ignored at
 * query time and dropped on the next `context_embed`. A new version therefore
 * invalidates its own vector and nothing else.
 *
 * Storage: `.context/embeddings/<provider>--<model>[--d<dims>].{json,f32}` —
 * the `.json` holds the keys (row order), the `.f32` holds the unit-normalized
 * vectors as little-endian float32 rows. Binary because a 50k-document corpus
 * at 1536 dimensions would not fit in one JSON string. One file pair per
 * provider+model, so switching models never mixes vector spaces. The directory
 * carries its own `.gitignore` (`*`): the index is derived data, rebuildable
 * with `ctx embed --rebuild`, and must never be committed.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextNode } from "../types.js";
import { isPublished } from "../parser.js";

export const EMBEDDINGS_DIR = ".context/embeddings";
export const DEFAULT_MAX_CHARS = 20_000;

export interface EmbeddingKey {
  id: string;
  version: number;
  content_hash: string;
}

interface IndexMeta {
  format: 1;
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
    readonly provider: string,
    readonly model: string,
    readonly fileStem: string,
  ) {}

  static async load(root: string, provider: string, model: string, dimensions?: number): Promise<EmbeddingStore> {
    const store = new EmbeddingStore(root, provider, model, slug(provider, model, dimensions));
    let meta: IndexMeta;
    let buf: Buffer;
    try {
      meta = JSON.parse(await readFile(store.metaPath, "utf-8"));
      buf = await readFile(store.vectorPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return store;
      throw err;
    }
    const dims = meta.dimensions;
    if (meta.format !== 1 || buf.byteLength !== meta.entries.length * dims * 4) {
      return store; // unreadable/torn index: treat as empty, the next embed rebuilds it
    }
    store.dimensions = dims;
    const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    meta.entries.forEach((key, i) => {
      store.rows.set(key.id, { key, vector: all.subarray(i * dims, (i + 1) * dims) });
    });
    return store;
  }

  get dir(): string {
    return join(this.root, EMBEDDINGS_DIR);
  }
  get metaPath(): string {
    return join(this.dir, `${this.fileStem}.json`);
  }
  get vectorPath(): string {
    return join(this.dir, `${this.fileStem}.f32`);
  }
  /** Vault-relative path of the index (for reporting). */
  get relativePath(): string {
    return `${EMBEDDINGS_DIR}/${this.fileStem}.{json,f32}`;
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
    if (this.dimensions && v.length !== this.dimensions) {
      throw new Error(`embedding for ${key.id} has ${v.length} dimensions, index has ${this.dimensions}`);
    }
    this.dimensions = v.length;
    this.rows.set(key.id, { key, vector: v });
  }

  delete(id: string): void {
    this.rows.delete(id);
  }

  clear(): void {
    this.rows.clear();
    this.dimensions = 0;
  }

  /** Write both files atomically (tmp + rename), plus the self-ignoring .gitignore. */
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
    const meta: IndexMeta = { format: 1, provider: this.provider, model: this.model, dimensions: dims, entries };
    const tag = `.tmp-${process.pid}-${Date.now()}`;
    await writeFile(this.vectorPath + tag, Buffer.from(all.buffer, all.byteOffset, all.byteLength));
    await writeFile(this.metaPath + tag, JSON.stringify(meta));
    await rename(this.vectorPath + tag, this.vectorPath);
    await rename(this.metaPath + tag, this.metaPath);
  }
}

/** Published documents only — the single gate every embedding path goes through. */
export function embeddable(docs: ContextNode[]): ContextNode[] {
  return docs.filter(isPublished);
}
