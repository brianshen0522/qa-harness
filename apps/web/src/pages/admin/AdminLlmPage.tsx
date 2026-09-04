import { useEffect, useState, type DragEvent, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import type {
  ChainEntry,
  Chains,
  LlmConfig,
  LlmConfigHealth,
  LlmConfigInput,
  LlmHealthStatus,
  LlmProbeResult,
  LlmProvider,
  LlmPurpose,
  LlmTestResult,
} from "../../api/types";
import { Badge, Button, Card, Dialog, Empty, ErrorText, Field, Input, Notice, Select, Spinner, Table, Textarea } from "../../components/ui";
import {
  LLM_HEALTH_LABEL,
  LLM_HEALTH_TONE,
  PURPOSES,
  PURPOSE_LABEL,
  PURPOSE_SHORT_LABEL,
  formatDate,
  formatInterval,
} from "../../lib/roles";

const PROVIDERS: LlmProvider[] = ["anthropic", "openai", "ollama"];

export default function AdminLlmPage() {
  const qc = useQueryClient();
  const configs = useQuery({ queryKey: ["admin", "llm", "configs"], queryFn: () => api<LlmConfig[]>("/admin/llm/configs") });
  const [editing, setEditing] = useState<LlmConfig | null | "new">(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const invalidateAll = () => qc.invalidateQueries({ queryKey: ["admin", "llm"] });

  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/admin/llm/configs/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeletingId(null);
      invalidateAll();
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">LLM Providers</h1>
        <Button onClick={() => setEditing("new")}>新增設定</Button>
      </div>

      <HealthSection />

      <Card title={`設定清單${configs.data ? `（${configs.data.length}）` : ""}`}>
        {configs.isPending && <Spinner />}
        <ErrorText error={configs.error} />
        <ErrorText error={remove.error} />
        {configs.data && configs.data.length === 0 && <Empty>尚無 LLM 設定。</Empty>}
        <ul className="divide-y divide-gray-100">
          {configs.data?.map((c) => (
            <li key={c.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    <Badge tone="purple">{c.provider}</Badge>
                    <Badge tone={c.enabled ? "green" : "red"}>{c.enabled ? "啟用" : "停用"}</Badge>
                    {c.supportsVision && <Badge tone="blue">Vision</Badge>}
                    {c.hasApiKey ? <Badge>Key：{c.apiKeyMasked || "已設定"}</Badge> : <Badge tone="amber">未設定 Key</Badge>}
                  </div>
                  <p className="text-xs text-gray-500">
                    模型：<code>{c.model}</code>
                    {c.endpoint && (
                      <>
                        {" "}
                        · Endpoint：<code>{c.endpoint}</code>
                      </>
                    )}
                  </p>
                  <div className="flex flex-wrap gap-1 text-xs">
                    {c.purposes.length === 0 && <span className="text-gray-400">未指定用途</span>}
                    {c.purposes.map((p) => (
                      <Badge key={p}>
                        {PURPOSE_LABEL[p]}
                        {c.chainPositions[p] != null && ` #${c.chainPositions[p]}`}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setTestingId(testingId === c.id ? null : c.id)}>
                    {testingId === c.id ? "收合測試" : "送測試 prompt"}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(c)}>
                    編輯
                  </Button>
                  <Button variant="danger" size="sm" onClick={() => setDeletingId(c.id)}>
                    刪除
                  </Button>
                </div>
              </div>
              {testingId === c.id && <TestPanel config={c} />}
            </li>
          ))}
        </ul>
      </Card>

      <ChainsSection configs={configs.data ?? []} />

      {editing !== null && <ConfigDialog config={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={invalidateAll} />}

      <Dialog open={deletingId !== null} title="刪除 LLM 設定" onClose={() => setDeletingId(null)}>
        <p className="text-sm text-gray-700">確定要刪除「{configs.data?.find((c) => c.id === deletingId)?.name}」嗎？它會從所有 fallback chain 中移除。</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeletingId(null)}>
            取消
          </Button>
          <Button variant="danger" onClick={() => deletingId && remove.mutate(deletingId)} disabled={remove.isPending}>
            確認刪除
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------- 健康狀態 */

const HEALTH_KEY = ["admin", "llm", "health"];

function coverageTone(c: { configured: number; usable: number }): "green" | "amber" | "red" {
  if (c.usable === 0 && c.configured > 0) return "red";
  if (c.usable < c.configured) return "amber";
  return "green";
}

/**
 * The circuit breaker's view of every config, plus what it costs: a purpose with
 * nothing usable does not fail any more, it pauses the work that needs it. The
 * poll tightens to 10s while anything is unhealthy so a recovery shows up fast.
 */
function HealthSection() {
  const qc = useQueryClient();
  const health = useQuery({
    queryKey: HEALTH_KEY,
    queryFn: () => api<LlmHealthStatus>("/admin/llm/health"),
    refetchInterval: (query) =>
      query.state.data?.configs.some((c) => c.health !== "healthy") ? 10_000 : 60_000,
  });

  const probeAll = useMutation({
    mutationFn: () => api<{ recovered: number }>("/admin/llm/probe-all", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: HEALTH_KEY }),
  });

  const data = health.data;
  const starved = data ? PURPOSES.filter((p) => data.coverage[p].usable === 0) : [];

  return (
    <Card
      title="健康狀態"
      actions={
        <>
          {probeAll.data && (
            <span className="text-xs text-gray-500">
              {probeAll.data.recovered > 0 ? `已恢復 ${probeAll.data.recovered} 組` : "沒有恢復任何一組"}
            </span>
          )}
          <Button size="sm" variant="secondary" disabled={probeAll.isPending} onClick={() => probeAll.mutate()}>
            {probeAll.isPending ? "重測中…" : "全部重測"}
          </Button>
        </>
      }
    >
      {health.isPending && <Spinner />}
      <ErrorText error={health.error} />
      <ErrorText error={probeAll.error} />

      {data && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {PURPOSES.map((p) => {
              const c = data.coverage[p];
              return (
                <Badge key={p} tone={coverageTone(c)}>
                  {PURPOSE_SHORT_LABEL[p]} {c.usable} / {c.configured}
                </Badge>
              );
            })}
            <span className="text-xs text-gray-400">可用 / 已設定（僅計入啟用的設定）</span>
          </div>

          {starved.length > 0 && (
            <Notice tone="red">
              以下用途目前沒有可用的 LLM：
              {starved
                .map((p) =>
                  data.coverage[p].configured === 0
                    ? `${PURPOSE_LABEL[p]}（尚未設定）`
                    : `${PURPOSE_LABEL[p]}（全部失效）`,
                )
                .join("、")}
              。需要這些用途的工作不會失敗，而是會暫停並保留進度，等有模型恢復後自動接續。
            </Notice>
          )}

          <p className="text-xs text-gray-400">
            失效的設定會自動重測，間隔{formatInterval(data.probeIntervalMs)}
            （連續失敗會逐次拉長），只要有一次成功就立刻放回輪替；這個機制不會停止，也不需要手動介入。
          </p>

          {data.configs.length === 0 ? (
            <Empty>尚無 LLM 設定。</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>名稱</th>
                  <th>健康</th>
                  <th>連續失敗</th>
                  <th>最近一次失敗</th>
                  <th>失效起於</th>
                  <th>上次重測</th>
                  <th>下次重測</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.configs.map((c) => (
                  <HealthRow key={c.id} config={c} />
                ))}
              </tbody>
            </Table>
          )}
        </div>
      )}
    </Card>
  );
}

function HealthRow({ config }: { config: LlmConfigHealth }) {
  const qc = useQueryClient();
  const probe = useMutation({
    mutationFn: () => api<LlmProbeResult>(`/admin/llm/configs/${config.id}/probe`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: HEALTH_KEY }),
  });

  return (
    <tr>
      <td>
        <p className="font-medium">{config.name}</p>
        <p className="text-xs text-gray-400">
          {config.provider} · {config.model}
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {!config.enabled && <Badge tone="gray">停用</Badge>}
          {config.purposes.map((p) => (
            <Badge key={p}>{PURPOSE_SHORT_LABEL[p]}</Badge>
          ))}
        </div>
      </td>
      <td>
        <Badge tone={LLM_HEALTH_TONE[config.health]}>{LLM_HEALTH_LABEL[config.health]}</Badge>
        {config.health !== "down" && config.lastRecoveredAt && (
          <p className="mt-1 whitespace-nowrap text-xs text-gray-400">{formatDate(config.lastRecoveredAt)} 恢復</p>
        )}
      </td>
      <td className="text-xs">{config.consecutiveFailures}</td>
      <td className="max-w-xs text-xs text-gray-600">
        {config.lastFailureAt ? (
          <>
            {config.lastFailureKind && <Badge tone="red">{config.lastFailureKind}</Badge>}
            <p className="mt-1 break-words">{config.lastFailureMessage ?? "（無訊息）"}</p>
            <p className="mt-0.5 text-gray-400">{formatDate(config.lastFailureAt)}</p>
          </>
        ) : (
          <span className="text-gray-400">-</span>
        )}
      </td>
      <td className="whitespace-nowrap text-xs text-gray-500">{formatDate(config.downSince)}</td>
      <td className="whitespace-nowrap text-xs text-gray-500">
        {formatDate(config.lastProbeAt)}
        {config.probeAttempts > 0 && <span className="ml-1 text-gray-400">（第 {config.probeAttempts} 次）</span>}
      </td>
      <td className="whitespace-nowrap text-xs text-gray-500">{formatDate(config.nextProbeAt)}</td>
      <td>
        <Button size="sm" variant="secondary" disabled={probe.isPending} onClick={() => probe.mutate()}>
          {probe.isPending ? "測試中…" : "立即測試"}
        </Button>
        {probe.data && (
          <p className={`mt-1 text-xs ${probe.data.ok ? "text-green-700" : "text-red-600"}`}>
            {probe.data.ok ? `成功 · ${probe.data.latencyMs} ms` : `失敗 · ${probe.data.error ?? "未知錯誤"}`}
          </p>
        )}
        <ErrorText error={probe.error} />
      </td>
    </tr>
  );
}

function TestPanel({ config }: { config: LlmConfig }) {
  const [prompt, setPrompt] = useState("請用一句話自我介紹。");
  const test = useMutation({
    mutationFn: () => api<LlmTestResult>(`/admin/llm/configs/${config.id}/test`, { method: "POST", body: { prompt } }),
  });
  const r = test.data;

  return (
    <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          test.mutate();
        }}
        className="space-y-2"
      >
        <Field label="測試 prompt">
          <Textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        <Button type="submit" size="sm" disabled={!prompt.trim() || test.isPending}>
          {test.isPending ? "送出中…" : "送出"}
        </Button>
      </form>
      <ErrorText error={test.error} />
      {r && (
        <div className="mt-3 text-sm">
          {r.ok ? (
            <>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <Badge tone="green">成功</Badge>
                <span>延遲 {r.latencyMs} ms</span>
                <span>模型 {r.model}</span>
                <span>
                  tokens {r.usage.inputTokens} / {r.usage.outputTokens}
                </span>
              </div>
              <pre className="whitespace-pre-wrap rounded bg-white p-2 font-sans text-sm text-gray-800">{r.text}</pre>
            </>
          ) : (
            <>
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <Badge tone="red">失敗</Badge>
                <span>{r.errorKind}</span>
                {r.status != null && <span>HTTP {r.status}</span>}
                <span>延遲 {r.latencyMs} ms</span>
              </div>
              <pre className="whitespace-pre-wrap rounded bg-white p-2 font-mono text-xs text-red-700">{r.error}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ConfigDialog({ config, onClose, onSaved }: { config: LlmConfig | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(config?.name ?? "");
  const [provider, setProvider] = useState<LlmProvider>(config?.provider ?? "anthropic");
  const [endpoint, setEndpoint] = useState(config?.endpoint ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(config?.model ?? "");
  const [purposes, setPurposes] = useState<LlmPurpose[]>(config?.purposes ?? []);
  const [supportsVision, setSupportsVision] = useState(config?.supportsVision ?? false);
  const [enabled, setEnabled] = useState(config?.enabled ?? true);

  const save = useMutation({
    mutationFn: () => {
      const body: LlmConfigInput = {
        name,
        provider,
        endpoint: endpoint.trim() || undefined,
        model,
        purposes,
        supportsVision,
        enabled,
      };
      if (apiKey) body.apiKey = apiKey;
      return config
        ? api<LlmConfig>(`/admin/llm/configs/${config.id}`, { method: "PATCH", body: { ...body } })
        : api<LlmConfig>("/admin/llm/configs", { method: "POST", body: { ...body } });
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const togglePurpose = (p: LlmPurpose) =>
    setPurposes((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : PURPOSES.filter((x) => x === p || cur.includes(x))));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  const executeWithoutVision = purposes.includes("execute") && !supportsVision;

  return (
    <Dialog open title={config ? `編輯：${config.name}` : "新增 LLM 設定"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="名稱">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Provider">
            <Select value={provider} onChange={(e) => setProvider(e.target.value as LlmProvider)}>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="模型">
            <Input required value={model} onChange={(e) => setModel(e.target.value)} placeholder="例如 claude-sonnet-4-5" />
          </Field>
        </div>
        <Field label="Endpoint（選填）" hint="留空使用 provider 預設；Ollama 通常為 http://localhost:11434">
          <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://..." />
        </Field>
        <Field label="API Key" hint={config?.hasApiKey ? `目前：${config.apiKeyMasked || "已設定"}，留空表示不變更` : "Ollama 可留空"}>
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" placeholder={config?.hasApiKey ? "••••••••（不變更）" : ""} />
        </Field>
        <fieldset>
          <legend className="mb-1 text-xs font-medium text-gray-600">用途</legend>
          <div className="flex flex-wrap gap-4">
            {PURPOSES.map((p) => (
              <label key={p} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={purposes.includes(p)} onChange={() => togglePurpose(p)} />
                {PURPOSE_LABEL[p]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={supportsVision} onChange={(e) => setSupportsVision(e.target.checked)} />
            支援 Vision
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            啟用
          </label>
        </div>
        {executeWithoutVision && <Notice>「執行（execute）」用途需要支援 Vision 的模型，儲存時後端可能拒絕。</Notice>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={!name.trim() || !model.trim() || save.isPending}>
            {save.isPending ? "儲存中…" : "儲存"}
          </Button>
        </div>
        <ErrorText error={save.error} />
      </form>
    </Dialog>
  );
}

function ChainsSection({ configs }: { configs: LlmConfig[] }) {
  const chains = useQuery({ queryKey: ["admin", "llm", "chains"], queryFn: () => api<Chains>("/admin/llm/chains") });

  return (
    <Card title="Fallback chains">
      <p className="mb-3 text-xs text-gray-400">每個用途一條順序清單，依序嘗試；遇到逾時、rate limit、5xx 或格式錯誤時往下一個切換。可用上下鍵或拖曳排序。</p>
      {chains.isPending && <Spinner />}
      <ErrorText error={chains.error} />
      {chains.data && (
        <div className="grid gap-4 md:grid-cols-3">
          {PURPOSES.map((p) => (
            <ChainEditor key={p} purpose={p} entries={chains.data[p] ?? []} configs={configs} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ChainEditor({ purpose, entries, configs }: { purpose: LlmPurpose; entries: ChainEntry[]; configs: LlmConfig[] }) {
  const qc = useQueryClient();
  const serverOrder = [...entries].sort((a, b) => a.order - b.order).map((e) => e.llmConfigId);
  const [order, setOrder] = useState<string[]>(serverOrder);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  useEffect(() => {
    setOrder(serverOrder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverOrder.join("|")]);

  // Configs that have this purpose but are not yet in the chain (the PUT must include every one).
  const missing = configs.filter((c) => c.purposes.includes(purpose) && !order.includes(c.id));
  const full = [...order, ...missing.map((c) => c.id)];

  const byId = new Map<string, ChainEntry["llmConfig"]>();
  for (const e of entries) byId.set(e.llmConfigId, e.llmConfig);
  for (const c of configs) if (!byId.has(c.id)) byId.set(c.id, c);

  const save = useMutation({
    mutationFn: (configIds: string[]) => api<unknown>(`/admin/llm/chains/${purpose}`, { method: "PUT", body: { configIds } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "llm"] }),
  });

  const move = (from: number, to: number) => {
    if (to < 0 || to >= full.length || from === to) return;
    const next = [...full];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setOrder(next);
  };

  const dirty = full.join("|") !== serverOrder.join("|");

  const onDragStart = (i: number) => (e: DragEvent<HTMLLIElement>) => {
    setDragIndex(i);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(i));
  };
  const onDragOver = (i: number) => (e: DragEvent<HTMLLIElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overIndex !== i) setOverIndex(i);
  };
  const onDrop = (i: number) => (e: DragEvent<HTMLLIElement>) => {
    e.preventDefault();
    const from = dragIndex ?? Number(e.dataTransfer.getData("text/plain"));
    if (!Number.isNaN(from)) move(from, i);
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <div className="rounded-md border border-gray-200">
      <header className="flex items-center justify-between border-b border-gray-100 bg-gray-50 px-3 py-2">
        <span className="text-sm font-medium">{PURPOSE_LABEL[purpose]}</span>
        {full.length === 0 ? <Badge tone="red">無</Badge> : <Badge>{full.length} 組</Badge>}
      </header>
      <ol className="divide-y divide-gray-100">
        {full.length === 0 && <li className="px-3 py-3 text-xs text-gray-400">尚無指定此用途的設定。</li>}
        {full.map((id, i) => {
          const c = byId.get(id);
          const isNew = !serverOrder.includes(id);
          return (
            <li
              key={id}
              draggable
              onDragStart={onDragStart(i)}
              onDragOver={onDragOver(i)}
              onDrop={onDrop(i)}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              className={`flex cursor-grab items-center gap-2 px-3 py-2 text-sm ${overIndex === i && dragIndex !== i ? "bg-blue-50" : ""} ${
                dragIndex === i ? "opacity-50" : ""
              }`}
            >
              <span className="w-5 text-xs text-gray-400">{i + 1}.</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {c?.name ?? id}
                  {isNew && <span className="ml-1 text-xs text-amber-600">（未排入）</span>}
                </p>
                <p className="truncate text-xs text-gray-400">
                  {c?.provider} · {c?.model}
                  {c && !c.enabled && <span className="ml-1 text-red-500">已停用</span>}
                  {purpose === "execute" && c && !c.supportsVision && <span className="ml-1 text-red-500">無 Vision</span>}
                </p>
              </div>
              <div className="flex flex-col">
                <button type="button" className="px-1 text-xs text-gray-500 hover:text-gray-900 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="上移">
                  ▲
                </button>
                <button
                  type="button"
                  className="px-1 text-xs text-gray-500 hover:text-gray-900 disabled:opacity-30"
                  disabled={i === full.length - 1}
                  onClick={() => move(i, i + 1)}
                  aria-label="下移"
                >
                  ▼
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      {full.length > 0 && (
        <footer className="flex items-center gap-2 border-t border-gray-100 px-3 py-2">
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(full)}>
            {save.isPending ? "儲存中…" : "儲存順序"}
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setOrder(serverOrder)}>
              還原
            </Button>
          )}
        </footer>
      )}
      {save.error && (
        <div className="px-3 pb-2">
          <ErrorText error={save.error} />
        </div>
      )}
    </div>
  );
}
