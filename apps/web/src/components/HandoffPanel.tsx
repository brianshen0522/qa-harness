import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type {
  DetectedSecret,
  HandoffApplyMode,
  HandoffDocumentListItem,
  HandoffImportResult,
  HandoffPreview,
  HandoffPrompt,
  Role,
  Scope,
  SuggestedTestCase,
} from "../api/types";
import { Badge, Button, Card, Empty, ErrorText, Notice, Select, Spinner, Table, Textarea } from "./ui";
import { APPLY_MODES, APPLY_MODE_LABEL, formatDate, handoffSectionLabel, hasRole } from "../lib/roles";

/**
 * Spec §4.2 Context Handoff：產生交接 prompt → 貼上回傳文件 → 預覽解析結果 → 選套用方式。
 * The same panel serves both scopes; only the base path differs.
 */
export function HandoffPanel({
  scope,
  entityId,
  myRole,
  locked,
}: {
  scope: Scope;
  entityId: string;
  myRole: Role;
  locked?: boolean;
}) {
  const qc = useQueryClient();
  const base = scope === "project" ? `/projects/${entityId}` : `/targets/${entityId}`;
  const detailKey = scope === "project" ? ["projects", entityId] : ["targets", entityId];

  const isEditor = hasRole(myRole, "editor");
  const canApply = isEditor && !locked;

  const [content, setContent] = useState("");
  const [mode, setMode] = useState<HandoffApplyMode>("overwrite");
  const [imported, setImported] = useState<HandoffImportResult | null>(null);

  const prompt = useQuery({
    queryKey: ["handoff", scope, entityId, "prompt"],
    queryFn: () => api<HandoffPrompt>(`${base}/handoff/prompt`),
  });
  const documents = useQuery({
    queryKey: ["handoff", scope, entityId, "documents"],
    queryFn: () => api<HandoffDocumentListItem[]>(`${base}/handoff/documents`),
  });

  const preview = useMutation({
    mutationFn: () => api<HandoffPreview>(`${base}/handoff/preview`, { method: "POST", body: { content } }),
    onSuccess: (data) => {
      setImported(null);
      setMode(data.unparsable ? "attachment" : data.recommendedMode);
    },
  });
  const apply = useMutation({
    mutationFn: () => api<HandoffImportResult>(`${base}/handoff/import`, { method: "POST", body: { content, mode } }),
    onSuccess: (data) => {
      setImported(data);
      qc.invalidateQueries({ queryKey: detailKey });
      qc.invalidateQueries({ queryKey: ["handoff", scope, entityId, "documents"] });
      qc.invalidateQueries({ queryKey: ["discussion", scope, entityId] });
      if (scope === "project") qc.invalidateQueries({ queryKey: ["projects", entityId, "versions"] });
    },
  });

  const p = preview.data;
  const unparsable = p?.unparsable ?? false;
  useEffect(() => {
    if (unparsable) setMode("attachment");
  }, [unparsable]);

  return (
    <div className="space-y-4">
      {locked && <Notice>此 Target 正在執行中，執行期間無法套用交接文件。</Notice>}
      {!isEditor && <Notice tone="blue">你是檢視者，只能產生與複製交接 prompt，無法匯入文件。</Notice>}

      <Card title="① 產生交接 prompt">
        <p className="mb-3 text-xs text-gray-500">
          複製這段 prompt 貼給你的 coding agent（Claude Code、Cursor 等），請它依格式回傳一份 Markdown 交接文件。
        </p>
        {prompt.isPending && <Spinner />}
        <ErrorText error={prompt.error} />
        {prompt.data && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <Badge tone="blue">harness {prompt.data.harnessVersion}</Badge>
              <span>scope：{prompt.data.scope === "project" ? "Project" : "Target"}</span>
              {prompt.data.kind && <span>kind：{prompt.data.kind}</span>}
              <CopyButton text={prompt.data.prompt} />
            </div>
            <pre className="max-h-72 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
              {prompt.data.prompt}
            </pre>
            <div className="mt-3">
              <h3 className="mb-1 text-xs font-medium text-gray-600">agent 必須回報的 section</h3>
              <ul className="space-y-1">
                {prompt.data.sections.map((s) => (
                  <li key={s.title} className="text-xs text-gray-600">
                    <span className="font-medium text-gray-800">{handoffSectionLabel(s.title)}</span>
                    <span className="text-gray-400">（## {s.title}）</span>
                    <span className="block text-gray-500">{s.ask}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </Card>

      <Card title="② 貼上回傳文件">
        <Textarea
          rows={10}
          value={content}
          disabled={!canApply}
          placeholder={canApply ? "把 coding agent 回傳的 Markdown 文件貼在這裡…" : "無匯入權限。"}
          onChange={(e) => setContent(e.target.value)}
        />
        <div className="mt-2 flex items-center gap-2">
          <Button onClick={() => preview.mutate()} disabled={!canApply || !content.trim() || preview.isPending}>
            {preview.isPending ? "解析中…" : "預覽解析結果"}
          </Button>
          {content && (
            <Button
              variant="ghost"
              onClick={() => {
                setContent("");
                preview.reset();
                apply.reset();
                setImported(null);
              }}
            >
              清空
            </Button>
          )}
        </div>
        <ErrorText error={preview.error} />
      </Card>

      {p && (
        <Card title="③ 預覽與套用">
          <div className="space-y-4">
            {p.warnings.length > 0 && (
              <Notice>
                <ul className="list-inside list-disc space-y-0.5">
                  {p.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </Notice>
            )}

            {p.unparsable && (
              <Notice tone="red">
                這份文件解析不出任何已知 section，只能以「當作附件」匯入，之後可以在討論區讓 LLM 幫忙整理。
              </Notice>
            )}

            {p.detectedSecrets.length > 0 && <SecretsWarning secrets={p.detectedSecrets} />}

            {Object.keys(p.frontMatter).length > 0 && (
              <div className="flex flex-wrap gap-2 text-xs text-gray-500">
                {Object.entries(p.frontMatter).map(([k, v]) => (
                  <span key={k} className="rounded bg-gray-100 px-2 py-0.5">
                    {k}：{v}
                  </span>
                ))}
              </div>
            )}

            {p.missingSections.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-medium text-gray-600">缺少或仍是空白的 section</h3>
                <p className="text-xs text-gray-400">{p.missingSections.map((t) => handoffSectionLabel(t)).join("、")}</p>
              </div>
            )}

            <div>
              <h3 className="mb-1 text-xs font-medium text-gray-600">已辨識的 section（{Object.keys(p.sections).length}）</h3>
              {Object.keys(p.sections).length === 0 ? (
                <Empty>沒有辨識出任何 section。</Empty>
              ) : (
                <div className="space-y-1">
                  {Object.entries(p.sections).map(([key, body]) => (
                    <CollapsibleSection key={key} title={handoffSectionLabel(key)} subtitle={key} body={body} />
                  ))}
                </div>
              )}
            </div>

            {Object.keys(p.unknownSections).length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-medium text-gray-600">未知 section（原樣保留為描述文字）</h3>
                <div className="space-y-1">
                  {Object.entries(p.unknownSections).map(([title, body]) => (
                    <CollapsibleSection key={title} title={title} subtitle="未知 section" body={body} unknown />
                  ))}
                </div>
              </div>
            )}

            {p.suggestedTestCases.length > 0 && <TestCaseList cases={p.suggestedTestCases} />}

            <div>
              <h3 className="mb-1 text-xs font-medium text-gray-600">解析後的描述</h3>
              <pre className="max-h-72 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
                {p.renderedDescription || "（空白）"}
              </pre>
            </div>

            <div className="border-t border-gray-100 pt-3">
              <h3 className="mb-2 text-xs font-medium text-gray-600">套用方式</h3>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={mode}
                  disabled={!canApply || p.unparsable}
                  onChange={(e) => setMode(e.target.value as HandoffApplyMode)}
                  className="w-48"
                >
                  {APPLY_MODES.map((m) => (
                    <option key={m} value={m}>
                      {APPLY_MODE_LABEL[m]}
                    </option>
                  ))}
                </Select>
                <Button onClick={() => apply.mutate()} disabled={!canApply || apply.isPending}>
                  {apply.isPending ? "套用中…" : "套用"}
                </Button>
                <span className="text-xs text-gray-400">建議：{APPLY_MODE_LABEL[p.recommendedMode]}</span>
              </div>
              <p className="mt-2 text-xs text-gray-400">
                覆蓋描述：以解析結果取代現有描述。合併：接在現有描述之後。當作附件：不動描述，只把原始文件存成附件供討論區使用。
              </p>
              <ErrorText error={apply.error} />
              {imported && (
                <Notice tone="blue">
                  已以「{APPLY_MODE_LABEL[imported.document.applyMode]}」匯入。
                  {imported.document.appliedToDescriptionVersion !== null
                    ? `描述已更新為 v${imported.document.appliedToDescriptionVersion}。`
                    : "原始文件已存為附件，描述未變更。"}
                </Notice>
              )}
            </div>
          </div>
        </Card>
      )}

      <Card title="匯入紀錄">
        {documents.isPending && <Spinner />}
        <ErrorText error={documents.error} />
        {documents.data && documents.data.length === 0 && <Empty>尚無匯入紀錄。</Empty>}
        {documents.data && documents.data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <th>時間</th>
                <th>套用方式</th>
                <th>harness 版本</th>
                <th>套用到描述版本</th>
              </tr>
            </thead>
            <tbody>
              {documents.data.map((doc) => (
                <tr key={doc.id}>
                  <td className="text-gray-500">{formatDate(doc.importedAt)}</td>
                  <td>{APPLY_MODE_LABEL[doc.applyMode]}</td>
                  <td className="text-gray-500">{doc.harnessVersion}</td>
                  <td className="text-gray-500">
                    {doc.appliedToDescriptionVersion === null ? "－" : `v${doc.appliedToDescriptionVersion}`}
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  return (
    <span className="flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          setError(null);
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          } catch {
            setError("複製失敗，請手動選取 prompt 內容複製。");
          }
        }}
      >
        {copied ? "已複製" : "複製"}
      </Button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

function SecretsWarning({ secrets }: { secrets: DetectedSecret[] }) {
  return (
    <Notice tone="red">
      <p className="font-medium">偵測到疑似憑證，請改存到 Target 的加密憑證欄位，不要留在描述中</p>
      <ul className="mt-1 space-y-0.5">
        {secrets.map((s, i) => (
          <li key={`${s.key}-${s.line}-${i}`} className="text-xs">
            第 {s.line} 行 · <code className="rounded bg-white/60 px-1">{s.key}</code> · {s.preview}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

function TestCaseList({ cases }: { cases: SuggestedTestCase[] }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium text-gray-600">建議 test case（{cases.length}）</h3>
      <p className="mb-2 text-xs text-gray-400">這些會在後續作為 test case 生成 pipeline 的種子，目前僅供檢視。</p>
      <ul className="space-y-2">
        {cases.map((c, i) => (
          <li key={`${c.title}-${i}`} className="rounded-md border border-gray-200 p-2">
            <p className="text-sm font-medium text-gray-800">{c.title}</p>
            {c.steps.length > 0 && (
              <ol className="mt-1 list-inside list-decimal space-y-0.5 text-xs text-gray-600">
                {c.steps.map((s, j) => (
                  <li key={j}>{s}</li>
                ))}
              </ol>
            )}
            {c.expected && <p className="mt-1 text-xs text-gray-500">預期結果：{c.expected}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CollapsibleSection({
  title,
  subtitle,
  body,
  unknown,
}: {
  title: string;
  subtitle: string;
  body: string;
  unknown?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-gray-200">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50"
      >
        <span className="flex items-center gap-2">
          <span className="font-medium text-gray-800">{title}</span>
          {unknown ? <Badge tone="amber">未知 section</Badge> : <span className="text-gray-400">{subtitle}</span>}
        </span>
        <span className="text-gray-400">{open ? "收合" : "展開"}</span>
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto border-t border-gray-100 bg-gray-50 p-3 text-xs text-gray-700">{body}</pre>
      )}
    </div>
  );
}
