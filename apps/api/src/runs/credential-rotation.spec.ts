import {
  ROTATION_SUFFIX, rotationPlaceholderKey, isRotationPlaceholderKey,
  generateSecret, usedRotationKeys, httpStatusOf, isAppliedStatus,
} from "./credential-rotation";

describe("rotation placeholder naming", () => {
  it("derives and recognises the {{key__next}} name", () => {
    const k = rotationPlaceholderKey("user_pw");
    expect(k).toBe(`user_pw${ROTATION_SUFFIX}`);
    expect(isRotationPlaceholderKey(k)).toBe(true);
    expect(isRotationPlaceholderKey("user_pw")).toBe(false);
    expect(isRotationPlaceholderKey(ROTATION_SUFFIX)).toBe(false); // suffix alone is not a real key
  });
});

describe("generateSecret", () => {
  it("always covers upper, lower, digit and symbol", () => {
    for (let i = 0; i < 200; i++) {
      const s = generateSecret();
      expect(s).toMatch(/[A-Z]/);
      expect(s).toMatch(/[a-z]/);
      expect(s).toMatch(/[0-9]/);
      expect(s).toMatch(/[!@#$%*_-]/);
    }
  });
  it("honours a max length cap while keeping every class", () => {
    for (let i = 0; i < 100; i++) {
      const s = generateSecret({ minLength: 8, maxLength: 8 });
      expect(s.length).toBe(8);
      expect(s).toMatch(/[A-Z]/);
      expect(s).toMatch(/[0-9]/);
      expect(s).toMatch(/[!@#$%*_-]/);
    }
  });
  it("honours a small maxLength given on its own", () => {
    for (let i = 0; i < 100; i++) {
      const s = generateSecret({ maxLength: 12 });
      expect(s.length).toBeGreaterThanOrEqual(8);
      expect(s.length).toBeLessThanOrEqual(12);
      expect(s).toMatch(/[A-Z]/); expect(s).toMatch(/[a-z]/); expect(s).toMatch(/[0-9]/); expect(s).toMatch(/[!@#$%*_-]/);
    }
  });
  it("respects a min length and never emits a space or quote", () => {
    const s = generateSecret({ minLength: 30 });
    expect(s.length).toBeGreaterThanOrEqual(30);
    expect(s).not.toMatch(/[\s"'\\]/);
  });
  it("is different every time (CSPRNG, not a constant)", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateSecret()));
    expect(seen.size).toBe(50);
  });
});

describe("usedRotationKeys", () => {
  const pending = new Set(["user_pw__next", "api_key__next"]);
  it("finds a placeholder used in an http body", () => {
    const params = { method: "PUT", path: "/users/7", body: { password: "{{user_pw__next}}" } };
    expect(usedRotationKeys(params, pending)).toEqual(["user_pw__next"]);
  });
  it("finds a placeholder used in a type action's text", () => {
    expect(usedRotationKeys({ text: "{{user_pw__next}}" }, pending)).toEqual(["user_pw__next"]);
  });
  it("finds a placeholder in headers or query too", () => {
    expect(usedRotationKeys({ headers: { "X-Key": "{{api_key__next}}" } }, pending)).toEqual(["api_key__next"]);
  });
  it("returns nothing when no pending placeholder is referenced", () => {
    expect(usedRotationKeys({ body: { password: "{{user_pw}}" } }, pending)).toEqual([]);
    expect(usedRotationKeys({ body: {} }, pending)).toEqual([]);
    expect(usedRotationKeys({ body: {} }, new Set())).toEqual([]);
  });
});

describe("http status helpers", () => {
  it("reads a numeric status", () => {
    expect(httpStatusOf({ status: 200 })).toBe(200);
    expect(httpStatusOf({ status: "200" })).toBeNull();
    expect(httpStatusOf(undefined)).toBeNull();
  });
  it("treats only 2xx as applied", () => {
    expect(isAppliedStatus(200)).toBe(true);
    expect(isAppliedStatus(204)).toBe(true);
    expect(isAppliedStatus(302)).toBe(false);
    expect(isAppliedStatus(400)).toBe(false);
    expect(isAppliedStatus(null)).toBe(false);
  });
});
