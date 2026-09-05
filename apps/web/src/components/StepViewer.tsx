import { useEffect, useState } from "react";
import type { HttpLog, RunStepRow } from "../api/types";
import { Badge, Dialog } from "./ui";
import { PHASE_LABEL, PHASE_TONE, VERDICT_LABEL, VERDICT_TONE, formatActionParams, formatDate } from "../lib/roles";

/** One step, normalised so live events and persisted rows render the same way. */
export interface ViewStep {
  seq: number;
  phase: string;
  actionType: string;
  params: Record<string, unknown>;
  intent: string;
  observation: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  screenshotKey: string | null;
  model?: string | null;
  createdAt?: string;
  /** For api targets: the executor's request/response for this step. */
  detail?: Record<string, unknown>;
}

export interface LiveStepLike {
  caseId: string; seq: number; phase: string;
  action: { type: string; params: Record<string, unknown> };
  intent: string; observation: string;
  result: { ok: boolean; durationMs: number; error?: string };
  model: string; screenshotKey: string | null;
}

export function stepFromEvent(e: LiveStepLike): ViewStep {
  return {
    seq: e.seq, phase: e.phase, actionType: e.action?.type ?? "", params: e.action?.params ?? {},
    intent: e.intent, observation: e.observation, ok: e.result?.ok ?? true,
    durationMs: e.result?.durationMs ?? 0, error: e.result?.error,
    screenshotKey: e.screenshotKey, model: e.model,
  };
}

export function stepFromRow(r: RunStepRow): ViewStep {
  return {
    seq: r.seq, phase: r.phase, actionType: r.action?.type ?? "", params: r.action?.params ?? {},
    intent: r.intent, observation: r.observation, ok: r.result?.ok ?? true,
    durationMs: r.result?.durationMs ?? r.durationMs, error: r.result?.error,
    screenshotKey: r.screenshotKey, model: r.modelUsed, createdAt: r.createdAt, detail: r.result?.detail,
  };
}

function evidenceUrl(runId: string, key: string): string {
  return `/api/runs/${runId}/evidence?key=${encodeURIComponent(key)}`;
}

/**
 * A floating window for stepping through one case's execution: the screenshot
 * (or the HTTP request/response for api targets) fills the left, the step's
 * details sit on the right, and ←/→ or the rail switches steps. The inline list
 * was too cramped to actually read a screenshot; this gives it the whole width.
 */
