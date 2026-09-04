import { checklistFor, initialCompleteness, mergeCompleteness, PROJECT_CHECKLIST } from "./checklists";

describe("checklists", () => {
  it("uses the project list for project scope and the kind-specific list for targets", () => {
    expect(checklistFor("project").map((i) => i.key)).toContain("test_surfaces");
    expect(checklistFor("target", "api").map((i) => i.key)).toEqual(
      ["endpoints", "auth", "test_accounts", "data_dependencies"],
    );
    expect(checklistFor("target", "web").map((i) => i.key)).toContain("selectors");
    expect(checklistFor("target", "desktop").map((i) => i.key)).toContain("window_structure");
  });

  it("starts every item at unknown", () => {
    const c = initialCompleteness(PROJECT_CHECKLIST);
    expect(new Set(Object.values(c))).toEqual(new Set(["unknown"]));
    expect(Object.keys(c)).toHaveLength(PROJECT_CHECKLIST.length);
  });

  it("merge keeps unreported items, applies known ones, and ignores junk", () => {
    const items = checklistFor("target", "api");
    const current = { endpoints: "clear" as const, auth: "partial" as const };
    const merged = mergeCompleteness(items, current, {
      auth: "clear",
      not_a_key: "clear",
      test_accounts: "banana",
    } as never);
    expect(merged).toEqual({
      endpoints: "clear",
      auth: "clear",
      test_accounts: "unknown",
      data_dependencies: "unknown",
    });
    expect(merged).not.toHaveProperty("not_a_key");
  });
});
