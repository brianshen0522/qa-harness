import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { AuditEntry, Usage } from "../../api/types";
import { Badge, Card, Empty, ErrorText, Spinner, Table } from "../../components/ui";
import { formatDate } from "../../lib/roles";

export default function AdminAuditPage() {
  const usage = useQuery({ queryKey: ["admin", "usage"], queryFn: () => api<Usage>("/admin/usage") });
  const audit = useQuery({ queryKey: ["admin", "audit"], queryFn: () => api<AuditEntry[]>("/admin/audit?limit=100") });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold">稽核與用量</h1>

      <Card title="估算成本與用量">
        {usage.isPending && <Spinner />}
        {usage.data && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-2xl font-semibold text-gray-800">${usage.data.totalCostUsd.toFixed(2)}</span>
              <span className="text-xs text-gray-500">估算總成本（USD，依已知模型單價；本地/未知模型計為 0）</span>
            </div>
            {usage.data.models.length > 0 && (
              <Table>
                <thead><tr><th>模型</th><th>呼叫數</th><th>輸入 tokens</th><th>輸出 tokens</th><th>估算成本</th></tr></thead>
                <tbody>
                  {usage.data.models.map((m, i) => (
                    <tr key={i}>
                      <td className="font-mono text-xs">{m.model ?? "-"}</td>
                      <td className="text-xs">{m.calls}</td>
                      <td className="text-xs">{m.inputTokens.toLocaleString()}</td>
                      <td className="text-xs">{m.outputTokens.toLocaleString()}</td>
                      <td className="text-xs">{m.costUsd > 0 ? `$${m.costUsd.toFixed(3)}` : <span className="text-gray-400">免費/未知</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {usage.data.byProject.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-gray-500">各 Project 執行量</p>
                <Table>
                  <thead><tr><th>Project</th><th>Run 數</th><th>步數</th></tr></thead>
                  <tbody>
                    {usage.data.byProject.map((p) => (
                      <tr key={p.projectId}><td>{p.name}</td><td className="text-xs">{p.runs}</td><td className="text-xs">{p.steps.toLocaleString()}</td></tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card title="LLM 用量摘要（依用途）">
        {usage.isPending && <Spinner />}
        <ErrorText error={usage.error} />
        {usage.data && usage.data.byPurpose.length === 0 && <Empty>尚無用量紀錄。</Empty>}
        {usage.data && usage.data.byPurpose.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>用途</th>
                <th>結果</th>
                <th>次數</th>
                <th>輸入 tokens</th>
                <th>輸出 tokens</th>
              </tr>
            </thead>
            <tbody>
              {usage.data.byPurpose.map((r, i) => (
                <tr key={i}>
                  <td>{r.purpose}</td>
                  <td>
                    <OutcomeBadge outcome={r.outcome} />
                  </td>
                  <td>{r._count._all}</td>
                  <td>{r._sum.inputTokens ?? 0}</td>
                  <td>{r._sum.outputTokens ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="最近 LLM 呼叫">
        {usage.data && usage.data.recent.length === 0 && <Empty>尚無紀錄。</Empty>}
        {usage.data && usage.data.recent.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>時間</th>
                <th>用途</th>
                <th>Schema</th>
                <th>模型</th>
                <th>嘗試</th>
                <th>結果</th>
                <th>Tokens（入/出）</th>
                <th>耗時</th>
                <th>錯誤</th>
              </tr>
            </thead>
            <tbody>
              {usage.data.recent.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-gray-500">{formatDate(r.createdAt)}</td>
                  <td>{r.purpose}</td>
                  <td className="text-gray-500">{r.schemaName || "-"}</td>
                  <td>{r.model || "-"}</td>
                  <td>{r.attempt}</td>
                  <td>
                    <OutcomeBadge outcome={r.outcome} />
                  </td>
                  <td>
                    {r.inputTokens ?? 0} / {r.outputTokens ?? 0}
                  </td>
                  <td>{r.durationMs != null ? `${r.durationMs} ms` : "-"}</td>
                  <td className="max-w-xs truncate text-xs text-red-600" title={r.errorMessage ?? ""}>
                    {r.errorMessage || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="稽核紀錄（最近 100 筆）">
        {audit.isPending && <Spinner />}
        <ErrorText error={audit.error} />
        {audit.data && audit.data.length === 0 && <Empty>尚無稽核紀錄。</Empty>}
        {audit.data && audit.data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>時間</th>
                <th>操作者</th>
                <th>動作</th>
                <th>對象</th>
                <th>內容</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.map((a) => (
                <AuditRow key={a.id} entry={a} />
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const tone = outcome === "success" || outcome === "ok" ? "green" : outcome.includes("fallback") ? "amber" : "red";
  return <Badge tone={tone}>{outcome}</Badge>;
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const payload = entry.payload == null ? "" : JSON.stringify(entry.payload, null, 2);
  return (
    <tr>
      <td className="whitespace-nowrap text-gray-500">{formatDate(entry.createdAt)}</td>
      <td>
        <Badge tone={entry.actorType === "admin" ? "amber" : "gray"}>{entry.actorType}</Badge>
        <span className="ml-1 text-xs text-gray-400">{entry.actorId ?? ""}</span>
      </td>
      <td className="font-medium">{entry.action}</td>
      <td className="text-gray-600">{entry.target || "-"}</td>
      <td>
        {payload ? (
          <>
            <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => setOpen((o) => !o)}>
              {open ? "收合" : "展開"}
            </button>
            {open && <pre className="mt-1 max-w-lg overflow-x-auto rounded bg-gray-50 p-2 text-xs">{payload}</pre>}
          </>
        ) : (
          <span className="text-gray-400">-</span>
        )}
      </td>
    </tr>
  );
}
