import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Overview, OverviewTarget, Verdicts } from "../api/types";
import { Badge, Card, Empty, ErrorText, KindBadge, Spinner } from "../components/ui";

function passRate(v: Verdicts): number | null {
  const judged = v.pass + v.fail + v.blocked;
  return judged ? Math.round((v.pass / judged) * 100) : null;
}

function StatTile({ label, value, tone }: { label: string; value: number; tone: "gray" | "amber" | "red" | "blue" }) {
  const color =
    tone === "red" ? "text-red-600 dark:text-red-400" : tone === "amber" ? "text-amber-700 dark:text-amber-300" : tone === "blue" ? "text-blue-600 dark:text-blue-400" : "text-gray-800 dark:text-gray-100";
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{label}</div>
    </div>
  );
}

function TargetRow({ t }: { t: OverviewTarget }) {
  const rate = t.lastRun ? passRate(t.lastRun.verdicts) : null;
  return (
    <Link
      to={`/targets/${t.id}?tab=runs`}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-gray-100 px-3 py-2.5 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50"
    >
      <KindBadge kind={t.kind} />
      <span className="font-medium text-gray-800 dark:text-gray-100">{t.name}</span>
      <span className="text-xs text-gray-400 dark:text-gray-500">{t.projectName}</span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {t.activeRun && (
          <Badge tone="amber">
            執行中 {t.activeRun.done}/{t.activeRun.total}
          </Badge>
        )}
        {t.outdatedCases > 0 && <Badge tone="amber">待處理 {t.outdatedCases}</Badge>}
        {t.openFindings > 0 && <Badge tone="purple">Finding {t.openFindings}</Badge>}
        {t.lastRun ? (
          <span className="flex items-center gap-1.5 text-xs">
            <span className={rate !== null && rate < 100 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}>
              {rate === null ? "—" : `${rate}%`}
            </span>
            <span className="text-gray-400 dark:text-gray-500">
              通過 {t.lastRun.verdicts.pass} · 失敗 {t.lastRun.verdicts.fail}
              {t.lastRun.verdicts.blocked ? ` · 受阻 ${t.lastRun.verdicts.blocked}` : ""}
            </span>
          </span>
        ) : (
          <span className="text-xs text-gray-400 dark:text-gray-500">尚未執行</span>
        )}
      </div>
    </Link>
  );
}

export default function DashboardPage() {
  const q = useQuery({ queryKey: ["me", "overview"], queryFn: () => api<Overview>("/me/overview"), refetchInterval: 15000 });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">首頁</h1>

      {q.isPending && <Spinner />}
      <ErrorText error={q.error} />

      {q.data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="執行中" value={q.data.totals.activeRuns} tone="amber" />
            <StatTile label="有失敗的 Target" value={q.data.totals.failingTargets} tone="red" />
            <StatTile label="待處理案例" value={q.data.totals.outdatedCases} tone="amber" />
            <StatTile label="未處理 Finding" value={q.data.totals.openFindings} tone="blue" />
          </div>

          <Card title="我的 Targets">
            {q.data.targets.length === 0 ? (
              <Empty>你還沒有任何 Target。到 Projects 建一個開始。</Empty>
            ) : (
              <div className="-mx-4 -mb-4">
                {q.data.targets.map((t) => (
                  <TargetRow key={t.id} t={t} />
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
