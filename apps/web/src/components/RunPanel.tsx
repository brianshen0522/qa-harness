import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiEventSource } from "../api/client";
import type {
  AbortRunResult,
  AddCaseResult,
  FindingStatus,
  HttpLog,
  Role,
  RunCase,
  RunDetail,
  RunEvent,
  FindingCaseDraft,
  RunFindingRow,
  RunLlmUsage,
  RunListItem,
  RunStepRow,
  SkipCaseResult,
  StartRunResult,
  CaseType,
  Priority,
  TargetKind,
  TestCase,
  TestCaseListData,
  TestResultRow,
  Verdict,
} from "../api/types";
import { Badge, Button, Card, Dialog, Empty, ErrorText, Field, Input, Notice, Select, Spinner, Table, Textarea } from "./ui";
import {
  ACTIVE_RUN_STATUSES,
  CASE_TYPE_LABEL,
  CASE_TYPE_TONE,
  FINDING_STATUSES,
  FINDING_STATUS_LABEL,
  FINDING_STATUS_TONE,
  CASE_TYPES,
  PHASES,
  PHASE_LABEL,
  PHASE_TONE,
  PRIORITIES,
  QUEUE_STATUS_LABEL,
  QUEUE_STATUS_TONE,
  RUN_STATUS_LABEL,
  RUN_STATUS_TONE,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  VERDICTS,
  VERDICT_LABEL,
  VERDICT_TONE,
  formatActionParams,
  formatDate,
  formatDuration,
  hasRole,
  pauseReasonLabel,
} from "../lib/roles";

const runsKey = (targetId: string) => ["target", targetId, "runs"];
const runKey = (runId: string) => ["run", runId];
const stepsKey = (runId: string) => ["run", runId, "steps"];
const casesKey = (targetId: string) => ["target", targetId, "test-cases"];

type StepEvent = Extract<RunEvent, { type: "step" }>;
type FindingEvent = Extract<RunEvent, { type: "finding" }>;
type CaseFinishedEvent = Extract<RunEvent, { type: "case_finished" }>;
type PausedEvent = Extract<RunEvent, { type: "paused" }>;
type SandboxEvent = Extract<RunEvent, { type: "sandbox" }>;

/** Evidence is served as raw bytes off the run, so it can be an `<img src>` directly. */
function evidenceUrl(runId: string, key: string): string {
  return `/api/runs/${runId}/evidence?key=${encodeURIComponent(key)}`;
}

const clampWidth = (w: number, min: number, max: number) => Math.min(max, Math.max(min, w));

/**
 * The live-run sidebar is drag-resizable and collapsible. During a run the live
 * view is the thing worth watching, so the operator gets to decide how much
 * room the detail panel takes — and can push it out of the way entirely.
 */
function useResizableSidebar(key: string, initial = 400, min = 300, max = 760) {
  const [width, setWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return v >= min && v <= max ? v : initial;
    } catch {
      return initial;
    }
  });
  const [collapsed, setCollapsed] = useState(false);
  const drag = useRef<{ startX: number; startW: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      // Sidebar sits on the right, so dragging the handle left widens it.
      setWidth(clampWidth(drag.current.startW + (drag.current.startX - e.clientX), min, max));
    };
    const onUp = () => {
      if (!drag.current) return;
      drag.current = null;
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(key, String(widthRef.current));
      } catch {
        /* private mode; the width just won't persist */
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [key, min, max]);

  const onHandleDown = (e: ReactMouseEvent) => {
    drag.current = { startX: e.clientX, startW: widthRef.current };
    document.body.style.userSelect = "none";
    e.preventDefault();
  };

  return { width, collapsed, setCollapsed, onHandleDown };
}

/** A titled, individually collapsible section inside the live-run sidebar. */
function LivePanel({
  title,
  count,
  defaultOpen = true,
  scroll = false,
  children,
}: {
  title: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  scroll?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-gray-800">
          {title}
          {count !== undefined && <span className="text-xs font-normal text-gray-400">{count}</span>}
        </span>
        <span className="text-xs text-gray-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className={`border-t border-gray-100 p-3 ${scroll ? "max-h-[42vh] overflow-y-auto" : ""}`}>{children}</div>}
    </section>
  );
}

/**
 * Spec §4.6 執行中頁面 and §4.7 結果頁 in one tab: while a run is in flight this is
 * the live page (sandbox view + three levels of progress + queue + findings); once
 * nothing is running it becomes the results view for whichever run is picked.
 */
