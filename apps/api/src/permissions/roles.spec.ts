import { effectiveTargetRole, validateOverride, atLeast, maxRole } from "./roles";

describe("role rules", () => {
  it("rule 1/5: project role is the default target role; effective = max", () => {
    expect(effectiveTargetRole("viewer", null)).toBe("viewer");
    expect(effectiveTargetRole("viewer", "editor")).toBe("editor");
    expect(effectiveTargetRole("editor", "viewer")).toBe("editor");
    expect(effectiveTargetRole("owner", "viewer")).toBe("owner");
  });
  it("rule 4: non-members get nothing even with an override", () => {
    expect(effectiveTargetRole(null, "owner")).toBeNull();
  });
  it("rule 2: override cannot lower below project role", () => {
    expect(validateOverride("editor", "viewer").ok).toBe(false);
    expect(validateOverride("editor", "editor").ok).toBe(true);
    expect(validateOverride("viewer", "owner").ok).toBe(true);
  });
  it("rule 3: project owner cannot be overridden", () => {
    expect(validateOverride("owner", "owner").ok).toBe(false);
  });
  it("rule 4: only project members can be assigned", () => {
    expect(validateOverride(null, "viewer").ok).toBe(false);
  });
  it("atLeast / maxRole", () => {
    expect(atLeast("editor", "viewer")).toBe(true);
    expect(atLeast("viewer", "editor")).toBe(false);
    expect(atLeast(null, "viewer")).toBe(false);
    expect(maxRole(null, null)).toBeNull();
    expect(maxRole("viewer", null)).toBe("viewer");
  });
});
