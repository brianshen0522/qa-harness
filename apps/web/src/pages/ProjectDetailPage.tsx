import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { DescriptionVersion, ProjectDetail, ProjectMember, Role, Target, TargetKind } from "../api/types";
import { Button, Card, Dialog, Empty, ErrorText, Field, Input, KindBadge, RoleBadge, Select, Spinner, StatusBadge, Table, Tabs, Textarea } from "../components/ui";
import { DescriptionEditor } from "../components/DescriptionEditor";
import { ConfigForm, configToDraft, draftToConfig, type ConfigDraft } from "../components/ConfigForm";
import { DiscussionPanel } from "../components/DiscussionPanel";
import { HandoffPanel } from "../components/HandoffPanel";
import { KIND_LABEL, ROLES, ROLE_LABEL, formatDate, hasRole } from "../lib/roles";

type TabKey = "overview" | "discussion" | "handoff";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "總覽" },
  { key: "discussion", label: "討論區" },
  { key: "handoff", label: "交接" },
];

export default function ProjectDetailPage() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: TabKey = tabParam === "discussion" || tabParam === "handoff" ? tabParam : "overview";
  const setTab = (key: TabKey) => setSearchParams(key === "overview" ? {} : { tab: key }, { replace: true });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const project = useQuery({ queryKey: ["projects", id], queryFn: () => api<ProjectDetail>(`/projects/${id}`) });

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showNewTarget, setShowNewTarget] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const invalidateProject = () => {
    qc.invalidateQueries({ queryKey: ["projects", id] });
    qc.invalidateQueries({ queryKey: ["projects"], exact: true });
  };

  const rename = useMutation({
    mutationFn: () => api<ProjectDetail>(`/projects/${id}`, { method: "PATCH", body: { name: nameDraft } }),
    onSuccess: () => {
      setEditingName(false);
      invalidateProject();
    },
  });
  const remove = useMutation({
    mutationFn: () => api<void>(`/projects/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      navigate("/");
    },
  });
  const saveDescription = useMutation({
    mutationFn: (content: string) => api<ProjectDetail>(`/projects/${id}/description`, { method: "PUT", body: { content, source: "manual" } }),
    onSuccess: () => {
      invalidateProject();
      qc.invalidateQueries({ queryKey: ["projects", id, "versions"] });
    },
  });

  if (project.isPending) return <Spinner />;
  if (project.isError) return <ErrorText error={project.error} />;
  const p = project.data;
  const isOwner = hasRole(p.myRole, "owner");
  const isEditor = hasRole(p.myRole, "editor");

  return (
    <div className="space-y-4">
      <nav className="text-xs text-gray-400">
        <Link to="/" className="hover:underline">
          Projects
        </Link>{" "}
        / {p.name}
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
            <h1 className="text-lg font-bold">{p.name}</h1>
          )}
          <RoleBadge role={p.myRole} />
          <span className="text-xs text-gray-500">Team：{p.team.name}</span>
        </div>
        {isOwner && !editingName && (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setNameDraft(p.name);
                setEditingName(true);
              }}
            >
              重新命名
            </Button>
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
              刪除 Project
            </Button>
          </div>
        )}
      </div>
      <ErrorText error={rename.error} />

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "discussion" && <DiscussionPanel scope="project" entityId={id} myRole={p.myRole} />}
      {tab === "handoff" && <HandoffPanel scope="project" entityId={id} myRole={p.myRole} />}

      {tab === "overview" && (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card
            title="描述"
            actions={
              <Button variant="ghost" size="sm" onClick={() => setShowHistory((s) => !s)}>
                {showHistory ? "隱藏版本歷史" : "版本歷史"}
              </Button>
            }
          >
            <DescriptionEditor
              value={p.description}
              version={p.descriptionVersion}
              canEdit={isEditor}
              onSave={(content) => saveDescription.mutate(content)}
              saving={saveDescription.isPending}
              error={saveDescription.error}
            />
            {showHistory && <VersionHistory projectId={id} />}
          </Card>

          <Card
            title={`Targets（${p.targets.length}）`}
            actions={isOwner && <Button size="sm" onClick={() => setShowNewTarget(true)}>新增 Target</Button>}
          >
            {p.targets.length === 0 ? (
              <Empty>尚無 Target。</Empty>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>名稱</th>
                    <th>種類</th>
                    <th>狀態</th>
                    <th>更新時間</th>
                  </tr>
                </thead>
                <tbody>
                  {p.targets.map((t) => (
                    <tr key={t.id} className="hover:bg-gray-50">
                      <td>
                        <Link to={`/targets/${t.id}`} className="font-medium text-blue-700 hover:underline">
                          {t.name}
                        </Link>
                      </td>
                      <td>
                        <KindBadge kind={t.kind} />
                      </td>
                      <td>
                        <StatusBadge status={t.status} />
                      </td>
                      <td className="text-gray-500">{formatDate(t.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <ProjectMembers projectId={id} isOwner={isOwner} />
      </div>
      )}

      <NewTargetDialog projectId={id} open={showNewTarget} onClose={() => setShowNewTarget(false)} />

      <Dialog open={confirmDelete} title="刪除 Project" onClose={() => setConfirmDelete(false)}>
        <p className="text-sm text-gray-700">
          確定要刪除「{p.name}」嗎？其下所有 Target 也會一併刪除，此動作無法復原。
        </p>
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

function VersionHistory({ projectId }: { projectId: string }) {
  const versions = useQuery({
    queryKey: ["projects", projectId, "versions"],
    queryFn: () => api<DescriptionVersion[]>(`/projects/${projectId}/description/versions`),
  });
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="mt-4 border-t border-gray-100 pt-3">
      <h3 className="mb-2 text-xs font-medium text-gray-600">版本歷史</h3>
      {versions.isPending && <Spinner />}
      <ErrorText error={versions.error} />
      {versions.data && versions.data.length === 0 && <Empty>尚無版本。</Empty>}
      <ul className="space-y-1">
        {versions.data?.map((v) => (
          <li key={v.id} className="rounded-md border border-gray-100">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-gray-50"
              onClick={() => setOpenId(openId === v.id ? null : v.id)}
            >
              <span className="font-medium">v{v.version}</span>
              <span className="text-gray-400">
                {v.source ? `${v.source} · ` : ""}
                {formatDate(v.createdAt)}
              </span>
            </button>
            {openId === v.id && (
              <pre className="whitespace-pre-wrap border-t border-gray-100 bg-gray-50 p-3 font-sans text-xs text-gray-700">{v.content || "（空白）"}</pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProjectMembers({ projectId, isOwner }: { projectId: string; isOwner: boolean }) {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ["projects", projectId, "members"], queryFn: () => api<ProjectMember[]>(`/projects/${projectId}/members`) });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["projects", projectId, "members"] });
    qc.invalidateQueries({ queryKey: ["projects", projectId], exact: true });
    qc.invalidateQueries({ queryKey: ["projects"], exact: true });
  };
  const add = useMutation({
    mutationFn: () => api<ProjectMember>(`/projects/${projectId}/members`, { method: "POST", body: { email, role } }),
    onSuccess: () => {
      setEmail("");
      invalidate();
    },
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api<ProjectMember>(`/projects/${projectId}/members/${userId}`, { method: "PATCH", body: { role } }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api<void>(`/projects/${projectId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  return (
    <Card title="成員">
      {isOwner && (
        <form onSubmit={submit} className="mb-3 space-y-2">
          <div className="flex gap-2">
            <Input type="email" placeholder="Email（需已註冊）" value={email} onChange={(e) => setEmail(e.target.value)} />
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)} className="w-28">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
            <Button type="submit" disabled={!email.trim() || add.isPending}>
              加入
            </Button>
          </div>
          <ErrorText error={add.error} />
        </form>
      )}
      {members.isPending && <Spinner />}
      <ErrorText error={members.error} />
      <ErrorText error={changeRole.error} />
      <ErrorText error={remove.error} />
      {members.data && (
        <ul className="divide-y divide-gray-100">
          {members.data.map((m) => (
            <li key={m.userId} className="flex items-center justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{m.user.name || m.user.email}</p>
                <p className="truncate text-xs text-gray-400">{m.user.email}</p>
              </div>
              {isOwner ? (
                <div className="flex items-center gap-1">
                  <Select
                    value={m.role}
                    onChange={(e) => changeRole.mutate({ userId: m.userId, role: e.target.value as Role })}
                    className="w-24 py-1 text-xs"
                    disabled={changeRole.isPending}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </Select>
                  <Button variant="danger" size="sm" onClick={() => remove.mutate(m.userId)} disabled={remove.isPending}>
                    移除
                  </Button>
                </div>
              ) : (
                <RoleBadge role={m.role} />
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NewTargetDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<TargetKind>("web");
  const [draft, setDraft] = useState<ConfigDraft>(() => configToDraft("web", null));
  const [description, setDescription] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const changeKind = (k: TargetKind) => {
    setKind(k);
    setDraft(configToDraft(k, null));
  };

  const create = useMutation({
    mutationFn: (config: Record<string, unknown>) =>
      api<Target>(`/projects/${projectId}/targets`, {
        method: "POST",
        body: { name, kind, config, description: description || undefined },
      }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["projects", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"], exact: true });
      setName("");
      setDescription("");
      setDraft(configToDraft(kind, null));
      onClose();
      navigate(`/targets/${t.id}`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    try {
      create.mutate(draftToConfig(kind, draft));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={open} title="新增 Target" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="名稱">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="種類">
          <Select value={kind} onChange={(e) => changeKind(e.target.value as TargetKind)}>
            {(Object.keys(KIND_LABEL) as TargetKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="rounded-md border border-gray-100 bg-gray-50 p-3">
          <p className="mb-2 text-xs font-medium text-gray-600">設定</p>
          <ConfigForm kind={kind} draft={draft} onChange={setDraft} />
        </div>
        <Field label="描述（選填）">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            建立
          </Button>
        </div>
        {localError && <p className="mt-2 text-xs text-red-600">{localError}</p>}
        <ErrorText error={create.error} />
      </form>
    </Dialog>
  );
}
