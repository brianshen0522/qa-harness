import { CONFIG_FIELDS } from "../lib/roles";
import type { TargetConfig, TargetKind } from "../api/types";
import { Field, Input, Select, Textarea } from "./ui";

/** Common viewport sizes so people don't hand-type "1280x800" and typo it. */
const VIEWPORT_PRESETS: { value: string; label: string }[] = [
  { value: "1920x1080", label: "桌機（1920×1080）" },
  { value: "1440x900", label: "筆電（1440×900）" },
  { value: "1280x800", label: "桌機小（1280×800）" },
  { value: "768x1024", label: "平板（768×1024）" },
  { value: "390x844", label: "手機（390×844）" },
];

function ViewportField({ value, disabled, onChange }: { value: string; disabled?: boolean; onChange: (v: string) => void }) {
  const isPreset = VIEWPORT_PRESETS.some((p) => p.value === value);
  const custom = value !== "" && !isPreset;
  return (
    <Field label="Viewport" hint="測試時瀏覽器視窗大小">
      <div className="space-y-2">
        <Select disabled={disabled} value={custom ? "__custom" : value} onChange={(e) => onChange(e.target.value === "__custom" ? value || "" : e.target.value)}>
          {VIEWPORT_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          <option value="__custom">自訂…</option>
        </Select>
        {custom && (
          <Input disabled={disabled} value={value} placeholder="寬x高，例如 1280x800" onChange={(e) => onChange(e.target.value)} />
        )}
      </div>
    </Field>
  );
}

/** Config is edited as a flat string map; `headers` is JSON text. */
export type ConfigDraft = Record<string, string>;

export function configToDraft(kind: TargetKind, config: TargetConfig | null | undefined): ConfigDraft {
  const draft: ConfigDraft = {};
  for (const f of CONFIG_FIELDS[kind]) {
    const v = config?.[f.key];
    if (f.json) draft[f.key] = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v, null, 2);
    else draft[f.key] = v == null ? "" : String(v);
  }
  return draft;
}

/** Throws an Error with a user-facing message when JSON fields are invalid. */
export function draftToConfig(kind: TargetKind, draft: ConfigDraft): TargetConfig {
  const config: TargetConfig = {};
  for (const f of CONFIG_FIELDS[kind]) {
    const raw = (draft[f.key] ?? "").trim();
    if (f.json) {
      if (!raw) {
        config[f.key] = {};
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`${f.label} 不是合法的 JSON`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${f.label} 必須是 JSON 物件`);
      config[f.key] = parsed;
    } else {
      config[f.key] = raw;
    }
  }
  return config;
}

export function ConfigForm({
  kind,
  draft,
  onChange,
  disabled,
}: {
  kind: TargetKind;
  draft: ConfigDraft;
  onChange: (next: ConfigDraft) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      {CONFIG_FIELDS[kind].map((f) =>
        f.key === "viewport" ? (
          <ViewportField key={f.key} disabled={disabled} value={draft[f.key] ?? ""} onChange={(v) => onChange({ ...draft, [f.key]: v })} />
        ) : f.json ? (
          <Field key={f.key} label={f.label}>
            <Textarea
              rows={4}
              disabled={disabled}
              value={draft[f.key] ?? ""}
              placeholder={f.placeholder}
              onChange={(e) => onChange({ ...draft, [f.key]: e.target.value })}
            />
          </Field>
        ) : (
          <Field key={f.key} label={f.label}>
            <Input
              disabled={disabled}
              value={draft[f.key] ?? ""}
              placeholder={f.placeholder}
              onChange={(e) => onChange({ ...draft, [f.key]: e.target.value })}
            />
          </Field>
        ),
      )}
    </div>
  );
}
