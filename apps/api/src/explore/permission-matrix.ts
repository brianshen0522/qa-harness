export type AccessState = "granted" | "denied" | "untested";

export interface PermissionRow {
  routeKey: string;
  title: string;
  access: Record<string, AccessState>;
}

export interface PermissionMatrix {
  identities: string[];
  rows: PermissionRow[];
  /** Rows where a lower-privilege identity reaches what a higher one also reaches,
   *  or where access looks inconsistent — the rows worth a hard look. */
  suspicious: PermissionRow[];
}

export interface MatrixNode {
  routeKey: string;
  title: string;
  reachableBy: string[];
  deniedFor: string[];
}

/**
 * §4.4-adjacent: once each identity has been crawled, "who can see what" is a
 * comparison, not a guess. A page reachable by a low-trust identity but denied
 * to none, while sitting under an admin route, is exactly the kind of thing that
 * is easy to miss by hand and expensive to get wrong.
 */
export function buildMatrix(nodes: MatrixNode[], identityNames: string[], privilegedRole: string | null): PermissionMatrix {
  const rows: PermissionRow[] = nodes
    .map((n) => {
      const access: Record<string, AccessState> = {};
      for (const id of identityNames) {
        access[id] = n.reachableBy.includes(id) ? "granted" : n.deniedFor.includes(id) ? "denied" : "untested";
      }
      return { routeKey: n.routeKey, title: n.title, access };
    })
    .sort((a, b) => a.routeKey.localeCompare(b.routeKey));

  // A route that reads as privileged (an /admin prefix, say) but is reachable by
  // an identity other than the privileged one is worth flagging.
  const suspicious = rows.filter((row) => {
    const looksPrivileged = /(^|\/)(admin|manage|internal|dashboard)(\/|$)/i.test(row.routeKey);
    if (!looksPrivileged) return false;
    const reachedByNonPrivileged = identityNames.some(
      (id) => id !== privilegedRole && row.access[id] === "granted",
    );
    return reachedByNonPrivileged;
  });

  return { identities: identityNames, rows, suspicious };
}
