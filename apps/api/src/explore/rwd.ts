import type { PageProbe } from "../sandbox/computer.service";

export interface Breakpoint {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
}

/** The usual phone / tablet / desktop split; overridable per run. */
export const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { name: "手機直式", width: 390, height: 844, mobile: true },
  { name: "平板", width: 820, height: 1180, mobile: true },
  { name: "桌機", width: 1280, height: 800, mobile: false },
];

export interface RwdIssue {
  kind: "horizontal_overflow" | "empty_render";
  severity: "major" | "minor" | "info";
  detail: string;
}

/**
 * Deterministic layout signals from the DOM probe. This is stage C's cheap
 * filter: only pages that trip one of these are worth a model's attention, so
 * the vision budget is not spent confirming that most pages are fine.
 */
export function rwdIssues(probe: PageProbe, bp: Breakpoint): RwdIssue[] {
  const issues: RwdIssue[] = [];
  // A few px of overflow is rounding; a scrollbar's worth is a real sideways scroll.
  const overflow = probe.scrollWidth - probe.clientWidth;
  if (overflow > 16) {
    issues.push({
      kind: "horizontal_overflow",
      severity: overflow > bp.width * 0.15 ? "major" : "minor",
      detail: `內容寬度 ${probe.scrollWidth}px 超出可視寬度 ${probe.clientWidth}px（多出 ${overflow}px），在 ${bp.width}px 寬時會橫向捲動。`,
    });
  }
  if (probe.textLength < 5 && bp.mobile) {
    issues.push({
      kind: "empty_render",
      severity: "info",
      detail: `在 ${bp.name}（${bp.width}px）幾乎沒有可見文字，可能是版面在小螢幕下沒渲染出來。`,
    });
  }
  return issues;
}