export function RunPanel({ targetId, kind, myRole }: { targetId: string; kind: TargetKind; myRole: Role }) {
  const qc = useQueryClient();
  const canEdit = hasRole(myRole, "editor");

  const [events, setEvents] = useState<RunEvent[]>([]);
  const [live, setLive] = useState(false);
  /** The run list says something is active but the stream had nothing to replay. */
  const [detached, setDetached] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  /** Re-attaching is worth doing once per mount, however the runs query settles. */
  const attachedRef = useRef(false);

  const runs = useQuery({
    queryKey: runsKey(targetId),
    queryFn: () => api<RunListItem[]>(`/targets/${targetId}/runs`),
  });

  // The run lives on the server; leaving the tab only hangs up this reader.
  useEffect(() => () => sourceRef.current?.close(), []);

  const finish = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setLive(false);
    qc.invalidateQueries({ queryKey: runsKey(targetId) });
  }, [qc, targetId]);

  /**
   * Attach to the target's run stream. The server replays everything that has
   * happened so far on connect and `RunEvent` carries no sequence number, so each
   * `open` starts the transcript over instead of appending a second copy.
   */
  const attach = useCallback(() => {
    if (sourceRef.current) return;
    setStreamError(null);
    setDetached(false);
    setLive(true);
    const source = apiEventSource(`/targets/${targetId}/runs/stream`);
    sourceRef.current = source;
    let seen = 0;
    source.onopen = () => {
      seen = 0;
      setEvents([]);
    };
    source.onmessage = (e) => {
      let event: RunEvent;
      try {
        event = JSON.parse(e.data as string) as RunEvent;
      } catch {
        return; // a malformed frame is not worth tearing the panel down over
      }
      // Nothing to attach to: the run ended between the list query and this
      // connect, which is not a failure worth shouting about.
      if (event.type === "error" && seen === 0) {
        setDetached(true);
        finish();
        return;
      }
      seen++;
      setEvents((prev) => [...prev, event]);
      if (event.type === "error") setStreamError(event.message);
      if (event.type === "run_finished") setSelectedRunId(event.runId);
      // The server ends the stream on a terminal event; close first so
      // `EventSource` does not reconnect and replay it forever.
      if (event.type === "run_finished" || event.type === "error") finish();
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) finish();
    };
  }, [targetId, finish]);

  // A reload during a long run should pick the run back up, not look idle.
  useEffect(() => {
    if (attachedRef.current || live || !runs.data) return;
    const latest = runs.data[0];
    if (!latest || !ACTIVE_RUN_STATUSES.includes(latest.status)) return;
    attachedRef.current = true;
    attach();
  }, [runs.data, live, attach]);

  const state = useMemo(() => digest(events), [events]);
  const liveRunId = state.runId ?? (runs.data?.[0] && ACTIVE_RUN_STATUSES.includes(runs.data[0].status) ? runs.data[0].id : null);

  // The queue itself lives in the run row, so a case added mid-run has to be re-read.
  const queueRevision = state.added.length;
  useEffect(() => {
    if (liveRunId) qc.invalidateQueries({ queryKey: runKey(liveRunId) });
  }, [queueRevision, liveRunId, qc]);

  useEffect(() => {
    if (!state.runFinished) return;
    qc.invalidateQueries({ queryKey: runKey(state.runFinished.runId) });
    qc.invalidateQueries({ queryKey: stepsKey(state.runFinished.runId) });
  }, [state.runFinished, qc]);

  const start = useMutation({
    mutationFn: (caseIds: string[] | undefined) =>
      api<StartRunResult>(`/targets/${targetId}/runs`, {
        method: "POST",
        body: caseIds && caseIds.length ? { caseIds } : {},
      }),
    onSuccess: () => {
      attachedRef.current = true;
      setEvents([]);
      attach();
      qc.invalidateQueries({ queryKey: runsKey(targetId) });
    },
  });

  const abort = useMutation({
    mutationFn: () => api<AbortRunResult>(`/targets/${targetId}/runs/abort`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: runsKey(targetId) }),
  });

  const skip = useMutation({
    mutationFn: (caseId: string) =>
      api<SkipCaseResult>(`/targets/${targetId}/runs/skip-case`, { method: "POST", body: { caseId } }),
    onSuccess: () => {
      if (liveRunId) qc.invalidateQueries({ queryKey: runKey(liveRunId) });
    },
  });

  const addCase = useMutation({
    mutationFn: (caseId: string) =>
      api<AddCaseResult>(`/targets/${targetId}/runs/add-case`, { method: "POST", body: { caseId } }),
    onSuccess: () => {
      if (liveRunId) qc.invalidateQueries({ queryKey: runKey(liveRunId) });
    },
  });

  const rerun = useMutation({
    mutationFn: (runId: string) => api<StartRunResult>(`/runs/${runId}/rerun-failed`, { method: "POST" }),
    onSuccess: () => {
      attachedRef.current = true;
      setEvents([]);
      attach();
      qc.invalidateQueries({ queryKey: runsKey(targetId) });
    },
  });

  if (runs.isPending) return <Spinner />;
  if (runs.isError) return <ErrorText error={runs.error} />;

  const latest = runs.data[0] ?? null;
  const listActive = !!latest && ACTIVE_RUN_STATUSES.includes(latest.status) && !detached;
  const inFlight = live || listActive;

  const resultsRunId =
    selectedRunId && runs.data.some((r) => r.id === selectedRunId) ? selectedRunId : (latest?.id ?? null);

  return (
    <div className="space-y-4">
      {streamError && <Notice tone="red">執行串流中斷：{streamError}</Notice>}
      <ErrorText error={start.error} />
      <ErrorText error={rerun.error} />

      {inFlight ? (
        <LiveRun
          targetId={targetId}
          kind={kind}
          canEdit={canEdit}
          live={live}
          runId={liveRunId}
          state={state}
          onAbort={() => abort.mutate()}
          aborting={abort.isPending}
          abortError={abort.error}
          onSkip={(caseId) => skip.mutate(caseId)}
          skipError={skip.error}
          onAddCase={(caseId) => addCase.mutate(caseId)}
          addError={addCase.error}
          adding={addCase.isPending}
        />
      ) : (
        <>
          <StartPanel
            targetId={targetId}
            canEdit={canEdit}
            starting={start.isPending}
            onStart={(caseIds) => start.mutate(caseIds)}
          />
          <ResultsView
            targetId={targetId}
            runs={runs.data}
            runId={resultsRunId}
            canEdit={canEdit}
            onSelect={setSelectedRunId}
            onRefresh={() => {
              runs.refetch();
              if (resultsRunId) {
                qc.invalidateQueries({ queryKey: runKey(resultsRunId) });
                qc.invalidateQueries({ queryKey: stepsKey(resultsRunId) });
              }
            }}
            onRerun={(runId) => rerun.mutate(runId)}
            rerunning={rerun.isPending}
          />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 事件彙整 */

interface LiveState {
  runId: string | null;
  total: number;
  index: number;
  order: string[];
  titles: Map<string, string>;
  started: Set<string>;
  finished: Map<string, CaseFinishedEvent>;
  skipped: Set<string>;
  added: string[];
  currentCaseId: string | null;
  stepsByCase: Map<string, StepEvent[]>;
  findings: FindingEvent[];
  findingCase: Map<string, string | null>;
  sandbox: SandboxEvent | null;
  paused: PausedEvent | null;
  resumed: string | null;
  runFinished: Extract<RunEvent, { type: "run_finished" }> | null;
}

/** Fold the replayed stream into the shape the live page renders from. */
function digest(events: RunEvent[]): LiveState {
  const state: LiveState = {
    runId: null,
    total: 0,
    index: 0,
    order: [],
    titles: new Map(),
    started: new Set(),
    finished: new Map(),
    skipped: new Set(),
    added: [],
    currentCaseId: null,
    stepsByCase: new Map(),
    findings: [],
    findingCase: new Map(),
    sandbox: null,
    paused: null,
    resumed: null,
    runFinished: null,
  };

  for (const event of events) {
    switch (event.type) {
      case "run_started":
        state.runId = event.runId;
        state.total = event.total;
        break;
      case "sandbox":
        state.sandbox = event;
        break;
      case "case_started":
        state.titles.set(event.caseId, event.title);
        state.started.add(event.caseId);
        state.index = event.index;
        state.total = event.total;
        state.currentCaseId = event.caseId;
        if (!state.order.includes(event.caseId)) state.order.push(event.caseId);
        break;
      case "step": {
        const list = state.stepsByCase.get(event.caseId) ?? [];
        list.push(event);
        state.stepsByCase.set(event.caseId, list);
        break;
      }
      case "finding":
        state.findings.push(event);
        state.findingCase.set(event.id, event.caseId);
        break;
      case "case_finished":
        state.finished.set(event.caseId, event);
        if (state.currentCaseId === event.caseId) state.currentCaseId = null;
        break;
      case "case_skipped":
        state.titles.set(event.caseId, event.title);
        state.skipped.add(event.caseId);
        break;
      case "case_added":
        state.titles.set(event.caseId, event.title);
        state.total = event.total;
        state.added.push(event.caseId);
        if (!state.order.includes(event.caseId)) state.order.push(event.caseId);
        break;
      case "paused":
        state.paused = event;
        state.resumed = null;
        break;
      case "resumed":
        state.paused = null;
        state.resumed = event.message;
        break;
      case "run_finished":
        state.runFinished = event;
        state.currentCaseId = null;
        break;
      default:
        break;
    }
  }
  return state;
}

/** The newest step of the whole run, whichever case it belongs to. */
function latestStep(state: LiveState): StepEvent | null {
  let newest: StepEvent | null = null;
  for (const steps of state.stepsByCase.values()) {
    const last = steps[steps.length - 1];
    if (!last) continue;
    if (!newest || last.seq > newest.seq) newest = last;
  }
  return newest;
}

/* -------------------------------------------------------------- 開始執行面板 */

function flattenCases(data: TestCaseListData | undefined): TestCase[] {
  if (!data) return [];
  return [...data.features.flatMap((f) => f.cases), ...data.unassigned];
}

function StartPanel({
  targetId,
  canEdit,
  starting,
  onStart,
}: {
  targetId: string;
  canEdit: boolean;
  starting: boolean;
  onStart: (caseIds: string[] | undefined) => void;
}) {
  const [mode, setMode] = useState<"all" | "pick">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const list = useQuery({
    queryKey: casesKey(targetId),
    queryFn: () => api<TestCaseListData>(`/targets/${targetId}/test-cases`),
  });

  const all = flattenCases(list.data);
  const active = all.filter((c) => c.status === "active");
  const count = mode === "all" ? active.length : picked.size;
  const locked = list.data?.target.locked ?? false;

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card title="開始執行">
      <div className="space-y-3">
        <p className="text-xs text-gray-400">
          執行會起一個 sandbox（api Target 例外），逐條跑測試案例並即時判定。同一個 Target 一次只能有一個執行。
        </p>

        {!canEdit && <Notice tone="blue">需要編輯者以上的角色才能啟動執行。</Notice>}
        {locked && <Notice>這個 Target 已經有一個執行在進行中，請等它結束或先中止。</Notice>}

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-52">
            <span className="mb-1 block text-xs font-medium text-gray-600">範圍</span>
            <Select value={mode} disabled={!canEdit || locked} onChange={(e) => setMode(e.target.value as "all" | "pick")}>
              <option value="all">全部「正常」狀態的案例</option>
              <option value="pick">自選案例</option>
            </Select>
          </div>
          <Button disabled={!canEdit || locked || starting || count === 0} onClick={() => onStart(mode === "all" ? undefined : [...picked])}>
            {starting ? "啟動中…" : `開始執行（${count} 條）`}
          </Button>
          {mode === "all" && (
            <span className="text-xs text-gray-500">
              狀態為「正常」的案例共 {active.length} 條，全部會依順序執行。
            </span>
          )}
          {mode === "pick" && count === 0 && <span className="text-xs text-gray-500">請至少勾選一條案例。</span>}
        </div>

        {list.isPending && <Spinner />}
        <ErrorText error={list.error} />

        {mode === "pick" && list.data && (
          <div className="max-h-80 overflow-y-auto rounded-md border border-gray-200">
            {all.length === 0 ? (
              <Empty>還沒有測試案例，先到「測試清單」生成或新增。</Empty>
            ) : (
              <ul className="divide-y divide-gray-100">
                {all.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={picked.has(c.id)}
                      disabled={!canEdit || locked}
                      onChange={() => toggle(c.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate">{c.title}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-gray-400">
                        <Badge tone="gray">{c.priority}</Badge>
                        <Badge tone={CASE_TYPE_TONE[c.type]}>{CASE_TYPE_LABEL[c.type]}</Badge>
                        {c.status !== "active" && <span className="text-amber-700">狀態：{c.status}</span>}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ §4.6 執行中頁面 */

function LiveRun({
  targetId,
  kind,
  canEdit,
  live,
  runId,
  state,
  onAbort,
  aborting,
  abortError,
  onSkip,
  skipError,
  onAddCase,
  addError,
  adding,
}: {
  targetId: string;
  kind: TargetKind;
  canEdit: boolean;
  live: boolean;
  runId: string | null;
  state: LiveState;
  onAbort: () => void;
  aborting: boolean;
  abortError: unknown;
  onSkip: (caseId: string) => void;
  skipError: unknown;
  onAddCase: (caseId: string) => void;
  addError: unknown;
  adding: boolean;
}) {
  const [openCase, setOpenCase] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Persisted state is the source of truth; the SSE stream only adds liveness.
  // Both are polled so that returning to this tab (or a dropped stream) shows
  // real progress from the server, never a blank reset. §4.6.
  const detail = useQuery({
    queryKey: runKey(runId ?? "none"),
    queryFn: () => api<RunDetail>(`/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: 4000,
  });
  // `api` runs have no screen, so the live view leans on the step rows for the
  // request/response — poll all of them there. For web runs, fetching every
  // step on a poll is wasteful, so persisted steps are pulled per expanded case.
  const steps = useQuery({
    queryKey: stepsKey(runId ?? "none"),
    queryFn: () => api<RunStepRow[]>(`/runs/${runId}/steps`),
    enabled: !!runId && kind === "api",
    refetchInterval: kind === "api" ? 4000 : false,
  });
  const openCaseSteps = useQuery({
    queryKey: [...stepsKey(runId ?? "none"), openCase ?? "none"],
    queryFn: () => api<RunStepRow[]>(`/runs/${runId}/steps?caseId=${openCase}`),
    enabled: !!runId && kind !== "api" && !!openCase,
    refetchInterval: 4000,
  });

  const detailByCase = useMemo(
    () => new Map((detail.data?.cases ?? []).map((c) => [c.caseId, c])),
    [detail.data],
  );

  const current =
    state.currentCaseId ?? detail.data?.cases.find((c) => c.queueStatus === "running")?.caseId ?? null;

  const queue: { caseId: string; title: string; order: number }[] = detail.data
    ? detail.data.cases.map((c) => ({ caseId: c.caseId, title: c.testCase.title, order: c.order }))
    : state.order.map((id, i) => ({ caseId: id, title: state.titles.get(id) ?? id, order: i }));

  /** Merge live event state over persisted detail for one case. */
  const caseView = (caseId: string) => {
    const liveFin = state.finished.get(caseId);
    const dc = detailByCase.get(caseId);
    const liveSteps = state.stepsByCase.get(caseId) ?? [];
    // Persisted steps only for the case currently expanded (fetched on demand).
    const persisted = openCase === caseId ? (kind === "api" ? (steps.data ?? []).filter((s) => s.testCaseId === caseId) : openCaseSteps.data ?? []) : [];
    const verdict = liveFin?.verdict ?? dc?.result?.verdict ?? null;
    const status = verdict
      ? "done"
      : state.skipped.has(caseId) || dc?.queueStatus === "skipped"
        ? "skipped"
        : caseId === current
          ? "running"
          : "queued";
    return {
      status: status as "done" | "skipped" | "running" | "queued",
      verdict,
      reasoning: liveFin?.reasoning ?? dc?.result?.llmReasoning ?? "",
      possiblyChanged: liveFin?.possiblyChanged ?? dc?.result?.possiblyChanged ?? false,
      liveSteps,
      persistedSteps: persisted,
      stepCount: liveSteps.length || dc?.result?.stepCount || 0,
    };
  };

  const step = latestStep(state);
  // The latest action strip: live step, or the last persisted step after a remount.
  const lastPersisted = (steps.data ?? []).at(-1) ?? null;

  const inRun = new Set(queue.map((q) => q.caseId));
  const viewUrl = state.sandbox?.viewUrl ?? detail.data?.run.viewUrl ?? null;
  const sandboxName = state.sandbox?.name ?? detail.data?.run.sandboxName ?? null;
  // Count done from whichever source knows more, so progress never regresses.
  const persistedDone = detail.data?.cases.filter((c) => c.result).length ?? 0;
  const done = Math.max(state.finished.size + state.skipped.size, persistedDone);
  const total = Math.max(state.total, queue.length);
  const runningIndex = Math.max(state.index, Math.min(done + 1, total)) || Math.min(done + 1, total);
  const pct = total ? Math.round((done / total) * 100) : 0;

  const { width, collapsed, setCollapsed, onHandleDown } = useResizableSidebar("qa.run.sidebar");

  const liveView =
    kind === "api" ? (
      <ApiLiveView runId={runId} step={step} rows={steps.data} loading={steps.isPending} fill />
    ) : viewUrl ? (
      <iframe
        src={viewUrl}
        title="執行即時畫面"
        className="h-full w-full flex-1 rounded-md border border-gray-800 bg-black"
      />
    ) : (
      <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-gray-300 bg-gray-50 text-sm text-gray-500">
        {state.sandbox?.note ?? "sandbox 還在啟動，畫面稍後出現。"}
      </div>
    );

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={state.paused ? "amber" : "blue"}>{state.paused ? "等待 LLM" : "執行中"}</Badge>
          <span className="text-sm font-semibold text-gray-800">第 {runningIndex} / {total} 條</span>
          <div className="h-2 w-40 overflow-hidden rounded bg-gray-100">
            <div className="h-2 rounded bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs text-gray-400">已完成 {done}</span>
          {sandboxName && <span className="hidden text-xs text-gray-400 sm:inline">sandbox：{sandboxName}</span>}
          {!live && <span className="text-xs text-amber-700">串流已中斷，重新整理可再接上。</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? "顯示詳情面板" : "隱藏詳情面板"}
          </Button>
          {canEdit && <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>加入案例</Button>}
          <Button variant="danger" size="sm" disabled={!canEdit || aborting} onClick={onAbort}>
            {aborting ? "中止中…" : "中止"}
          </Button>
        </div>
      </div>
      <ErrorText error={abortError} />
      <ErrorText error={skipError} />
      <ErrorText error={detail.error} />

      {state.paused && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
          <p className="text-sm font-semibold">等待 LLM</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{state.paused.message}</p>
          <p className="mt-1 text-xs">{pauseReasonLabel(state.paused.reason)}。進度都保留著，有模型恢復後會自己接續。</p>
        </div>
      )}
      {state.resumed && (
        <p className="rounded-md border border-green-200 bg-green-50 px-3 py-1.5 text-sm text-green-800">{state.resumed}</p>
      )}

      {/* Cockpit: big live view + resizable, collapsible detail sidebar. */}
      <div className="flex h-[calc(100vh-13rem)] min-h-[520px] items-stretch">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {liveView}
          {/* The latest action, always visible under the live view. Live event
              first, then the last persisted step so a remount is not blank. */}
          <div className="shrink-0 rounded-md border border-gray-200 bg-white px-3 py-2">
            {(() => {
              const s = step
                ? { seq: step.seq, type: step.action.type, ok: step.result.ok, ms: step.result.durationMs, intent: step.intent }
                : lastPersisted
                  ? { seq: lastPersisted.seq, type: lastPersisted.action?.type ?? "", ok: lastPersisted.result?.ok ?? true, ms: lastPersisted.result?.durationMs ?? lastPersisted.durationMs, intent: lastPersisted.intent }
                  : null;
              if (!s) return <span className="text-xs text-gray-400">還沒有步驟。</span>;
              return (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-gray-800">第 {s.seq} 步</span>
                  <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">{s.type}</code>
                  <span className={`text-xs ${s.ok ? "text-green-700" : "text-red-600"}`}>
                    {s.ok ? "成功" : "失敗"} · {s.ms}ms
                  </span>
                  {s.intent && <span className="min-w-0 flex-1 truncate text-sm text-gray-700">意圖：{s.intent}</span>}
                  {current && <span className="hidden truncate text-xs text-gray-400 md:inline">{state.titles.get(current) ?? detailByCase.get(current)?.testCase.title ?? ""}</span>}
                </div>
              );
            })()}
          </div>
        </div>

        {!collapsed && (
          <div
            onMouseDown={onHandleDown}
            className="group mx-1 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center rounded"
            title="拖曳調整寬度"
          >
            <div className="h-10 w-1 rounded bg-gray-200 group-hover:bg-blue-400" />
          </div>
        )}

        {collapsed ? (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="flex w-6 shrink-0 items-center justify-center rounded-md border border-gray-200 bg-white text-xs text-gray-500 hover:bg-gray-50"
            title="展開詳情面板"
          >
            ‹
          </button>
        ) : (
          <div className="flex shrink-0 flex-col gap-3 overflow-y-auto pr-1" style={{ width }}>
            <LivePanel title="階段">
              <div className="flex flex-wrap items-center gap-1">
                {PHASES.map((p, i) => {
                  const isCurrent = step?.phase === p;
                  return (
                    <span key={p} className="flex items-center gap-1">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${isCurrent ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500"}`}>
                        {PHASE_LABEL[p]}
                      </span>
                      {i < PHASES.length - 1 && <span className="text-xs text-gray-300">→</span>}
                    </span>
                  );
                })}
              </div>
            </LivePanel>

            <LivePanel title="案例清單" count={queue.length} scroll>
              {queue.length === 0 ? (
                <Empty>案例清單載入中…</Empty>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {queue.map((q) => {
                    const cv = caseView(q.caseId);
                    const open = openCase === q.caseId;
                    return (
                      <li key={q.caseId} className={`py-2 ${q.caseId === current ? "-mx-3 border-l-2 border-blue-500 bg-blue-50/40 px-3" : ""}`}>
                        <div className="flex items-start gap-2">
                          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenCase(open ? null : q.caseId)}>
                            <p className="truncate text-sm text-gray-800">{q.title}</p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-1">
                              <Badge tone={QUEUE_STATUS_TONE[cv.status]}>{QUEUE_STATUS_LABEL[cv.status]}</Badge>
                              {cv.verdict && <Badge tone={VERDICT_TONE[cv.verdict]}>{VERDICT_LABEL[cv.verdict]}</Badge>}
                              {cv.possiblyChanged && <Badge tone="amber">可能已變更</Badge>}
                              {cv.stepCount > 0 && <span className="text-xs text-gray-400">{cv.stepCount} 步</span>}
                            </p>
                          </button>
                          {cv.status === "queued" && canEdit && (
                            <Button variant="ghost" size="sm" onClick={() => onSkip(q.caseId)}>跳過</Button>
                          )}
                        </div>
                        {open && (
                          <div className="mt-2 space-y-2">
                            {cv.reasoning && (
                              <p className="rounded-md bg-gray-50 p-2 text-sm text-gray-700">
                                <span className="mr-1 text-xs font-medium text-gray-500">理由</span>{cv.reasoning}
                              </p>
                            )}
                            {cv.liveSteps.length > 0 ? (
                              cv.liveSteps.map((sc) => <LiveStepCard key={`${sc.caseId}-${sc.seq}`} step={sc} runId={runId} />)
                            ) : cv.persistedSteps.length > 0 ? (
                              cv.persistedSteps.map((sc) => <StepRow key={sc.id} step={sc} runId={runId ?? ""} />)
                            ) : (
                              <Empty>這條案例還沒有步驟。</Empty>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </LivePanel>

            <LivePanel title="即時 Finding" count={state.findings.length} scroll>
              {state.findings.length === 0 ? (
                <Empty>目前沒有額外發現。</Empty>
              ) : (
                <ul className="space-y-2">
                  {state.findings.map((f) => (
                    <li key={f.id} className="rounded-md border border-gray-200 p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={SEVERITY_TONE[f.severity]}>{SEVERITY_LABEL[f.severity]}</Badge>
                        <span className="text-sm font-medium text-gray-800">{f.title}</span>
                      </div>
                      {f.description && <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600">{f.description}</p>}
                      <p className="mt-1 text-xs text-gray-400">
                        發現於：{f.caseId ? (state.titles.get(f.caseId) ?? f.caseId) : "非特定案例"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </LivePanel>
          </div>
        )}
      </div>

      <AddCaseDialog
        open={addOpen}
        targetId={targetId}
        inRun={inRun}
        adding={adding}
        error={addError}
        onClose={() => setAddOpen(false)}
        onAdd={(caseId) => onAddCase(caseId)}
      />
    </div>
  );
}

/** `api` targets have no sandbox; the current request is what "live" means here. */
function ApiLiveView({
  runId,
  step,
  rows,
  loading,
  fill,
}: {
  runId: string | null;
  step: StepEvent | null;
  rows: RunStepRow[] | undefined;
  loading: boolean;
  /** Fill the cockpit's left pane (grow + scroll) instead of sitting inline. */
  fill?: boolean;
}) {
  const httpStep = step && step.action.type === "http_request" ? step : null;
  const row =
    httpStep && runId
      ? (rows ?? []).find((r) => r.seq === httpStep.seq && r.testCaseId === httpStep.caseId)
      : undefined;
  const detail = (row?.result?.detail ?? {}) as { status?: number; statusText?: string; body?: unknown };
  const params = (httpStep?.action.params ?? {}) as Record<string, unknown>;
  const method = String(params.method ?? "GET").toUpperCase();
  const path = String(params.url ?? params.path ?? "");
  const body =
    typeof detail.body === "string" ? detail.body : detail.body === undefined ? "" : JSON.stringify(detail.body, null, 2);

  return (
    <Card title="目前的請求" className={fill ? "flex flex-1 flex-col overflow-hidden [&>div:last-child]:flex-1 [&>div:last-child]:overflow-y-auto" : undefined}>
      <p className="mb-2 text-xs text-gray-400">
        api Target 不會起 sandbox，也就沒有畫面可以看；這裡顯示代理當下送出的 HTTP 請求與回應。
      </p>
      {!httpStep ? (
        <Empty>{step ? `目前這一步是「${step.action.type}」，不是 HTTP 請求。` : "還沒有請求。"}</Empty>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-semibold text-gray-700">{method}</code>
            <code className="min-w-0 break-all text-xs text-gray-700">{path}</code>
            {detail.status !== undefined && (
              <Badge tone={detail.status >= 500 ? "red" : detail.status >= 400 ? "amber" : "green"}>
                {detail.status} {detail.statusText ?? ""}
              </Badge>
            )}
            <span className="text-xs text-gray-400">{step?.result.durationMs}ms</span>
          </div>
          {step?.intent && (
            <p className="text-sm text-gray-800">
              <span className="mr-1 text-xs font-medium text-gray-500">意圖</span>
              {step.intent}
            </p>
          )}
          {step?.result.error && <p className="text-xs text-red-600">錯誤：{step.result.error}</p>}
          <div>
            <p className="mb-1 text-xs font-medium text-gray-500">回應內容</p>
            {loading && !row ? (
              <Spinner label="讀取回應中…" />
            ) : (
              <pre className="max-h-96 overflow-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                {body || "（沒有內容）"}
              </pre>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function LiveStepCard({ step, runId }: { step: StepEvent; runId: string | null }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-gray-800">第 {step.seq} 步</span>
        <Badge tone={PHASE_TONE[step.phase] ?? "gray"}>{PHASE_LABEL[step.phase] ?? step.phase}</Badge>
        <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">{step.action.type}</code>
        <span className={`ml-auto text-xs ${step.result.ok ? "text-green-700" : "text-red-600"}`}>
          {step.result.ok ? "成功" : "失敗"} · {step.result.durationMs}ms
        </span>
      </div>
      <p className="mt-1 break-all font-mono text-xs text-gray-500">{formatActionParams(step.action.params)}</p>
      {step.intent && <p className="mt-1 text-sm text-gray-800">意圖：{step.intent}</p>}
      {step.observation && <p className="mt-0.5 text-sm text-gray-600">觀察：{step.observation}</p>}
      {step.result.error && <p className="mt-0.5 text-xs text-red-600">錯誤：{step.result.error}</p>}
      {runId && step.screenshotKey && (
        <img
          src={evidenceUrl(runId, step.screenshotKey)}
          alt={`第 ${step.seq} 步截圖`}
          className="mt-2 w-full rounded border border-gray-200"
          loading="lazy"
        />
      )}
      <p className="mt-1 text-xs text-gray-400">{step.model}</p>
    </div>
  );
}

function AddCaseDialog({
  open,
  targetId,
  inRun,
  adding,
  error,
  onClose,
  onAdd,
}: {
  open: boolean;
  targetId: string;
  inRun: Set<string>;
  adding: boolean;
  error: unknown;
  onClose: () => void;
  onAdd: (caseId: string) => void;
}) {
  const list = useQuery({
    queryKey: casesKey(targetId),
    queryFn: () => api<TestCaseListData>(`/targets/${targetId}/test-cases`),
    enabled: open,
  });
  const candidates = flattenCases(list.data).filter((c) => !inRun.has(c.id));

  return (
    <Dialog open={open} title="加入案例到這次執行" onClose={onClose}>
      <p className="mb-2 text-xs text-gray-400">加進來的案例會排在佇列最後面，等前面的跑完才輪到它。</p>
      {list.isPending && <Spinner />}
      <ErrorText error={list.error} />
      <ErrorText error={error} />
      {list.data && candidates.length === 0 && <Empty>所有案例都已經在這次執行裡了。</Empty>}
      {candidates.length > 0 && (
        <ul className="max-h-80 divide-y divide-gray-100 overflow-y-auto">
          {candidates.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate">{c.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1">
                  <Badge tone="gray">{c.priority}</Badge>
                  <Badge tone={CASE_TYPE_TONE[c.type]}>{CASE_TYPE_LABEL[c.type]}</Badge>
                </p>
              </div>
              <Button size="sm" variant="secondary" disabled={adding} onClick={() => onAdd(c.id)}>
                加入
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          關閉
        </Button>
      </div>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- §4.7 結果頁 */

function runLabel(run: RunListItem): string {
  const v = run.verdicts;
  return `${formatDate(run.startedAt)} · ${RUN_STATUS_LABEL[run.status]} · 通過 ${v.pass}／失敗 ${v.fail}／受阻 ${v.blocked}`;
}

function ResultsView({
  targetId,
  runs,
  runId,
  canEdit,
  onSelect,
  onRefresh,
  onRerun,
  rerunning,
}: {
  targetId: string;
  runs: RunListItem[];
  runId: string | null;
  canEdit: boolean;
  onSelect: (runId: string) => void;
  onRefresh: () => void;
  onRerun: (runId: string) => void;
  rerunning: boolean;
}) {
  const qc = useQueryClient();

  const detail = useQuery({
    queryKey: runKey(runId ?? "none"),
    queryFn: () => api<RunDetail>(`/runs/${runId}`),
    enabled: !!runId,
  });
  const steps = useQuery({
    queryKey: stepsKey(runId ?? "none"),
    queryFn: () => api<RunStepRow[]>(`/runs/${runId}/steps`),
    enabled: !!runId,
  });

  const invalidate = () => {
    if (!runId) return;
    qc.invalidateQueries({ queryKey: runKey(runId) });
    qc.invalidateQueries({ queryKey: runsKey(targetId) });
  };

  const stepsByCase = useMemo(() => {
    const map = new Map<string, RunStepRow[]>();
    for (const s of steps.data ?? []) {
      if (!s.testCaseId) continue;
      const list = map.get(s.testCaseId) ?? [];
      list.push(s);
      map.set(s.testCaseId, list);
    }
    return map;
  }, [steps.data]);

  const models = useMemo(() => {
    const set = new Set<string>();
    for (const s of steps.data ?? []) if (s.modelUsed) set.add(s.modelUsed);
    return [...set];
  }, [steps.data]);

  if (runs.length === 0) {
    return (
      <Card title="執行結果">
        <Empty>還沒有跑過任何執行。</Empty>
      </Card>
    );
  }

  const d = detail.data;
  const failed = d ? d.verdicts.fail + d.verdicts.blocked : 0;

  return (
    <Card
      title="執行結果"
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={onRefresh}>
            重新整理
          </Button>
          {runId && (
            <Button size="sm" disabled={!canEdit || rerunning || failed === 0} onClick={() => onRerun(runId)}>
              {rerunning ? "啟動中…" : `重跑失敗的案例（${failed}）`}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="w-full max-w-xl">
          <span className="mb-1 block text-xs font-medium text-gray-600">執行紀錄</span>
          <Select value={runId ?? ""} onChange={(e) => onSelect(e.target.value)}>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {runLabel(r)}
              </option>
            ))}
          </Select>
        </div>

        {detail.isPending && runId && <Spinner />}
        <ErrorText error={detail.error} />
        <ErrorText error={steps.error} />

        {d && (
          <>
            <RunSummary run={d} models={models} />

            <div>
              <p className="mb-2 text-xs font-medium text-gray-500">依 feature 的通過率</p>
              {d.features.length === 0 ? (
                <Empty>還沒有可以統計的結果。</Empty>
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th>Feature</th>
                      <th>通過</th>
                      <th>總數</th>
                      <th>通過率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.features.map((f) => {
                      const rate = f.total ? Math.round((f.pass / f.total) * 100) : 0;
                      return (
                        <tr key={f.id ?? "__none__"}>
                          <td>{f.name}</td>
                          <td className="text-xs">{f.pass}</td>
                          <td className="text-xs">{f.total}</td>
                          <td className="text-xs">
                            <span className={rate === 100 ? "text-green-700" : rate >= 50 ? "text-amber-700" : "text-red-600"}>
                              {rate}%
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-gray-500">案例結果（{d.cases.length}）</p>
              {d.cases.length === 0 ? (
                <Empty>這次執行沒有案例。</Empty>
              ) : (
                <ul className="space-y-2">
                  {d.cases.map((c) => (
                    <ResultCase
                      key={c.caseId}
                      runId={d.run.id}
                      item={c}
                      steps={stepsByCase.get(c.caseId) ?? []}
                      canEdit={canEdit}
                      onReviewed={invalidate}
                    />
                  ))}
                </ul>
              )}
            </div>

            <ChangeDetection
              runId={d.run.id}
              targetId={targetId}
              count={d.cases.filter((c) => c.result?.possiblyChanged).length}
              canEdit={canEdit}
            />

            <FindingsPanel
              findings={d.findings}
              cases={d.cases}
              targetId={targetId}
              canEdit={canEdit}
              onChanged={invalidate}
            />
          </>
        )}
      </div>
    </Card>
  );
}

function RunSummary({ run, models }: { run: RunDetail; models: string[] }) {
  const r = run.run;
  const duration = r.endedAt ? new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime() : null;
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={RUN_STATUS_TONE[r.status]}>{RUN_STATUS_LABEL[r.status]}</Badge>
        <span className="text-xs text-gray-500">開始 {formatDate(r.startedAt)}</span>
        <span className="text-xs text-gray-500">耗時 {duration === null ? "進行中" : formatDuration(duration)}</span>
        <span className="text-xs text-gray-500">共 {r.stepCount} 步</span>
        {r.sandboxName && <span className="text-xs text-gray-500">sandbox {r.sandboxName}</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {VERDICTS.map((v) => (
          <span key={v} className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm">
            <span className="mr-1 text-xs text-gray-500">{VERDICT_LABEL[v]}</span>
            <span className="font-semibold text-gray-800">{run.verdicts[v] ?? 0}</span>
          </span>
        ))}
      </div>
      <LlmUsageBlock usage={r.llmUsage} fallbackModels={models} />
      {r.pausedReason && <p className="mt-1 text-xs text-amber-700">曾經等待 LLM：{pauseReasonLabel(r.pausedReason)}</p>}
      {r.error && <p className="mt-1 text-xs text-red-600">{r.error}</p>}
    </div>
  );
}

/**
 * §4.7 「使用的 model（含 fallback 切換紀錄）」. A run that quietly finished on the
 * third config in the chain should not look like one that never faltered.
 */
function LlmUsageBlock({ usage, fallbackModels }: { usage: RunLlmUsage | null; fallbackModels: string[] }) {
  const [open, setOpen] = useState(false);
  if (!usage?.configs.length) {
    return (
      <p className="mt-2 text-xs text-gray-500">
        使用的模型：{fallbackModels.length ? fallbackModels.join("、") : "-"}
      </p>
    );
  }
  const switches = usage.switches.length;
  const outages = usage.outages.length;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
        <span>
          使用的模型：
          {usage.configs.map((c) => `${c.configName}（${c.models.join("/") || "?"}，${c.calls} 次呼叫${c.failures ? `、${c.failures} 次失敗` : ""}）`).join("、")}
        </span>
        {(switches > 0 || outages > 0) && (
          <button type="button" className="font-medium text-amber-700 hover:underline" onClick={() => setOpen((v) => !v)}>
            {switches > 0 && `切換 fallback ${switches} 次`}
            {switches > 0 && outages > 0 && "，"}
            {outages > 0 && `全部不可用 ${outages} 次`}
            {open ? "（收合）" : "（展開）"}
          </button>
        )}
      </div>
      {open && (
        <ul className="mt-1 space-y-1 border-l-2 border-amber-200 pl-2">
          {usage.switches.map((sw, i) => (
            <li key={`s${i}`} className="text-xs text-gray-600">
              {formatDate(sw.at)}　{sw.fromConfigName} → {sw.toConfigName}
              <span className="ml-1 text-gray-400">（{sw.reason}）</span>
            </li>
          ))}
          {usage.outages.map((o, i) => (
            <li key={`o${i}`} className="text-xs text-amber-700">
              {formatDate(o.at)}　全部設定都不可用，執行暫停等待：{o.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ResultCase({
  runId,
  item,
  steps,
  canEdit,
  onReviewed,
}: {
  runId: string;
  item: RunCase;
  steps: RunStepRow[];
  canEdit: boolean;
  onReviewed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const result = item.result;
  const disagree = !!result?.humanVerdict && result.humanVerdict !== result.verdict;

  return (
    <li className={`rounded-md border p-3 ${disagree ? "border-amber-300 bg-amber-50/40" : "border-gray-200"}`}>
      <button type="button" className="w-full text-left" onClick={() => setOpen((v) => !v)}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-800">{item.testCase.title}</span>
          <Badge tone="gray">{item.testCase.priority}</Badge>
          <Badge tone={CASE_TYPE_TONE[item.testCase.type]}>{CASE_TYPE_LABEL[item.testCase.type]}</Badge>
          {item.testCase.feature && <span className="text-xs text-gray-400">{item.testCase.feature.name}</span>}
          <span className="ml-auto text-xs text-gray-400">{open ? "收合" : "展開"}</span>
        </div>
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1 text-xs text-gray-500">
          模型判定
          {result ? <Badge tone={VERDICT_TONE[result.verdict]}>{VERDICT_LABEL[result.verdict]}</Badge> : <Badge tone="gray">未執行</Badge>}
        </span>
        <span className="flex items-center gap-1 text-xs text-gray-500">
          人工覆核
          {result?.humanVerdict ? (
            <Badge tone={VERDICT_TONE[result.humanVerdict]}>{VERDICT_LABEL[result.humanVerdict]}</Badge>
          ) : (
            <Badge tone="gray">尚未覆核</Badge>
          )}
        </span>
        {result?.possiblyChanged && <Badge tone="amber">可能已變更</Badge>}
        {item.queueStatus === "skipped" && <Badge tone="gray">{QUEUE_STATUS_LABEL.skipped}</Badge>}
        {result && (
          <span className="text-xs text-gray-400">
            {result.stepCount} 步 · {formatDuration(result.durationMs)}
          </span>
        )}
      </div>

      {disagree && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
          人工覆核與模型判定不同：模型判「{VERDICT_LABEL[result!.verdict]}」，人工改判「
          {VERDICT_LABEL[result!.humanVerdict!]}」。兩邊都保留，不會互相覆蓋。
        </p>
      )}
      {result?.possiblyChanged && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
          這條的失敗看起來像是功能改了，而不是壞了。可以在下面建立變更提案，一次處理這次執行裡所有這類案例。
        </p>
      )}
      {item.editedAfterUse && (
        <p className="mt-2 text-xs text-amber-700">
          案例已於執行後修改（執行時用 v{item.caseVersion ?? "?"}，目前是 v{item.testCase.currentVersion}）。
        </p>
      )}

      {result?.llmReasoning && (
        <p className="mt-2 whitespace-pre-wrap rounded-md bg-gray-50 p-2 text-sm text-gray-700">
          <span className="mr-1 text-xs font-medium text-gray-500">理由</span>
          {result.llmReasoning}
        </p>
      )}

      {result && result.reproSteps.length > 0 && (
        <div className="mt-2">
          <p className="mb-1 text-xs font-medium text-gray-500">重現步驟</p>
          <ol className="list-decimal space-y-0.5 pl-5 text-sm text-gray-700">
            {result.reproSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}

      {result && canEdit && <ReviewControls result={result} onReviewed={onReviewed} />}
      {result && !canEdit && result.humanNote && (
        <p className="mt-2 text-xs text-gray-500">覆核備註：{result.humanNote}</p>
      )}

      {open && (
        <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
          <div>
            <p className="mb-1 text-xs font-medium text-gray-500">案例內容</p>
            <p className="text-xs text-gray-500">前置條件：{item.testCase.precondition || "-"}</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-gray-700">
              {item.testCase.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            <p className="mt-1 text-sm text-gray-700">預期：{item.testCase.expected}</p>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-gray-500">步驟時間軸（{steps.length}）</p>
            {steps.length === 0 ? (
              <Empty>這條案例沒有步驟紀錄。</Empty>
            ) : (
              <ol className="space-y-2">
                {steps.map((s) => (
                  <StepRow key={s.id} runId={runId} step={s} />
                ))}
              </ol>
            )}
          </div>

          {result?.evidence.video && (
            <div>
              <p className="mb-1 text-xs font-medium text-gray-500">錄影</p>
              <video
                controls
                preload="metadata"
                className="w-full rounded border border-gray-200 bg-black"
                src={evidenceUrl(runId, result.evidence.video)}
              />
            </div>
          )}

          {result && <HttpLogsBlock logs={result.evidence.httpLogs ?? []} />}
          {result && (result.evidence.evidenceRefs?.length ?? 0) > 0 && (
            <p className="text-xs text-gray-500">證據參照：{result.evidence.evidenceRefs!.join("、")}</p>
          )}
        </div>
      )}
    </li>
  );
}

function ReviewControls({ result, onReviewed }: { result: TestResultRow; onReviewed: () => void }) {
  const [overturning, setOverturning] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>(result.humanVerdict ?? (result.verdict === "pass" ? "fail" : "pass"));
  const [note, setNote] = useState(result.humanNote ?? "");

  const review = useMutation({
    mutationFn: (body: { verdict: Verdict; note?: string }) =>
      api<TestResultRow>(`/results/${result.id}/review`, { method: "POST", body }),
    onSuccess: () => {
      setOverturning(false);
      onReviewed();
    },
  });

  return (
    <div className="mt-2 rounded-md border border-gray-200 bg-white p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500">人工覆核</span>
        <Button
          size="sm"
          variant="secondary"
          disabled={review.isPending}
          onClick={() => review.mutate({ verdict: result.verdict, note: note.trim() || undefined })}
        >
          同意模型判定（{VERDICT_LABEL[result.verdict]}）
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOverturning((v) => !v)}>
          {overturning ? "取消推翻" : "推翻判定"}
        </Button>
        {result.reviewedAt && <span className="text-xs text-gray-400">上次覆核 {formatDate(result.reviewedAt)}</span>}
      </div>

      {result.humanNote && !overturning && <p className="mt-1 text-xs text-gray-500">備註：{result.humanNote}</p>}

      {overturning && (
        <div className="mt-2 space-y-2">
          <div className="w-40">
            <span className="mb-1 block text-xs font-medium text-gray-600">改判為</span>
            <Select value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict)}>
              {VERDICTS.map((v) => (
                <option key={v} value={v}>
                  {VERDICT_LABEL[v]}
                </option>
              ))}
            </Select>
          </div>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="為什麼推翻（選填）" />
          <Button size="sm" disabled={review.isPending} onClick={() => review.mutate({ verdict, note: note.trim() || undefined })}>
            {review.isPending ? "送出中…" : "送出覆核"}
          </Button>
        </div>
      )}
      <ErrorText error={review.error} />
    </div>
  );
}

/**
 * §4.7: a finding turns into a test case in one click, but the model's draft is
 * shown first. A finding is an observation; making it a permanent test is a
 * decision, and the person making it should see what they are signing.
 */
function FindingToCaseDialog({
  findingId,
  onClose,
  onSaved,
}: {
  findingId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<FindingCaseDraft | null>(null);
  const drafted = useMutation({
    mutationFn: () => api<FindingCaseDraft>(`/findings/${findingId}/test-case/draft`, { method: "POST" }),
    onSuccess: setDraft,
  });
  const save = useMutation({
    mutationFn: (body: FindingCaseDraft) =>
      api(`/findings/${findingId}/test-case`, {
        method: "POST",
        body: {
          title: body.title,
          precondition: body.precondition,
          steps: body.steps,
          expected: body.expected,
          priority: body.priority,
          type: body.type,
          featureId: body.featureId,
          featureName: body.featureName,
        },
      }),
    onSuccess: onSaved,
  });

  useEffect(() => {
    drafted.mutate();
    // Drafting once per open is the point; re-running on every render is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findingId]);

  const patch = (fields: Partial<FindingCaseDraft>) => setDraft((d) => (d ? { ...d, ...fields } : d));

  return (
    <Dialog open title="把 finding 轉成測試案例" onClose={onClose}>
      {drafted.isPending && <Spinner label="模型正在草擬案例…" />}
      <ErrorText error={drafted.error} />
      {draft && (
        <div className="space-y-2">
          <Field label="標題">
            <Input value={draft.title} onChange={(e) => patch({ title: e.target.value })} />
          </Field>
          <Field label="前置條件">
            <Input value={draft.precondition} onChange={(e) => patch({ precondition: e.target.value })} />
          </Field>
          <Field label="步驟" hint="一行一個步驟">
            <Textarea
              rows={5}
              value={draft.steps.join("\n")}
              onChange={(e) => patch({ steps: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })}
            />
          </Field>
          <Field label="預期結果" hint="寫「修好之後應該是什麼樣子」，不是重述錯誤">
            <Textarea rows={2} value={draft.expected} onChange={(e) => patch({ expected: e.target.value })} />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="優先級">
              <Select value={draft.priority} onChange={(e) => patch({ priority: e.target.value as Priority })}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </Select>
            </Field>
            <Field label="類型">
              <Select value={draft.type} onChange={(e) => patch({ type: e.target.value as CaseType })}>
                {CASE_TYPES.map((t) => (
                  <option key={t} value={t}>{CASE_TYPE_LABEL[t]}</option>
                ))}
              </Select>
            </Field>
            <Field label="所屬功能">
              <Input
                value={draft.featureName ?? ""}
                onChange={(e) => patch({ featureName: e.target.value, featureId: null })}
                placeholder="留空則不歸類"
              />
            </Field>
          </div>
          <p className="text-xs text-gray-400">由 {draft.model} 草擬，存檔前可以直接改。</p>
          <div className="flex items-center gap-2">
            <Button disabled={save.isPending} onClick={() => save.mutate(draft)}>
              {save.isPending ? "建立中…" : "建立測試案例"}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
          </div>
          <ErrorText error={save.error} />
        </div>
      )}
    </Dialog>
  );
}

function StepRow({ runId, step }: { runId: string; step: RunStepRow }) {
  const ok = step.result?.ok ?? true;
  return (
    <li className="rounded-md border border-gray-200 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-gray-800">第 {step.seq} 步</span>
        <Badge tone={PHASE_TONE[step.phase] ?? "gray"}>{PHASE_LABEL[step.phase] ?? step.phase}</Badge>
        <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">{step.action?.type}</code>
        <span className={`ml-auto text-xs ${ok ? "text-green-700" : "text-red-600"}`}>
          {ok ? "成功" : "失敗"} · {step.result?.durationMs ?? step.durationMs}ms
        </span>
      </div>
      <p className="mt-1 break-all font-mono text-xs text-gray-500">{formatActionParams(step.action?.params)}</p>
      {step.intent && <p className="mt-1 text-sm text-gray-800">意圖：{step.intent}</p>}
      {step.observation && <p className="mt-0.5 text-sm text-gray-600">觀察：{step.observation}</p>}
      {step.result?.error && <p className="mt-0.5 text-xs text-red-600">錯誤：{step.result.error}</p>}
      {step.screenshotKey && (
        <img
          src={evidenceUrl(runId, step.screenshotKey)}
          alt={`第 ${step.seq} 步截圖`}
          className="mt-2 w-full rounded border border-gray-200"
          loading="lazy"
        />
      )}
      <p className="mt-1 text-xs text-gray-400">
        {step.modelUsed ?? "-"} · {formatDate(step.createdAt)}
      </p>
    </li>
  );
}

function HttpLogsBlock({ logs }: { logs: HttpLog[] }) {
  const [open, setOpen] = useState(false);
  if (logs.length === 0) return null;
  return (
    <div>
      <button type="button" className="text-xs font-medium text-blue-700 hover:underline" onClick={() => setOpen((v) => !v)}>
        {open ? "收合" : "展開"} HTTP log（{logs.length}）
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {logs.map((log, i) => (
            <li key={i} className="rounded-md border border-gray-200 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-semibold text-gray-700">{log.method}</code>
                <code className="min-w-0 break-all text-xs text-gray-700">{log.url}</code>
                {log.status !== null && (
                  <Badge tone={log.status >= 500 ? "red" : log.status >= 400 ? "amber" : "green"}>
                    {log.status} {log.statusText}
                  </Badge>
                )}
                <span className="text-xs text-gray-400">{log.durationMs}ms</span>
              </div>
              {log.error && <p className="mt-1 text-xs text-red-600">錯誤：{log.error}</p>}
              {log.requestBody && (
                <Snippet label="請求內容">{log.requestBody}</Snippet>
              )}
              <Snippet label="回應內容">{log.responseBody || "（沒有內容）"}</Snippet>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Snippet({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-1">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <pre className="mt-0.5 max-h-64 overflow-auto rounded bg-gray-900 p-2 text-xs text-gray-100">{children}</pre>
    </div>
  );
}

/**
 * Spec §4.4 被動偵測: a failure that looks like the feature moved is a change to
 * discuss, not a bug to file. This is the way into that flow.
 */
function ChangeDetection({
  runId,
  targetId,
  count,
  canEdit,
}: {
  runId: string;
  targetId: string;
  count: number;
  canEdit: boolean;
}) {
  const [created, setCreated] = useState(false);
  const propose = useMutation({
    mutationFn: () => api(`/runs/${runId}/change-proposal`, { method: "POST" }),
    onSuccess: () => setCreated(true),
  });
  if (!count) return null;

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm text-amber-900">
        有 {count} 條案例的失敗像是功能被改掉或移除，而不是行為錯誤。
      </p>
      <div className="mt-2 flex items-center gap-2">
        {created ? (
          <Link to={`/targets/${targetId}?tab=changes`} className="text-sm font-medium text-blue-700 hover:underline">
            提案已建立，去「變更」分頁逐項確認 →
          </Link>
        ) : (
          <Button size="sm" onClick={() => propose.mutate()} disabled={!canEdit || propose.isPending}>
            {propose.isPending ? "分析中…" : "建立變更提案"}
          </Button>
        )}
      </div>
      <ErrorText error={propose.error} />
    </div>
  );
}

function FindingsPanel({
  findings,
  cases,
  targetId,
  canEdit,
  onChanged,
}: {
  findings: RunFindingRow[];
  cases: RunCase[];
  targetId: string;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const titles = new Map(cases.map((c) => [c.caseId, c.testCase.title]));
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: FindingStatus }) =>
      api<RunFindingRow>(`/findings/${id}/status`, { method: "POST", body: { status } }),
    onSuccess: onChanged,
  });
  const propose = useMutation({
    mutationFn: (id: string) => api(`/findings/${id}/change-proposal`, { method: "POST" }),
    onSuccess: onChanged,
  });
  const [drafting, setDrafting] = useState<string | null>(null);

  return (
    <div>
      <p className="mb-2 text-xs font-medium text-gray-500">Finding（{findings.length}）</p>
      <ErrorText error={setStatus.error} />
      {drafting && (
        <FindingToCaseDialog
          findingId={drafting}
          onClose={() => setDrafting(null)}
          onSaved={() => {
            setDrafting(null);
            onChanged();
          }}
        />
      )}
      {findings.length === 0 ? (
        <Empty>這次執行沒有額外發現。</Empty>
      ) : (
        <ul className="space-y-2">
          {findings.map((f) => (
            <li key={f.id} className="rounded-md border border-gray-200 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEVERITY_TONE[f.severity]}>{SEVERITY_LABEL[f.severity]}</Badge>
                <span className="text-sm font-medium text-gray-800">{f.title}</span>
                <Badge tone={FINDING_STATUS_TONE[f.status]}>{FINDING_STATUS_LABEL[f.status]}</Badge>
                <span className="ml-auto text-xs text-gray-400">{formatDate(f.createdAt)}</span>
              </div>
              {f.description && <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600">{f.description}</p>}
              <p className="mt-1 text-xs text-gray-400">
                {f.feature ? `Feature：${f.feature.name} · ` : ""}
                發現於：{f.testCaseId ? (titles.get(f.testCaseId) ?? f.testCaseId) : "非特定案例"}
              </p>
              {canEdit && (
                <div className="mt-2 flex items-center gap-2">
                  <div className="w-52">
                    <Select
                      value={f.status}
                      className="py-1 text-xs"
                      disabled={setStatus.isPending}
                      onChange={(e) => setStatus.mutate({ id: f.id, status: e.target.value as FindingStatus })}
                    >
                      {FINDING_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {FINDING_STATUS_LABEL[s]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  {f.convertedProposalId ? (
                    <Link to={`/targets/${targetId}?tab=changes`} className="text-xs text-blue-700 hover:underline">
                      看變更提案 →
                    </Link>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={propose.isPending || !!f.convertedCaseId}
                      onClick={() => propose.mutate(f.id)}
                    >
                      {propose.isPending ? "分析中…" : "轉為變更提案"}
                    </Button>
                  )}
                  {f.convertedCaseId ? (
                    <Link to={`/targets/${targetId}?tab=cases`} className="text-xs text-blue-700 hover:underline">
                      看測試案例 →
                    </Link>
                  ) : (
                    <Button variant="secondary" size="sm" onClick={() => setDrafting(f.id)}>
                      轉為測試案例
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
