import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiEventStream, errorMessage } from "../api/client";
import type {
  CaseChangeItem, CaseSnapshot, CaseType, ChangeApplyResult, ChangeLogEntry, ChangeProposal,
  ChangeProposalList, FeatureChangeItem, GenerationEvent, Priority, Role, Scope,
} from "../api/types";
import {
  Badge, Button, Card, Empty, ErrorText, Field, Input, Notice, Select, Spinner, Textarea,
} from "./ui";
import {
  CASE_OP_LABEL, CASE_TYPES, CASE_TYPE_LABEL, CHANGE_OP_TONE, CHANGE_SOURCE_LABEL,
  FEATURE_OP_LABEL, PRIORITIES, PROPOSAL_STATE_LABEL, PROPOSAL_STATE_TONE,
  formatDate, hasRole,
} from "../lib/roles";

const listKey = (scope: Scope, id: string) => [scope, id, "changes"];
const logKey = (scope: Scope, id: string) => [scope, id, "change-log"];

/**
 * Spec §4.4 變更管理。The model only proposes; every item is accepted or rejected
 * by hand, and what was applied stays on a timeline afterwards.
 */
export function ChangePanel({
  scope,
  entityId,
  myRole,
  description,
  running,
}: {
  scope: Scope;
  entityId: string;
  myRole: Role | undefined;
  description: string;
  running?: boolean;
}) {
  const queryClient = useQueryClient();
  const canEdit = hasRole(myRole, "editor");
  const base = scope === "project" ? `/projects/${entityId}` : `/targets/${entityId}`;

  const list = useQuery({
    queryKey: listKey(scope, entityId),
    queryFn: () => api<ChangeProposalList>(`${base}/changes`),
  });
  const logs = useQuery({
    queryKey: logKey(scope, entityId),
    queryFn: () => api<ChangeLogEntry[]>(`${base}/change-log`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: listKey(scope, entityId) });
    void queryClient.invalidateQueries({ queryKey: logKey(scope, entityId) });
    void queryClient.invalidateQueries({ queryKey: ["target", entityId, "test-cases"] });
    void queryClient.invalidateQueries({ queryKey: [scope, entityId] });
  };

  const pending = list.data?.proposals.filter((p) => p.state === "pending") ?? [];
  const decided = list.data?.proposals.filter((p) => p.state !== "pending") ?? [];

  return (
    <div className="space-y-4">
      {canEdit && <AnalyzeForm base={base} description={description} onDone={invalidate} />}

      {list.isLoading && <Spinner />}
      <ErrorText error={list.error} />

      {!list.isLoading && !pending.length && (
        <Card title="待處理的變更提案">
          <Empty>目前沒有待處理的提案。有功能增減時，在上面說明一次就會產生提案。</Empty>
        </Card>
      )}

      {pending.map((proposal) => (
        <ProposalCard
          key={proposal.id}
          proposal={proposal}
          canEdit={canEdit}
          running={!!running}
          onDone={invalidate}
        />
      ))}

      <Timeline entries={logs.data ?? []} loading={logs.isLoading} error={logs.error} />

      {!!decided.length && <DecidedList proposals={decided} />}
    </div>
  );
}

// ---------- entry points ----------

