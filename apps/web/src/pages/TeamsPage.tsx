import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Team, TeamMember } from "../api/types";
import { Badge, Button, Card, Empty, ErrorText, Input, Spinner, Table } from "../components/ui";
import { formatDate } from "../lib/roles";

export default function TeamsPage() {
  const qc = useQueryClient();
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => api<Team[]>("/teams") });
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api<Team>("/teams", { method: "POST", body: { name } }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["teams"] });
      setName("");
      setSelected(t.id);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  const selectedTeam = teams.data?.find((t) => t.id === selected) ?? teams.data?.[0];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">Teams</h1>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card title="我的 Teams">
          <form onSubmit={submit} className="mb-3 flex gap-2">
            <Input placeholder="新 Team 名稱" value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              建立
            </Button>
          </form>
          <ErrorText error={create.error} />
          {teams.isPending && <Spinner />}
          <ErrorText error={teams.error} />
          {teams.data && teams.data.length === 0 && <Empty>尚無 Team。</Empty>}
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {teams.data?.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setSelected(t.id)}
                  className={`flex w-full items-center justify-between px-2 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-800 ${
                    selectedTeam?.id === t.id ? "bg-blue-50 dark:bg-blue-950/40" : ""
                  }`}
                >
                  <span className="font-medium">{t.name}</span>
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    {t._count.members} 位成員 · {t._count.projects} 個 Project
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {selectedTeam ? <TeamMembers team={selectedTeam} /> : <Card title="成員"><Empty>請選擇一個 Team。</Empty></Card>}
      </div>
    </div>
  );
}

function TeamMembers({ team }: { team: Team }) {
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ["teams", team.id, "members"], queryFn: () => api<TeamMember[]>(`/teams/${team.id}/members`) });
  const [email, setEmail] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["teams", team.id, "members"] });
    qc.invalidateQueries({ queryKey: ["teams"] });
  };

  const add = useMutation({
    mutationFn: () => api<TeamMember>(`/teams/${team.id}/members`, { method: "POST", body: { email } }),
    onSuccess: () => {
      setEmail("");
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api<void>(`/teams/${team.id}/members/${userId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });

  return (
    <Card title={`${team.name} 的成員`} actions={<span className="text-xs text-gray-400 dark:text-gray-500">建立於 {formatDate(team.createdAt)}</span>}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
        className="mb-3 flex gap-2"
      >
        <Input type="email" placeholder="以 Email 加入成員（需已註冊）" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button type="submit" disabled={!email.trim() || add.isPending}>
          加入
        </Button>
      </form>
      <ErrorText error={add.error} />
      <ErrorText error={remove.error} />
      {members.isPending && <Spinner />}
      <ErrorText error={members.error} />
      {members.data && (
        <Table>
          <thead>
            <tr>
              <th>名稱</th>
              <th>Email</th>
              <th>狀態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.data.map((m) => (
              <tr key={m.userId}>
                <td>{m.user.name || "-"}</td>
                <td>{m.user.email}</td>
                <td>
                  <Badge tone={m.user.status === "active" ? "green" : "red"}>{m.user.status === "active" ? "啟用" : "停用"}</Badge>
                </td>
                <td className="text-right">
                  <Button variant="danger" size="sm" onClick={() => remove.mutate(m.userId)} disabled={remove.isPending}>
                    移除
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
