import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type {
  ChecklistItem,
  CompletenessMap,
  DiscussionMessage,
  DiscussionPostResult,
  DiscussionState,
  LinkReference,
  ProjectAttachment,
  ProposalDecision,
  Role,
  SavedDescription,
  Scope,
  TargetProposal,
} from "../api/types";
import { Badge, Button, Card, Empty, ErrorText, KindBadge, Notice, Spinner, Textarea } from "./ui";
import {
  COMPLETENESS_LABEL,
  COMPLETENESS_TONE,
  PROPOSAL_STATUS_LABEL,
  formatBytes,
  formatDate,
  hasRole,
} from "../lib/roles";

/**
 * Spec §4.1 討論區：guided chat + 完整度 panel + 描述草稿 panel + Target 提案卡。
 * The same panel serves both scopes; only the base path and `canPropose` differ.
 */
export function DiscussionPanel({
  scope,
  entityId,
  myRole,
  locked,
}: {
  scope: Scope;
  entityId: string;
  myRole: Role;
  locked?: boolean;
}) {
  const qc = useQueryClient();
  const base = scope === "project" ? `/projects/${entityId}` : `/targets/${entityId}`;
  const detailKey = scope === "project" ? ["projects", entityId] : ["targets", entityId];
  const discussionKey = ["discussion", scope, entityId];

  const state = useQuery({
    queryKey: discussionKey,
    queryFn: () => api<DiscussionState>(`${base}/discussion`),
  });

  const [content, setContent] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const isEditor = hasRole(myRole, "editor");
  const isOwner = hasRole(myRole, "owner");
  const canCompose = isEditor && !locked;

  const invalidateDiscussion = () => qc.invalidateQueries({ queryKey: discussionKey });

  const send = useMutation({
    mutationFn: (text: string) =>
      api<DiscussionPostResult>(`${base}/discussion/messages`, { method: "POST", body: { content: text } }),
    onSuccess: () => {
      setContent("");
      invalidateDiscussion();
      if (state.data) qc.invalidateQueries({ queryKey: ["attachments", state.data.projectId] });
    },
  });

  const messages = state.data?.messages ?? [];
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, send.isPending]);

  /** Spec §4.1「使用者可點某項直接補充」— clicking a question or checklist row seeds the composer. */
  const prefill = (text: string) => {
    if (!canCompose) return;
    setContent((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")}\n\n${text}` : text));
    composerRef.current?.focus();
  };

  /** Accepts both the form submit event and the Cmd/Ctrl+Enter keyboard event. */
  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const text = content.trim();
    if (!text || send.isPending) return;
    send.mutate(text);
  };

  if (state.isPending) return <Spinner />;
  if (state.isError) return <ErrorText error={state.error} />;
  const d = state.data;

  return (
    <div className="space-y-4">
      {locked && <Notice>此 Target 正在執行中，執行期間無法在討論區發言或儲存描述。</Notice>}
      {!isEditor && <Notice tone="blue">你是檢視者，只能閱讀討論內容，無法發言或修改草稿。</Notice>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title={`討論區 — ${d.entityName}`}>
          <div ref={listRef} className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
            {messages.length === 0 && (
              <Empty>還沒有對話。先說說這個{scope === "project" ? " Project" : " Target"}是做什麼的，LLM 會依清單逐項追問。</Empty>
            )}
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} checklist={d.checklist} onPickQuestion={prefill} canCompose={canCompose} />
            ))}
            {send.isPending && (
              <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/40 px-3 py-2">
                <Spinner label="LLM 回覆中…（依 model 不同，可能需要 5–60 秒，請勿離開此頁）" />
              </div>
            )}
          </div>

          <form onSubmit={submit} className="mt-3 border-t border-gray-100 dark:border-gray-800 pt-3">
            <Textarea
              ref={composerRef}
              rows={4}
              value={content}
              disabled={!canCompose || send.isPending}
              placeholder={
                canCompose ? "說明系統細節，或貼上參考連結（會自動抓取內容並顯示預覽）。Cmd/Ctrl + Enter 送出。" : "無發言權限。"
              }
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(e);
              }}
            />
            <div className="mt-2 flex items-center gap-2">
              <Button type="submit" disabled={!canCompose || !content.trim() || send.isPending}>
                {send.isPending ? "LLM 回覆中…" : "送出"}
              </Button>
              <span className="text-xs text-gray-400 dark:text-gray-500">Cmd / Ctrl + Enter 送出</span>
            </div>
            <ErrorText error={send.error} />
          </form>
        </Card>

        <div className="space-y-4">
          <CompletenessPanel checklist={d.checklist} completeness={d.completeness} canCompose={canCompose} onSupplement={prefill} />
          <DraftPanel
            base={base}
            draft={d.draft}
            canEdit={isEditor && !locked}
            onSaved={invalidateDiscussion}
            onDescriptionSaved={() => {
              invalidateDiscussion();
              qc.invalidateQueries({ queryKey: detailKey });
              if (scope === "project") qc.invalidateQueries({ queryKey: ["projects", entityId, "versions"] });
            }}
          />
          <AttachmentsPanel projectId={d.projectId} />
        </div>
      </div>

      {d.canPropose && (
        <ProposalsPanel proposals={d.proposals} isOwner={isOwner} isEditor={isEditor} onDecided={invalidateDiscussion} />
      )}
    </div>
  );
}