function AnalyzeForm({ base, description, onDone }: { base: string; description: string; onDone: () => void }) {
  const [mode, setMode] = useState<"note" | "description">("note");
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState(description);

  const analyze = useMutation({
    mutationFn: () =>
      mode === "note"
        ? api<ChangeProposal>(`${base}/changes/from-discussion`, { method: "POST", body: { note } })
        : api<ChangeProposal>(`${base}/changes/analyze`, {
            method: "POST",
            body: { source: "manual", note: note || "描述被手動修改了，請分析影響。", proposedDescription: draft },
          }),
    onSuccess: () => {
      setNote("");
      onDone();
    },
  });

  return (
    <Card
      title="說明這次的變更"
      actions={
        <div className="flex items-center gap-1 text-xs">
          <Button variant={mode === "note" ? "primary" : "ghost"} size="sm" onClick={() => setMode("note")}>
            用文字說明
          </Button>
          <Button variant={mode === "description" ? "primary" : "ghost"} size="sm" onClick={() => setMode("description")}>
            改描述後分析影響
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {mode === "note" ? (
          <Field label="這次改了什麼" hint="例如「加了匯出 CSV」「購物車移除了」「登入改成 OTP」。">
            <Textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="登入改成簡訊 OTP，密碼登入拿掉了"
            />
          </Field>
        ) : (
          <>
            <Field label="改好的描述" hint="這份會直接當成套用後的描述，模型只負責判斷它對功能和案例的影響。">
              <Textarea rows={10} value={draft} onChange={(e) => setDraft(e.target.value)} />
            </Field>
            <Field label="補充說明（選填）">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="改了哪一段、為什麼改" />
            </Field>
          </>
        )}
        <div className="flex items-center gap-2">
          <Button
            onClick={() => analyze.mutate()}
            disabled={analyze.isPending || (mode === "note" ? !note.trim() : !draft.trim())}
          >
            {analyze.isPending ? "分析中…" : "分析影響"}
          </Button>
          <span className="text-xs text-gray-500">分析只會產生提案，不會直接改測試清單。</span>
        </div>
        <ErrorText error={analyze.error} />
      </div>
    </Card>
  );
}

// ---------- one proposal ----------

function ProposalCard({
  proposal,
  canEdit,
  running,
  onDone,
}: {
  proposal: ChangeProposal;
  canEdit: boolean;
  running: boolean;
  onDone: () => void;
}) {
  const items = useMemo(
    () => [...proposal.featureChanges, ...proposal.caseChanges].filter((i) => !i.unresolved),
    [proposal],
  );
  const [accepted, setAccepted] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(items.map((i) => [i.id, true])),
  );
  const [takeDescription, setTakeDescription] = useState(proposal.hasDescriptionChange);
  const [edits, setEdits] = useState<Record<string, Partial<CaseSnapshot>>>({});
  const [result, setResult] = useState<ChangeApplyResult | null>(null);

  const acceptedCount = items.filter((i) => accepted[i.id]).length + (takeDescription ? 1 : 0);

  const apply = useMutation({
    mutationFn: () =>
      api<ChangeApplyResult>(`/changes/${proposal.id}/apply`, {
        method: "POST",
        body: { description: takeDescription, items: accepted, edits },
      }),
    onSuccess: (data) => {
      setResult(data);
      onDone();
    },
  });
  const reject = useMutation({
    mutationFn: () => api(`/changes/${proposal.id}/reject`, { method: "POST" }),
    onSuccess: onDone,
  });

  if (result) {
    return (
      <AppliedCard proposal={proposal} result={result} canEdit={canEdit} running={running} onDone={onDone} />
    );
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          變更提案
          <Badge tone={PROPOSAL_STATE_TONE[proposal.state]}>{PROPOSAL_STATE_LABEL[proposal.state]}</Badge>
          <Badge tone="blue">{CHANGE_SOURCE_LABEL[proposal.source]}</Badge>
        </span>
      }
      actions={<span className="text-xs text-gray-400">{formatDate(proposal.createdAt)}</span>}
    >
      <div className="space-y-4">
        <p className="text-sm text-gray-800">{proposal.summary}</p>

        {running && <Notice>Target 執行中，提案先留著，等這次執行結束才能套用。</Notice>}
        {!!proposal.counts.unresolved && (
          <Notice>
            有 {proposal.counts.unresolved} 項指到已經不存在的功能或案例，無法套用，已標示出來。
          </Notice>
        )}

        {proposal.hasDescriptionChange && (
          <section>
            <CheckRow
              checked={takeDescription}
              disabled={!canEdit}
              onChange={setTakeDescription}
              label={<span className="text-sm font-medium text-gray-800">採用新的描述</span>}
            />
            <div className="mt-2 pl-6">
              <DiffView text={proposal.descriptionDiff} />
            </div>
          </section>
        )}

        {!!proposal.featureChanges.length && (
          <section>
            <h3 className="mb-2 text-xs font-semibold text-gray-500">功能變動</h3>
            <div className="space-y-2">
              {proposal.featureChanges.map((item) => (
                <FeatureItem
                  key={item.id}
                  item={item}
                  checked={!!accepted[item.id]}
                  canEdit={canEdit}
                  onChange={(v) => setAccepted((prev) => ({ ...prev, [item.id]: v }))}
                />
              ))}
            </div>
          </section>
        )}

        {!!proposal.caseChanges.length && (
          <section>
            <h3 className="mb-2 text-xs font-semibold text-gray-500">測試案例變動</h3>
            <div className="space-y-2">
              {proposal.caseChanges.map((item) => (
                <CaseItem
                  key={item.id}
                  item={item}
                  checked={!!accepted[item.id]}
                  canEdit={canEdit}
                  edit={edits[item.id]}
                  onChange={(v) => setAccepted((prev) => ({ ...prev, [item.id]: v }))}
                  onEdit={(patch) => setEdits((prev) => ({ ...prev, [item.id]: { ...prev[item.id], ...patch } }))}
                />
              ))}
            </div>
          </section>
        )}

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
            <Button onClick={() => apply.mutate()} disabled={running || apply.isPending || !acceptedCount}>
              {apply.isPending ? "套用中…" : `套用勾選的 ${acceptedCount} 項`}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setAccepted(Object.fromEntries(items.map((i) => [i.id, true])))}
            >
              全選
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAccepted({})}>
              全不選
            </Button>
            <Button variant="danger" size="sm" onClick={() => reject.mutate()} disabled={reject.isPending}>
              整份拒絕
            </Button>
            {proposal.model && <span className="ml-auto text-xs text-gray-400">由 {proposal.model} 產生</span>}
          </div>
        )}
        <ErrorText error={apply.error ?? reject.error} />
      </div>
    </Card>
  );
}

