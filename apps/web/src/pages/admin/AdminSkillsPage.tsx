import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "../../api/client";
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Spinner, Textarea } from "../../components/ui";
import { formatDate } from "../../lib/roles";

interface Skill {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  order: number;
  updatedAt: string;
}

/**
 * §4.8 Skills（global）: reusable house rules folded into every generation and
 * execution prompt. This is where the LLM's behaviour is shaped once for all
 * targets, instead of restating the same rules in every description.
 */
export default function AdminSkillsPage() {
  const qc = useQueryClient();
  const skills = useQuery({ queryKey: ["admin", "skills"], queryFn: () => api<Skill[]>("/admin/skills") });
  const [editing, setEditing] = useState<Skill | "new" | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin", "skills"] });

  const toggle = useMutation({
    mutationFn: (s: Skill) => api(`/admin/skills/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/admin/skills/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-4">
      <Card
        title="全域 Skills"
        actions={<Button size="sm" onClick={() => setEditing("new")}>新增 Skill</Button>}
      >
        <p className="mb-3 text-sm text-gray-500">
          Skill 是一段「不論哪個 target 都要遵守」的規則（例如日期格式、必檢查的元件、公司術語）。
          它會被自動加進生成測試案例與執行代理的系統提示裡，不用在每個描述裡重寫一遍。
          停用的 Skill 不會被套用。
        </p>
        {skills.isPending && <Spinner />}
        <ErrorText error={skills.error ?? toggle.error ?? remove.error} />
        {skills.data && (
          skills.data.length === 0 ? (
            <Empty>還沒有任何 Skill。</Empty>
          ) : (
            <ul className="space-y-2">
              {skills.data.map((s) => (
                <li key={s.id} className="rounded-md border border-gray-200 p-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gray-800">{s.name}</span>
                        <Badge tone={s.enabled ? "green" : "gray"}>{s.enabled ? "啟用中" : "已停用"}</Badge>
                      </div>
                      <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap font-sans text-xs text-gray-600">{s.content}</pre>
                      <p className="mt-1 text-xs text-gray-400">更新於 {formatDate(s.updatedAt)}</p>
                    </div>
                    <div className="flex flex-col gap-1">
                      <Button variant="ghost" size="sm" onClick={() => toggle.mutate(s)} disabled={toggle.isPending}>
                        {s.enabled ? "停用" : "啟用"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(s)}>編輯</Button>
                      <Button variant="danger" size="sm" onClick={() => remove.mutate(s.id)} disabled={remove.isPending}>刪除</Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )
        )}
      </Card>
      {editing && <SkillEditor skill={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate(); }} />}
    </div>
  );
}

function SkillEditor({ skill, onClose, onSaved }: { skill: Skill | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(skill?.name ?? "");
  const [content, setContent] = useState(skill?.content ?? "");

  const save = useMutation({
    mutationFn: () =>
      skill
        ? api(`/admin/skills/${skill.id}`, { method: "PATCH", body: { name, content } })
        : api("/admin/skills", { method: "POST", body: { name, content } }),
    onSuccess: onSaved,
  });

  return (
    <Card title={skill ? "編輯 Skill" : "新增 Skill"} actions={<Button variant="ghost" size="sm" onClick={onClose}>關閉</Button>}>
      <div className="space-y-3">
        <Field label="名稱"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：日期一律用 YYYY-MM-DD" /></Field>
        <Field label="內容（Markdown）" hint="會原樣加進系統提示，寫得具體、可執行。">
          <Textarea rows={8} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
        <div className="flex items-center gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
            {save.isPending ? "儲存中…" : "儲存"}
          </Button>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          {save.error ? <span className="text-xs text-red-600">{errorMessage(save.error)}</span> : null}
        </div>
      </div>
    </Card>
  );
}
