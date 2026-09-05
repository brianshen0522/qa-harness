import { INestApplication } from "@nestjs/common";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { api, createApp, loginAdmin, loginUser, resetDb } from "./helpers";
import { PrismaService } from "../src/prisma/prisma.service";
import { McpService } from "../src/mcp/mcp.service";

/**
 * A tiny stand-in MCP server: JSON-RPC 2.0 over HTTP for initialize / tools/list
 * / tools/call. Lets the whole MCP host be tested without an external server.
 */
function mockMcpServer(): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let msg: { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      try { msg = JSON.parse(body || "{}"); } catch { msg = {}; }
      const reply = (result: unknown) => {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      calls.push(msg.method ?? "");
      if (msg.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "1" } });
      if (msg.method === "tools/list") return reply({ tools: [{ name: "echo", description: "回傳輸入", inputSchema: { type: "object", properties: { msg: { type: "string" } } } }] });
      if (msg.method === "tools/call") {
        const arg = msg.params?.arguments?.msg ?? "";
        return reply({ content: [{ type: "text", text: `echoed: ${arg}` }], isError: false });
      }
      // notifications/initialized and anything else: 202-ish empty ack.
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls }));
  });
}

describe("MCP servers (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string, owner: string;
  let projectId: string;
  let mock: Awaited<ReturnType<typeof mockMcpServer>>;

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await resetDb(prisma);
    mock = await mockMcpServer();
    admin = await loginAdmin(app, prisma);
    owner = await loginUser(app, "owner@m.local");
    const team = await api(app).post("/api/teams").set("Cookie", owner).send({ name: "T" }).expect(201);
    const project = await api(app).post("/api/projects").set("Cookie", owner).send({ teamId: team.body.id, name: "P" }).expect(201);
    projectId = project.body.id;
  });

  afterAll(async () => {
    await new Promise<void>((r) => mock.server.close(() => r()));
    await app.close();
  });

  it("registers a global MCP server, never returning its auth", async () => {
    const res = await api(app).post("/api/admin/mcp").set("Cookie", admin)
      .send({ name: "Mock", url: mock.url, auth: "secret-token" }).expect(201);
    expect(res.body.hasAuth).toBe(true);
    expect(res.body).not.toHaveProperty("authEncrypted");
    expect(res.body).not.toHaveProperty("auth");
  });

  it("tests the connection and lists the server's tools", async () => {
    const server = (await api(app).get("/api/admin/mcp").set("Cookie", admin).expect(200)).body[0];
    const res = await api(app).post(`/api/admin/mcp/${server.id}/test`).set("Cookie", admin).expect(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.tools.map((t: { name: string }) => t.name)).toContain("echo");
    // The tool list is cached on the row for display.
    const cached = (await api(app).get("/api/admin/mcp").set("Cookie", admin).expect(200)).body[0];
    expect(cached.tools.some((t: { name: string }) => t.name === "echo")).toBe(true);
    expect(mock.calls).toContain("initialize");
    expect(mock.calls).toContain("tools/list");
  });

  it("resolves tools for a project and can call one (the host path the worker uses)", async () => {
    const mcp = app.get(McpService);
    const tools = await mcp.toolsForProject(projectId);
    expect(tools.map((t) => t.tool.name)).toContain("echo");

    const server = (await api(app).get("/api/admin/mcp").set("Cookie", admin).expect(200)).body[0];
    const result = await mcp.callTool(server.id, "echo", { msg: "hi" });
    expect(result.isError).toBe(false);
    expect(result.text).toBe("echoed: hi");
    expect(mock.calls).toContain("tools/call");
  });

  it("scopes project MCP servers to editors", async () => {
    const viewer = await loginUser(app, "viewer@m.local");
    await api(app).post(`/api/projects/${projectId}/members`).set("Cookie", owner).send({ email: "viewer@m.local", role: "viewer" }).expect(201);
    await api(app).post(`/api/projects/${projectId}/mcp`).set("Cookie", viewer).send({ name: "x", url: mock.url }).expect(403);
    const created = await api(app).post(`/api/projects/${projectId}/mcp`).set("Cookie", owner).send({ name: "專案 MCP", url: mock.url }).expect(201);
    expect(created.body.scope).toBe("project");
    // A disabled server contributes no tools.
    await api(app).patch(`/api/mcp/${created.body.id}`).set("Cookie", owner).send({ enabled: false }).expect(200);
    const tools = await app.get(McpService).toolsForProject(projectId);
    // Only the (enabled) global one remains.
    expect(tools.filter((t) => t.serverId === created.body.id)).toHaveLength(0);
  });
});
