import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { useAdminMe } from "../../api/auth";
import type { AdminPrincipal } from "../../api/types";
import { Button, ErrorText, Field, Input } from "../../components/ui";

export default function AdminLoginPage() {
  const me = useAdminMe();
  const qc = useQueryClient();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from || "/admin/llm";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = useMutation({
    mutationFn: () => api<AdminPrincipal>("/admin/auth/login", { method: "POST", body: { email, password } }),
    onSuccess: (admin) => qc.setQueryData(["admin", "me"], admin),
  });

  if (me.data) return <Navigate to={from} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-900 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg bg-white p-6 shadow-xl">
        <div>
          <h1 className="text-xl font-bold">管理員登入</h1>
          <p className="mt-1 text-sm text-gray-500">QA Harness Admin</p>
        </div>
        <Field label="Email">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </Field>
        <Field label="密碼">
          <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        <Button type="submit" className="w-full" disabled={login.isPending}>
          登入
        </Button>
        <ErrorText error={login.error} />
        <p className="text-center text-xs text-gray-400">
          <Link to="/login" className="hover:underline">
            返回一般使用者登入
          </Link>
        </p>
      </form>
    </div>
  );
}
