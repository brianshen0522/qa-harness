import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FindingStatus, Severity } from "@prisma/client";
import { api } from "../api/client";
import type { InboxFinding, Role } from "../api/types";
import {
  FINDING_STATUS_LABEL,
  FINDING_STATUS_TONE,
  SEVERITY_LABEL,
  SEVERITY_TONE,
  formatDate,
  hasRole,
} from "../lib/roles";
import { Badge, Button, Card, Empty, ErrorText, Select, Spinner } from "./ui";
import { FindingToCaseDialog } from "./RunPanel";
import { useToast } from "./Toast";

const SEVERITY_ORDER: Severity[] = ["critical", "major", "minor", "info"];

/** §4.7 triage inbox: every finding for a target, across runs, in one place. */
export function FindingsInbox({ targetId, myRole }: { targetId: string; myRole: Role }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canEdit = hasRole(myRole, "editor");
  const [status, setStatus] = useState<FindingStatus | "all">("open");
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [drafting, setDrafting] = useState<string | null>(null);

  const key = ["targets", targetId, "findings", status, severity];
  const q = useQuery({
    queryKey: key,
    queryFn: () => {
      const params = new URLSearchParams();
      if (status !== "all") params.set("status", status);
      if (severity !== "all") params.set("severity", severity);
      const qs = params.toString();
      return api<InboxFinding[]>(`/targets/${targetId}/findings${qs ? `?${qs}` : ""}`);
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["targets", targetId, "findings"] });

  const setFindingStatus = useMutation({
    mutationFn: ({ id, next }: { id: string; next: FindingStatus }) =>
      api(`/findings/${id}/status`, { method: "POST", body: { status: next } }),
    onSuccess: (_d, v) => {
      toast.success(v.next === "dismissed" ? "已忽略" : "已更新狀態");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "更新失敗"),
  });
  const propose = useMutation({
    mutationFn: (id: string) => api(`/findings/${id}/change-proposal`, { method: "POST" }),
    onSuccess: () => {
      toast.success("已轉為變更提案");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "轉換失敗"),
  });

  const findings = q.data ?? [];
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const openCount = findings.filter((f) => f.status === "open").length;

  return (
    <Card
      title={`Finding 收件匣${status === "open" ? `（${openCount} 待處理）` : ""}`}
      actions={
        <div className="flex items-center gap-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value as FindingStatus | "all")} className="py-1 text-xs">
            <option value="open">待處理</option>
            <option value="all">全部狀態</option>
            <option value="converted_to_case">已轉案例</option>
            <option value="converted_to_proposal">已轉提案</option>
            <option value="dismissed">已忽略</option>
          </Select>
          <Select value={severity} onChange={(e) => setSeverity(e.target.value as Severity | "all")} className="py-1 text-xs">
            <option value="all">全部嚴重度</option>
            {SEVERITY_ORDER.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
      }
    >
      {q.isPending && <Spinner />}
      <ErrorText error={q.error} />

      {drafting && (
        <FindingToCaseDialog
          findingId={drafting}
          onClose={() => setDrafting(null)}
          onSaved={() => {
            setDrafting(null);
            toast.success("已轉為測試案例");
            invalidate();
          }}
        />
      )}

      {q.data && sorted.length === 0 && <Empty>沒有符合條件的 finding。</Empty>}

      {sorted.length > 0 && (
        <ul className="space-y-2">
          {sorted.map((f) => (
            <li key={f.id} className="rounded-md border border-gray-200 p-2.5 dark:border-gray-700">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEVERITY_TONE[f.severity]}>{SEVERITY_LABEL[f.severity]}</Badge>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-100">{f.title}</span>
                <Badge tone={FINDING_STATUS_TONE[f.status]}>{FINDING_STATUS_LABEL[f.status]}</Badge>
                <Link
                  to={`/targets/${targetId}?tab=runs&run=${f.run.id}`}
                  className="ml-auto text-xs text-blue-700 hover:underline dark:text-blue-300"
                >
                  {formatDate(f.run.startedAt)} 的執行 →
                </Link>
              </div>
              {f.description && <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600 dark:text-gray-300">{f.description}</p>}
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                {f.feature ? `Feature：${f.feature.name} · ` : ""}
                發現於：{f.caseTitle ?? "非特定案例"}
              </p>
              {canEdit && f.status === "open" && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => setDrafting(f.id)}>
                    轉為測試案例
                  </Button>
                  <Button variant="secondary" size="sm" disabled={propose.isPending} onClick={() => propose.mutate(f.id)}>
                    {propose.isPending ? "分析中…" : "轉為變更提案"}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={setFindingStatus.isPending} onClick={() => setFindingStatus.mutate({ id: f.id, next: "dismissed" })}>
                    忽略
                  </Button>
                </div>
              )}
              {canEdit && f.status !== "open" && (
                <div className="mt-2 flex items-center gap-2">
                  {f.convertedCaseId && (
                    <Link to={`/targets/${targetId}?tab=cases`} className="text-xs text-blue-700 hover:underline dark:text-blue-300">
                      看測試案例 →
                    </Link>
                  )}
                  {f.convertedProposalId && (
                    <Link to={`/targets/${targetId}?tab=changes`} className="text-xs text-blue-700 hover:underline dark:text-blue-300">
                      看變更提案 →
                    </Link>
                  )}
                  {f.status === "dismissed" && (
                    <Button variant="ghost" size="sm" onClick={() => setFindingStatus.mutate({ id: f.id, next: "open" })}>
                      復原
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
