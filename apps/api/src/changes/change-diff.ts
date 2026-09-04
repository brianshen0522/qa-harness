/**
 * Diffing for change proposals (§4.4: 修改型變動必須顯示 diff，不只給新版本).
 *
 * The model is asked for a diff too, but the server computes its own from the
 * stored "before" and the proposed "after": that is the pair we will actually
 * apply, so it is the pair the reviewer has to see.
 */

/** Longest-common-subsequence line diff, rendered as a unified-style hunk list. */
export function lineDiff(before: string, after: string, context = 2): string {
  // An empty text is no lines at all, not one blank line: otherwise adding a
  // first description shows a spurious "- " deletion above it.
  const a = before ? before.replace(/\r\n/g, "\n").split("\n") : [];
  const b = after ? after.replace(/\r\n/g, "\n").split("\n") : [];
  if (before === after) return "";

  const ops = diffLines(a, b);
  const hunks: string[] = [];
  let current: string[] | null = null;
  let pending = 0; // trailing context still allowed in the open hunk

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === "same") {
      if (!current) continue;
      if (pending > 0) {
        current.push(`  ${op.line}`);
        pending--;
        if (pending === 0) {
          // Leave the hunk open only if another change is close enough to join it.
          const next = ops.slice(i + 1, i + 1 + context + 1).findIndex((o) => o.kind !== "same");
          if (next === -1) {
            hunks.push(current.join("\n"));
            current = null;
          } else {
            pending = context;
          }
        }
      }
      continue;
    }
    if (!current) {
      current = [];
      // Lead-in context.
      for (let k = Math.max(0, i - context); k < i; k++) {
        if (ops[k].kind === "same") current.push(`  ${ops[k].line}`);
      }
    }
    pending = context;
    current.push(`${op.kind === "add" ? "+ " : "- "}${op.line}`);
  }
  if (current) hunks.push(current.join("\n"));
  return hunks.join("\n…\n");
}

type LineOp = { kind: "same" | "add" | "del"; line: string };

/** Classic LCS table. Descriptions are at most a few hundred lines, so O(n·m) is fine. */
function diffLines(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  // Guard against a pathological input rather than allocating gigabytes.
  if (n * m > 4_000_000) {
    return [
      ...a.map((line): LineOp => ({ kind: "del", line })),
      ...b.map((line): LineOp => ({ kind: "add", line })),
    ];
  }
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", line: a[i++] });
    } else {
      out.push({ kind: "add", line: b[j++] });
    }
  }
  while (i < n) out.push({ kind: "del", line: a[i++] });
  while (j < m) out.push({ kind: "add", line: b[j++] });
  return out;
}

export interface CaseSnapshot {
  title: string;
  precondition: string;
  steps: string[];
  expected: string;
  priority: string;
  type: string;
  featureName: string | null;
  status?: string;
}

const FIELD_LABELS: Record<keyof CaseSnapshot, string> = {
  title: "標題",
  precondition: "前置條件",
  steps: "步驟",
  expected: "預期結果",
  priority: "優先級",
  type: "類型",
  featureName: "所屬功能",
  status: "狀態",
};

/**
 * Field-level diff for a test case. A whole-text diff of a case reads badly:
 * what the reviewer wants to know is which field moved and how.
 */
export function caseDiff(before: CaseSnapshot, after: CaseSnapshot): string {
  const parts: string[] = [];
  for (const key of Object.keys(FIELD_LABELS) as (keyof CaseSnapshot)[]) {
    const b = before[key];
    const a = after[key];
    if (b === undefined && a === undefined) continue;
    if (key === "steps") {
      const bs = (b as string[] | undefined) ?? [];
      const as = (a as string[] | undefined) ?? [];
      if (bs.join("\n") === as.join("\n")) continue;
      parts.push(`【${FIELD_LABELS[key]}】\n${lineDiff(bs.join("\n"), as.join("\n"), 1)}`);
      continue;
    }
    const bt = (b as string | null | undefined) ?? "";
    const at = (a as string | null | undefined) ?? "";
    if (bt === at) continue;
    parts.push(
      bt.includes("\n") || at.includes("\n")
        ? `【${FIELD_LABELS[key]}】\n${lineDiff(bt, at, 1)}`
        : `【${FIELD_LABELS[key]}】\n- ${bt || "（空）"}\n+ ${at || "（空）"}`,
    );
  }
  return parts.join("\n");
}

/** Fields the reviewer edited by hand, merged over what the model proposed. */
export function mergeSnapshot(base: CaseSnapshot, patch: Partial<CaseSnapshot> | undefined): CaseSnapshot {
  if (!patch) return base;
  return {
    title: patch.title ?? base.title,
    precondition: patch.precondition ?? base.precondition,
    steps: patch.steps ?? base.steps,
    expected: patch.expected ?? base.expected,
    priority: patch.priority ?? base.priority,
    type: patch.type ?? base.type,
    featureName: patch.featureName !== undefined ? patch.featureName : base.featureName,
    status: patch.status ?? base.status,
  };
}
