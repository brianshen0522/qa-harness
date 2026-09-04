import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiEventSource, apiEventStream, errorMessage } from "../api/client";
import type {
  AccessState, ExploreDetail, ExploreEvent, ExploreRunRow, IdentityList, Role, TargetIdentity,
} from "../api/types";
import {
  Badge, Button, Card, Dialog, Empty, ErrorText, Field, Input, Notice, Select, Spinner,
} from "./ui";
import { formatDate, hasRole } from "../lib/roles";

const identitiesKey = (t: string) => ["target", t, "identities"];
const latestKey = (t: string) => ["target", t, "explore-latest"];

function evidenceUrl(runId: string, key: string): string {
  return `/api/explore/${runId}/evidence?key=${encodeURIComponent(key)}`;
}

/**
 * Explore-first mode. The user does not plan anything: they declare who uses the
 * system (identities), press go, and the model crawls every identity's view
 * across breakpoints, then designs test cases from what is actually there.
 */
export function ExplorePanel({ targetId, myRole, kind }: { targetId: string; myRole: Role | undefined; kind: string }) {
  const canEdit = hasRole(myRole, "editor");
  const [live, setLive] = useState<ExploreEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  const qc = useQueryClient();
  const sourceRef = useRef<EventSource | null>(null);
  const attachedRef = useRef(false);

  // Poll while a run is active so the site map / matrix / findings fill in as
  // the crawl progresses — and so a page that is left and reopened is not stale.
  const latest = useQuery({
    queryKey: latestKey(targetId),
    queryFn: () => api<ExploreDetail | null>(`/targets/${targetId}/explore/latest`),
    refetchInterval: (q) => {
      const s = (q.state.data as ExploreDetail | null)?.run.status;
      return s === "running" || s === "paused" ? 4000 : false;
    },
  });
  const activeRun = latest.data?.run.status === "running" || latest.data?.run.status === "paused";

  useEffect(() => () => sourceRef.current?.close(), []);

  /** Reconnect to the live feed of a run already in progress; the server replays. */
  const attach = useCallback(() => {
    if (sourceRef.current) return;
    setLive([]);
    const source = apiEventSource(`/targets/${targetId}/explore/stream`);
    sourceRef.current = source;
    let seen = 0;
    source.onopen = () => {
      seen = 0;
      setLive([]);
    };
    source.onmessage = (e) => {
      let event: ExploreEvent;
      try {
        event = JSON.parse(e.data as string) as ExploreEvent;
      } catch {
        return;
      }
      if (event.type === "error" && seen === 0) {
        source.close();
        sourceRef.current = null;
        return;
      }
      seen++;
      setLive((prev) => [...prev, event]);
      if (event.type === "finished" || event.type === "error") {
        source.close();
        sourceRef.current = null;
        void qc.invalidateQueries({ queryKey: latestKey(targetId) });
        void qc.invalidateQueries({ queryKey: ["target", targetId, "test-cases"] });
      }
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        sourceRef.current = null;
      }
    };
  }, [targetId, qc]);

  // Coming back to a running exploration re-attaches to its feed, rather than
  // looking idle while the crawl keeps going on the server.
  useEffect(() => {
    if (attachedRef.current || running || !activeRun) return;
    attachedRef.current = true;
    attach();
  }, [activeRun, running, attach]);

  const run = async (body: Record<string, unknown>) => {
    setLive([]);
    setRunning(true);
    setStartError(null);
    attachedRef.current = true; // this POST is the stream; don't also re-attach
    try {
      await apiEventStream<ExploreEvent>(`/targets/${targetId}/explore`, { body }, (e) => {
        setLive((prev) => [...prev, e]);
        if (e.type === "visit" || e.type === "matrix" || e.type === "synth") {
          void qc.invalidateQueries({ queryKey: latestKey(targetId) });
        }
      });
    } catch (err) {
      setStartError(err);
    } finally {
      setRunning(false);
      void qc.invalidateQueries({ queryKey: latestKey(targetId) });
      void qc.invalidateQueries({ queryKey: ["target", targetId, "test-cases"] });
    }
  };

  if (kind !== "web") {
    return <Card title="探索模式"><Notice>探索模式目前只支援 web 類型的 Target。</Notice></Card>;
  }

  const showFeed = running || activeRun || live.length > 0;

  return (
    <div className="space-y-4">
      <IdentitiesCard targetId={targetId} canEdit={canEdit} />
      <StartCard canEdit={canEdit} running={running || !!activeRun} onRun={run} error={startError} />
      {showFeed && <LiveFeed events={live} running={running || !!activeRun} />}

      {latest.isLoading && <Spinner />}
      {latest.data && <Results detail={latest.data} targetId={targetId} />}
      {!latest.isLoading && !latest.data && !live.length && (
        <Card title="探索結果"><Empty>還沒有探索過。設定好身份後按「開始探索」，讓模型自己把系統走一遍。</Empty></Card>
      )}
    </div>
  );
}