/** What happened after applying, plus the one follow-up that is worth offering. */
function AppliedCard({
  proposal,
  result,
  canEdit,
  running,
  onDone,
}: {
  proposal: ChangeProposal;
  result: ChangeApplyResult;
  canEdit: boolean;
  running: boolean;
  onDone: () => void;
}) {
  const [progress, setProgress] = useState<string | null>(null);
  const regenerate = useMutation({
    mutationFn: async () => {
      setProgress("開始重新生成…");
      await apiEventStream<GenerationEvent>(
        `/targets/${proposal.targetId}/generate`,
        { body: { mode: "append", onlyFeatureIds: result.regenerableFeatureIds } },
        (event) => {
          if (event.type === "feature_started") setProgress(`正在出題：${event.name}（${event.index}/${event.total}）`);
          if (event.type === "saved") setProgress(`完成，寫入 ${event.caseCount} 條案例。`);
          if (event.type === "paused") setProgress(event.message);
          if (event.type === "error") setProgress(`失敗：${event.message}`);
        },
      );
    },
    onSuccess: onDone,
  });

  return (
    <Card title="提案已套用">
      <div className="space-y-3 text-sm text-gray-700">
        <p>{proposal.summary}</p>
        <ul className="list-inside list-disc text-xs text-gray-600">
          {result.descriptionVersionAfter !== null && <li>描述更新為 v{result.descriptionVersionAfter}</li>}
          <li>影響 {result.affectedFeatureIds.length} 個功能、{result.affectedTestCaseIds.length} 條測試案例</li>
        </ul>
        {canEdit && proposal.targetId && !!result.regenerableFeatureIds.length && (
          <div className="rounded-md bg-gray-50 p-3">
            <p className="mb-2 text-xs text-gray-600">
              只重新生成受影響的 {result.regenerableFeatureIds.length} 個功能的測試案例，其他功能的清單不動。
            </p>
            <Button size="sm" onClick={() => regenerate.mutate()} disabled={running || regenerate.isPending}>
              {regenerate.isPending ? "生成中…" : "重新生成這些功能的案例"}
            </Button>
            {progress && <p className="mt-2 text-xs text-gray-500">{progress}</p>}
            <ErrorText error={regenerate.error} />
          </div>
        )}
      </div>
    </Card>
  );
}

// ---------- items ----------

