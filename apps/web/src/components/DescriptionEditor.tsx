import { useEffect, useState } from "react";
import { Button, ErrorText, Textarea } from "./ui";

export function DescriptionEditor({
  value,
  version,
  canEdit,
  disabled,
  onSave,
  saving,
  error,
}: {
  value: string | null;
  version: number;
  canEdit: boolean;
  disabled?: boolean;
  onSave: (content: string) => void;
  saving: boolean;
  error: unknown;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => {
    setDraft(value ?? "");
  }, [value, version]);

  const dirty = draft !== (value ?? "");
  const editable = canEdit && !disabled;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
        <span>目前版本：v{version}</span>
        {dirty && editable && <span className="text-amber-600">尚未儲存</span>}
      </div>
      {editable ? (
        <>
          <Textarea rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="描述這個項目的目的、功能、使用情境…" />
          <div className="mt-2 flex items-center gap-2">
            <Button onClick={() => onSave(draft)} disabled={!dirty || saving}>
              {saving ? "儲存中…" : "儲存"}
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft(value ?? "")} disabled={saving}>
                還原
              </Button>
            )}
          </div>
          <ErrorText error={error} />
        </>
      ) : (
        <pre className="whitespace-pre-wrap rounded-md bg-gray-50 p-3 font-sans text-sm text-gray-700">{value || "（尚無描述）"}</pre>
      )}
    </div>
  );
}