// ---------- identities ----------

function IdentitiesCard({ targetId, canEdit }: { targetId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: identitiesKey(targetId), queryFn: () => api<IdentityList>(`/targets/${targetId}/identities`) });
  const [adding, setAdding] = useState(false);

  const remove = useMutation({
    mutationFn: (id: string) => api(`/identities/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: identitiesKey(targetId) }),
  });

  return (
    <Card title="身份" actions={canEdit && <Button size="sm" onClick={() => setAdding(true)}>新增身份</Button>}>
      <p className="mb-3 text-xs text-gray-500">
        每個身份代表「一種使用者」（管理員、一般會員、未登入訪客…）。探索會逐一登入、各走一遍，
        「誰能看到什麼」才能靠比對得出來，而不是用猜的。
      </p>
      {list.isLoading && <Spinner />}
      <ErrorText error={list.error ?? remove.error} />
      {list.data && (
        list.data.identities.length === 0 ? (
          <Empty>還沒有身份。至少建立一個（未登入的訪客也算）。</Empty>
        ) : (
          <ul className="space-y-2">
            {list.data.identities.map((i) => (
              <li key={i.id} className="flex items-center gap-2 rounded-md border border-gray-200 p-2">
                <Badge tone={/admin|owner/i.test(i.role) ? "purple" : i.isAnonymous ? "gray" : "blue"}>{i.role}</Badge>
                <span className="text-sm font-medium text-gray-800">{i.name}</span>
                {i.isAnonymous ? <span className="text-xs text-gray-400">未登入</span>
                  : <span className="text-xs text-gray-400">憑證：{i.credentialKeys.join("、") || "（未設定）"}</span>}
                {canEdit && (
                  <Button variant="ghost" size="sm" className="ml-auto" onClick={() => remove.mutate(i.id)} disabled={remove.isPending}>
                    刪除
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )
      )}
      {adding && (
        <IdentityDialog
          targetId={targetId}
          credentialKeys={list.data?.credentialKeys ?? []}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); void qc.invalidateQueries({ queryKey: identitiesKey(targetId) }); }}
        />
      )}
    </Card>
  );
}

function IdentityDialog({ targetId, credentialKeys, onClose, onSaved }: {
  targetId: string; credentialKeys: string[]; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("user");
  const [anon, setAnon] = useState(false);
  const [userKey, setUserKey] = useState("");
  const [passKey, setPassKey] = useState("");
  const [loginPath, setLoginPath] = useState("/login");
  const [submitText, setSubmitText] = useState("Sign In");

  const save = useMutation({
    mutationFn: () => api<TargetIdentity>(`/targets/${targetId}/identities`, {
      method: "POST",
      body: anon
        ? { name, role, isAnonymous: true }
        : { name, role, credentialKeys: [userKey, passKey].filter(Boolean), loginConfig: { loginPath, userKey, passKey, submitText } },
    }),
    onSuccess: onSaved,
  });

  return (
    <Dialog open title="新增身份" onClose={onClose}>
      <div className="space-y-2">
        <Field label="名稱"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 管理員 / 一般會員 / 訪客" /></Field>
        <Field label="角色標籤" hint="給權限矩陣比對用，例如 admin / member / guest">
          <Input value={role} onChange={(e) => setRole(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} />
          未登入的訪客（不需要憑證）
        </label>
        {!anon && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="帳號憑證">
                <Select value={userKey} onChange={(e) => setUserKey(e.target.value)}>
                  <option value="">選一個</option>
                  {credentialKeys.map((k) => <option key={k} value={k}>{k}</option>)}
                </Select>
              </Field>
              <Field label="密碼憑證">
                <Select value={passKey} onChange={(e) => setPassKey(e.target.value)}>
                  <option value="">選一個</option>
                  {credentialKeys.map((k) => <option key={k} value={k}>{k}</option>)}
                </Select>
              </Field>
            </div>
            {credentialKeys.length === 0 && <Notice>這個 Target 還沒有憑證。請先到「總覽」設定憑證，再回來建立需要登入的身份。</Notice>}
            <div className="grid grid-cols-2 gap-2">
              <Field label="登入頁路徑"><Input value={loginPath} onChange={(e) => setLoginPath(e.target.value)} /></Field>
              <Field label="登入按鈕文字"><Input value={submitText} onChange={(e) => setSubmitText(e.target.value)} /></Field>
            </div>
          </>
        )}
        <div className="flex items-center gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim() || (!anon && (!userKey || !passKey))}>
            {save.isPending ? "建立中…" : "建立"}
          </Button>
          <Button variant="ghost" onClick={onClose}>取消</Button>
        </div>
        <ErrorText error={save.error} />
      </div>
    </Dialog>
  );
}

// ---------- start ----------

function StartCard({ canEdit, running, onRun, error }: {
  canEdit: boolean; running: boolean; onRun: (b: Record<string, unknown>) => void; error: unknown;
}) {
  const [maxNodes, setMaxNodes] = useState(60);
  const [maxDepth, setMaxDepth] = useState(4);
  const [doRwd, setDoRwd] = useState(true);
  const [deepBudget, setDeepBudget] = useState(8);
  const [doSynthesis, setDoSynthesis] = useState(true);

  return (
    <Card title="開始探索">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="最多掃描頁面數"><Input type="number" min={1} max={400} value={maxNodes} onChange={(e) => setMaxNodes(Number(e.target.value))} /></Field>
        <Field label="連結深度上限"><Input type="number" min={1} max={10} value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} /></Field>
        <Field label="深入查看預算（模型次數）" hint="對有表單的頁面用視覺深入盤點；0 表示關閉">
          <Input type="number" min={0} max={40} value={deepBudget} onChange={(e) => setDeepBudget(Number(e.target.value))} />
        </Field>
        <div className="flex flex-col justify-end gap-1">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={doRwd} onChange={(e) => setDoRwd(e.target.checked)} /> 掃描 RWD 各斷點</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={doSynthesis} onChange={(e) => setDoSynthesis(e.target.checked)} /> 掃描後自動設計測試案例</label>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button disabled={!canEdit || running} onClick={() => onRun({ maxNodes, maxDepth, doRwd, deepBudget, doSynthesis })}>
          {running ? "探索中…" : "開始探索"}
        </Button>
        <span className="text-xs text-gray-500">探索會開一個 sandbox 實際操作站台。過程唯讀：不會送出表單或刪任何東西。</span>
      </div>
      <ErrorText error={error} />
    </Card>
  );
}

function LiveFeed({ events, running }: { events: ExploreEvent[]; running: boolean }) {
  const lines = events.slice(-40).map((e, i) => {
    let text = "";
    if (e.type === "phase") text = `▶ ${e.message}`;
    else if (e.type === "login") text = `${e.ok ? "✓" : "✗"} ${e.message}`;
    else if (e.type === "visit") text = `  [${e.identity}] ${e.routeKey}${e.denied ? "（被擋）" : ""}`;
    else if (e.type === "rwd" && e.issues > 0) text = `  RWD ${e.routeKey} @${e.breakpoint}：${e.issues} 個問題`;
    else if (e.type === "matrix") text = `權限矩陣：${e.routes} 條路由，${e.suspicious} 個可疑`;
    else if (e.type === "interact") text = `  互動 ${e.routeKey} 點「${e.opener}」→ 發現${e.found === "modal" ? "彈窗" : e.found === "menu" ? "選單" : "面板"}`;
    else if (e.type === "synth") text = `  設計 ${e.routeKey} → ${e.cases} 條`;
    else if (e.type === "paused") text = `⏸ ${e.message}`;
    else if (e.type === "resumed") text = `▶ ${e.message}`;
    else if (e.type === "finished") text = `✓ 完成，共 ${e.stats.casesGenerated} 條案例`;
    else if (e.type === "error") text = `✗ ${e.message}`;
    return text ? <div key={i}>{text}</div> : null;
  });
  return (
    <Card title={running ? "探索進行中…" : "探索紀錄"}>
      <pre className="max-h-72 overflow-auto rounded bg-gray-900 p-3 text-xs leading-relaxed text-gray-200">{lines}</pre>
    </Card>
  );
}

// ---------- results ----------

function Results({ detail, targetId }: { detail: ExploreDetail; targetId: string }) {
  const s = detail.run.stats;
  const findings = detail.observations.filter((o) => o.kind === "finding");
  const rwd = detail.observations.filter((o) => o.kind === "rwd_issue");
  const deep = detail.observations.filter((o) => o.kind === "deep_note");

  return (
    <div className="space-y-4">
      <Card title="覆蓋率總覽" actions={<Badge tone={detail.run.status === "succeeded" ? "green" : detail.run.status === "failed" ? "red" : "amber"}>{detail.run.status}</Badge>}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Stat label="掃描頁面" value={s?.routes ?? 0} />
          <Stat label="身份" value={s?.identities ?? 0} />
          <Stat label="產生案例" value={s?.casesGenerated ?? 0} />
          <Stat label="RWD 問題" value={s?.rwdIssues ?? 0} />
          <Stat label="即時發現" value={s?.findings ?? 0} />
          <Stat label="可疑存取" value={s?.suspiciousAccess ?? 0} tone={s?.suspiciousAccess ? "red" : "gray"} />
          <Stat label="有表單頁" value={s?.coverage?.withForms ?? 0} />
          <Stat label="模型呼叫" value={detail.run.llmCalls} />
        </div>
        {detail.run.startedAt && <p className="mt-2 text-xs text-gray-400">{formatDate(detail.run.startedAt)}</p>}
        {detail.run.error && <p className="mt-1 text-xs text-red-600">{detail.run.error}</p>}
      </Card>

      <PermissionMatrix detail={detail} />

      {(findings.length > 0 || deep.length > 0) && (
        <Card title={`探索發現（${findings.length} 問題 · ${deep.length} 情境筆記）`}>
          <ul className="space-y-2">
            {findings.map((o) => (
              <li key={o.id} className="rounded-md border border-red-200 bg-red-50/40 p-2">
                <div className="flex items-center gap-2">
                  <Badge tone={o.severity === "critical" || o.severity === "major" ? "red" : "amber"}>{o.severity}</Badge>
                  <span className="text-sm font-medium text-gray-800">{o.note}</span>
                </div>
                {typeof o.data.description === "string" && <p className="mt-1 text-xs text-gray-600">{o.data.description}</p>}
              </li>
            ))}
          </ul>
          {deep.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-gray-500">情境筆記（{deep.length}）</summary>
              <ul className="mt-1 space-y-1">
                {deep.map((o) => <li key={o.id} className="text-xs text-gray-600">· {o.note}</li>)}
              </ul>
            </details>
          )}
        </Card>
      )}

      {rwd.length > 0 && (
        <Card title={`RWD 問題（${rwd.length}）`}>
          <ul className="space-y-1">
            {rwd.map((o) => (
              <li key={o.id} className="text-sm text-gray-700">
                <Badge tone={o.severity === "major" ? "red" : "amber"}>{o.breakpoint}</Badge> {o.note}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <SiteMap detail={detail} />
    </div>
  );
}

function Stat({ label, value, tone = "gray" }: { label: string; value: number; tone?: "gray" | "red" }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white px-3 py-2">
      <div className={`text-lg font-semibold ${tone === "red" && value > 0 ? "text-red-600" : "text-gray-800"}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

function PermissionMatrix({ detail }: { detail: ExploreDetail }) {
  const { matrix } = detail;
  const cell = (s: AccessState) =>
    s === "granted" ? <span className="text-green-700">可進</span>
    : s === "denied" ? <span className="text-gray-400">被擋</span>
    : <span className="text-gray-300">—</span>;
  return (
    <Card title="權限矩陣" actions={matrix.suspicious.length > 0 && <Badge tone="red">{matrix.suspicious.length} 個可疑</Badge>}>
      {matrix.suspicious.length > 0 && (
        <Notice tone="red">
          有 {matrix.suspicious.length} 條看起來該受保護的路由被非特權身份進入了：{matrix.suspicious.map((r) => r.routeKey).join("、")}
        </Notice>
      )}
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
              <th className="py-1 pr-3">路由</th>
              {matrix.identities.map((id) => <th key={id} className="px-2 py-1">{id}</th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => {
              const flagged = matrix.suspicious.some((s) => s.routeKey === row.routeKey);
              return (
                <tr key={row.routeKey} className={`border-b border-gray-100 ${flagged ? "bg-red-50/50" : ""}`}>
                  <td className="py-1 pr-3 font-mono text-xs text-gray-700">{row.routeKey}</td>
                  {matrix.identities.map((id) => <td key={id} className="px-2 py-1 text-xs">{cell(row.access[id])}</td>)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const STATE_KINDS = new Set(["modal", "panel", "menu"]);
const STATE_LABEL: Record<string, string> = { modal: "彈窗", panel: "面板", menu: "選單" };

function SiteMap({ detail }: { detail: ExploreDetail }) {
  const [shot, setShot] = useState<string | null>(null);

  // Split real pages from the interaction states (modals/menus) that hang off
  // them, and attach each state to the page whose button opened it.
  const { byDepth, childrenOf, stateCount } = useMemo(() => {
    const pages = detail.nodes.filter((n) => !STATE_KINDS.has(n.kind));
    const states = detail.nodes.filter((n) => STATE_KINDS.has(n.kind));
    const parentByTo = new Map<string, string>();
    for (const e of detail.edges) if (e.kind === "control" && e.to) parentByTo.set(e.to, e.from);
    const childrenOf = new Map<string, typeof states>();
    for (const st of states) {
      const parent = parentByTo.get(st.id);
      if (!parent) continue;
      const list = childrenOf.get(parent) ?? [];
      list.push(st);
      childrenOf.set(parent, list);
    }
    const m = new Map<number, typeof pages>();
    for (const n of pages) {
      const list = m.get(n.depth) ?? [];
      list.push(n);
      m.set(n.depth, list);
    }
    return { byDepth: [...m.entries()].sort((a, b) => a[0] - b[0]), childrenOf, stateCount: states.length };
  }, [detail.nodes, detail.edges]);

  const chip = (n: ExploreDetail["nodes"][number], isState: boolean) => (
    <button
      key={n.id}
      type="button"
      onClick={() => n.screenshotKey && setShot(evidenceUrl(detail.run.id, n.screenshotKey))}
      className={`rounded-md border px-2 py-1 text-left text-xs ${
        isState ? "border-purple-300 bg-purple-50" : n.kind === "form" ? "border-blue-300 bg-blue-50" : "border-gray-200 bg-white"
      } ${n.screenshotKey ? "hover:bg-gray-100" : "cursor-default"}`}
      title={n.title}
    >
      <div className="font-mono text-gray-800">
        {isState && <span className="mr-1 rounded bg-purple-200 px-1 text-[10px] text-purple-800">{STATE_LABEL[n.kind] ?? n.kind}</span>}
        {isState ? n.routeKey.split(" ▸ ").slice(1).join(" ▸ ") || n.title : n.routeKey}
      </div>
      <div className="text-gray-400">
        {n.reachableBy.join("/") || "無人可進"}
        {!isState && n.kind === "form" ? " · 表單" : ""}
      </div>
    </button>
  );

  return (
    <Card title={`站點地圖（${byDepth.reduce((a, [, ns]) => a + ns.length, 0)} 頁${stateCount ? ` · ${stateCount} 個互動狀態` : ""}）`}>
      <div className="space-y-3">
        {byDepth.map(([depth, nodes]) => (
          <div key={depth}>
            <p className="mb-1 text-xs text-gray-400">深度 {depth}</p>
            <div className="flex flex-col gap-2">
              {nodes.map((n) => {
                const kids = childrenOf.get(n.id) ?? [];
                return (
                  <div key={n.id} className="flex flex-wrap items-start gap-2">
                    {chip(n, false)}
                    {kids.length > 0 && (
                      <>
                        <span className="self-center text-gray-300">›</span>
                        {kids.map((k) => chip(k, true))}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {shot && (
        <Dialog open title="頁面截圖" onClose={() => setShot(null)}>
          <img src={shot} alt="頁面截圖" className="w-full rounded border border-gray-200" />
        </Dialog>
      )}
    </Card>
  );
}