function MessageBubble({
  message,
  checklist,
  onPickQuestion,
  canCompose,
}: {
  message: DiscussionMessage;
  checklist: ChecklistItem[];
  onPickQuestion: (text: string) => void;
  canCompose: boolean;
}) {
  const isUser = message.role === "user";
  const questions = message.structured?.questions ?? [];

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 ${isUser ? "bg-blue-50 dark:bg-blue-950/40 text-gray-800 dark:text-gray-100" : "bg-gray-50 dark:bg-gray-800/50 text-gray-800 dark:text-gray-100"}`}>
        <div className="mb-1 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
          <span>{isUser ? "你" : "LLM"}</span>
          <span>{formatDate(message.createdAt)}</span>
        </div>
        <p className="whitespace-pre-wrap text-sm">{message.content}</p>

        {message.references && message.references.length > 0 && <ReferenceCards references={message.references} />}

        {questions.length > 0 && (
          <ol className="mt-2 space-y-1 border-t border-gray-200 dark:border-gray-700 pt-2 text-sm">
            {questions.map((q, i) => {
              const item = checklist.find((c) => c.key === q.item);
              return (
                <li key={`${message.id}-${i}`} className="flex items-start gap-2">
                  <span className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{i + 1}.</span>
                  <button
                    type="button"
                    disabled={!canCompose}
                    onClick={() => onPickQuestion(`> [${item?.label ?? q.item}] ${q.question}\n`)}
                    className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1 text-left text-xs transition hover:border-blue-300 dark:hover:border-blue-800 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:cursor-not-allowed disabled:opacity-60"
                    title={canCompose ? "點擊直接補充這一項" : "無發言權限"}
                  >
                    <span className="mr-1 font-medium text-blue-700 dark:text-blue-300">{item?.label ?? q.item}</span>
                    <span className="text-gray-700 dark:text-gray-200">{q.question}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}

        {!isUser && message.model && <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">model：{message.model}</p>}
      </div>
    </div>
  );
}

function ReferenceCards({ references }: { references: LinkReference[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {references.map((r) => (
        <li key={r.url} className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-2 py-1.5 text-xs">
          <a href={r.url} target="_blank" rel="noreferrer" className="font-medium text-blue-700 dark:text-blue-300 hover:underline">
            {r.title || r.url}
          </a>
          <p className="truncate text-gray-400 dark:text-gray-500">{r.url}</p>
          {r.error ? <p className="text-red-600 dark:text-red-400">抓取失敗：{r.error}</p> : <p className="text-gray-400 dark:text-gray-500">已讀取 {r.chars} 字</p>}
        </li>
      ))}
    </ul>
  );
}

function CompletenessPanel({
  checklist,
  completeness,
  canCompose,
  onSupplement,
}: {
  checklist: ChecklistItem[];
  completeness: CompletenessMap;
  canCompose: boolean;
  onSupplement: (text: string) => void;
}) {
  return (
    <Card title="完整度">
      <p className="mb-2 text-xs text-gray-400 dark:text-gray-500">點任一項可直接在下方對話框補充該項資訊。</p>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {checklist.map((item) => {
          const value = completeness[item.key] ?? "unknown";
          return (
            <li key={item.key}>
              <button
                type="button"
                disabled={!canCompose}
                onClick={() => onSupplement(`請補充「${item.label}」：${item.hint}\n`)}
                className="flex w-full items-start justify-between gap-2 py-2 text-left transition hover:bg-gray-50 dark:hover:bg-gray-800 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-800 dark:text-gray-100">{item.label}</span>
                  <span className="block text-xs text-gray-400 dark:text-gray-500">{item.hint}</span>
                </span>
                <Badge tone={COMPLETENESS_TONE[value]}>{COMPLETENESS_LABEL[value]}</Badge>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function DraftPanel({
  base,
  draft,
  canEdit,
  onSaved,
  onDescriptionSaved,
}: {
  base: string;
  draft: string;
  canEdit: boolean;
  onSaved: () => void;
  onDescriptionSaved: () => void;
}) {
  const [text, setText] = useState(draft);
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  useEffect(() => {
    setText(draft);
  }, [draft]);

  const saveDraft = useMutation({
    mutationFn: () => api<unknown>(`${base}/discussion/draft`, { method: "PUT", body: { draft: text } }),
    onSuccess: onSaved,
  });
  const saveDescription = useMutation({
    mutationFn: () => api<SavedDescription>(`${base}/discussion/save-description`, { method: "POST", body: { content: text } }),
    onSuccess: (saved) => {
      setSavedVersion(saved.descriptionVersion);
      onDescriptionSaved();
    },
  });

  const dirty = text !== draft;

  return (
    <Card title="描述草稿">
      <p className="mb-2 text-xs text-gray-400 dark:text-gray-500">草稿會隨對話自動更新，也可以直接編輯。</p>
      {canEdit ? (
        <>
          <Textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="LLM 會把整理後的描述寫在這裡…" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => saveDraft.mutate()} disabled={!dirty || saveDraft.isPending}>
              {saveDraft.isPending ? "儲存中…" : "儲存草稿"}
            </Button>
            <Button size="sm" onClick={() => saveDescription.mutate()} disabled={!text.trim() || saveDescription.isPending}>
              {saveDescription.isPending ? "儲存中…" : "儲存為描述"}
            </Button>
            {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">尚未儲存</span>}
          </div>
          {savedVersion !== null && <p className="mt-2 text-xs text-green-700 dark:text-green-300">已儲存為描述 v{savedVersion}。</p>}
          <ErrorText error={saveDraft.error} />
          <ErrorText error={saveDescription.error} />
        </>
      ) : (
        <pre className="whitespace-pre-wrap rounded-md bg-gray-50 dark:bg-gray-800/50 p-3 font-sans text-sm text-gray-700 dark:text-gray-200">{draft || "（尚無草稿）"}</pre>
      )}
    </Card>
  );
}

function AttachmentsPanel({ projectId }: { projectId: string }) {
  const attachments = useQuery({
    queryKey: ["attachments", projectId],
    queryFn: () => api<ProjectAttachment[]>(`/projects/${projectId}/attachments`),
  });

  return (
    <Card title="參考附件">
      {attachments.isPending && <Spinner />}
      <ErrorText error={attachments.error} />
      {attachments.data && attachments.data.length === 0 && <Empty>尚無附件。在對話中貼連結會自動存成附件。</Empty>}
      {attachments.data && attachments.data.length > 0 && (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {attachments.data.map((a) => (
            <li key={a.id} className="py-2 text-xs">
              <div className="flex items-center gap-2">
                <Badge tone={a.sourceType === "handoff" ? "purple" : a.sourceType === "file" ? "blue" : "gray"}>
                  {a.sourceType === "handoff" ? "交接" : a.sourceType === "file" ? "檔案" : "連結"}
                </Badge>
                {a.url ? (
                  <a href={a.url} target="_blank" rel="noreferrer" className="truncate font-medium text-blue-700 dark:text-blue-300 hover:underline">
                    {a.filename}
                  </a>
                ) : (
                  <span className="truncate font-medium text-gray-800 dark:text-gray-100">{a.filename}</span>
                )}
              </div>
              <p className="mt-0.5 text-gray-400 dark:text-gray-500">
                {formatBytes(a.byteSize)} · {formatDate(a.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ProposalsPanel({
  proposals,
  isOwner,
  isEditor,
  onDecided,
}: {
  proposals: TargetProposal[];
  isOwner: boolean;
  isEditor: boolean;
  onDecided: () => void;
}) {
  const pending = proposals.filter((p) => p.status === "pending");
  const decided = proposals.filter((p) => p.status !== "pending");

  return (
    <Card title={`Target 提案（${pending.length} 筆待決定）`}>
      <p className="mb-3 text-xs text-gray-400 dark:text-gray-500">LLM 只會提案，不會直接建立 Target；接受後才會實際建立。</p>
      {proposals.length === 0 && <Empty>尚無提案。當 LLM 認為被測面已經清楚時，會在這裡提出 Target 提案。</Empty>}

      <div className="space-y-3">
        {pending.map((p) => (
          <PendingProposalCard key={p.id} proposal={p} isOwner={isOwner} isEditor={isEditor} onDecided={onDecided} />
        ))}
      </div>

      {decided.length > 0 && (
        <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-800 border-t border-gray-100 dark:border-gray-800 pt-2">
          {decided.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <KindBadge kind={p.kind} />
              <span className="font-medium">{p.name}</span>
              <Badge tone={p.status === "accepted" ? "green" : "gray"}>{PROPOSAL_STATUS_LABEL[p.status]}</Badge>
              {p.createdTargetId && (
                <Link to={`/targets/${p.createdTargetId}`} className="text-xs text-blue-700 dark:text-blue-300 hover:underline">
                  前往 Target
                </Link>
              )}
              <span className="text-xs text-gray-400 dark:text-gray-500">{formatDate(p.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PendingProposalCard({
  proposal,
  isOwner,
  isEditor,
  onDecided,
}: {
  proposal: TargetProposal;
  isOwner: boolean;
  isEditor: boolean;
  onDecided: () => void;
}) {
  const [createdTargetId, setCreatedTargetId] = useState<string | null>(null);

  const accept = useMutation({
    mutationFn: () => api<ProposalDecision>(`/discussion/proposals/${proposal.id}/accept`, { method: "POST" }),
    onSuccess: (res) => {
      setCreatedTargetId(res.target?.id ?? res.createdTargetId);
      onDecided();
    },
  });
  const reject = useMutation({
    mutationFn: () => api<ProposalDecision>(`/discussion/proposals/${proposal.id}/reject`, { method: "POST" }),
    onSuccess: onDecided,
  });

  const configEntries = Object.entries(proposal.config ?? {});

  return (
    <div className="rounded-lg border border-blue-200 dark:border-blue-900 bg-blue-50/40 dark:bg-blue-950/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind={proposal.kind} />
        <span className="text-sm font-semibold">{proposal.name}</span>
        <Badge tone="amber">{PROPOSAL_STATUS_LABEL.pending}</Badge>
        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">{formatDate(proposal.createdAt)}</span>
      </div>

      <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-200">{proposal.rationale}</p>

      {configEntries.length > 0 && (
        <dl className="mt-2 space-y-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2 text-xs">
          {configEntries.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="w-32 shrink-0 font-medium text-gray-500 dark:text-gray-400">{k}</dt>
              <dd className="min-w-0 break-all text-gray-800 dark:text-gray-100">
                {v == null || v === "" ? "（未填）" : typeof v === "object" ? JSON.stringify(v) : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {proposal.credentialKeys.length > 0 && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">建立後需另外填入憑證：{proposal.credentialKeys.join("、")}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!isOwner || accept.isPending || reject.isPending}
          title={isOwner ? undefined : "只有 Project 擁有者可以接受提案並建立 Target"}
          onClick={() => accept.mutate()}
        >
          {accept.isPending ? "建立中…" : "接受"}
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={!isEditor || accept.isPending || reject.isPending}
          onClick={() => reject.mutate()}
        >
          拒絕
        </Button>
        {!isOwner && <span className="text-xs text-gray-400 dark:text-gray-500">只有擁有者可以接受提案。</span>}
        {createdTargetId && (
          <Link to={`/targets/${createdTargetId}`} className="text-xs font-medium text-blue-700 dark:text-blue-300 hover:underline">
            已建立，前往 Target →
          </Link>
        )}
      </div>
      <ErrorText error={accept.error} />
      <ErrorText error={reject.error} />
    </div>
  );
}
