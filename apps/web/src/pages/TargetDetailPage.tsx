import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { CredentialType, Role, TargetCredentialInfo, TargetDetail, TargetMember } from "../api/types";
import { Badge, Button, Card, Dialog, Empty, ErrorText, Field, Input, KindBadge, Notice, RoleBadge, Select, Spinner, StatusBadge, Tabs } from "../components/ui";
import { useToast } from "../components/Toast";
import { useConfirm } from "../components/Confirm";
import { DescriptionEditor } from "../components/DescriptionEditor";
import { ConfigForm, configToDraft, draftToConfig, type ConfigDraft } from "../components/ConfigForm";
import { DiscussionPanel } from "../components/DiscussionPanel";
import { HandoffPanel } from "../components/HandoffPanel";
import { TestCaseList } from "../components/TestCaseList";
import { RunPanel } from "../components/RunPanel";
import { ChangePanel } from "../components/ChangePanel";
import { ExplorePanel } from "../components/ExplorePanel";
import { ApiSetupPanel } from "../components/ApiSetupPanel";
import { FindingsInbox } from "../components/FindingsInbox";
import { ROLES, ROLE_LABEL, hasRole } from "../lib/roles";

type TabKey = "overview" | "discussion" | "handoff" | "explore" | "cases" | "changes" | "runs" | "findings";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "總覽" },
  { key: "discussion", label: "討論區" },
  { key: "handoff", label: "交接" },
  { key: "explore", label: "探索" },
  { key: "cases", label: "測試清單" },
  { key: "changes", label: "變更" },
  { key: "runs", label: "執行" },
  { key: "findings", label: "Finding" },
];

