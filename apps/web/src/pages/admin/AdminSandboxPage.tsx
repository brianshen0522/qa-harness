import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiEventSource, errorMessage } from "../../api/client";
import type {
  AgentPhase,
  SandboxActionResult,
  SandboxInstance,
  SandboxSettings,
  SandboxStatus,
  SessionEvent,
  SessionSendResult,
  SessionSnapshot,
  SessionStatus,
  SessionStepEvent,
} from "../../api/types";
import {
  Badge,
  Button,
  Card,
  Empty,
  ErrorText,
  Field,
  Input,
  Notice,
  Select,
  Spinner,
  Tabs,
  Textarea,
} from "../../components/ui";
import { formatDate } from "../../lib/roles";

const TABS = [
  { key: "console" as const, label: "主控台" },
  { key: "settings" as const, label: "設定" },
];
type TabKey = (typeof TABS)[number]["key"];

const STATUS_KEY = ["admin", "sandbox", "status"];

export default function AdminSandboxPage() {
  const [tab, setTab] = useState<TabKey>("console");

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">Sandbox</h1>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === "console" ? <ConsoleTab /> : <SettingsTab />}
    </div>
  );
}

/* ------------------------------------------------------------------ 主控台 */

function ConsoleTab() {
  const qc = useQueryClient();
  const viewRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const status = useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => api<SandboxStatus>("/admin/sandbox/status"),
    // A container that is still booting changes state fast; a settled one does not.
    refetchInterval: (query) =>
      query.state.data?.instances.some((i) => i.health === "starting") ? 5000 : 20000,
  });

  const instances = status.data?.instances ?? [];
  const selected =
    instances.find((i) => i.id === selectedId) ?? instances.find((i) => i.running) ?? instances[0] ?? null;

  const invalidateStatus = () => qc.invalidateQueries({ queryKey: STATUS_KEY });

  const focusView = (id: string) => {
    setSelectedId(id);
    viewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-4">
      <StatusBar status={status.data} isPending={status.isPending} error={status.error} />

      <Launcher
        status={status.data}
        onStarted={(instance) => {
          setSelectedId(instance.id);
          invalidateStatus();
        }}
      />

      <Card title={`Sandbox 清單（${instances.length}）`}>
        {status.isPending && <Spinner />}
        {!status.isPending && instances.length === 0 && (
          <Empty>目前沒有 sandbox 容器。用上方的「啟動 sandbox」開一個。</Empty>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {instances.map((i) => (
            <InstanceCard
              key={i.id}
              instance={i}
              selected={selected?.id === i.id}
              onSelect={() => setSelectedId(i.id)}
              onView={() => focusView(i.id)}
              onStopped={() => {
                if (selectedId === i.id) setSelectedId(null);
                invalidateStatus();
              }}
            />
          ))}
        </div>
      </Card>

      <div ref={viewRef}>
        <LiveView instance={selected} fallbackResolution={status.data?.settings.resolution ?? null} />
      </div>

      {selected ? (
        <AgentPanel
          key={selected.id}
          instance={selected}
          defaultMaxSteps={status.data?.settings.maxStepsPerCase ?? 20}
        />
      ) : (
        <Card title="與 LLM 對話">
          <Empty>先啟動並選取一個 sandbox，才能開始對話。</Empty>
        </Card>
      )}

      {selected && <ManualPanel key={`manual-${selected.id}`} instance={selected} />}
    </div>
  );
}

/* -------------------------------------------------------------- 狀態列 */

function StatusBar({
  status,
  isPending,
  error,
}: {
  status: SandboxStatus | undefined;
  isPending: boolean;
  error: unknown;
}) {
  return (
    <Card title="環境狀態">
      {isPending && <Spinner />}
      <ErrorText error={error} />
      {status && (
        <div className="space-y-2">
          {status.docker.ok ? (
            <p className="text-sm text-gray-700">
              <Badge tone="green">Docker 正常</Badge>{" "}
              <span className="ml-1 text-gray-500">版本 {status.docker.version ?? "未知"}</span>
            </p>
          ) : (
            <Notice tone="red">無法連線到 Docker：{status.docker.error ?? "未知錯誤"}</Notice>
          )}

          {status.image.present ? (
            <p className="text-sm text-gray-700">
              <Badge tone="green">Image 已存在</Badge>{" "}
              <code className="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-xs">{status.image.name}</code>
            </p>
          ) : (
            <Notice tone="amber">
              <p>
                找不到 sandbox image <code className="rounded bg-white/60 px-1">{status.image.name}</code>，請先建置：
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-gray-900 px-3 py-2 text-xs text-gray-100">
                docker build -t {status.image.name} docker/sandbox
              </pre>
            </Notice>
          )}

          <p className="text-sm text-gray-700">
            執行中：
            <span className="mx-1 font-semibold">
              {status.running} / {status.maxConcurrent}
            </span>
            <span className="text-xs text-gray-400">
              （解析度 {status.settings.resolution}、每步逾時 {status.settings.stepTimeoutSec} 秒）
            </span>
          </p>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ 啟動 sandbox */

function Launcher({
  status,
  onStarted,
}: {
  status: SandboxStatus | undefined;
  onStarted: (instance: SandboxInstance) => void;
}) {
  const [startUrl, setStartUrl] = useState("");
  const [ttl, setTtl] = useState("60");

  const start = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      if (startUrl.trim()) body.startUrl = startUrl.trim();
      const minutes = Number(ttl);
      if (Number.isFinite(minutes) && minutes > 0) body.ttlMinutes = Math.round(minutes);
      return api<SandboxInstance>("/admin/sandbox/instances", { method: "POST", body });
    },
    onSuccess: onStarted,
  });

  const blocked = !!status && (!status.docker.ok || !status.image.present);
  const full = !!status && status.running >= status.maxConcurrent;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!start.isPending) start.mutate();
  };

  return (
    <Card title="啟動 sandbox">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Field label="起始網址（選填）" hint="容器啟動後會用 Chromium 開這個頁面。">
            <Input
              type="url"
              value={startUrl}
              placeholder="https://example.com"
              onChange={(e) => setStartUrl(e.target.value)}
            />
          </Field>
          <Field label="存活時間（分鐘）" hint="到期後容器會自動回收。5–480。">
            <Input type="number" min={5} max={480} value={ttl} onChange={(e) => setTtl(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={start.isPending || blocked}>
            {start.isPending ? "啟動中…" : "啟動 sandbox"}
          </Button>
          {start.isPending && (
            <span className="text-xs text-gray-500">正在等待桌面就緒，通常需要 2–20 秒，請不要離開此頁。</span>
          )}
          {!start.isPending && full && <span className="text-xs text-amber-600">已達並行上限，需先停止一個。</span>}
          {!start.isPending && blocked && <span className="text-xs text-gray-400">Docker 或 image 尚未就緒。</span>}
        </div>
        <ErrorText error={start.error} />
      </form>
    </Card>
  );
}

function healthTone(health: string): "green" | "amber" | "red" | "gray" {
  if (health === "healthy") return "green";
  if (health === "starting") return "amber";
  if (health === "unhealthy") return "red";
  return "gray";
}

const HEALTH_LABEL: Record<string, string> = {
  healthy: "健康",
  starting: "啟動中",
  unhealthy: "不健康",
  none: "無檢查",
};

function InstanceCard({
  instance,
  selected,
  onSelect,
  onView,
  onStopped,
}: {
  instance: SandboxInstance;
  selected: boolean;
  onSelect: () => void;
  onView: () => void;
  onStopped: () => void;
}) {
  const stop = useMutation({
    mutationFn: () => api<{ ok: true }>(`/admin/sandbox/instances/${instance.id}`, { method: "DELETE" }),
    onSuccess: onStopped,
  });

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
      className={`cursor-pointer rounded-lg border p-3 text-left transition ${
        selected ? "border-blue-400 bg-blue-50/50 ring-1 ring-blue-200" : "border-gray-200 hover:border-gray-300"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{instance.name}</span>
        <Badge tone={instance.running ? "green" : "gray"}>{instance.status}</Badge>
        <Badge tone={healthTone(instance.health)}>{HEALTH_LABEL[instance.health] ?? instance.health}</Badge>
        {selected && <Badge tone="blue">使用中</Badge>}
      </div>
      <dl className="mt-2 space-y-0.5 text-xs text-gray-500">
        <div>解析度：{instance.resolution ?? "未知"}</div>
        <div>建立於：{formatDate(instance.createdAt)}</div>
        <div>到期：{instance.expiresAt ? formatDate(instance.expiresAt) : "不自動回收"}</div>
      </dl>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!instance.viewUrl}
          onClick={(e) => {
            e.stopPropagation();
            onView();
          }}
        >
          檢視畫面
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={stop.isPending}
          onClick={(e) => {
            e.stopPropagation();
            stop.mutate();
          }}
        >
          {stop.isPending ? "停止中…" : "停止"}
        </Button>
      </div>
      <ErrorText error={stop.error} />
    </div>
  );
}

/* ---------------------------------------------------------------- 即時畫面 */

function aspectRatio(resolution: string | null | undefined): string {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec((resolution ?? "").trim());
  if (!m) return "16 / 10";
  return `${m[1]} / ${m[2]}`;
}

function LiveView({
  instance,
  fallbackResolution,
}: {
  instance: SandboxInstance | null;
  fallbackResolution: string | null;
}) {
  const [nonce, setNonce] = useState(0);
  const viewUrl = instance?.viewUrl ?? null;

  return (
    <Card
      title={`即時畫面${instance ? ` — ${instance.name}` : ""}`}
      actions={
        viewUrl ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => setNonce((n) => n + 1)}>
              重新載入
            </Button>
            <a
              href={viewUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium text-blue-700 hover:underline"
            >
              另開分頁
            </a>
          </>
        ) : undefined
      }
    >
      <p className="mb-2 text-xs text-gray-400">
        這是容器內建 noVNC 的即時畫面，由瀏覽器直接連到 127.0.0.1:{instance?.novncPort ?? "…"}（只綁在
        loopback，不經過 API）。因此只有在跑 API 的那台機器上開這個頁面才看得到畫面。
      </p>
      {viewUrl ? (
        <iframe
          key={`${viewUrl}#${nonce}`}
          src={viewUrl}
          title="sandbox 即時畫面"
          className="w-full rounded-md border border-gray-300 bg-black"
          style={{ aspectRatio: aspectRatio(instance?.resolution ?? fallbackResolution) }}
        />
      ) : (
        <Empty>
          {instance ? "這個 sandbox 沒有對外的 noVNC 連接埠，無法顯示即時畫面。" : "尚未選取 sandbox。"}
        </Empty>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------- 與 LLM 對話 */

const PHASE_LABEL: Record<AgentPhase, string> = {
  setup: "準備",
  executing: "執行",
  verifying: "驗證",
  judging: "判定",
};

const PHASE_TONE: Record<AgentPhase, "blue" | "purple" | "amber" | "green"> = {
  setup: "blue",
  executing: "purple",
  verifying: "amber",
  judging: "green",
};

function formatParams(params: Record<string, unknown>): string {
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) return "（無參數）";
  return entries
    .map(([k, v]) => `${k}=${v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("  ");
}

/**
 * One ongoing conversation with a sandbox. The transcript lives in component
 * state fed by the SSE stream — react-query only fetches the first snapshot, so
 * a reload paints immediately and the replay on connect fills in the rest.
 */
function AgentPanel({ instance, defaultMaxSteps }: { instance: SandboxInstance; defaultMaxSteps: number }) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [reconnecting, setReconnecting] = useState(false);
  const [draft, setDraft] = useState("");
  const [maxSteps, setMaxSteps] = useState(String(defaultMaxSteps));
  const [atBottom, setAtBottom] = useState(true);

  // Keyed by `seq`, which is unique and monotonic per session: the stream
  // replays everything on connect, so the snapshot and the replay collapse here
  // instead of showing up twice.
  const bySeq = useRef(new Map<number, SessionEvent>());
  const listRef = useRef<HTMLDivElement>(null);

  const ingest = useCallback((incoming: SessionEvent[]) => {
    const map = bySeq.current;
    let changed = false;
    for (const event of incoming) {
      if (event.type === "status") {
        setStatus(event.status);
        continue;
      }
      if (event.type === "reset") {
        // The transcript is thrown away rather than rendered.
        map.clear();
        changed = true;
        continue;
      }
      map.set(event.seq, event);
      changed = true;
    }
    if (changed) setEvents([...map.values()]);
  }, []);

  const path = `/admin/sandbox/instances/${instance.id}/agent`;

  const snapshot = useQuery({
    queryKey: ["admin", "sandbox", "agent", instance.id],
    queryFn: () => api<SessionSnapshot>(`${path}/session`),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!snapshot.data) return;
    ingest(snapshot.data.events);
    setStatus(snapshot.data.status);
  }, [snapshot.data, ingest]);

  useEffect(() => {
    const source = apiEventSource(`${path}/stream`);
    source.onopen = () => setReconnecting(false);
    source.onmessage = (e) => {
      setReconnecting(false);
      try {
        ingest([JSON.parse(e.data as string) as SessionEvent]);
      } catch {
        /* a malformed frame is not worth breaking the transcript over */
      }
    };
    // EventSource retries on its own; only say so while it is actually retrying.
    source.onerror = () => setReconnecting(source.readyState === EventSource.CONNECTING);
    return () => source.close();
  }, [path, ingest]);

  // Follow the tail, unless the user has scrolled up to read something.
  useEffect(() => {
    if (!atBottom) return;
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [events, atBottom]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  const jumpToLatest = () => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  };

  const send = useMutation({
    mutationFn: (content: string) => {
      const body: Record<string, unknown> = { content };
      const steps = Number(maxSteps);
      if (Number.isFinite(steps) && steps > 0) body.maxSteps = Math.round(steps);
      return api<SessionSendResult>(`${path}/messages`, { method: "POST", body });
    },
    onSuccess: () => setDraft(""),
  });

  const stop = useMutation({
    mutationFn: () => api<{ stopped: boolean }>(`${path}/stop`, { method: "POST" }),
  });

  const clear = useMutation({
    mutationFn: () => api<{ ok: true }>(`${path}/session`, { method: "DELETE" }),
    onSuccess: () => {
      bySeq.current.clear();
      setEvents([]);
    },
  });

  const submit = () => {
    if (!draft.trim() || send.isPending) return;
    send.mutate(draft.trim());
  };

  const confirmClear = () => {
    if (window.confirm("清除這個 sandbox 的整段對話？先前的訊息與步驟都會消失，無法復原。")) clear.mutate();
  };

  const running = status === "running";
  const visible = useMemo(() => visibleEvents(events, running), [events, running]);
  // Rounds are numbered for the reader; `runId` is an opaque id.
  const rounds = useMemo(() => {
    const map = new Map<number, number>();
    let n = 0;
    for (const event of events) if (event.type === "run_started") map.set(event.seq, ++n);
    return map;
  }, [events]);

  return (
    <Card
      title={`與 LLM 對話 — ${instance.name}`}
      actions={
        <>
          <Badge tone={running ? "amber" : "gray"}>{running ? "執行中" : "閒置"}</Badge>
          <Button size="sm" variant="ghost" disabled={clear.isPending || events.length === 0} onClick={confirmClear}>
            {clear.isPending ? "清除中…" : "清除對話"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {reconnecting && <p className="text-xs text-amber-600">連線中斷，重新連線中…</p>}
        <ErrorText error={snapshot.error} />
        <ErrorText error={stop.error} />
        <ErrorText error={clear.error} />

        <div className="relative">
          <div
            ref={listRef}
            onScroll={onScroll}
            className="max-h-[60vh] space-y-2 overflow-y-auto rounded-md bg-gray-50 p-3"
          >
            {snapshot.isPending && <Spinner />}
            {!snapshot.isPending && visible.length === 0 && (
              <Empty>還沒有對話。在下方輸入要 LLM 做的事，牠會看著畫面一步一步操作這個桌面。</Empty>
            )}
            {visible.map((event) => (
              <TranscriptRow key={event.seq} event={event} round={rounds.get(event.seq) ?? 1} />
            ))}
          </div>
          {!atBottom && (
            <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
              <span className="pointer-events-auto">
                <Button size="sm" variant="secondary" onClick={jumpToLatest}>
                  回到最新
                </Button>
              </span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Field
            label="訊息"
            hint={
              running
                ? "執行中，送出的訊息會在下一步前插入"
                : "送出後會開始新的一輪，先前的對話會保留"
            }
          >
            <Textarea
              rows={3}
              value={draft}
              placeholder="開啟 https://example.com，點擊 More information 連結，回報跳轉後的網址"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </Field>

          <div className="flex flex-wrap items-end gap-3">
            <div className="w-32">
              <Field label="最多步數">
                <Input
                  type="number"
                  min={1}
                  max={200}
                  value={maxSteps}
                  onChange={(e) => setMaxSteps(e.target.value)}
                />
              </Field>
            </div>
            <Button onClick={submit} disabled={!draft.trim() || send.isPending}>
              {send.isPending ? "送出中…" : "送出"}
            </Button>
            {running && (
              <Button variant="danger" disabled={stop.isPending} onClick={() => stop.mutate()}>
                {stop.isPending ? "中止中…" : "中止本輪"}
              </Button>
            )}
            <span className="text-xs text-gray-400">Cmd / Ctrl + Enter 送出</span>
            {!instance.running && <span className="text-xs text-amber-600">這個容器沒有在執行中。</span>}
          </div>
          <ErrorText error={send.error} />
        </div>
      </div>
    </Card>
  );
}

/**
 * `status` and `reset` never reach the transcript, and a `thinking` row is only
 * a placeholder: it stands until its step lands, and a round that stopped —
 * finished, errored or back to idle — leaves nothing thinking.
 */
function visibleEvents(events: SessionEvent[], running: boolean): SessionEvent[] {
  return events.filter((event, i) => {
    if (event.type !== "thinking") return true;
    if (!running) return false;
    return !events
      .slice(i + 1)
      .some(
        (later) =>
          (later.type === "step" && later.step === event.step) ||
          later.type === "finished" ||
          later.type === "error",
      );
  });
}

function TranscriptRow({ event, round }: { event: SessionEvent; round: number }) {
  if (event.type === "user_message") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-md border border-blue-200 bg-blue-50 px-3 py-2">
          <p className="whitespace-pre-wrap text-sm text-gray-800">{event.content}</p>
          {event.interjected && (
            <div className="mt-1.5">
              <Badge tone="amber">插話</Badge>
              <p className="mt-1 text-xs text-amber-700">這則訊息會在本輪的下一步前被讀取。</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (event.type === "run_started") {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-gray-400">
        <span className="h-px flex-1 bg-gray-200" />
        <span className="whitespace-nowrap">
          第 {round} 輪 · {event.sandbox} · 畫面 {event.screen} · 最多 {event.maxSteps} 步
        </span>
        <span className="h-px flex-1 bg-gray-200" />
      </div>
    );
  }

  if (event.type === "thinking") {
    return (
      <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-1">
        <Spinner label={`第 ${event.step} 步思考中…`} />
      </div>
    );
  }

  if (event.type === "step") return <StepCard step={event} />;

  if (event.type === "finished") {
    const cls =
      event.reason === "done"
        ? "border-green-200 bg-green-50 text-green-800"
        : event.reason === "max_steps"
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-gray-300 bg-gray-100 text-gray-700";
    const label =
      event.reason === "done" ? "已完成" : event.reason === "max_steps" ? "達到步數上限" : "已中止";
    return (
      <div className={`rounded-md border px-3 py-2 ${cls}`}>
        <p className="text-sm font-semibold">
          {label}（共 {event.steps} 步）
        </p>
        <p className="mt-1 whitespace-pre-wrap text-sm">{event.summary}</p>
      </div>
    );
  }

  if (event.type === "error") return <Notice tone="red">{event.message}</Notice>;

  return null;
}

function StepCard({ step }: { step: SessionStepEvent }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-gray-800">第 {step.step} 步</span>
        <Badge tone={PHASE_TONE[step.phase] ?? "gray"}>{PHASE_LABEL[step.phase] ?? step.phase}</Badge>
        <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">
          {step.action.type}
        </code>
        <span
          className={`ml-auto rounded px-2 py-0.5 text-xs font-medium ${
            step.result.ok ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
          }`}
        >
          {step.result.ok ? "成功" : "失敗"} · {step.result.durationMs}ms
        </span>
      </div>

      <p className="mt-2 break-all font-mono text-xs text-gray-500">{formatParams(step.action.params)}</p>

      {step.intent && (
        <p className="mt-2 text-sm text-gray-800">
          <span className="mr-1 text-xs font-medium text-gray-500">意圖</span>
          {step.intent}
        </p>
      )}
      {step.observation && (
        <p className="mt-1 text-sm text-gray-800">
          <span className="mr-1 text-xs font-medium text-gray-500">觀察</span>
          {step.observation}
        </p>
      )}
      {step.result.error && <p className="mt-1 text-xs text-red-600">錯誤：{step.result.error}</p>}

      <p className="mt-2 text-xs text-gray-400">
        {step.model} · LLM {step.llmMs}ms
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- 手動動作 */

const ACTIONS = [
  "screenshot",
  "click",
  "double_click",
  "right_click",
  "move",
  "type",
  "key",
  "scroll",
  "navigate",
  "run_command",
  "cursor",
] as const;
type ActionName = (typeof ACTIONS)[number];

const ACTION_TEMPLATE: Record<ActionName, string> = {
  screenshot: "{}",
  click: '{ "x": 640, "y": 400 }',
  double_click: '{ "x": 640, "y": 400 }',
  right_click: '{ "x": 640, "y": 400 }',
  move: '{ "x": 640, "y": 400 }',
  type: '{ "text": "hello" }',
  key: '{ "key": "Return" }',
  scroll: '{ "direction": "down", "amount": 3 }',
  navigate: '{ "url": "https://example.com" }',
  run_command: '{ "command": "ls /", "timeout": 30 }',
  cursor: "{}",
};

function ManualPanel({ instance }: { instance: SandboxInstance }) {
  const [open, setOpen] = useState(false);

  return (
    <Card
      title="手動動作與容器 log"
      actions={
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "收合" : "展開"}
        </Button>
      }
    >
      {open ? (
        <div className="space-y-4">
          <ActionRunner instance={instance} />
          <LogViewer instance={instance} />
        </div>
      ) : (
        <p className="text-xs text-gray-400">不透過 LLM，直接對容器送單一動作，或查看容器 log。</p>
      )}
    </Card>
  );
}

function ActionRunner({ instance }: { instance: SandboxInstance }) {
  const [action, setAction] = useState<ActionName>("screenshot");
  const [params, setParams] = useState(ACTION_TEMPLATE.screenshot);
  const [parseError, setParseError] = useState<string | null>(null);

  const perform = useMutation({
    mutationFn: (body: { action: string; params: Record<string, unknown> }) =>
      api<SandboxActionResult>(`/admin/sandbox/instances/${instance.id}/actions`, { method: "POST", body }),
  });

  const submit = () => {
    setParseError(null);
    let parsed: Record<string, unknown> = {};
    const raw = params.trim();
    if (raw) {
      try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          setParseError("參數必須是一個 JSON 物件。");
          return;
        }
        parsed = value as Record<string, unknown>;
      } catch (err) {
        setParseError(`參數不是合法的 JSON：${errorMessage(err)}`);
        return;
      }
    }
    perform.mutate({ action, params: parsed });
  };

  const result = perform.data;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Field label="動作">
          <Select
            value={action}
            onChange={(e) => {
              const next = e.target.value as ActionName;
              setAction(next);
              setParams(ACTION_TEMPLATE[next]);
              setParseError(null);
            }}
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="參數（JSON）">
          <Textarea rows={3} value={params} onChange={(e) => setParams(e.target.value)} />
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={perform.isPending}>
          {perform.isPending ? "送出中…" : "送出"}
        </Button>
        {result && (
          <span className="text-xs text-gray-500">
            {result.ok ? "成功" : "失敗"} · {result.durationMs}ms
          </span>
        )}
      </div>
      {parseError && <ErrorText error={parseError} />}
      <ErrorText error={perform.error} />

      {result && (
        <div className="space-y-2">
          {result.image && (
            <img
              src={result.image}
              alt="sandbox 截圖"
              className="w-full rounded-md border border-gray-300"
            />
          )}
          <pre className="max-h-64 overflow-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
            {JSON.stringify({ ...result, image: result.image ? "（已於上方顯示）" : undefined }, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function LogViewer({ instance }: { instance: SandboxInstance }) {
  const logs = useQuery({
    queryKey: ["admin", "sandbox", "logs", instance.id],
    queryFn: () => api<{ logs: string }>(`/admin/sandbox/instances/${instance.id}/logs?tail=200`),
  });

  return (
    <div className="space-y-2 border-t border-gray-100 pt-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">容器 log（最後 200 行）</h3>
        <Button size="sm" variant="secondary" onClick={() => logs.refetch()} disabled={logs.isFetching}>
          {logs.isFetching ? "載入中…" : "重新載入"}
        </Button>
      </div>
      {logs.isPending && <Spinner />}
      <ErrorText error={logs.error} />
      {logs.data && (
        <pre className="max-h-72 overflow-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
          {logs.data.logs || "（沒有輸出）"}
        </pre>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 設定 */

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

function SettingsTab() {
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
  );
}
