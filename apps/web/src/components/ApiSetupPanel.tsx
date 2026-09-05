import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ApiSetup, SetupStep } from "../api/types";
import { Badge, Button, Empty, ErrorText, Field, Input, Notice, Select, Spinner, Textarea } from "./ui";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Draft mirrors SetupStep but keeps headers/body as raw text for editing. */
interface StepDraft {
  label: string;
  method: string;
  path: string;
  headersText: string;
  bodyText: string;
  captures: { name: string; from: string }[];
}

function toDraft(step: SetupStep): StepDraft {
  return {
    label: step.label ?? "",
    method: step.request.method ?? "GET",
    path: step.request.path ?? "",
    headersText: step.request.headers && Object.keys(step.request.headers).length ? JSON.stringify(step.request.headers, null, 2) : "",
    bodyText: step.request.body === undefined || step.request.body === null ? "" : typeof step.request.body === "string" ? step.request.body : JSON.stringify(step.request.body, null, 2),
    captures: step.captures.map((c) => ({ name: c.name, from: c.from })),
  };
}

function blankStep(): StepDraft {
  return { label: "", method: "POST", path: "", headersText: "", bodyText: "", captures: [] };
}

function parseMaybeJson(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return t; // a raw string body is legitimate
  }
}

function draftToStep(d: StepDraft): SetupStep {
  let headers: Record<string, string> | undefined;
  const ht = d.headersText.trim();
  if (ht) {
    const parsed = JSON.parse(ht) as Record<string, unknown>;
    headers = {};
    for (const [k, v] of Object.entries(parsed)) headers[k] = String(v);
  }
  return {
    label: d.label.trim() || "步驟",
    request: { method: d.method, path: d.path.trim(), headers, body: parseMaybeJson(d.bodyText) },
    captures: d.captures.map((c) => ({ name: c.name.trim(), from: c.from.trim() })).filter((c) => c.name || c.from),
  };
}

