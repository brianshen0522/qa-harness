import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ProjectListItem, Team } from "../api/types";
import { Button, Card, Dialog, Empty, ErrorText, Field, Input, RoleBadge, Select, Spinner, Table, Textarea } from "../components/ui";
import { formatDate } from "../lib/roles";

export default function ProjectsPage() {
  const [open, setOpen] = useState(false);
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<ProjectListItem[]>("/projects") });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Projects</h1>
        <Button onClick={() => setOpen(true)}>新增 Project</Button>
      </div>

      <Card>
        {projects.isPending && <Spinner />}
        <ErrorText error={projects.error} />
        {projects.data && projects.data.length === 0 && <Empty>尚無 Project，點「新增 Project」開始。</Empty>}
        {projects.data && projects.data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>名稱</th>
                <th>Team</th>
                <th>我的角色</th>
                <th>Targets</th>
                <th>成員</th>
                <th>更新時間</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td>
                    <Link to={`/projects/${p.id}`} className="font-medium text-blue-700 hover:underline">
                      {p.name}
                    </Link>
                    {p.description && <p className="mt-0.5 line-clamp-1 max-w-md text-xs text-gray-400">{p.description}</p>}
                  </td>
                  <td>{p.team.name}</td>
                  <td>
                    <RoleBadge role={p.myRole} />
                  </td>
                  <td>{p._count.targets}</td>
                  <td>{p._count.members}</td>
                  <td className="text-gray-500">{formatDate(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <CreateProjectDialog open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => api<Team[]>("/teams"), enabled: open });
  const [teamId, setTeamId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [newTeamName, setNewTeamName] = useState("");

  const noTeams = teams.data && teams.data.length === 0;
  const selectedTeam = teamId || teams.data?.[0]?.id || "";

  const createTeam = useMutation({
    mutationFn: () => api<Team>("/teams", { method: "POST", body: { name: newTeamName } }),
    onSuccess: (t) => {
      qc.invalidateQueries({ queryKey: ["teams"] });
      setTeamId(t.id);
      setNewTeamName("");
    },
  });

  const create = useMutation({
    mutationFn: () =>
      api<ProjectListItem>("/projects", {
        method: "POST",
        body: { teamId: selectedTeam, name, description: description || undefined },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["teams"] });
      setName("");
      setDescription("");
      onClose();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!selectedTeam) return;
    create.mutate();
  };

  return (
    <Dialog open={open} title="新增 Project" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {teams.isPending && <Spinner />}
        <ErrorText error={teams.error} />
        {noTeams ? (
          <div className="space-y-2 rounded-md border border-dashed border-gray-300 bg-gray-50 p-3">
            <p className="text-xs text-gray-600">你還沒有任何 Team，請先建立一個。</p>
            <div className="flex gap-2">
              <Input placeholder="Team 名稱" value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} />
              <Button variant="secondary" onClick={() => createTeam.mutate()} disabled={!newTeamName.trim() || createTeam.isPending}>
                建立 Team
              </Button>
            </div>
            <ErrorText error={createTeam.error} />
          </div>
        ) : (
          teams.data && (
            <Field label="Team">
              <Select value={selectedTeam} onChange={(e) => setTeamId(e.target.value)}>
                {teams.data.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )
        )}
        <Field label="名稱">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="描述（選填）">
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={!selectedTeam || !name.trim() || create.isPending}>
            建立
          </Button>
        </div>
        <ErrorText error={create.error} />
      </form>
    </Dialog>
  );
}
