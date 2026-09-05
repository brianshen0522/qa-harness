import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { useMe } from "../api/auth";
import type { Providers, UserPrincipal } from "../api/types";
import { Button, ErrorText, Field, Input, Spinner } from "../components/ui";
import { ThemeToggle } from "../components/ThemeToggle";

export default function LoginPage() {
  const me = useMe();
  const qc = useQueryClient();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from || "/";
  const providers = useQuery({ queryKey: ["auth", "providers"], queryFn: () => api<Providers>("/auth/providers") });

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const devLogin = useMutation({
    mutationFn: () => api<UserPrincipal>("/auth/dev-login", { method: "POST", body: { email, name: name || undefined } }),
    onSuccess: (user) => qc.setQueryData(["auth", "me"], user),
  });

  // One login for everyone; an admin account lands straight in the admin area.
  if (me.data) return <Navigate to={me.data.isAdmin ? "/admin" : from} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    devLogin.mutate();
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-6 shadow-sm">
        <h1 className="text-xl font-bold">QA Harness</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">請登入以繼續</p>

        {providers.isPending && <Spinner />}
        {providers.isError && <ErrorText error={providers.error} />}
        {providers.data && (
          <div className="mt-5 space-y-3">
            {providers.data.google && (
              <a href="/api/auth/google" className="block rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-center text-sm hover:bg-gray-50 dark:hover:bg-gray-800">
                使用 Google 登入
              </a>
            )}
            {providers.data.github && (
              <a href="/api/auth/github" className="block rounded-md border border-gray-300 dark:border-gray-700 px-3 py-2 text-center text-sm hover:bg-gray-50 dark:hover:bg-gray-800">
                使用 GitHub 登入
              </a>
            )}
            {!providers.data.google && !providers.data.github && !providers.data.dev && (
              <p className="text-sm text-gray-500 dark:text-gray-400">目前沒有可用的登入方式，請聯絡管理員。</p>
            )}
            {providers.data.dev && (
              <form onSubmit={submit} className="space-y-3 rounded-md border border-dashed border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3">
                <p className="text-xs font-medium text-amber-800 dark:text-amber-300">開發者登入（僅開發環境）</p>
                <Field label="Email">
                  <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                </Field>
                <Field label="名稱（選填）">
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Button type="submit" className="w-full" disabled={devLogin.isPending}>
                  登入
                </Button>
                <ErrorText error={devLogin.error} />
              </form>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