export function ApiSetupPanel({ targetId, canEdit }: { targetId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const setup = useQuery({ queryKey: ["targets", targetId, "api-setup"], queryFn: () => api<ApiSetup>(`/targets/${targetId}/api-setup`) });
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (setup.data) setSteps(setup.data.steps.map(toDraft));
  }, [setup.data]);

  const save = useMutation({
    mutationFn: (payload: SetupStep[]) => api<ApiSetup>(`/targets/${targetId}/api-setup`, { method: "PUT", body: { steps: payload } }),
    onSuccess: (data) => {
      qc.setQueryData(["targets", targetId, "api-setup"], data);
      setSteps(data.steps.map(toDraft));
    },
  });

  const submit = () => {
    setLocalError(null);
    try {
      save.mutate(steps.map(draftToStep));
    } catch (err) {
      setLocalError(err instanceof Error ? `JSON 解析失敗:${err.message}` : String(err));
    }
  };

  const patch = (i: number, next: Partial<StepDraft>) => setSteps((s) => s.map((st, idx) => (idx === i ? { ...st, ...next } : st)));
  const move = (i: number, dir: -1 | 1) =>
    setSteps((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const copy = [...s];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });

  const capturedNames = steps.flatMap((s) => s.captures.map((c) => c.name.trim()).filter(Boolean));

  if (setup.isLoading) return <Spinner />;

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        前置流程會在<b>每一趟執行開始時跑一次</b>(不經 LLM),把 login token 這類「執行期才知道」的值擷取成具名變數。
        之後每一條 case 都能用 <code className="rounded bg-gray-100 px-1 py-0.5">{"{{名稱}}"}</code> 取用,不必每條都重登入 ——
        「共用步驟」和「測試」就此分開。
      </p>

      {capturedNames.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
          可供 case 使用的變數:
          {capturedNames.map((n) => (
            <code key={n} className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">{`{{${n}}}`}</code>
          ))}
        </div>
      )}

      {steps.length === 0 && <Empty>尚未設定前置流程。這個 Target 的每條 case 需自行處理登入等前置。</Empty>}

      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={i} className="rounded-lg border border-gray-200 bg-gray-50/60 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600">{i + 1}</span>
              <Input value={step.label} disabled={!canEdit} placeholder="這一步在做什麼,例如「登入取得 token」" onChange={(e) => patch(i, { label: e.target.value })} />
              {canEdit && (
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="上移">↑</Button>
                  <Button variant="ghost" size="sm" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="下移">↓</Button>
                  <Button variant="danger" size="sm" onClick={() => setSteps((s) => s.filter((_, idx) => idx !== i))}>移除</Button>
                </div>
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
              <Select value={step.method} disabled={!canEdit} onChange={(e) => patch(i, { method: e.target.value })} className="w-28">
                {METHODS.map((m) => <option key={m}>{m}</option>)}
              </Select>
              <Input value={step.path} disabled={!canEdit} placeholder="/api/auth/login(相對 base_url)" onChange={(e) => patch(i, { path: e.target.value })} />
            </div>

            <div className="mt-2 grid gap-2 lg:grid-cols-2">
              <Field label="Headers(JSON,可留空)">
                <Textarea rows={2} value={step.headersText} disabled={!canEdit} placeholder={'{ "Content-Type": "application/json" }'} onChange={(e) => patch(i, { headersText: e.target.value })} />
              </Field>
              <Field label="Body(JSON 或純文字,可留空)">
                <Textarea rows={2} value={step.bodyText} disabled={!canEdit} placeholder={'{ "login": "admin", "password": "{{admin_pw}}" }'} onChange={(e) => patch(i, { bodyText: e.target.value })} />
              </Field>
            </div>

            <div className="mt-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium text-gray-600">擷取變數</span>
                {canEdit && (
                  <Button variant="ghost" size="sm" onClick={() => patch(i, { captures: [...step.captures, { name: "", from: "" }] })}>+ 擷取</Button>
                )}
              </div>
              {step.captures.length === 0 ? (
                <p className="text-xs text-gray-400">這一步不擷取任何值。</p>
              ) : (
                <ul className="space-y-1.5">
                  {step.captures.map((cap, ci) => (
                    <li key={ci} className="flex items-center gap-2">
                      <Input value={cap.name} disabled={!canEdit} placeholder="變數名(token)" className="w-40"
                        onChange={(e) => patch(i, { captures: step.captures.map((c, idx) => (idx === ci ? { ...c, name: e.target.value } : c)) })} />
                      <span className="text-xs text-gray-400">←</span>
                      <Input value={cap.from} disabled={!canEdit} placeholder="回應路徑(body.access_token)"
                        onChange={(e) => patch(i, { captures: step.captures.map((c, idx) => (idx === ci ? { ...c, from: e.target.value } : c)) })} />
                      {canEdit && (
                        <Button variant="ghost" size="sm" onClick={() => patch(i, { captures: step.captures.filter((_, idx) => idx !== ci) })}>✕</Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-[11px] text-gray-400">來源路徑從回應取值:<code>body.…</code>、<code>status</code>、<code>headers.location</code>;陣列用索引 <code>body.items.0.id</code>。</p>
            </div>
          </li>
        ))}
      </ol>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
          <Button variant="secondary" size="sm" onClick={() => setSteps((s) => [...s, blankStep()])}>+ 新增步驟</Button>
          <div className="grow" />
          <Button size="sm" onClick={submit} disabled={save.isPending}>{save.isPending ? "儲存中…" : "儲存前置流程"}</Button>
        </div>
      )}
      {save.isSuccess && !save.isPending && <Notice tone="blue">已儲存。下一趟執行會套用。</Notice>}
      {localError && <p className="text-xs text-red-600">{localError}</p>}
      <ErrorText error={save.error} />
      <ErrorText error={setup.error} />
    </div>
  );
}
