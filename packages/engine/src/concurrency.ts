/**
 * Bounded-parallel mapping, shared by the whole-vault crawls and bulk publish.
 *
 * A vault may live on a network-backed mount (Cloud Storage via gcsfuse), where
 * every file operation is a round trip. Walking N files with an `await` inside a
 * `for` loop therefore costs N latencies in series — which is what made a large
 * import spend minutes waiting on I/O. Batching overlaps those round trips.
 */

/**
 * Files read or written concurrently by a whole-vault crawl.
 *
 * Bulk publish deliberately uses a LOWER bound (see `BulkPublishOptions`): its
 * unit is a document, and each one costs several file operations, so the two
 * numbers describe different amounts of in-flight I/O rather than disagreeing.
 */
export const VAULT_IO_CONCURRENCY = 32;

/**
 * Map over `items` with at most `concurrency` calls in flight, preserving input
 * order in the result.
 *
 * A sliding pool, not fixed batches: the next item starts as soon as any call
 * settles. Waiting for a whole batch let one slow round trip on a network mount
 * idle every other slot. Per-item error handling belongs to `fn`: a rejection
 * propagates and no further items start, as a throw inside an `await` loop would.
 */
export async function mapInBatches<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number = VAULT_IO_CONCURRENCY,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Math.min(Math.max(1, Math.floor(concurrency) || 1), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}
