import { useEffect, useState } from "react";
import { Button, ErrorText, Textarea } from "./ui";
import { Markdown } from "./Markdown";

export function DescriptionEditor({
  value,
  version,
  canEdit,
  disabled,
  onSave,
  saving,
  error,
  historyHref,
}: {
  value: string | null;
  version: number;
  canEdit: boolean;
  disabled?: boolean;
  onSave: (content: string) => void;
  saving: boolean;
  error: unknown;
  /** Where to see how the description changed over versions (the 變更 tab). */
  historyHref?: string;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setDraft(value ?? "");
  }, [value, version]);

  const dirty = draft !== (value ?? "");
  const editable = canEdit && !disabled;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
        <span className="flex items-center gap-2">
          <span>目前版本：v{version}</span>
          {historyHref && version > 0 && <a href={historyHref} className="text-blue-600 hover:underline dark:text-blue-400">版本沿革</a>}
          {dirty && editable && <span className="text-amber-600 dark:text-amber-400">尚未儲存</span>}
        </span>
        <span className="flex items-center gap-1">
          {editable && (
            <div className="inline-flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-700">
              <button type="button" onClick={() => setMode("edit")} className={`px-2 py-0.5 ${mode === "edit" ? "bg-gray-200 dark:bg-gray-700" : ""}`}>編輯</button>
              <button type="button" onClick={() => setMode("preview")} className={`px-2 py-0.5 ${mode === "preview" ? "bg-gray-200 dark:bg-gray-700" : ""}`}>預覽</button>
            </div>
          )}
          <button type="button" onClick={() => setExpanded((e) => !e)} className="rounded-md border border-gray-300 px-2 py-0.5 dark:border-gray-700">{expanded ? "縮小" : "放大"}</button>
        </span>
      </div>

      {editable && mode === "edit" ? (
        <>
          <Textarea rows={expanded ? 30 : 10} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="描述這個項目的目的、功能、使用情境…（支援 Markdown）" className="font-mono text-xs" />
          <div className="mt-2 flex items-center gap-2">
            <Button onClick={() => onSave(draft)} disabled={!dirty || saving}>{saving ? "儲存中…" : "儲存"}</Button>
            {dirty && <Button variant="ghost" onClick={() => setDraft(value ?? "")} disabled={saving}>還原</Button>}
          </div>
          <ErrorText error={error} />
        </>
      ) : (value || draft) ? (
        <div className={`rounded-md border border-gray-200 bg-gray-50/60 p-3 dark:border-gray-700 dark:bg-gray-800/40 ${expanded ? "" : "max-h-96 overflow-y-auto"}`}>
          <Markdown>{editable ? draft : value ?? ""}</Markdown>
        </div>
      ) : (
        <p className="rounded-md bg-gray-50 p-3 text-sm text-gray-400 dark:bg-gray-800/50 dark:text-gray-500">（尚無描述）</p>
      )}
    </div>
  );
}
