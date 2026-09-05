import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiSetupPanel } from "./ApiSetupPanel";
import { api, apiEventSource, apiEventStream, errorMessage } from "../api/client";
import type {
  CaseStatus,
  CaseType,
  Feature,
  FeatureWithCases,
  GenerationCancelResult,
  GenerationEvent,
  GenerationMode,
  GenerationRun,
  Priority,
  TestCase,
  TestCaseInput,
  TestCaseListData,
  TestCaseVersion,
} from "../api/types";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Empty,
  ErrorText,
  Field,
  Input,
  Notice,
  Select,
  Spinner,
  Table,
  Textarea,
} from "./ui";
import {
  CASE_SOURCE_LABEL,
  CASE_STATUSES,
  CASE_STATUS_LABEL,
  CASE_STATUS_TONE,
  CASE_TYPES,
  CASE_TYPE_LABEL,
  CASE_TYPE_TONE,
  GENERATION_MODES,
  GENERATION_MODE_LABEL,
  GENERATION_STATUS_LABEL,
  GENERATION_STATUS_TONE,
  PAUSE_REASON_LABEL,
  PRIORITIES,
  formatDate,
  formatDuration,
  hasRole,
  pauseReasonLabel,
} from "../lib/roles";

const listKey = (targetId: string) => ["target", targetId, "test-cases"];
const runsKey = (targetId: string) => ["target", targetId, "generation-runs"];

const UNASSIGNED = "__unassigned__";

/**
 * Spec §4.3 測試清單：the generated feature inventory and its test cases, plus the
 * pipeline that produces them. Everything a viewer sees is read-only; every
 * mutation needs editor+ and is refused while the target is running, so the
 * whole panel keys off `target.myRole` / `target.locked` from the list payload.
 */
