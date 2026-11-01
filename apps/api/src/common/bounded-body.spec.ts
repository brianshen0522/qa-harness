import { readBounded } from "./bounded-body";

describe("readBounded", () => {
  it("returns a body under the limit whole", async () => {
    const { body, truncated } = await readBounded(new Response("hello"), 10);
    expect(body.toString()).toBe("hello");
    expect(truncated).toBe(false);
  });

  it("stops reading and cancels past the limit", async () => {
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { pulls++; c.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    const { body, truncated } = await readBounded(new Response(stream), 2048);
    expect(body.byteLength).toBe(2048);
    expect(truncated).toBe(true);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(6);
  });

  it("handles a response with no body", async () => {
    expect((await readBounded(new Response(null), 10)).body.byteLength).toBe(0);
  });
});
