import { buildMatrix, type MatrixNode } from "./permission-matrix";

const nodes: MatrixNode[] = [
  { routeKey: "/", title: "Home", reachableBy: ["admin", "member", "guest"], deniedFor: [] },
  { routeKey: "/admin/users", title: "Users", reachableBy: ["admin"], deniedFor: ["member", "guest"] },
  { routeKey: "/admin/secret", title: "Leak", reachableBy: ["admin", "member"], deniedFor: ["guest"] },
];

describe("buildMatrix", () => {
  it("maps each identity to granted / denied / untested per route", () => {
    const m = buildMatrix(nodes, ["admin", "member", "guest"], "admin");
    const users = m.rows.find((r) => r.routeKey === "/admin/users")!;
    expect(users.access).toEqual({ admin: "granted", member: "denied", guest: "denied" });
  });

  it("flags a privileged route reachable by a non-privileged identity", () => {
    const m = buildMatrix(nodes, ["admin", "member", "guest"], "admin");
    expect(m.suspicious.map((r) => r.routeKey)).toEqual(["/admin/secret"]);
  });

  it("does not flag a properly locked-down admin route", () => {
    const m = buildMatrix([nodes[1]], ["admin", "member", "guest"], "admin");
    expect(m.suspicious).toHaveLength(0);
  });

  it("marks a route never seen by an identity as untested, not denied", () => {
    const m = buildMatrix(
      [{ routeKey: "/x", title: "X", reachableBy: ["admin"], deniedFor: [] }],
      ["admin", "guest"],
      "admin",
    );
    expect(m.rows[0].access.guest).toBe("untested");
  });
});