export function TestCaseList({ targetId }: { targetId: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: listKey(targetId),
    queryFn: () => api<TestCaseListData>(`/targets/${targetId}/test-cases`),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: listKey(targetId) });
    qc.invalidateQueries({ queryKey: runsKey(targetId) });
  };

  const [statusFilter, setStatusFilter] = useState<CaseStatus | "all">("all");
  const [priorityFilter, setPriorityFilter] = useState<Priority | "all">("all");
  const [typeFilter, setTypeFilter] = useState<CaseType | "all">("all");
  const [search, setSearch] = useState("");

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openCases, setOpenCases] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [editing, setEditing] = useState<{ mode: "create" | "edit"; testCase: TestCase | null } | null>(null);
  const [featureEditing, setFeatureEditing] = useState<{ mode: "create" | "edit"; feature: Feature | null } | null>(null);
  const [versionsFor, setVersionsFor] = useState<TestCase | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TestCase | null>(null);
  const [confirmFeatureDelete, setConfirmFeatureDelete] = useState<Feature | null>(null);
  const [setupFor, setSetupFor] = useState<Feature | null>(null);

  const data = list.data;
  const features = data?.features ?? [];
  const canEdit = !!data && hasRole(data.target.myRole, "editor") && !data.target.locked;

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (c: TestCase) =>
      (statusFilter === "all" || c.status === statusFilter) &&
      (priorityFilter === "all" || c.priority === priorityFilter) &&
      (typeFilter === "all" || c.type === typeFilter) &&
      (!needle || c.title.toLowerCase().includes(needle));
  }, [search, statusFilter, priorityFilter, typeFilter]);

  const filtering = statusFilter !== "all" || priorityFilter !== "all" || typeFilter !== "all" || !!search.trim();

  const groups = useMemo<{ key: string; feature: FeatureWithCases | null; cases: TestCase[]; total: number }[]>(() => {
    if (!data) return [];
    const out: { key: string; feature: FeatureWithCases | null; cases: TestCase[]; total: number }[] = data.features.map((f) => ({
      key: f.id,
      feature: f,
      cases: f.cases.filter(matches),
      total: f.cases.length,
    }));
    out.push({
      key: UNASSIGNED,
      feature: null,
      cases: data.unassigned.filter(matches),
      total: data.unassigned.length,
    });
    return out;
  }, [data, matches]);

  const shownCount = groups.reduce((n, g) => n + g.cases.length, 0);

  const setStatuses = useMutation({
    mutationFn: (status: CaseStatus) =>
      api<{ count: number }>(`/targets/${targetId}/test-cases/status`, {
        method: "PUT",
        body: { caseIds: [...selected], status },
      }),
    onSuccess: () => {
      setSelected(new Set());
      invalidate();
    },
  });

  const saveCase = useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: TestCaseInput }) =>
      id
        ? api<TestCase>(`/test-cases/${id}`, { method: "PATCH", body: { ...input } })
        : api<TestCase>(`/targets/${targetId}/test-cases`, { method: "POST", body: { ...input } }),
    onSuccess: () => {
      setEditing(null);
      invalidate();
    },
  });

  const removeCase = useMutation({
    mutationFn: (id: string) => api<void>(`/test-cases/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirmDelete(null);
      invalidate();
    },
  });

  const saveFeature = useMutation({
    mutationFn: ({ id, name, description }: { id: string | null; name: string; description: string }) =>
      id
        ? api<Feature>(`/features/${id}`, { method: "PATCH", body: { name, description } })
        : api<Feature>(`/targets/${targetId}/features`, { method: "POST", body: { name, description } }),
    onSuccess: () => {
      setFeatureEditing(null);
      invalidate();
    },
  });

  const removeFeature = useMutation({
    mutationFn: (id: string) => api<void>(`/features/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirmFeatureDelete(null);
      invalidate();
    },
  });

  if (list.isPending) return <Spinner />;
  if (list.isError) return <ErrorText error={list.error} />;
  if (!data) return null;

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const toggleGroup = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setSelected(next);
  };

  const { counts } = data;

  return (
    <div className="space-y-4">
      <Card
        title="測試清單"
        actions={
          canEdit ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => setFeatureEditing({ mode: "create", feature: null })}>
                新增功能
              </Button>
              <Button size="sm" onClick={() => setEditing({ mode: "create", testCase: null })}>
                新增案例
              </Button>
            </>
          ) : undefined
        }
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="blue">功能 {counts.features}</Badge>
            <Badge tone="gray">案例 {counts.cases}</Badge>
            <Badge tone="green">正常 {counts.active}</Badge>
            <Badge tone="amber">待處理 {counts.outdated}</Badge>
            <Badge tone="gray">已淘汰 {counts.deprecated}</Badge>
            <span className="text-xs text-gray-400">描述版本 v{data.target.descriptionVersion}</span>
          </div>

          {data.target.locked && (
            <Notice>此 Target 正在執行中，測試清單目前為唯讀，執行結束後才能新增或修改。</Notice>
          )}
          {!hasRole(data.target.myRole, "editor") && (
            <Notice tone="blue">你是檢視者，只能閱讀測試清單，無法新增或修改。</Notice>
          )}
          {counts.outdated > 0 && (
            <Notice>
              <div className="flex flex-wrap items-center gap-2">
                <span>有 {counts.outdated} 條待處理，描述變更後尚未確認。</span>
                <Button size="sm" variant="secondary" onClick={() => setStatusFilter("outdated")}>
                  只看待處理
                </Button>
              </div>
            </Notice>
          )}
        </div>
      </Card>

      <GenerationPanel targetId={targetId} canEdit={canEdit} onFinished={invalidate} />

      <Card title={`案例（顯示 ${shownCount} / ${counts.cases}）`}>
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="狀態">
              <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as CaseStatus | "all")}>
                <option value="all">全部</option>
                {CASE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {CASE_STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="優先級">
              <Select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as Priority | "all")}>
                <option value="all">全部</option>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="類型">
              <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as CaseType | "all")}>
                <option value="all">全部</option>
                {CASE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CASE_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="搜尋標題">
              <Input value={search} placeholder="關鍵字" onChange={(e) => setSearch(e.target.value)} />
            </Field>
          </div>

          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2">
              <span className="text-sm text-blue-900">已選取 {selected.size} 條</span>
              {CASE_STATUSES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant="secondary"
                  disabled={!canEdit || setStatuses.isPending}
                  onClick={() => setStatuses.mutate(s)}
                >
                  標記為{CASE_STATUS_LABEL[s]}
                </Button>
              ))}
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                清除選取
              </Button>
            </div>
          )}
          <ErrorText error={setStatuses.error} />
          <ErrorText error={removeCase.error} />
          <ErrorText error={removeFeature.error} />

          {counts.cases === 0 && (
            <Empty>還沒有測試案例。用上方的「生成測試清單」讓 LLM 依描述展開，或手動新增一條。</Empty>
          )}
          {counts.cases > 0 && shownCount === 0 && <Empty>沒有符合篩選條件的案例。</Empty>}

          <div className="space-y-3">
            {groups.map((g) => {
              if (g.total === 0 && g.key === UNASSIGNED) return null;
              if (filtering && g.cases.length === 0) return null;
              const isCollapsed = collapsed.has(g.key);
              const ids = g.cases.map((c) => c.id);
              const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
              return (
                <section key={g.key} className="overflow-hidden rounded-lg border border-gray-200">
                  <header className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      aria-label="全選這個功能的案例"
                      checked={allSelected}
                      disabled={!canEdit || ids.length === 0}
                      onChange={(e) => toggleGroup(ids, e.target.checked)}
                    />
                    <button
                      type="button"
                      className="text-sm font-semibold text-gray-800 hover:underline"
                      onClick={() => setCollapsed(toggle(collapsed, g.key))}
                    >
                      {isCollapsed ? "▸" : "▾"} {g.feature ? g.feature.name : "未分類"}
                    </button>
                    <Badge tone="gray">{g.cases.length} 條</Badge>
                    {g.feature?.stale && <Badge tone="amber">描述已更新</Badge>}
                    {g.feature?.status === "removed" && <Badge tone="gray">已移除</Badge>}
                    <span className="min-w-0 flex-1 truncate text-xs text-gray-400">
                      {g.feature ? g.feature.description : "不屬於任何功能的案例"}
                    </span>
                    {g.feature && data.target.kind === "api" && (
                      <Button size="sm" variant="ghost" onClick={() => setSetupFor(g.feature as Feature)}>
                        前置流程
                      </Button>
                    )}
                    {canEdit && g.feature && (
                      <span className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setFeatureEditing({ mode: "edit", feature: g.feature as Feature })}
                        >
                          編輯
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmFeatureDelete(g.feature as Feature)}>
                          刪除
                        </Button>
                      </span>
                    )}
                  </header>

                  {!isCollapsed && (
                    <ul>
                      {g.cases.length === 0 && (
                        <li className="px-3">
                          <Empty>這個功能還沒有案例。</Empty>
                        </li>
                      )}
                      {g.cases.map((c) => (
                        <CaseRow
                          key={c.id}
                          testCase={c}
                          open={openCases.has(c.id)}
                          selected={selected.has(c.id)}
                          canEdit={canEdit}
                          onToggle={() => setOpenCases(toggle(openCases, c.id))}
                          onSelect={() => setSelected(toggle(selected, c.id))}
                          onEdit={() => setEditing({ mode: "edit", testCase: c })}
                          onVersions={() => setVersionsFor(c)}
                          onDelete={() => setConfirmDelete(c)}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </Card>

      {editing && (
        <CaseDialog
          key={editing.testCase?.id ?? "new-case"}
          mode={editing.mode}
          initial={editing.testCase}
          features={features}
          pending={saveCase.isPending}
          error={saveCase.error}
          onClose={() => setEditing(null)}
          onSubmit={(input) => saveCase.mutate({ id: editing.testCase?.id ?? null, input })}
        />
      )}

      {featureEditing && (
        <FeatureDialog
          key={featureEditing.feature?.id ?? "new-feature"}
          mode={featureEditing.mode}
          initial={featureEditing.feature}
          pending={saveFeature.isPending}
          error={saveFeature.error}
          onClose={() => setFeatureEditing(null)}
          onSubmit={(name, description) =>
            saveFeature.mutate({ id: featureEditing.feature?.id ?? null, name, description })
          }
        />
      )}

      {setupFor && (
        <Dialog open title={`前置流程 — ${setupFor.name}`} size="lg" onClose={() => setSetupFor(null)}>
          <ApiSetupPanel scope={{ kind: "feature", featureId: setupFor.id }} canEdit={canEdit} />
        </Dialog>
      )}

      {versionsFor && <VersionsDialog testCase={versionsFor} onClose={() => setVersionsFor(null)} />}

      <Dialog open={!!confirmDelete} title="刪除案例" onClose={() => setConfirmDelete(null)}>
        <p className="text-sm text-gray-700">確定要刪除「{confirmDelete?.title}」嗎？版本歷史會一併刪除，無法復原。</p>
        <p className="mt-2 text-xs text-gray-400">若只是想停用，改用「標記為已淘汰」會保留紀錄。</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
            取消
          </Button>
          <Button
            variant="danger"
            disabled={removeCase.isPending}
            onClick={() => confirmDelete && removeCase.mutate(confirmDelete.id)}
          >
            確認刪除
          </Button>
        </div>
        <ErrorText error={removeCase.error} />
      </Dialog>

      <Dialog open={!!confirmFeatureDelete} title="刪除功能" onClose={() => setConfirmFeatureDelete(null)}>
        <p className="text-sm text-gray-700">確定要刪除功能「{confirmFeatureDelete?.name}」嗎？</p>
        <p className="mt-2 text-xs text-gray-400">底下的案例不會被刪除，只是會移到「未分類」。</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmFeatureDelete(null)}>
            取消
          </Button>
          <Button
            variant="danger"
            disabled={removeFeature.isPending}
            onClick={() => confirmFeatureDelete && removeFeature.mutate(confirmFeatureDelete.id)}
          >
            確認刪除
          </Button>
        </div>
        <ErrorText error={removeFeature.error} />
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ 案例列 */

const PRIORITY_CLASS: Record<Priority, string> = {
  P0: "bg-red-100 text-red-700",
  P1: "bg-orange-100 text-orange-800",
  P2: "bg-gray-100 text-gray-700",
  P3: "bg-gray-50 text-gray-500",
};

function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${PRIORITY_CLASS[priority]}`}>
      {priority}
    </span>
  );
}

function CaseRow({
  testCase,
  open,
  selected,
  canEdit,
  onToggle,
  onSelect,
  onEdit,
  onVersions,
  onDelete,
}: {
  testCase: TestCase;
  open: boolean;
  selected: boolean;
  canEdit: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onEdit: () => void;
  onVersions: () => void;
  onDelete: () => void;
}) {
  const c = testCase;
  return (
    <li className="border-t border-gray-100 first:border-t-0">
      <div className="flex items-start gap-2 px-3 py-2">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4"
          aria-label={`選取 ${c.title}`}
          checked={selected}
          disabled={!canEdit}
          onChange={onSelect}
        />
        <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-gray-400">{open ? "▾" : "▸"}</span>
            <PriorityBadge priority={c.priority} />
            <Badge tone={CASE_TYPE_TONE[c.type]}>{CASE_TYPE_LABEL[c.type]}</Badge>
            <Badge tone={CASE_STATUS_TONE[c.status]}>{CASE_STATUS_LABEL[c.status]}</Badge>
            <span className="text-sm font-medium text-gray-800">{c.title}</span>
            <span className="text-xs text-gray-400">{CASE_SOURCE_LABEL[c.source]}</span>
          </span>
        </button>
      </div>

      {open && (
        <div className="space-y-3 border-t border-gray-100 bg-gray-50/60 px-3 py-3 pl-9">
          <DetailBlock label="前置條件">
            {c.precondition ? (
              <p className="whitespace-pre-wrap text-sm text-gray-700">{c.precondition}</p>
            ) : (
              <p className="text-sm text-gray-400">無</p>
            )}
          </DetailBlock>
          <DetailBlock label="步驟">
            {c.steps.length === 0 ? (
              <p className="text-sm text-gray-400">無</p>
            ) : (
              <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
                {c.steps.map((s, i) => (
                  <li key={i} className="whitespace-pre-wrap">
                    {s}
                  </li>
                ))}
              </ol>
            )}
          </DetailBlock>
          <DetailBlock label="預期結果">
            <p className="whitespace-pre-wrap text-sm text-gray-700">{c.expected}</p>
          </DetailBlock>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button size="sm" variant="secondary" disabled={!canEdit} onClick={onEdit}>
              編輯
            </Button>
            <Button size="sm" variant="secondary" onClick={onVersions}>
              版本（v{c.currentVersion}）
            </Button>
            <Button size="sm" variant="danger" disabled={!canEdit} onClick={onDelete}>
              刪除
            </Button>
            <span className="text-xs text-gray-400">
              依描述 v{c.basedOnDescriptionVersion} 產生 · 更新於 {formatDate(c.updatedAt)}
            </span>
          </div>
        </div>
      )}
    </li>
  );
}

function DetailBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-gray-500">{label}</p>
      {children}
    </div>
  );
}

/* ------------------------------------------------------- 生成 pipeline 面板 */

function pick<T extends GenerationEvent["type"]>(
  events: GenerationEvent[],
  type: T,
): Extract<GenerationEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GenerationEvent, { type: T }> => e.type === type);
}

function GenerationPanel({
  targetId,
  canEdit,
  onFinished,
}: {
  targetId: string;
  canEdit: boolean;
  onFinished: () => void;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<GenerationMode>("replace");
  const [events, setEvents] = useState<GenerationEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  /** A re-attach is only worth doing once per mount, however the runs query settles. */
  const attachedRef = useRef(false);

  // The run lives on the server, so leaving the tab only hangs up this reader.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      sourceRef.current?.close();
    },
    [],
  );

  const runs = useQuery({
    queryKey: runsKey(targetId),
    queryFn: () => api<GenerationRun[]>(`/targets/${targetId}/generation-runs`),
  });

  const finish = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setRunning(false);
    qc.invalidateQueries({ queryKey: runsKey(targetId) });
  }, [qc, targetId]);

  /**
   * Re-attach to a run already in progress. The server replays the whole history
   * on connect and `GenerationEvent` carries no sequence number, so each `open`
   * starts the transcript over instead of appending a second copy.
   */
  const attach = useCallback(() => {
    if (sourceRef.current) return;
    setError(null);
    setRunning(true);
    const source = apiEventSource(`/targets/${targetId}/generate/stream`);
    sourceRef.current = source;
    let seen = 0;
    source.onopen = () => {
      seen = 0;
      setEvents([]);
    };
    source.onmessage = (e) => {
      let event: GenerationEvent;
      try {
        event = JSON.parse(e.data as string) as GenerationEvent;
      } catch {
        return; // a malformed frame is not worth tearing the panel down over
      }
      // The run finished between the runs query and this connect: there is
      // nothing to re-attach to, which is not a failure worth shouting about.
      if (event.type === "error" && seen === 0) {
        finish();
        return;
      }
      seen++;
      setEvents((prev) => [...prev, event]);
      if (event.type === "finished") onFinished();
      // The server ends the stream on a terminal event; close first so
      // `EventSource` does not reconnect and replay it forever.
      if (event.type === "finished" || event.type === "error") finish();
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) finish();
    };
  }, [targetId, onFinished, finish]);

  // A reload during a long run should pick the run back up, not look idle.
  useEffect(() => {
    if (attachedRef.current || running || !runs.data) return;
    const latest = runs.data[0];
    if (!latest || (latest.status !== "running" && latest.status !== "paused")) return;
    attachedRef.current = true;
    attach();
  }, [runs.data, running, attach]);

  const start = async () => {
    if (running) return;
    const explain =
      mode === "replace"
        ? "「重新生成」會清掉先前由 LLM 生成的案例（手動撰寫的會保留），再重跑整個 pipeline。"
        : "「附加」會保留現有清單，把新生成的功能與案例加在後面。";
    if (!window.confirm(`${explain}\n\n整個流程需要數分鐘（每個功能大約 25 秒）。生成在伺服器上進行，關掉分頁也不會中斷，回來時會自動接上。要開始嗎？`)) {
      return;
    }
    attachedRef.current = true;
    setEvents([]);
    setError(null);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    qc.invalidateQueries({ queryKey: runsKey(targetId) });
    try {
      await apiEventStream<GenerationEvent>(
        `/targets/${targetId}/generate`,
        { body: { mode }, signal: controller.signal },
        (event) => {
          setEvents((prev) => [...prev, event]);
          if (event.type === "finished") onFinished();
        },
      );
    } catch (err) {
      if (!controller.signal.aborted) setError(errorMessage(err));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
      qc.invalidateQueries({ queryKey: runsKey(targetId) });
    }
  };

  const cancel = useMutation({
    mutationFn: () => api<GenerationCancelResult>(`/targets/${targetId}/generate/cancel`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: runsKey(targetId) }),
  });

  const streamError = pick(events, "error")[0] ?? null;
  const paused = pauseState(events);

  return (
    <Card
      title="生成測試清單"
      actions={running ? <Badge tone="amber">{paused ? "等待 LLM" : "生成中"}</Badge> : undefined}
    >
      <div className="space-y-3">
        <p className="text-xs text-gray-400">
          依描述、Target 設定、附件、交接文件與現況探索，先產生功能清單，再逐一展開成測試案例，最後去重排序。
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44">
            <Field label="模式">
              <Select
                value={mode}
                disabled={!canEdit || running}
                onChange={(e) => setMode(e.target.value as GenerationMode)}
              >
                {GENERATION_MODES.map((m) => (
                  <option key={m} value={m}>
                    {GENERATION_MODE_LABEL[m]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button disabled={!canEdit || running} onClick={start}>
            {running ? (paused ? "等待 LLM…" : "生成中…") : "生成"}
          </Button>
          {running && (
            <Button variant="danger" disabled={!canEdit || cancel.isPending} onClick={() => cancel.mutate()}>
              {cancel.isPending ? "中止中…" : "中止"}
            </Button>
          )}
          <span className="text-xs text-gray-500">
            {mode === "replace"
              ? "重新生成：先前生成的案例會被取代，手動撰寫的會保留。"
              : "附加：現有清單保留，新的功能與案例加在後面。"}
          </span>
        </div>
        {!canEdit && <p className="text-xs text-gray-400">需要編輯者以上的角色，且 Target 不在執行中，才能生成。</p>}

        {error && <Notice tone="red">{error}</Notice>}
        {streamError && <Notice tone="red">生成失敗：{streamError.message}</Notice>}
        <ErrorText error={cancel.error} />

        {events.length > 0 && <GenerationProgress events={events} running={running} paused={!!paused} />}

        <div className="border-t border-gray-100 pt-3">
          <p className="mb-2 text-xs font-medium text-gray-500">生成紀錄</p>
          {runs.isPending && <Spinner />}
          <ErrorText error={runs.error} />
          {runs.data && runs.data.length === 0 && <Empty>還沒有跑過生成。</Empty>}
          {runs.data && runs.data.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th>時間</th>
                  <th>模式</th>
                  <th>狀態</th>
                  <th>功能</th>
                  <th>案例</th>
                  <th>去重</th>
                  <th>模型</th>
                  <th>耗時</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-xs text-gray-500">{formatDate(r.startedAt)}</td>
                    <td className="text-xs">{GENERATION_MODE_LABEL[r.mode]}</td>
                    <td>
                      <Badge tone={GENERATION_STATUS_TONE[r.status]}>{GENERATION_STATUS_LABEL[r.status]}</Badge>
                      {r.status === "paused" && (
                        <p className="mt-1 text-xs text-amber-700">
                          {pauseReasonLabel(r.pausedReason)}
                          {r.pausedAt && <span className="text-gray-400"> · {formatDate(r.pausedAt)}</span>}
                        </p>
                      )}
                      {r.error && <p className="mt-1 text-xs text-red-600">{r.error}</p>}
                    </td>
                    <td className="text-xs">{r.featureCount}</td>
                    <td className="text-xs">{r.caseCount}</td>
                    <td className="text-xs">{r.duplicatesDropped}</td>
                    <td className="text-xs text-gray-500">{r.model ?? "-"}</td>
                    <td className="whitespace-nowrap text-xs text-gray-500">
                      {r.endedAt
                        ? formatDuration(new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime())
                        : r.status === "paused"
                          ? "等待中"
                          : "進行中"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </div>
    </Card>
  );
}

/** The pause still in force, if any — a later `resumed` or terminal event clears it. */
function pauseState(events: GenerationEvent[]): Extract<GenerationEvent, { type: "paused" }> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "resumed" || e.type === "finished" || e.type === "error") return null;
    if (e.type === "paused") return e;
  }
  return null;
}

/** The live step list: discovery → feature inventory → per-feature cases → dedupe → saved. */
function GenerationProgress({
  events,
  running,
  paused,
}: {
  events: GenerationEvent[];
  running: boolean;
  paused: boolean;
}) {
  const started = pick(events, "started")[0] ?? null;
  const discovery = pick(events, "discovery")[0] ?? null;
  const featureList = pick(events, "features")[0] ?? null;
  const inventory = pick(events, "feature_started");
  const done = new Map(pick(events, "feature_cases").map((e) => [e.index, e]));
  const deduped = pick(events, "deduped")[0] ?? null;
  const saved = pick(events, "saved")[0] ?? null;
  const finished = pick(events, "finished")[0] ?? null;
  const failed = pick(events, "error").length > 0;
  // Pauses and resumes are interleaved with the feature loop; keep them in order.
  const pauses = events
    .map((event, index) => ({ event, index }))
    .filter(
      (e): e is { event: Extract<GenerationEvent, { type: "paused" | "resumed" }>; index: number } =>
        e.event.type === "paused" || e.event.type === "resumed",
    );

  return (
    <div className="space-y-2 rounded-md bg-gray-50 p-3">
      {started && (
        <StepLine tone="muted">
          開始生成 · {GENERATION_MODE_LABEL[started.mode]} · 依描述 v{started.descriptionVersion}
        </StepLine>
      )}

      {discovery ? (
        <StepLine tone={discovery.ok ? "ok" : "warn"}>
          現況探索{discovery.ok ? "完成" : "沒有結果"}
          {discovery.source ? ` · ${discovery.source}` : ""} · {discovery.note}
        </StepLine>
      ) : (
        running && started && <PendingLine label="現況探索中…" />
      )}

      {featureList ? (
        <div>
          <StepLine tone="ok">
            功能清單完成，共 {featureList.features.length} 個功能 · {featureList.model}
          </StepLine>
          <ul className="mt-1 flex flex-wrap gap-1 pl-5">
            {featureList.features.map((f) => (
              <li key={f.name}>
                <Badge tone="gray">{f.name}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        running && discovery && <PendingLine label="正在整理功能清單…" />
      )}

      {inventory.map((f) => {
        const result = done.get(f.index);
        if (result) {
          return (
            <StepLine key={f.index} tone="ok">
              [{f.index}/{f.total}] {f.name} → {result.count} 條 · {result.model}
            </StepLine>
          );
        }
        if (paused) {
          return (
            <StepLine key={f.index} tone="warn">
              [{f.index}/{f.total}] {f.name} → 等待 LLM 恢復
            </StepLine>
          );
        }
        if (!running) {
          return (
            <StepLine key={f.index} tone="warn">
              [{f.index}/{f.total}] {f.name} → 未完成
            </StepLine>
          );
        }
        return <PendingLine key={f.index} label={`[${f.index}/${f.total}] ${f.name} 展開案例中…`} />;
      })}

      {pauses.map(({ event, index }) =>
        event.type === "paused" ? (
          <div key={index} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
            <p className="text-sm font-semibold">等待 LLM</p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{event.message}</p>
            <p className="mt-1 text-xs">
              {PAUSE_REASON_LABEL[event.reason] ?? event.reason} · 已完成 {event.featureIndex} / {event.total}{" "}
              個功能。進度都保留著，有模型恢復後會自動從這裡接續。
            </p>
          </div>
        ) : (
          <p
            key={index}
            className="rounded-md border border-green-200 bg-green-50 px-3 py-1.5 text-sm text-green-800"
          >
            {event.message}
          </p>
        ),
      )}

      {deduped && (
        <StepLine tone="ok">
          去重與排序：保留 {deduped.kept} 條，捨棄 {deduped.dropped} 條重複
        </StepLine>
      )}
      {saved && (
        <StepLine tone="ok">
          已寫入：{saved.featureCount} 個功能、{saved.caseCount} 條案例
        </StepLine>
      )}
      {finished && (
        <StepLine tone="ok">
          完成 · {finished.featureCount} 個功能、{finished.caseCount} 條案例 · 耗時 {formatDuration(finished.durationMs)}
        </StepLine>
      )}
      {running && !finished && !failed && (
        <p className="text-xs text-gray-400">
          整個流程需要數分鐘。生成在伺服器上進行，離開或重新整理這個分頁都不會中斷，回到這裡會自動接回進度。
        </p>
      )}
    </div>
  );
}

function StepLine({ tone, children }: { tone: "ok" | "warn" | "muted"; children: ReactNode }) {
  const mark = tone === "ok" ? "✓" : tone === "warn" ? "!" : "·";
  const cls = tone === "ok" ? "text-green-700" : tone === "warn" ? "text-amber-700" : "text-gray-400";
  return (
    <p className="flex items-start gap-2 text-sm text-gray-700">
      <span className={`w-4 shrink-0 text-center ${cls}`}>{mark}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}

function PendingLine({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-1">
      <Spinner label={label} />
    </div>
  );
}

/* ------------------------------------------------------------ 新增／編輯案例 */

function CaseDialog({
  mode,
  initial,
  features,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  mode: "create" | "edit";
  initial: TestCase | null;
  features: Feature[];
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (input: TestCaseInput) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [featureId, setFeatureId] = useState(initial?.featureId ?? "");
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? "P2");
  const [type, setType] = useState<CaseType>(initial?.type ?? "happy");
  const [precondition, setPrecondition] = useState(initial?.precondition ?? "");
  const [steps, setSteps] = useState<string[]>(initial?.steps.length ? [...initial.steps] : [""]);
  const [expected, setExpected] = useState(initial?.expected ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const setStep = (index: number, value: string) =>
    setSteps((prev) => prev.map((s, i) => (i === index ? value : s)));
  const addStep = () => setSteps((prev) => [...prev, ""]);
  const removeStep = (index: number) =>
    setSteps((prev) => (prev.length === 1 ? [""] : prev.filter((_, i) => i !== index)));
  const moveStep = (index: number, delta: number) =>
    setSteps((prev) => {
      const to = index + delta;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const cleanSteps = steps.map((s) => s.trim()).filter(Boolean);
    if (!title.trim()) return setLocalError("請填寫標題。");
    if (cleanSteps.length === 0) return setLocalError("至少需要一個步驟。");
    if (!expected.trim()) return setLocalError("請填寫預期結果。");
    setLocalError(null);
    onSubmit({
      title: title.trim(),
      precondition: precondition.trim(),
      steps: cleanSteps,
      expected: expected.trim(),
      priority,
      type,
      featureId: featureId || null,
    });
  };

  return (
    <Dialog open title={mode === "create" ? "新增測試案例" : "編輯測試案例"} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
          <Field label="標題">
            <Input value={title} autoFocus placeholder="例如：以有效帳密登入" onChange={(e) => setTitle(e.target.value)} />
          </Field>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="功能">
              <Select value={featureId} onChange={(e) => setFeatureId(e.target.value)}>
                <option value="">未分類</option>
                {features.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="優先級">
              <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="類型">
              <Select value={type} onChange={(e) => setType(e.target.value as CaseType)}>
                {CASE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CASE_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Field label="前置條件" hint="選填。執行這條案例前必須成立的狀態。">
            <Textarea rows={2} value={precondition} onChange={(e) => setPrecondition(e.target.value)} />
          </Field>

          <div>
            <p className="mb-1 text-xs font-medium text-gray-600">步驟</p>
            <ul className="space-y-2">
              {steps.map((s, i) => (
                <li key={i} className="flex items-center gap-1">
                  <span className="w-5 shrink-0 text-right text-xs text-gray-400">{i + 1}.</span>
                  <Input value={s} placeholder="例如：輸入帳號與密碼後按登入" onChange={(e) => setStep(i, e.target.value)} />
                  <Button size="sm" variant="ghost" aria-label="上移" disabled={i === 0} onClick={() => moveStep(i, -1)}>
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="下移"
                    disabled={i === steps.length - 1}
                    onClick={() => moveStep(i, 1)}
                  >
                    ↓
                  </Button>
                  <Button size="sm" variant="ghost" aria-label="刪除這個步驟" onClick={() => removeStep(i)}>
                    ✕
                  </Button>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="secondary" className="mt-2" onClick={addStep}>
              新增步驟
            </Button>
          </div>

          <Field label="預期結果">
            <Textarea rows={3} value={expected} onChange={(e) => setExpected(e.target.value)} />
          </Field>
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-gray-100 pt-3">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "儲存中…" : "儲存"}
          </Button>
        </div>
        {localError && <p className="mt-2 text-xs text-red-600">{localError}</p>}
        <ErrorText error={error} />
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------ 新增／編輯功能 */

function FeatureDialog({
  mode,
  initial,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  mode: "create" | "edit";
  initial: Feature | null;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (name: string, description: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setLocalError("請填寫功能名稱。");
    setLocalError(null);
    onSubmit(name.trim(), description.trim());
  };

  return (
    <Dialog open title={mode === "create" ? "新增功能" : "編輯功能"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="名稱">
          <Input value={name} autoFocus placeholder="例如：待辦事項新增" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="說明" hint="選填。">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "儲存中…" : "儲存"}
          </Button>
        </div>
        {localError && <p className="mt-2 text-xs text-red-600">{localError}</p>}
        <ErrorText error={error} />
      </form>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- 版本歷史 */

function VersionsDialog({ testCase, onClose }: { testCase: TestCase; onClose: () => void }) {
  const versions = useQuery({
    queryKey: ["test-case", testCase.id, "versions"],
    queryFn: () => api<TestCaseVersion[]>(`/test-cases/${testCase.id}/versions`),
  });

  return (
    <Dialog open title={`版本歷史 — ${testCase.title}`} onClose={onClose}>
      <div className="max-h-[65vh] overflow-y-auto pr-1">
        {versions.isPending && <Spinner />}
        <ErrorText error={versions.error} />
        {versions.data && versions.data.length === 0 && <Empty>沒有版本紀錄。</Empty>}
        {versions.data && versions.data.length > 0 && (
          <ul className="space-y-3">
            {versions.data.map((v, i) => (
              <li key={v.id} className="rounded-md border border-gray-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={i === 0 ? "blue" : "gray"}>v{v.version}</Badge>
                  {i === 0 && <span className="text-xs text-blue-700">目前版本</span>}
                  <span className="text-xs text-gray-400">{formatDate(v.createdAt)}</span>
                  <PriorityBadge priority={v.content.priority} />
                  <Badge tone={CASE_TYPE_TONE[v.content.type]}>{CASE_TYPE_LABEL[v.content.type]}</Badge>
                </div>
                <p className="mt-2 text-sm font-medium text-gray-800">{v.content.title}</p>
                <p className="mt-1 text-xs font-medium text-gray-500">預期結果</p>
                <p className="whitespace-pre-wrap text-sm text-gray-700">{v.content.expected}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          關閉
        </Button>
      </div>
    </Dialog>
  );
}
