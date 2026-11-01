/**
 * Reads at most `maxBytes` of a response. The URLs fetched on the API host come
 * from users, models and tested systems, so a body must not be able to exhaust
 * the process's memory.
 */
export async function readBounded(res: Response, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  if (!res.body) return { body: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { body: Buffer.concat(chunks), truncated: false };
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      await reader.cancel().catch(() => undefined);
      return { body: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(value);
    total += value.byteLength;
  }
}