function FeatureItem({
  item,
  checked,
  canEdit,
  onChange,
}: {
  item: FeatureChangeItem;
  checked: boolean;
  canEdit: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <ItemShell item={item} checked={checked} canEdit={canEdit} onChange={onChange}
      label={<Badge tone={CHANGE_OP_TONE[item.op]}>{FEATURE_OP_LABEL[item.op]}</Badge>}
      title={item.name || item.before?.name || "（沒有名稱）"}
    >
      {item.op === "modify" && item.before && (
        <div className="text-xs">
          <DiffView text={diffText(item.before.description, item.description)} />
        </div>
      )}
      {item.op === "add" && item.description && <p className="text-xs text-gray-600">{item.description}</p>}
      {item.op === "remove" && (
        <p className="text-xs text-gray-600">這個功能底下的測試案例會一起標成停用，資料還留著。</p>
      )}
    </ItemShell>
  );
}

function CaseItem({
  item,
  checked,
  canEdit,
  edit,
  onChange,
  onEdit,
}: {
  item: CaseChangeItem;
  checked: boolean;
  canEdit: boolean;
  edit: Partial<CaseSnapshot> | undefined;
  onChange: (v: boolean) => void;
  onEdit: (patch: Partial<CaseSnapshot>) => void;
}) {
  const [open, setOpen] = useState(false);
  const merged = item.after ? { ...item.after, ...edit } : null;
  const editable = canEdit && (item.op === "add" || item.op === "modify") && merged;

  return (
    <ItemShell
      item={item}
      checked={checked}
      canEdit={canEdit}
      onChange={onChange}
      label={<Badge tone={CHANGE_OP_TONE[item.op]}>{CASE_OP_LABEL[item.op]}</Badge>}
      title={merged?.title || item.before?.title || "（沒有標題）"}
      aside={
        editable ? (
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? "收起" : "手動修改"}
          </Button>
        ) : null
      }
    >
      {item.featureRef && <p className="text-xs text-gray-500">功能：{item.featureRef}</p>}
      {item.op === "modify" && <DiffView text={item.diff} />}
      {item.op === "add" && merged && !open && <CasePreview snapshot={merged} />}
      {item.op === "mark_outdated" && (
        <p className="text-xs text-gray-600">會標成待處理、預設不執行，等你決定要怎麼改。</p>
      )}
      {item.op === "deprecate" && <p className="text-xs text-gray-600">會停用，保留歷史但不再執行。</p>}
      {open && merged && <CaseEditor snapshot={merged} onEdit={onEdit} />}
    </ItemShell>
  );
}

