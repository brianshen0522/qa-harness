import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Spinner } from "./ui";
import { hasRole } from "../lib/roles";
import type { Role } from "../api/types";

interface McpTool { name: string; description?: string }
interface McpServer { id: string; name: string; url: string; hasAuth: boolean; enabled: boolean; tools: McpTool[]; lastError: string | null }

/** §6.2 project-scoped MCP servers, alongside the global ones. */
export function ProjectMcp({ projectId, myRole }: { projectId: string; myRole: Role | undefined }) {
  const canEdit = hasRole(myRole, "editor");
  const qc = useQueryClient();
  const key = ["project", projectId, "mcp"];
  const servers = useQuery({ queryKey: key, queryFn: () => api<McpServer[]>(`/projects/${projectId}/mcp`) });
  const [adding, setAdding] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  return (
    <Card title="專案 MCP 伺服器" actions={canEdit && <Button size="sm" onClick={() => setAdding(true)}>新增</Button>}>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">只給這個專案用的 MCP 工具,和全域的一起提供給執行代理。</p>
      {servers.isPending && <Spinner />}
      <ErrorText error={servers.error} />
      {servers.data && (servers.data.length === 0 ? <Empty>還沒有專案 MCP。</Empty> : (
        <ul className="space-y-2">
          {servers.data.map((s) => <Row key={s.id} projectId={projectId} server={s} canEdit={canEdit} onChanged={invalidate} />)}
        </ul>
      ))}
      {adding && <Editor projectId={projectId} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); invalidate(); }} />}
    </Card>
  );
}

function Row({ projectId, server, canEdit, onChanged }: { projectId: string; server: McpServer; canEdit: boolean; onChanged: () => void }) {
  const [tools, setTools] = useState<McpTool[]>(server.tools ?? []);
  const [err, setErr] = useState<string | null>(server.lastError);
  const test = useMutation({
    mutationFn: () => api<{ ok: boolean; error?: string; tools: McpTool[] }>(`/mcp/${server.id}/test`, { method: "POST" }),
    onSuccess: (r) => { setTools(r.tools); setErr(r.ok ? null : r.error ?? "失敗"); onChanged(); },
  });
  const toggle = useMutation({ mutationFn: () => api(`/mcp/${server.id}`, { method: "PATCH", body: { enabled: !server.enabled } }), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: () => api(`/mcp/${server.id}`, { method: "DELETE" }), onSuccess: onChanged });

  return (
    <li className="rounded-md border border-gray-200 dark:border-gray-700 p-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{server.name}</span>
            <Badge tone={server.enabled ? "green" : "gray"}>{server.enabled ? "啟用中" : "已停用"}</Badge>
            {server.hasAuth && <Badge tone="blue">有 auth</Badge>}
          </div>
          <p className="font-mono text-xs text-gray-500 dark:text-gray-400">{server.url}</p>
          {tools.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{tools.map((t) => <Badge key={t.name} tone="purple">{t.name}</Badge>)}</div>}
          {err && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{err}</p>}
        </div>
        {canEdit && (
          <div className="flex flex-col gap-1">
            <Button variant="secondary" size="sm" onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? "測試中…" : "測試"}</Button>
            <Button variant="ghost" size="sm" onClick={() => toggle.mutate()} disabled={toggle.isPending}>{server.enabled ? "停用" : "啟用"}</Button>
            <Button variant="danger" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>刪除</Button>
          </div>
        )}
      </div>
    </li>
  );
}

function Editor({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState("");
  const save = useMutation({
    mutationFn: () => api(`/projects/${projectId}/mcp`, { method: "POST", body: { name, url, ...(auth ? { auth } : {}) } }),
    onSuccess: onSaved,
  });
  return (
    <div className="mt-3 space-y-2 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3">
      <Field label="名稱"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" /></Field>
      <Field label="Auth(選填)"><Input value={auth} onChange={(e) => setAuth(e.target.value)} /></Field>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !name.trim() || !url.trim()}>{save.isPending ? "儲存中…" : "儲存"}</Button>
        <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
        {save.error ? <span className="text-xs text-red-600 dark:text-red-400">{errorMessage(save.error)}</span> : null}
      </div>
    </div>
  );
}
