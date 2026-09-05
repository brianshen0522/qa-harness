import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../../api/client";
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Spinner } from "../../components/ui";
import { formatDate } from "../../lib/roles";

interface McpTool { name: string; description?: string }
interface McpServer {
  id: string; name: string; url: string; hasAuth: boolean; enabled: boolean;
  tools: McpTool[]; lastCheckedAt: string | null; lastError: string | null;
}
interface TestResult { ok: boolean; error?: string; tools: McpTool[] }

/**
 * §4.8 / §6.2 MCP（global）: register Model Context Protocol servers whose tools
 * the agent and discussion can call. Test connection lists the tools live.
 */
export default function AdminMcpPage() {
  const qc = useQueryClient();
  const servers = useQuery({ queryKey: ["admin", "mcp"], queryFn: () => api<McpServer[]>("/admin/mcp") });
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin", "mcp"] });

  return (
    <div className="space-y-4">
      <Card title="全域 MCP 伺服器" actions={<Button size="sm" onClick={() => setEditing("new")}>新增 MCP</Button>}>
        <p className="mb-3 text-sm text-gray-500">
          MCP（Model Context Protocol）伺服器提供外部工具（抓網頁、查資料庫、讀 repo…）。
          設定後,執行代理與討論區可以呼叫它的工具。連線測試會即時列出可用工具。
        </p>
        {servers.isPending && <Spinner />}
        <ErrorText error={servers.error} />
        {servers.data && (servers.data.length === 0 ? <Empty>還沒有任何 MCP 伺服器。</Empty> : (
          <ul className="space-y-2">
            {servers.data.map((s) => <ServerRow key={s.id} server={s} onChanged={invalidate} onEdit={() => setEditing(s)} />)}
          </ul>
        ))}
      </Card>
      {editing && <Editor server={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate(); }} />}
    </div>
  );
}

function ServerRow({ server, onChanged, onEdit }: { server: McpServer; onChanged: () => void; onEdit: () => void }) {
  const [result, setResult] = useState<TestResult | null>(null);
  const test = useMutation({
    mutationFn: () => api<TestResult>(`/admin/mcp/${server.id}/test`, { method: "POST" }),
    onSuccess: (r) => { setResult(r); onChanged(); },
  });
  const toggle = useMutation({
    mutationFn: () => api(`/admin/mcp/${server.id}`, { method: "PATCH", body: { enabled: !server.enabled } }),
    onSuccess: onChanged,
  });
  const remove = useMutation({ mutationFn: () => api(`/admin/mcp/${server.id}`, { method: "DELETE" }), onSuccess: onChanged });
  const tools = result?.tools ?? server.tools ?? [];

  return (
    <li className="rounded-md border border-gray-200 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-gray-800">{server.name}</span>
            <Badge tone={server.enabled ? "green" : "gray"}>{server.enabled ? "啟用中" : "已停用"}</Badge>
            {server.hasAuth && <Badge tone="blue">有 auth</Badge>}
          </div>
          <p className="mt-0.5 font-mono text-xs text-gray-500">{server.url}</p>
          {server.lastCheckedAt && (
            <p className="text-xs text-gray-400">
              上次測試 {formatDate(server.lastCheckedAt)}
              {server.lastError ? <span className="text-red-600">：{server.lastError}</span> : "，正常"}
            </p>
          )}
          {tools.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {tools.map((t) => <Badge key={t.name} tone="purple">{t.name}</Badge>)}
            </div>
          )}
          {result && !result.ok && <p className="mt-1 text-xs text-red-600">連線失敗：{result.error}</p>}
        </div>
        <div className="flex flex-col gap-1">
          <Button variant="secondary" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? "測試中…" : "測試連線"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toggle.mutate()} disabled={toggle.isPending}>{server.enabled ? "停用" : "啟用"}</Button>
          <Button variant="ghost" size="sm" onClick={onEdit}>編輯</Button>
          <Button variant="danger" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>刪除</Button>
        </div>
      </div>
      <ErrorText error={test.error ?? toggle.error ?? remove.error} />
    </li>
  );
}

function Editor({ server, onClose, onSaved }: { server: McpServer | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [auth, setAuth] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { name, url };
      if (auth) body.auth = auth;
      return server ? api(`/admin/mcp/${server.id}`, { method: "PATCH", body }) : api("/admin/mcp", { method: "POST", body });
    },
    onSuccess: onSaved,
  });
  return (
    <Card title={server ? "編輯 MCP" : "新增 MCP"} actions={<Button variant="ghost" size="sm" onClick={onClose}>關閉</Button>}>
      <div className="space-y-2">
        <Field label="名稱"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：內部知識庫" /></Field>
        <Field label="URL" hint="MCP 伺服器的 Streamable HTTP 端點"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" /></Field>
        <Field label={server?.hasAuth ? "Auth（留空保留原本）" : "Auth（選填，Bearer token）"}>
          <Input value={auth} onChange={(e) => setAuth(e.target.value)} placeholder="token 或 Bearer xxx" />
        </Field>
        <div className="flex items-center gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim() || !url.trim()}>{save.isPending ? "儲存中…" : "儲存"}</Button>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          {save.error ? <span className="text-xs text-red-600">{errorMessage(save.error)}</span> : null}
        </div>
      </div>
    </Card>
  );
}
