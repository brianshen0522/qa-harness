import { parseRpc } from "./mcp-client";

describe("parseRpc", () => {
  it("parses a plain JSON body", () => {
    expect(parseRpc('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}').result?.tools).toEqual([]);
  });

  it("parses a JSON-RPC object out of an SSE stream", () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect((parseRpc(sse).result as { ok: boolean }).ok).toBe(true);
  });

  it("takes the last data frame when several are present", () => {
    const sse = 'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    expect((parseRpc(sse).result as { n: number }).n).toBe(2);
  });

  it("throws on an unparseable body", () => {
    expect(() => parseRpc("not json at all")).toThrow();
  });
});
