import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { AdminUser, UserStatus } from "../../api/types";
import { Badge, Button, Card, Empty, ErrorText, Input, Spinner, Table } from "../../components/ui";
import { ROLE_LABEL, formatDate } from "../../lib/roles";

export default function AdminUsersPage() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: () => api<AdminUser[]>("/admin/users") });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin", "users"] });
  const invite = useMutation({
    mutationFn: () => api<AdminUser>("/admin/users", { method: "POST", body: { email, name: name || undefined } }),
    onSuccess: () => {
      setEmail("");
      setName("");
      invalidate();
    },
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: UserStatus }) => api<AdminUser>(`/admin/users/${id}`, { method: "PATCH", body: { status } }),
    onSuccess: invalidate,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">使用者</h1>
      <Card title="邀請使用者（預先建立帳號）">
        <form onSubmit={submit} className="flex flex-wrap gap-2">
          <Input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="max-w-xs" />
          <Input placeholder="名稱（選填）" value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" />
          <Button type="submit" disabled={!email.trim() || invite.isPending}>
            邀請
          </Button>
        </form>
        <ErrorText error={invite.error} />
      </Card>

      <Card title={`所有使用者${users.data ? `（${users.data.length}）` : ""}`}>
        {users.isPending && <Spinner />}
        <ErrorText error={users.error} />
        <ErrorText error={setStatus.error} />
        {users.data && users.data.length === 0 && <Empty>尚無使用者。</Empty>}
        {users.data && users.data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>Email</th>
                <th>名稱</th>
                <th>登入方式</th>
                <th>狀態</th>
                <th>Teams</th>
                <th>Projects</th>
                <th>建立時間</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.id}>
                  <td className="font-medium">{u.email}</td>
                  <td>{u.name || "-"}</td>
                  <td className="text-gray-500">{u.authProvider || "-"}</td>
                  <td>
                    <Badge tone={u.status === "active" ? "green" : "red"}>{u.status === "active" ? "啟用" : "停用"}</Badge>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {u.teams.length === 0 ? <span className="text-gray-400">-</span> : u.teams.map((t) => <Badge key={t.id}>{t.name}</Badge>)}
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {u.projects.length === 0 ? (
                        <span className="text-gray-400">-</span>
                      ) : (
                        u.projects.map((p) => (
                          <Badge key={p.id} tone="blue">
                            {p.name}（{ROLE_LABEL[p.role]}）
                          </Badge>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap text-gray-500">{formatDate(u.createdAt)}</td>
                  <td className="text-right">
                    <Button
                      variant={u.status === "active" ? "danger" : "secondary"}
                      size="sm"
                      disabled={setStatus.isPending}
                      onClick={() => setStatus.mutate({ id: u.id, status: u.status === "active" ? "disabled" : "active" })}
                    >
                      {u.status === "active" ? "停用" : "啟用"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