function ItemShell({
  item,
  checked,
  canEdit,
  onChange,
  label,
  title,
  aside,
  children,
}: {
  item: { id: string; reason: string; unresolved?: string };
  checked: boolean;
  canEdit: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  title: string;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const blocked = !!item.unresolved;
  return (
    <div className={`rounded-md border p-3 ${blocked ? "border-gray-200 bg-gray-50 opacity-70" : checked ? "border-blue-200 bg-blue-50/40" : "border-gray-200"}`}>
      <div className="flex items-start gap-2">
        {blocked ? (
          <span className="mt-0.5 text-xs text-gray-400">—</span>
        ) : (
          <input
            type="checkbox"
            className="mt-1"
            checked={checked}
            disabled={!canEdit}
            onChange={(e) => onChange(e.target.checked)}
          />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {label}
            <span className="text-sm font-medium text-gray-800">{title}</span>
            {aside && <span className="ml-auto">{aside}</span>}
          </div>
          {item.reason && <p className="text-xs text-gray-600">理由：{item.reason}</p>}
          {blocked && <p className="text-xs text-red-600">{item.unresolved}</p>}
          {children}
        </div>
      </div>
    </div>
  );
}

function CasePreview({ snapshot }: { snapshot: CaseSnapshot }) {
  return (
    <div className="rounded bg-gray-50 p-2 text-xs text-gray-700">
      <p>前置條件：{snapshot.precondition || "（無）"}</p>
      <ol className="ml-4 list-decimal">
        {snapshot.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      <p>預期結果：{snapshot.expected}</p>
      <p className="text-gray-500">
        {snapshot.priority} / {CASE_TYPE_LABEL[snapshot.type] ?? snapshot.type}
      </p>
    </div>
  );
}

/** §4.4 「手動修改後按套用」: the reviewer's edits win over what the model wrote. */
function CaseEditor({ snapshot, onEdit }: { snapshot: CaseSnapshot; onEdit: (patch: Partial<CaseSnapshot>) => void }) {
  return (
    <div className="space-y-2 rounded bg-white p-2 ring-1 ring-gray-200">
      <Field label="標題">
        <Input value={snapshot.title} onChange={(e) => onEdit({ title: e.target.value })} />
      </Field>
      <Field label="前置條件">
        <Input value={snapshot.precondition} onChange={(e) => onEdit({ precondition: e.target.value })} />
      </Field>
      <Field label="步驟" hint="一行一個步驟">
        <Textarea
          rows={4}
          value={snapshot.steps.join("\n")}
          onChange={(e) => onEdit({ steps: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
        />
      </Field>
      <Field label="預期結果">
        <Textarea rows={2} value={snapshot.expected} onChange={(e) => onEdit({ expected: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="優先級">
          <Select value={snapshot.priority} onChange={(e) => onEdit({ priority: e.target.value as Priority })}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </Select>
        </Field>
        <Field label="類型">
          <Select value={snapshot.type} onChange={(e) => onEdit({ type: e.target.value as CaseType })}>
            {CASE_TYPES.map((t) => (
              <option key={t} value={t}>{CASE_TYPE_LABEL[t]}</option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  );
}

// ---------- shared bits ----------

function CheckRow({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** Colours a server-computed diff. Lines start with "+ ", "- " or two spaces. */
function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <p className="text-xs text-gray-400">（沒有內容變動）</p>;
  return (
    <pre className="overflow-x-auto rounded bg-gray-900/95 p-2 text-xs leading-relaxed text-gray-200">
      {text.split("\n").map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith("+")
              ? "text-green-300"
              : line.startsWith("-")
                ? "text-red-300"
                : line.startsWith("【")
                  ? "mt-1 font-semibold text-gray-100"
                  : "text-gray-400"
          }
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/** Feature descriptions are short; a two-line before/after reads better than a hunk. */
function diffText(before: string, after: string): string {
  if (before === after) return "";
  return `- ${before || "（空）"}\n+ ${after || "（空）"}`;
}

function Timeline({ entries, loading, error }: { entries: ChangeLogEntry[]; loading: boolean; error: unknown }) {
  return (
    <Card title="變更時間軸">
      {loading && <Spinner />}
      <ErrorText error={error} />
      {!loading && !entries.length && <Empty>還沒有套用過任何變更。</Empty>}
      <ol className="space-y-3">
        {entries.map((entry) => (
          <li key={entry.id} className="border-l-2 border-gray-200 pl-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span>{formatDate(entry.appliedAt)}</span>
              <Badge tone="blue">{CHANGE_SOURCE_LABEL[entry.source]}</Badge>
              <span>{entry.appliedBy}</span>
            </div>
            <p className="text-sm text-gray-800">{entry.summary}</p>
            <p className="text-xs text-gray-500">
              影響 {entry.featureCount} 個功能、{entry.caseCount} 條案例
              {entry.descriptionVersionAfter !== null && `，描述更新為 v${entry.descriptionVersionAfter}`}
            </p>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function DecidedList({ proposals }: { proposals: ChangeProposal[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Card
      title={`已處理的提案（${proposals.length}）`}
      actions={
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : "展開"}
        </Button>
      }
    >
      {open ? (
        <ul className="space-y-2">
          {proposals.map((p) => (
            <li key={p.id} className="flex items-start gap-2 text-sm">
              <Badge tone={PROPOSAL_STATE_TONE[p.state]}>{PROPOSAL_STATE_LABEL[p.state]}</Badge>
              <span className="flex-1 text-gray-700">{p.summary}</span>
              <span className="text-xs text-gray-400">{formatDate(p.decidedAt ?? p.createdAt)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-gray-500">已套用或已拒絕的提案都留在這裡。</p>
      )}
    </Card>
  );
}
