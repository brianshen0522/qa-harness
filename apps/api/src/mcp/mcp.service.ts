import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { McpScope, Prisma, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PermissionsService } from "../permissions/permissions.service";
import { CryptoService } from "../crypto/crypto.service";
import { AuditService } from "../audit/audit.service";
import { McpClient, type McpTool } from "./mcp-client";

export interface McpInput {
  name: string;
  url: string;
  auth?: string;
  enabled?: boolean;
}

export interface ResolvedMcpTool {
  server: string;
  serverId: string;
  tool: McpTool;
}

/**
 * MCP server registry + host (§3.2 / §6.2). Manages global and project MCP
 * servers, tests connectivity, and — for the worker — resolves the tools a
 * target's project can use and calls them. Auth is encrypted and never returned.
 */
@Injectable()
export class McpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: PermissionsService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  // ----- global (admin) -----

  listGlobal() {
    return this.prisma.mcpServer.findMany({ where: { scope: McpScope.global }, orderBy: { createdAt: "asc" } }).then((rows) => rows.map(publicRow));
  }

  async createGlobal(adminId: string, input: McpInput) {
    this.validate(input);
    const row = await this.prisma.mcpServer.create({
      data: {
        scope: McpScope.global, name: input.name.trim(), url: input.url.trim(),
        authEncrypted: input.auth ? this.crypto.encrypt(input.auth) : null, enabled: input.enabled ?? true,
      },
    });
    await this.audit.log("admin", adminId, "mcp.create", row.id, { scope: "global", name: row.name });
    return publicRow(row);
  }

  async updateGlobal(id: string, adminId: string, input: Partial<McpInput>) {
    await this.getGlobal(id);
    const row = await this.prisma.mcpServer.update({ where: { id }, data: this.patch(input) });
    await this.audit.log("admin", adminId, "mcp.update", id, { fields: Object.keys(input) });
    return publicRow(row);
  }

  async removeGlobal(id: string, adminId: string) {
    await this.getGlobal(id);
    await this.prisma.mcpServer.delete({ where: { id } });
    await this.audit.log("admin", adminId, "mcp.delete", id, {});
    return { ok: true };
  }

  testGlobal(id: string) {
    return this.testAndCache(id);
  }

  // ----- project (owner/editor) -----

  async listProject(projectId: string, userId: string) {
    await this.perms.requireProject(projectId, userId, Role.viewer);
    return this.prisma.mcpServer.findMany({ where: { scope: McpScope.project, projectId }, orderBy: { createdAt: "asc" } }).then((r) => r.map(publicRow));
  }

  async createProject(projectId: string, userId: string, input: McpInput) {
    await this.perms.requireProject(projectId, userId, Role.editor);
    this.validate(input);
    const row = await this.prisma.mcpServer.create({
      data: {
        scope: McpScope.project, projectId, name: input.name.trim(), url: input.url.trim(),
        authEncrypted: input.auth ? this.crypto.encrypt(input.auth) : null, enabled: input.enabled ?? true,
      },
    });
    await this.audit.log("user", userId, "mcp.create", row.id, { scope: "project", projectId, name: row.name });
    return publicRow(row);
  }

  async updateProject(id: string, userId: string, input: Partial<McpInput>) {
    const row = await this.getProject(id);
    await this.perms.requireProject(row.projectId!, userId, Role.editor);
    return publicRow(await this.prisma.mcpServer.update({ where: { id }, data: this.patch(input) }));
  }

  async removeProject(id: string, userId: string) {
    const row = await this.getProject(id);
    await this.perms.requireProject(row.projectId!, userId, Role.editor);
    await this.prisma.mcpServer.delete({ where: { id } });
    return { ok: true };
  }

  async testProject(id: string, userId: string) {
    const row = await this.getProject(id);
    await this.perms.requireProject(row.projectId!, userId, Role.editor);
    return this.testAndCache(id);
  }

  // ----- host: for the worker -----

  /** Enabled tools from the global + this project's MCP servers, flattened. */
  async toolsForProject(projectId: string): Promise<ResolvedMcpTool[]> {
    const servers = await this.prisma.mcpServer.findMany({
      where: { enabled: true, OR: [{ scope: McpScope.global }, { scope: McpScope.project, projectId }] },
    });
    const out: ResolvedMcpTool[] = [];
    for (const s of servers) {
      try {
        const tools = await this.client(s).probe();
        out.push(...tools.map((t) => ({ server: s.name, serverId: s.id, tool: t })));
      } catch {
        // A down MCP server must not break a run; its tools are just unavailable.
      }
    }
    return out;
  }

  /** Call one tool by server id + tool name. Used when the agent emits mcp_call. */
  async callTool(serverId: string, tool: string, args: Record<string, unknown>) {
    const server = await this.prisma.mcpServer.findUnique({ where: { id: serverId } });
    if (!server || !server.enabled) throw new BadRequestException("MCP 伺服器不存在或已停用");
    const client = this.client(server);
    await client.initialize();
    return client.callTool(tool, args);
  }

  // ----- helpers -----

  private async testAndCache(id: string) {
    const server = await this.prisma.mcpServer.findUniqueOrThrow({ where: { id } });
    try {
      const tools = await this.client(server).probe();
      await this.prisma.mcpServer.update({
        where: { id },
        data: { toolsCache: tools as unknown as Prisma.InputJsonValue, lastCheckedAt: new Date(), lastError: null },
      });
      return { ok: true, tools };
    } catch (err) {
      await this.prisma.mcpServer.update({ where: { id }, data: { lastCheckedAt: new Date(), lastError: (err as Error).message.slice(0, 500) } });
      return { ok: false, error: (err as Error).message, tools: [] as McpTool[] };
    }
  }

  private client(server: { url: string; authEncrypted: string | null }): McpClient {
    return new McpClient(server.url, server.authEncrypted ? this.crypto.decrypt(server.authEncrypted) : null);
  }

  private patch(input: Partial<McpInput>): Prisma.McpServerUpdateInput {
    return {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.url !== undefined ? { url: input.url.trim() } : {}),
      ...(input.auth !== undefined ? { authEncrypted: input.auth ? this.crypto.encrypt(input.auth) : null } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    };
  }

  private validate(input: McpInput) {
    if (!input.name?.trim()) throw new BadRequestException("MCP 名稱不能是空的");
    if (!/^https?:\/\//.test(input.url?.trim() ?? "")) throw new BadRequestException("MCP URL 必須是 http(s) 網址");
  }

  private async getGlobal(id: string) {
    const row = await this.prisma.mcpServer.findUnique({ where: { id } });
    if (!row || row.scope !== McpScope.global) throw new NotFoundException("MCP 伺服器不存在");
    return row;
  }

  private async getProject(id: string) {
    const row = await this.prisma.mcpServer.findUnique({ where: { id } });
    if (!row || row.scope !== McpScope.project || !row.projectId) throw new NotFoundException("MCP 伺服器不存在");
    return row;
  }
}

/** Never return the encrypted auth; expose only whether one is set. */
function publicRow(r: {
  id: string; scope: McpScope; projectId: string | null; name: string; url: string;
  authEncrypted: string | null; enabled: boolean; toolsCache: Prisma.JsonValue; lastCheckedAt: Date | null; lastError: string | null;
}) {
  return {
    id: r.id, scope: r.scope, projectId: r.projectId, name: r.name, url: r.url,
    hasAuth: !!r.authEncrypted, enabled: r.enabled, tools: r.toolsCache, lastCheckedAt: r.lastCheckedAt, lastError: r.lastError,
  };
}
