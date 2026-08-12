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
 * Map over `items` in bounded-parallel batches, preserving input order.
 *
 * Each batch is awaited whole before the next starts, so at most `concurrency`
 * operations are ever in flight. Per-item error handling belongs to `fn`: a
 * rejection propagates and abandons the remaining batches, exactly as a throw
 * inside an `await` loop would.
 */
export async function mapInBatches<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number = VAULT_IO_CONCURRENCY,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    out.push(...(await Promise.all(items.slice(i, i + concurrency).map(fn))));
  }
  return out;
}
