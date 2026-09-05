import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Spinner, Textarea } from "./ui";
import { hasRole } from "../lib/roles";
import type { Role } from "../api/types";

interface Skill {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}

/**
 * §4.8 project-scoped skills. House rules that apply only to this project's
 * targets, folded into its generation and execution prompts alongside the
 * global ones.
 */
export function ProjectSkills({ projectId, myRole }: { projectId: string; myRole: Role | undefined }) {
  const canEdit = hasRole(myRole, "editor");
  const qc = useQueryClient();
  const key = ["project", projectId, "skills"];
  const skills = useQuery({ queryKey: key, queryFn: () => api<Skill[]>(`/projects/${projectId}/skills`) });
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const toggle = useMutation({
    mutationFn: (s: Skill) => api(`/skills/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/skills/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  return (
    <Card
      title="專案 Skills"
      actions={canEdit && <Button size="sm" onClick={() => setEditing("new")}>新增</Button>}
    >
      <p className="mb-2 text-xs text-gray-500">
        只套用在這個專案的規則，會和全域 Skills 一起加進生成與執行的提示。
      </p>
      {skills.isPending && <Spinner />}
      <ErrorText error={skills.error ?? toggle.error ?? remove.error} />
      {skills.data && (
        skills.data.length === 0 ? (
          <Empty>還沒有專案 Skill。</Empty>
        ) : (
          <ul className="space-y-2">
            {skills.data.map((s) => (
              <li key={s.id} className="rounded-md border border-gray-200 p-2">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-800">{s.name}</span>
                      <Badge tone={s.enabled ? "green" : "gray"}>{s.enabled ? "啟用中" : "已停用"}</Badge>
                    </div>
                    <pre className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap font-sans text-xs text-gray-600">{s.content}</pre>
                  </div>
                  {canEdit && (
                    <div className="flex flex-col gap-1">
                      <Button variant="ghost" size="sm" onClick={() => toggle.mutate(s)} disabled={toggle.isPending}>
                        {s.enabled ? "停用" : "啟用"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(s)}>編輯</Button>
                      <Button variant="danger" size="sm" onClick={() => remove.mutate(s.id)} disabled={remove.isPending}>刪除</Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )
      )}
      {editing && (
        <Editor
          projectId={projectId}
          skill={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); invalidate(); }}
        />
      )}
    </Card>
  );
}

function Editor({ projectId, skill, onClose, onSaved }: { projectId: string; skill: Skill | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(skill?.name ?? "");
  const [content, setContent] = useState(skill?.content ?? "");
  const save = useMutation({
    mutationFn: () =>
      skill
        ? api(`/skills/${skill.id}`, { method: "PATCH", body: { name, content } })
        : api(`/projects/${projectId}/skills`, { method: "POST", body: { name, content } }),
    onSuccess: onSaved,
  });
  return (
    <div className="mt-3 space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3">
      <Field label="名稱"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="內容（Markdown）"><Textarea rows={5} value={content} onChange={(e) => setContent(e.target.value)} /></Field>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
          {save.isPending ? "儲存中…" : "儲存"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
        {save.error ? <span className="text-xs text-red-600">{errorMessage(save.error)}</span> : null}
      </div>
    </div>
  );
}