export function StepViewer({
  runId,
  title,
  kind,
  steps,
  verdict,
  reasoning,
  initialSeq,
  onClose,
}: {
  runId: string;
  title: string;
  kind: "api" | "web" | "desktop" | string;
  steps: ViewStep[];
  verdict?: string | null;
  reasoning?: string;
  initialSeq?: number;
  onClose: () => void;
}) {
  const [i, setI] = useState(() => {
    const idx = steps.findIndex((s) => s.seq === initialSeq);
    return idx >= 0 ? idx : 0;
  });
  const clamp = (n: number) => Math.max(0, Math.min(steps.length - 1, n));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setI((v) => clamp(v + 1));
      if (e.key === "ArrowLeft") setI((v) => clamp(v - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length]);

  const step = steps[i];

  return (
    <Dialog
      open
      size="xl"
      onClose={onClose}
      bodyClassName="min-h-0 flex-1 overflow-hidden"
      title={
        <span className="flex items-center gap-2">
          <span className="truncate">{title}</span>
          {verdict && <Badge tone={VERDICT_TONE[verdict as keyof typeof VERDICT_TONE] ?? "gray"}>{VERDICT_LABEL[verdict as keyof typeof VERDICT_LABEL] ?? verdict}</Badge>}
        </span>
      }
    >
      {steps.length === 0 ? (
        <div className="p-8 text-center text-sm text-gray-500">這條案例還沒有步驟。</div>
      ) : (
        <div className="flex h-[78vh] min-h-0">
          {/* Left: the big view — screenshot, or HTTP request/response for api. */}
          <div className="flex min-w-0 flex-1 flex-col bg-gray-900">
            <div className="flex-1 overflow-auto">
              {step.screenshotKey ? (
                <img src={evidenceUrl(runId, step.screenshotKey)} alt={`第 ${step.seq} 步`} className="mx-auto max-h-full object-contain" />
              ) : (
                <HttpDetail step={step} />
              )}
            </div>
            {/* Step nav bar */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-gray-800 bg-gray-900 px-3 py-2 text-gray-200">
              <button type="button" className="rounded px-3 py-1 text-sm hover:bg-gray-700 disabled:opacity-40" disabled={i === 0} onClick={() => setI(clamp(i - 1))}>← 上一步</button>
              <span className="text-xs text-gray-400">第 {step.seq} 步 · {i + 1} / {steps.length}</span>
              <button type="button" className="rounded px-3 py-1 text-sm hover:bg-gray-700 disabled:opacity-40" disabled={i === steps.length - 1} onClick={() => setI(clamp(i + 1))}>下一步 →</button>
            </div>
          </div>

          {/* Right: the step rail + the current step's details. */}
          <div className="flex w-96 shrink-0 flex-col border-l border-gray-200">
            <div className="shrink-0 space-y-2 border-b border-gray-100 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-gray-800">第 {step.seq} 步</span>
                <Badge tone={(PHASE_TONE as Record<string, "blue"|"purple"|"amber"|"green">)[step.phase] ?? "gray"}>{(PHASE_LABEL as Record<string,string>)[step.phase] ?? step.phase}</Badge>
                <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">{step.actionType}</code>
                <span className={`text-xs ${step.ok ? "text-green-700" : "text-red-600"}`}>{step.ok ? "成功" : "失敗"} · {step.durationMs}ms</span>
              </div>
              {step.intent && <p className="text-sm text-gray-800"><span className="mr-1 text-xs font-medium text-gray-500">意圖</span>{step.intent}</p>}
              {step.observation && <p className="text-sm text-gray-600"><span className="mr-1 text-xs font-medium text-gray-500">觀察</span>{step.observation}</p>}
              <p className="break-all font-mono text-xs text-gray-500">{formatActionParams(step.params)}</p>
              {step.error && <p className="text-xs text-red-600">錯誤：{step.error}</p>}
              <p className="text-xs text-gray-400">{step.model ?? ""}{step.createdAt ? ` · ${formatDate(step.createdAt)}` : ""}</p>
            </div>
            {reasoning && (
              <div className="shrink-0 border-b border-gray-100 bg-amber-50/40 p-3">
                <p className="text-xs font-medium text-gray-500">判定理由</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{reasoning}</p>
              </div>
            )}
            <ol className="min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto">
              {steps.map((s, idx) => (
                <li key={s.seq}>
                  <button
                    type="button"
                    onClick={() => setI(idx)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-gray-50 ${idx === i ? "bg-blue-50" : ""}`}
                  >
                    <span className="w-8 shrink-0 text-gray-400">#{s.seq}</span>
                    <code className="shrink-0 rounded bg-gray-100 px-1 py-0.5 text-gray-700">{s.actionType}</code>
                    <span className="min-w-0 flex-1 truncate text-gray-600">{s.intent || s.observation}</span>
                    {s.screenshotKey && kind !== "api" && <span className="shrink-0 text-gray-300">🖼</span>}
                    {!s.ok && <span className="shrink-0 text-red-500">✕</span>}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function HttpDetail({ step }: { step: ViewStep }) {
  const detail = (step.detail ?? {}) as { status?: number; statusText?: string; body?: unknown; log?: HttpLog };
  const p = step.params;
  const method = String(p.method ?? (step.actionType === "http_request" ? "GET" : step.actionType)).toUpperCase();
  const path = String(p.url ?? p.path ?? "");
  const reqBody = p.body ? (typeof p.body === "string" ? p.body : JSON.stringify(p.body, null, 2)) : "";
  const resBody = typeof detail.body === "string" ? detail.body : detail.body === undefined ? "" : JSON.stringify(detail.body, null, 2);

  if (step.actionType !== "http_request") {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-gray-400">
        這一步是「{step.actionType}」,沒有畫面。
        {step.observation && <span className="mt-2 block text-gray-300">{step.observation}</span>}
      </div>
    );
  }
  return (
    <div className="grid h-full grid-rows-2 gap-2 p-3 text-gray-100">
      <div className="min-h-0 overflow-auto rounded bg-black/40 p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <code className="rounded bg-gray-700 px-1.5 py-0.5 text-xs font-semibold">{method}</code>
          <code className="break-all text-xs">{path}</code>
        </div>
        <p className="text-xs text-gray-400">Request body</p>
        <pre className="mt-1 whitespace-pre-wrap text-xs text-gray-200">{reqBody || "（無）"}</pre>
      </div>
      <div className="min-h-0 overflow-auto rounded bg-black/40 p-3">
        <div className="mb-2 flex items-center gap-2">
          {detail.status !== undefined && (
            <Badge tone={detail.status >= 500 ? "red" : detail.status >= 400 ? "amber" : "green"}>{detail.status} {detail.statusText ?? ""}</Badge>
          )}
          <span className="text-xs text-gray-400">{step.durationMs}ms</span>
        </div>
        <p className="text-xs text-gray-400">Response body</p>
        <pre className="mt-1 whitespace-pre-wrap text-xs text-gray-200">{resBody || "（無內容）"}</pre>
      </div>
    </div>
  );
}
