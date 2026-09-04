import { CONFIG_FIELDS } from "../lib/roles";
import type { TargetConfig, TargetKind } from "../api/types";
import { Field, Input, Textarea } from "./ui";

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
        f.json ? (
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
