import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import type { AdminPrincipal, UserPrincipal } from "./types";

async function fetchPrincipal<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function useMe() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => fetchPrincipal<UserPrincipal>("/auth/me"),
    retry: false,
    staleTime: 60_000,
  });
}

export function useAdminMe() {
  return useQuery({
    queryKey: ["admin", "me"],
    queryFn: () => fetchPrincipal<AdminPrincipal>("/admin/auth/me"),
    retry: false,
    staleTime: 60_000,
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/auth/logout", { method: "POST" }),
    onSuccess: () => {
      qc.setQueryData(["auth", "me"], null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
    },
  });
}

export function useAdminLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/admin/auth/logout", { method: "POST" }),
    onSuccess: () => {
      qc.setQueryData(["admin", "me"], null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] === "admin" && q.queryKey[1] !== "me" });
    },
  });
}