export default function TargetDetailPage() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: TabKey =
    tabParam === "discussion" || tabParam === "handoff" || tabParam === "cases" ||
    tabParam === "changes" || tabParam === "runs" || tabParam === "explore" || tabParam === "findings"
      ? tabParam
      : "overview";
  const setTab = (key: TabKey) => setSearchParams(key === "overview" ? {} : { tab: key }, { replace: true });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const target = useQuery({ queryKey: ["targets", id], queryFn: () => api<TargetDetail>(`/targets/${id}`) });

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["targets", id] });
    if (target.data) qc.invalidateQueries({ queryKey: ["projects", target.data.projectId] });
  };

  const rename = useMutation({
    mutationFn: () => api<TargetDetail>(`/targets/${id}`, { method: "PATCH", body: { name: nameDraft } }),
    onSuccess: () => {
      setEditingName(false);
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => api<void>(`/targets/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      const projectId = target.data?.projectId;
      qc.invalidateQueries({ queryKey: ["projects"] });
      navigate(projectId ? `/projects/${projectId}` : "/");
    },
  });
  const saveDescription = useMutation({
    mutationFn: (content: string) => api<TargetDetail>(`/targets/${id}/description`, { method: "PUT", body: { content } }),
    onSuccess: invalidate,
  });

  if (target.isPending) return <Spinner />;
  if (target.isError) return <ErrorText error={target.error} />;
  const t = target.data;
  const isOwner = hasRole(t.myRole, "owner");
  const isEditor = hasRole(t.myRole, "editor");
  const running = t.status === "running";

  return (
    <div className="space-y-4">
      <nav className="text-xs text-gray-400 dark:text-gray-500">
        <Link to="/" className="hover:underline">
          Projects
        </Link>{" "}
        /{" "}
        <Link to={`/projects/${t.project.id}`} className="hover:underline">
          {t.project.name}
        </Link>{" "}
        / {t.name}
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {editingName ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                rename.mutate();
              }}
              className="flex items-center gap-2"
            >
              <Input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} className="w-64" autoFocus />
              <Button type="submit" size="sm" disabled={!nameDraft.trim() || rename.isPending}>
                儲存
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditingName(false)}>
                取消
              </Button>
            </form>
          ) : (
            <h1 className="text-lg font-bold">{t.name}</h1>
          )}
          <KindBadge kind={t.kind} />
          <StatusBadge status={t.status} />
          <RoleBadge role={t.myRole} />
        </div>
        {isOwner && !editingName && (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={running}
              onClick={() => {
                setNameDraft(t.name);
                setEditingName(true);
              }}
            >
              重新命名
            </Button>
            <Button variant="danger" size="sm" disabled={running} onClick={() => setConfirmDelete(true)}>
              刪除 Target
            </Button>
          </div>
        )}
      </div>
      <ErrorText error={rename.error} />

      {running && <Notice>此 Target 正在執行中，執行期間無法修改設定、描述或憑證。</Notice>}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "discussion" && <DiscussionPanel scope="target" entityId={id} myRole={t.myRole} locked={running} />}
      {tab === "handoff" && <HandoffPanel scope="target" entityId={id} myRole={t.myRole} locked={running} />}
      {tab === "explore" && <ExplorePanel targetId={id} myRole={t.myRole} kind={t.kind} />}
      {tab === "cases" && <TestCaseList targetId={id} />}
      {tab === "changes" && (
        <ChangePanel scope="target" entityId={id} myRole={t.myRole} description={t.description ?? ""} running={running} />
      )}
      {tab === "runs" && <RunPanel targetId={id} kind={t.kind} myRole={t.myRole} />}
      {tab === "findings" && <FindingsInbox targetId={id} myRole={t.myRole} />}

      {tab === "overview" && (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card title="設定">
            <ConfigPanel target={t} canEdit={isOwner && !running} onSaved={invalidate} />
          </Card>
          <Card title="描述">
            <DescriptionEditor
              value={t.description}
              version={t.descriptionVersion}
              canEdit={isEditor}
              disabled={running}
              onSave={(content) => saveDescription.mutate(content)}
              saving={saveDescription.isPending}
              error={saveDescription.error}
            />
          </Card>
        </div>
        <div className="space-y-4">
          <Card title="憑證">
            <CredentialsPanel target={t} canEdit={isOwner && !running} onSaved={invalidate} />
          </Card>
          <TargetMembers targetId={id} isOwner={isOwner} />
        </div>
      </div>
      )}

      {tab === "overview" && t.kind === "api" && (
        <Card title="前置流程(共用步驟)" className="mt-4">
          <ApiSetupPanel scope={{ kind: "target", targetId: id }} canEdit={isEditor && !running} />
        </Card>
      )}

      <Dialog open={confirmDelete} title="刪除 Target" onClose={() => setConfirmDelete(false)}>
        <p className="text-sm text-gray-700 dark:text-gray-200">確定要刪除「{t.name}」嗎？此動作無法復原。</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
            取消
          </Button>
          <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
            確認刪除
          </Button>
        </div>
        <ErrorText error={remove.error} />
      </Dialog>
    </div>
  );
}

function ConfigPanel({ target, canEdit, onSaved }: { target: TargetDetail; canEdit: boolean; onSaved: () => void }) {
  const [draft, setDraft] = useState<ConfigDraft>(() => configToDraft(target.kind, target.config));
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(configToDraft(target.kind, target.config));
  }, [target.kind, target.config]);

  const save = useMutation({
    mutationFn: (config: Record<string, unknown>) => api<TargetDetail>(`/targets/${target.id}`, { method: "PATCH", body: { config } }),
    onSuccess: onSaved,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    try {
      save.mutate(draftToConfig(target.kind, draft));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  const original = configToDraft(target.kind, target.config);
  const dirty = Object.keys(draft).some((k) => draft[k] !== original[k]);

  return (
    <form onSubmit={submit}>
      <ConfigForm kind={target.kind} draft={draft} onChange={setDraft} disabled={!canEdit} />
      {canEdit && (
        <div className="mt-3 flex items-center gap-2">
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? "儲存中…" : "儲存設定"}
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(original)}>
              還原
            </Button>
          )}
        </div>
      )}
      {localError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{localError}</p>}
      <ErrorText error={save.error} />
    </form>
  );
}

const CRED_TYPES: { value: CredentialType; label: string }[] = [
  { value: "password", label: "帳號密碼" },
  { value: "api_key", label: "API key" },
  { value: "bearer_token", label: "Bearer token" },
  { value: "cookie", label: "Cookie" },
  { value: "other", label: "其他" },
];
const CRED_TYPE_LABEL: Record<CredentialType, string> = Object.fromEntries(CRED_TYPES.map((t) => [t.value, t.label])) as Record<CredentialType, string>;
const credFields = (t: CredentialType): string[] => (t === "password" ? ["username", "password"] : ["value"]);
const fieldLabel = (f: string): string => (f === "username" ? "帳號" : f === "password" ? "密碼" : "值");

function CredentialsPanel({ target, canEdit, onSaved }: { target: TargetDetail; canEdit: boolean; onSaved: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const creds: TargetCredentialInfo[] = target.credentials ?? [];

  // Add / overwrite form
  const [name, setName] = useState("");
  const [type, setType] = useState<CredentialType>("password");
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [addRotation, setAddRotation] = useState(false);
  // Inline edit state
  const [editing, setEditing] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editFields, setEditFields] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState(false);
  const [revealBase, setRevealBase] = useState<Record<string, string>>({});

  const resetForm = () => { setName(""); setType("password"); setDescription(""); setFields({}); setAddRotation(false); };
  const formValid = name.trim() && credFields(type).every((f) => (fields[f] ?? "").length > 0);

  const put = useMutation({
    mutationFn: () => api<unknown>(`/targets/${target.id}/credentials`, { method: "PUT", body: { name: name.trim(), type, description: description.trim(), fields, allowRotation: addRotation } }),
    onSuccess: () => {
      const existed = creds.some((c) => c.name === name.trim());
      resetForm();
      onSaved();
      toast.success(existed ? "憑證已覆寫。" : "憑證已新增。");
    },
  });
  const patch = useMutation({
    mutationFn: (vars: { name: string; body: Record<string, unknown> }) =>
      api<unknown>(`/targets/${target.id}/credentials/${encodeURIComponent(vars.name)}`, { method: "PATCH", body: vars.body }),
    onSuccess: () => onSaved(),
  });
  const del = useMutation({
    mutationFn: (n: string) => api<void>(`/targets/${target.id}/credentials/${encodeURIComponent(n)}`, { method: "DELETE" }),
    onSuccess: () => { onSaved(); toast.success("憑證已刪除。"); },
  });
  const reveal = useMutation({
    mutationFn: (n: string) => api<{ fields: Record<string, string> }>(`/targets/${target.id}/credentials/${encodeURIComponent(n)}/reveal`),
    onSuccess: (data) => { setEditFields(data.fields); setRevealBase(data.fields); setRevealed(true); },
  });

  const startEdit = (c: TargetCredentialInfo) => { setEditing(c.name); setRenameTo(c.name); setEditDesc(c.description); setEditFields({}); setRevealed(false); setRevealBase({}); };
  const cancelEdit = () => { setEditing(null); setRenameTo(""); setEditDesc(""); setEditFields({}); setRevealed(false); setRevealBase({}); };
  const saveEdit = (c: TargetCredentialInfo) => {
    const body: Record<string, unknown> = {};
    if (renameTo.trim() && renameTo.trim() !== c.name) body.newKey = renameTo.trim();
    if (editDesc !== c.description) body.description = editDesc;
    // Send only fields with a non-empty value that differs from what was revealed.
    const changedFields = Object.fromEntries(
      Object.entries(editFields).filter(([f, v]) => v.length > 0 && v !== (revealBase[f] ?? "")),
    );
    if (Object.keys(changedFields).length) body.fields = changedFields;
    if (!Object.keys(body).length) { cancelEdit(); return; }
    patch.mutate({ name: c.name, body }, { onSuccess: () => { cancelEdit(); toast.success("憑證已更新。"); } });
  };
  const toggleRotation = async (c: TargetCredentialInfo) => {
    if (!c.allowRotation) {
      const ok = await confirm({
        title: "允許執行時輪替這個憑證？",
        body: <>開啟後，若某條 case 在測試中改掉了「<code>{c.name}</code>」的值（例如改密碼），平台會產生新值並<b>自動把儲存的憑證同步成新值</b>，之後的執行都會用新值登入。只對「本來就是拿來被測試修改」的憑證開啟。</>,
        confirmLabel: "開啟輪替",
      });
      if (!ok) return;
    }
    patch.mutate({ name: c.name, body: { allowRotation: !c.allowRotation } }, {
      onSuccess: () => toast.success(c.allowRotation ? `已關閉「${c.name}」的輪替。` : `已開啟「${c.name}」的輪替。`),
    });
  };
  const removeCred = async (c: TargetCredentialInfo) => {
    const ok = await confirm({ title: "刪除憑證", body: <>確定刪除憑證「<code>{c.name}</code>」？用到 {c.refs.map((r) => <code key={r}>{`{{${r}}}`}</code>)} 的前置流程與身份將無法代入。</>, tone: "danger", confirmLabel: "刪除" });
    if (ok) del.mutate(c.name);
  };

  return (
    <div>
      <p className="mb-2 text-xs text-gray-400 dark:text-gray-500">
        憑證值儲存後不會再顯示。請填「說明」告訴 LLM 這是誰的憑證、登入後會到哪，測試代理才不會拿錯帳號。帳號密碼會綁成一組，引用時用 <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 py-0.5">{"{{名稱.username}}"}</code> / <code className="rounded bg-gray-100 dark:bg-gray-800 px-1 py-0.5">{"{{名稱.password}}"}</code>。
      </p>
      {creds.length === 0 ? (
        <Empty>尚無憑證。</Empty>
      ) : (
        <ul className="mb-3 divide-y divide-gray-100 dark:divide-gray-800">
          {creds.map((c) => (
            <li key={c.name} className="py-2 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-gray-800 dark:text-gray-100">{c.name}</span>
                    <Badge tone="gray">{CRED_TYPE_LABEL[c.type]}</Badge>
                    {c.allowRotation && <Badge tone="blue">可輪替</Badge>}
                  </div>
                  {c.description && <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{c.description}</p>}
                  <p className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-gray-400 dark:text-gray-500">
                    {c.refs.map((r) => <code key={r} className="rounded bg-gray-100 dark:bg-gray-800 px-1 py-0.5">{`{{${r}}}`}</code>)}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 items-center gap-1">
                    <label className="mr-1 flex cursor-pointer items-center gap-1 text-xs text-gray-500 dark:text-gray-400" title="開啟後，case 若在測試中改掉此憑證的密碼，平台會自動把儲存的值同步成新值">
                      <input type="checkbox" checked={c.allowRotation} disabled={patch.isPending} onChange={() => toggleRotation(c)} className="h-3.5 w-3.5 accent-blue-600" />
                      可輪替
                    </label>
                    <Button variant="ghost" size="sm" onClick={() => (editing === c.name ? cancelEdit() : startEdit(c))}>編輯</Button>
                    <Button variant="danger" size="sm" onClick={() => removeCred(c)} disabled={del.isPending}>刪除</Button>
                  </div>
                )}
              </div>
              {canEdit && editing === c.name && (
                <div className="mt-2 space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/40 p-3">
                  <Field label="名稱（改名會一併更新前置流程與身份裡的 {{引用}}）">
                    <Input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} placeholder={c.name} />
                  </Field>
                  <Field label="說明（給 LLM 判斷用）">
                    <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="例如：一般會員，登入後看 Browse" />
                  </Field>
                  {credFields(c.type).map((f) => (
                    <Field key={f} label={revealed ? fieldLabel(f) : `新${fieldLabel(f)}（留空則不變更）`}>
                      <Input type={revealed || f === "username" ? "text" : "password"} value={editFields[f] ?? ""} autoComplete="off"
                        onChange={(e) => setEditFields((s) => ({ ...s, [f]: e.target.value }))} placeholder={revealed || f === "username" ? "" : "••••••••"} />
                    </Field>
                  ))}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => saveEdit(c)} disabled={patch.isPending}>{patch.isPending ? "儲存中…" : "儲存"}</Button>
                    <Button variant="ghost" size="sm" onClick={cancelEdit}>取消</Button>
                    {!revealed && (
                      <Button variant="ghost" size="sm" onClick={() => reveal.mutate(c.name)} disabled={reveal.isPending}>
                        {reveal.isPending ? "讀取中…" : "顯示目前值"}
                      </Button>
                    )}
                    {revealed && <span className="text-[11px] text-amber-600 dark:text-amber-400">目前值已顯示，直接修改後按儲存即可。</span>}
                  </div>
                  <ErrorText error={reveal.error} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={del.error} />
      <ErrorText error={patch.error} />
      {canEdit && (
        <form onSubmit={(e) => { e.preventDefault(); if (formValid) put.mutate(); }} className="space-y-2 border-t border-gray-100 dark:border-gray-800 pt-3">
          <p className="text-xs font-medium text-gray-600 dark:text-gray-300">新增 / 覆寫憑證</p>
          <Field label="類型">
            <Select value={type} onChange={(e) => { setType(e.target.value as CredentialType); setFields({}); }}>
              {CRED_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </Field>
          <Field label="名稱（引用時寫在 {{}} 裡）">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={type === "password" ? "例如 一般使用者" : "例如 api_token"} />
          </Field>
          {credFields(type).map((f) => (
            <Field key={f} label={fieldLabel(f)}>
              <Input type={f === "username" ? "text" : "password"} value={fields[f] ?? ""} autoComplete="new-password"
                onChange={(e) => setFields((s) => ({ ...s, [f]: e.target.value }))} />
            </Field>
          ))}
          <Field label="說明（給 LLM 判斷用，建議填）">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="例如：一般會員，登入後導向 /(Browse)" />
          </Field>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <input type="checkbox" checked={addRotation} onChange={(e) => setAddRotation(e.target.checked)} className="h-3.5 w-3.5 accent-blue-600" />
            允許執行時輪替（case 改掉此憑證{type === "password" ? "的密碼" : "的值"}時，自動同步儲存的值）
          </label>
          <Button type="submit" size="sm" disabled={!formValid || put.isPending}>
            {creds.some((c) => c.name === name.trim()) ? "覆寫憑證" : "新增憑證"}
          </Button>
          <ErrorText error={put.error} />
        </form>
      )}
    </div>
  );
}

function TargetMembers({ targetId, isOwner }: { targetId: string; isOwner: boolean }) {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ["targets", targetId, "members"], queryFn: () => api<TargetMember[]>(`/targets/${targetId}/members`) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["targets", targetId, "members"] });

  const setOverride = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api<unknown>(`/targets/${targetId}/members/${userId}`, { method: "PUT", body: { role } }),
    onSuccess: invalidate,
  });
  const clearOverride = useMutation({
    mutationFn: (userId: string) => api<void>(`/targets/${targetId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  return (
    <Card title="成員與角色">
      <p className="mb-2 text-xs text-gray-400 dark:text-gray-500">列出所有 Project 成員；Target 覆寫只能提升角色，不能低於 Project 角色，Project 擁有者不可覆寫。</p>
      {members.isPending && <Spinner />}
      <ErrorText error={members.error} />
      <ErrorText error={setOverride.error} />
      <ErrorText error={clearOverride.error} />
      {members.data && members.data.length === 0 && <Empty>沒有成員。</Empty>}
      {members.data && (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {members.data.map((m) => {
            const canOverride = isOwner && m.projectRole !== "owner";
            return (
              <li key={m.user.id} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{m.user.name || m.user.email}</p>
                    <p className="truncate text-xs text-gray-400 dark:text-gray-500">{m.user.email}</p>
                  </div>
                  <div className="text-right">
                    <span className="mr-1 text-xs text-gray-400 dark:text-gray-500">有效</span>
                    <RoleBadge role={m.effectiveRole} />
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <span>Project：{ROLE_LABEL[m.projectRole]}</span>
                  <span>·</span>
                  <span>Target 覆寫：</span>
                  {canOverride ? (
                    <>
                      <Select
                        value={m.targetRole ?? ""}
                        className="w-28 py-0.5 text-xs"
                        disabled={setOverride.isPending || clearOverride.isPending}
                        onChange={(e) => {
                          const v = e.target.value as Role | "";
                          if (v === "") clearOverride.mutate(m.user.id);
                          else setOverride.mutate({ userId: m.user.id, role: v });
                        }}
                      >
                        <option value="">（無）</option>
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </Select>
                    </>
                  ) : m.targetRole ? (
                    <Badge tone="blue">{ROLE_LABEL[m.targetRole]}</Badge>
                  ) : (
                    <span>無</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
