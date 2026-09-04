import { caseDiff, lineDiff, mergeSnapshot, type CaseSnapshot } from "./change-diff";

describe("lineDiff", () => {
  it("is empty when nothing changed", () => {
    expect(lineDiff("a\nb", "a\nb")).toBe("");
  });

  it("marks added and removed lines and keeps surrounding context", () => {
    const out = lineDiff("一\n二\n三\n四\n五", "一\n二\n改過的三\n四\n五");
    expect(out).toContain("- 三");
    expect(out).toContain("+ 改過的三");
    expect(out).toContain("  二");
    expect(out).toContain("  四");
  });

  it("splits distant changes into separate hunks", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 1", "LINE 1").replace("line 28", "LINE 28");
    const out = lineDiff(before, after);
    expect(out).toContain("…");
    expect(out).not.toContain("line 14");
  });

  it("treats an empty side as a whole-text insert or delete", () => {
    expect(lineDiff("", "新的一行")).toBe("+ 新的一行");
    expect(lineDiff("舊的一行", "")).toContain("- 舊的一行");
  });
});

const base: CaseSnapshot = {
  title: "登入成功",
  precondition: "已有帳號",
  steps: ["開啟登入頁", "輸入帳密", "按登入"],
  expected: "導向首頁",
  priority: "P0",
  type: "happy",
  featureName: "登入",
};

describe("caseDiff", () => {
  it("says nothing when the case is unchanged", () => {
    expect(caseDiff(base, { ...base })).toBe("");
  });

  it("reports each changed field with its label", () => {
    const out = caseDiff(base, { ...base, expected: "導向儀表板", priority: "P1" });
    expect(out).toContain("【預期結果】");
    expect(out).toContain("- 導向首頁");
    expect(out).toContain("+ 導向儀表板");
    expect(out).toContain("【優先級】");
    expect(out).not.toContain("【標題】");
  });

  it("diffs steps line by line rather than as one blob", () => {
    const out = caseDiff(base, { ...base, steps: ["開啟登入頁", "輸入帳密", "輸入 OTP", "按登入"] });
    expect(out).toContain("【步驟】");
    expect(out).toContain("+ 輸入 OTP");
    expect(out).not.toContain("- 開啟登入頁");
  });

  it("shows （空）rather than a blank line for a field that was empty", () => {
    const out = caseDiff({ ...base, precondition: "" }, { ...base, precondition: "已登入" });
    expect(out).toContain("- （空）");
    expect(out).toContain("+ 已登入");
  });
});

describe("mergeSnapshot", () => {
  it("returns the base untouched when there is no hand edit", () => {
    expect(mergeSnapshot(base, undefined)).toBe(base);
  });

  it("lets a reviewer override single fields", () => {
    const merged = mergeSnapshot(base, { expected: "看到歡迎訊息", steps: ["一步到位"] });
    expect(merged.expected).toBe("看到歡迎訊息");
    expect(merged.steps).toEqual(["一步到位"]);
    expect(merged.title).toBe(base.title);
  });

  it("allows clearing the feature, which undefined would not", () => {
    expect(mergeSnapshot(base, { featureName: null }).featureName).toBeNull();
    expect(mergeSnapshot(base, {}).featureName).toBe("登入");
  });
});
