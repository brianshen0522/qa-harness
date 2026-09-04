import { normalizeRoute } from "./route-key";

const B = "http://host.docker.internal:8080/";

describe("normalizeRoute", () => {
  it("keeps a static path as-is", () => {
    expect(normalizeRoute("http://host.docker.internal:8080/admin/users", B)?.key).toBe("/admin/users");
  });

  it("collapses numeric and uuid ids to :id", () => {
    expect(normalizeRoute(`${B}todos/1`, B)?.key).toBe("/todos/:id");
    expect(normalizeRoute(`${B}todos/2`, B)?.key).toBe("/todos/:id");
    expect(normalizeRoute(`${B}users/9f8c1e34-2b7a-4d10-bb00-000000000001`, B)?.key).toBe("/users/:id");
  });

  it("collapses cuid-style ids (what StreamHub uses)", () => {
    expect(normalizeRoute(`${B}admin/users/cmt13d3300003pi56a85o94ab`, B)?.key).toBe("/admin/users/:id");
  });

  it("treats a trailing slash as the same route", () => {
    expect(normalizeRoute(`${B}favorites/`, B)?.key).toBe("/favorites");
    expect(normalizeRoute(`${B}favorites`, B)?.key).toBe("/favorites");
  });

  it("keeps query parameter names but not their values", () => {
    const a = normalizeRoute(`${B}search?q=matrix&page=2`, B)?.key;
    const b = normalizeRoute(`${B}search?q=aliens&page=9`, B)?.key;
    expect(a).toBe(b);
    expect(a).toBe("/search?page&q");
  });

  it("understands hash routes", () => {
    expect(normalizeRoute(`${B}#/library/42`, B)?.key).toBe("/#/library/:id");
  });

  it("rejects off-site and non-http links", () => {
    expect(normalizeRoute("https://youtube.com/watch?v=x", B)).toBeNull();
    expect(normalizeRoute("mailto:a@b.c", B)).toBeNull();
    expect(normalizeRoute("javascript:void(0)", B)).toBeNull();
  });

  it("returns a concrete sample url alongside the key", () => {
    const r = normalizeRoute(`${B}todos/7?x=1`, B);
    expect(r?.key).toBe("/todos/:id?x");
    expect(r?.sample).toBe("http://host.docker.internal:8080/todos/7?x=1");
  });
});
