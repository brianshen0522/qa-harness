import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Role, TargetDetail, TargetMember } from "../api/types";
import { Badge, Button, Card, Dialog, Empty, ErrorText, Field, Input, KindBadge, Notice, RoleBadge, Select, Spinner, StatusBadge, Tabs } from "../components/ui";
import { DescriptionEditor } from "../components/DescriptionEditor";
import { ConfigForm, configToDraft, draftToConfig, type ConfigDraft } from "../components/ConfigForm";
import { DiscussionPanel } from "../components/DiscussionPanel";
import { HandoffPanel } from "../components/HandoffPanel";
import { TestCaseList } from "../components/TestCaseList";
import { RunPanel } from "../components/RunPanel";
import { ChangePanel } from "../components/ChangePanel";
import { ExplorePanel } from "../components/ExplorePanel";
import { ROLES, ROLE_LABEL, hasRole } from "../lib/roles";

type TabKey = "overview" | "discussion" | "handoff" | "explore" | "cases" | "changes" | "runs";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "總覽" },
  { key: "discussion", label: "討論區" },
  { key: "handoff", label: "交接" },
  { key: "explore", label: "探索" },
  { key: "cases", label: "測試清單" },
  { key: "changes", label: "變更" },
  { key: "runs", label: "執行" },
];

export default function TargetDetailPage() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: TabKey =
    tabParam === "discussion" || tabParam === "handoff" || tabParam === "cases" ||
    tabParam === "changes" || tabParam === "runs" || tabParam === "explore"
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
      <nav className="text-xs text-gray-400">
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

      <Dialog open={confirmDelete} title="刪除 Target" onClose={() => setConfirmDelete(false)}>
        <p className="text-sm text-gray-700">確定要刪除「{t.name}」嗎？此動作無法復原。</p>
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
      {localError && <p className="mt-2 text-xs text-red-600">{localError}</p>}
      <ErrorText error={save.error} />
    </form>
  );
}

function CredentialsPanel({ target, canEdit, onSaved }: { target: TargetDetail; canEdit: boolean; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const put = useMutation({
    mutationFn: () => api<unknown>(`/targets/${target.id}/credentials`, { method: "PUT", body: { key, value } }),
    onSuccess: () => {
      setKey("");
      setValue("");
      onSaved();
    },
  });
  const del = useMutation({
    mutationFn: (k: string) => api<void>(`/targets/${target.id}/credentials/${encodeURIComponent(k)}`, { method: "DELETE" }),
    onSuccess: onSaved,
  });

  return (
    <div>
      <p className="mb-2 text-xs text-gray-400">憑證值儲存後不會再顯示，只列出鍵名。</p>
      {target.credentialKeys.length === 0 ? (
        <Empty>尚無憑證。</Empty>
      ) : (
        <ul className="mb-3 divide-y divide-gray-100">
          {target.credentialKeys.map((k) => (
            <li key={k} className="flex items-center justify-between py-1.5 text-sm">
              <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">{k}</code>
              {canEdit && (
                <Button variant="danger" size="sm" onClick={() => del.mutate(k)} disabled={del.isPending}>
                  刪除
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={del.error} />
      {canEdit && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            put.mutate();
          }}
          className="space-y-2 border-t border-gray-100 pt-3"
        >
          <Field label="鍵名">
            <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="例如 API_TOKEN" />
          </Field>
          <Field label="值">
            <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
          </Field>
          <Button type="submit" size="sm" disabled={!key.trim() || !value || put.isPending}>
            {target.credentialKeys.includes(key.trim()) ? "覆寫憑證" : "新增憑證"}
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
      <p className="mb-2 text-xs text-gray-400">列出所有 Project 成員；Target 覆寫只能提升角色，不能低於 Project 角色，Project 擁有者不可覆寫。</p>
      {members.isPending && <Spinner />}
      <ErrorText error={members.error} />
      <ErrorText error={setOverride.error} />
      <ErrorText error={clearOverride.error} />
      {members.data && members.data.length === 0 && <Empty>沒有成員。</Empty>}
      {members.data && (
        <ul className="divide-y divide-gray-100">
          {members.data.map((m) => {
            const canOverride = isOwner && m.projectRole !== "owner";
            return (
              <li key={m.user.id} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{m.user.name || m.user.email}</p>
                    <p className="truncate text-xs text-gray-400">{m.user.email}</p>
                  </div>
                  <div className="text-right">
                    <span className="mr-1 text-xs text-gray-400">有效</span>
                    <RoleBadge role={m.effectiveRole} />
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
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
