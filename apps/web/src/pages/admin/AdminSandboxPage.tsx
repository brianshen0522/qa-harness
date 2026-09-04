import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { SandboxSettings } from "../../api/types";
import { Button, Card, ErrorText, Field, Input, Spinner } from "../../components/ui";

type Draft = Record<keyof SandboxSettings, string>;

const FIELDS: { key: keyof SandboxSettings; label: string; type: "text" | "number"; hint?: string }[] = [
  { key: "image", label: "容器 Image", type: "text", hint: "例如 ghcr.io/anthropics/computer-use-demo:latest" },
  { key: "cpu", label: "CPU（核心數）", type: "number" },
  { key: "memoryMb", label: "記憶體（MB）", type: "number" },
  { key: "resolution", label: "解析度", type: "text", hint: "例如 1280x800" },
  { key: "maxConcurrent", label: "並行上限", type: "number" },
  { key: "maxStepsPerCase", label: "每個 case 步數上限", type: "number" },
  { key: "stepTimeoutSec", label: "每步逾時（秒）", type: "number" },
  { key: "retentionDays", label: "證據保留天數", type: "number" },
];

function toDraft(s: SandboxSettings): Draft {
  return Object.fromEntries(FIELDS.map((f) => [f.key, String(s[f.key] ?? "")])) as Draft;
}

export default function AdminSandboxPage() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["admin", "sandbox"], queryFn: () => api<SandboxSettings>("/admin/sandbox") });
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (settings.data) setDraft(toDraft(settings.data));
  }, [settings.data]);

  const save = useMutation({
    mutationFn: (body: SandboxSettings) => api<SandboxSettings>("/admin/sandbox", { method: "PUT", body: { ...body } }),
    onSuccess: (data) => {
      qc.setQueryData(["admin", "sandbox"], data);
      qc.invalidateQueries({ queryKey: ["admin", "sandbox"] });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const body: Record<string, string | number> = {};
    for (const f of FIELDS) {
      const raw = draft[f.key].trim();
      body[f.key] = f.type === "number" ? Number(raw) : raw;
    }
    save.mutate(body as unknown as SandboxSettings);
  };

  const dirty = settings.data && draft ? JSON.stringify(draft) !== JSON.stringify(toDraft(settings.data)) : false;

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">Sandbox 設定</h1>
      <Card>
        {settings.isPending && <Spinner />}
        <ErrorText error={settings.error} />
        {draft && (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              {FIELDS.map((f) => (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  <Input
                    type={f.type}
                    min={f.type === "number" ? 0 : undefined}
                    step={f.key === "cpu" ? "0.5" : undefined}
                    value={draft[f.key]}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  />
                </Field>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={!dirty || save.isPending}>
                {save.isPending ? "儲存中…" : "儲存"}
              </Button>
              {dirty && settings.data && (
                <Button variant="ghost" onClick={() => setDraft(toDraft(settings.data))}>
                  還原
                </Button>
              )}
              {save.isSuccess && !dirty && <span className="text-xs text-green-600">已儲存</span>}
            </div>
            <ErrorText error={save.error} />
          </form>
        )}
      </Card>
    </div>
  );
}
