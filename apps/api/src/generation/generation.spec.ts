import {
  dedupeCases, dedupeFeatures, normaliseCases, redactConfig, snapshot,
  type GeneratedCase,
} from "./generation.service";
import type { FeatureList, TestCaseOutput } from "@qa-harness/schemas";

const gen = (over: Partial<GeneratedCase>): GeneratedCase => ({
  feature_ref: "登入", title: "t", precondition: "", steps: ["a"],
  expected: "e", priority: "P2", type: "happy", ...over,
});

describe("dedupeFeatures", () => {
  it("drops repeats that differ only by case or punctuation, keeping the first", () => {
    const list = {
      schema_version: "1.0",
      features: [
        { name: "使用者登入", description: "帳密登入" },
        { name: "使用者登入 ", description: "重複" },
        { name: "User Login", description: "英文" },
        { name: "user login!", description: "重複" },
        { name: "  ", description: "空的" },
      ],
    } as FeatureList;
    expect(dedupeFeatures(list)).toEqual([
      { name: "使用者登入", description: "帳密登入" },
      { name: "User Login", description: "英文" },
    ]);
  });

  it("survives a model that returns nothing", () => {
    expect(dedupeFeatures({ schema_version: "1.0", features: [] } as FeatureList)).toEqual([]);
  });
});

describe("normaliseCases", () => {
  it("pins every case to the feature being generated and trims the content", () => {
    const out = {
      schema_version: "1.0",
      cases: [
        { feature_ref: "亂寫的", title: "  登入成功  ", precondition: " 有帳號 ", steps: [" 開頁面 ", "送出"], expected: " 進入首頁 ", priority: "P0", type: "happy" },
      ],
    } as TestCaseOutput;
    expect(normaliseCases(out, "使用者登入")[0]).toEqual({
      feature_ref: "使用者登入", title: "登入成功", precondition: "有帳號",
      steps: ["開頁面", "送出"], expected: "進入首頁", priority: "P0", type: "happy",
    });
  });

  it("discards cases with no title, no steps or no expected result", () => {
    const out = {
      schema_version: "1.0",
      cases: [
        { feature_ref: "x", title: "", precondition: "", steps: ["a"], expected: "e", priority: "P1", type: "happy" },
        { feature_ref: "x", title: "t", precondition: "", steps: [], expected: "e", priority: "P1", type: "happy" },
        { feature_ref: "x", title: "t", precondition: "", steps: ["a"], expected: "  ", priority: "P1", type: "happy" },
        { feature_ref: "x", title: "好的", precondition: "", steps: ["a"], expected: "e", priority: "P1", type: "edge" },
      ],
    } as TestCaseOutput;
    expect(normaliseCases(out, "f").map((c) => c.title)).toEqual(["好的"]);
  });
});

describe("dedupeCases", () => {
  it("removes a reworded duplicate across features", () => {
    const expected = "導向首頁並顯示使用者名稱";
    const { kept, dropped } = dedupeCases(
      [
        gen({ title: "使用正確帳號密碼登入成功", expected }),
        gen({ title: "使用正確的帳號密碼登入成功", expected, feature_ref: "首頁" }),
        gen({ title: "使用錯誤密碼登入失敗", expected: "顯示帳號或密碼錯誤" }),
      ],
      ["登入", "首頁"],
    );
    expect(dropped).toBe(1);
    expect(kept.map((c) => c.title)).toEqual(["使用正確帳號密碼登入成功", "使用錯誤密碼登入失敗"]);
  });

  it("keeps cases that differ only by verb, which the title alone cannot separate", () => {
    const { kept, dropped } = dedupeCases(
      [
        gen({ title: "Create todo succeeds", expected: "Returns 201 and the created todo" }),
        gen({ title: "Delete todo succeeds", expected: "Returns 204 and the todo is gone" }),
      ],
      ["待辦"],
    );
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(2);
  });

  it("keeps genuinely different cases in the same feature", () => {
    const { kept, dropped } = dedupeCases(
      [
        gen({ title: "新增待辦", expected: "清單多一筆" }),
        gen({ title: "刪除待辦", expected: "清單少一筆" }),
        gen({ title: "編輯待辦標題", expected: "清單顯示新標題" }),
        gen({ title: "標題為空時顯示錯誤", expected: "顯示「標題必填」" }),
        gen({ title: "標題超過長度上限時顯示錯誤", expected: "顯示「標題過長」" }),
      ],
      ["登入"],
    );
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(5);
  });

  it("treats an English singular/plural rewrite as the same case", () => {
    const { dropped } = dedupeCases(
      [
        gen({ title: "Login with valid credentials", expected: "Returns 200 and a token" }),
        gen({ title: "Login with valid credential", expected: "Returns 200 and a token" }),
      ],
      ["登入"],
    );
    expect(dropped).toBe(1);
  });

  it("orders by feature, then priority, then type", () => {
    const { kept } = dedupeCases(
      [
        gen({ feature_ref: "B", title: "b-p0", priority: "P0" }),
        gen({ feature_ref: "A", title: "a-p2-negative", priority: "P2", type: "negative" }),
        gen({ feature_ref: "A", title: "a-p2-happy", priority: "P2", type: "happy" }),
        gen({ feature_ref: "A", title: "a-p0", priority: "P0" }),
      ],
      ["A", "B"],
    );
    expect(kept.map((c) => c.title)).toEqual(["a-p0", "a-p2-happy", "a-p2-negative", "b-p0"]);
  });

  it("puts cases with an unknown feature last instead of dropping them", () => {
    const { kept } = dedupeCases(
      [gen({ feature_ref: "不存在", title: "orphan" }), gen({ feature_ref: "A", title: "known" })],
      ["A"],
    );
    expect(kept.map((c) => c.title)).toEqual(["known", "orphan"]);
  });
});

describe("redactConfig", () => {
  it("masks credential-looking values wherever they sit", () => {
    const out = redactConfig({
      base_url: "http://localhost:8080",
      headers: { Authorization: "Bearer sk-live-123", "X-Trace": "on" },
      nested: [{ api_key: "abcdef" }],
      viewport: "1280x800",
    });
    expect(out).toEqual({
      base_url: "http://localhost:8080",
      headers: { Authorization: "****（已遮蔽）", "X-Trace": "on" },
      nested: [{ api_key: "****（已遮蔽）" }],
      viewport: "1280x800",
    });
    expect(JSON.stringify(out)).not.toContain("sk-live-123");
  });

  it("leaves a config with nothing sensitive untouched", () => {
    const config = { url: "http://localhost:3000", viewport: "1280x800" };
    expect(redactConfig(config)).toEqual(config);
  });
});

describe("snapshot", () => {
  it("captures the fields a version needs and nothing else", () => {
    expect(
      snapshot({
        title: "t", precondition: "p", steps: ["a"], expected: "e",
        priority: "P1", type: "edge", featureId: "f1",
      }),
    ).toEqual({ title: "t", precondition: "p", steps: ["a"], expected: "e", priority: "P1", type: "edge", featureId: "f1" });
  });
});
