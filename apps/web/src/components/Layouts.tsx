import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router-dom";
import { useLogout, useMe } from "../api/auth";
import { ThemeToggle } from "./ThemeToggle";
import { Button, Spinner } from "./ui";

function navClass({ isActive }: { isActive: boolean }) {
  return `rounded-md px-3 py-1.5 text-sm ${isActive ? "bg-gray-900 text-white" : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"}`;
}

export function UserLayout() {
  const me = useMe();
  const logout = useLogout();
  const location = useLocation();

  if (me.isPending) return <Spinner />;
  if (me.isError) return <p className="p-6 text-sm text-red-600 dark:text-red-400">無法連線到伺服器：{me.error.message}</p>;
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <Link to="/" className="text-base font-bold text-gray-900 dark:text-gray-50">
              QA Harness
            </Link>
            <nav className="flex items-center gap-1">
              <NavLink to="/" end className={navClass}>
                Projects
              </NavLink>
              <NavLink to="/teams" className={navClass}>
                Teams
              </NavLink>
              {me.data.isAdmin && (
                <NavLink to="/admin" className={navClass}>
                  管理
                </NavLink>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <ThemeToggle />
            <span className="text-gray-700 dark:text-gray-200 dark:text-gray-200">{me.data.name || me.data.email}</span>
            <Button variant="secondary" size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
              登出
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-screen-2xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}

export function AdminLayout() {
  const me = useMe();
  const logout = useLogout();
  const location = useLocation();

  if (me.isPending) return <Spinner />;
  if (me.isError) return <p className="p-6 text-sm text-red-600 dark:text-red-400">無法連線到伺服器：{me.error.message}</p>;
  // Not logged in -> login; logged in but not an admin -> back to the app.
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!me.data.isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="min-h-screen">
      <header className="border-b border-gray-800 bg-gray-900 text-white">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-4">
            <Link to="/admin/llm" className="text-base font-bold">
              QA Harness <span className="ml-1 rounded bg-amber-500 px-1.5 py-0.5 text-xs text-black">Admin</span>
            </Link>
            <nav className="flex items-center gap-1">
              {[
                ["/admin/users", "使用者"],
                ["/admin/llm", "LLM"],
                ["/admin/sandbox", "Sandbox"],
                ["/admin/skills", "Skills"],
                ["/admin/mcp", "MCP"],
                ["/admin/audit", "稽核與用量"],
              ].map(([to, label]) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `rounded-md px-3 py-1.5 text-sm ${isActive ? "bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-50" : "text-gray-300 hover:bg-gray-800"}`
                  }
                >
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <ThemeToggle subtle />
            <span className="text-gray-300">{me.data.email}</span>
            <Button variant="secondary" size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
              登出
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-screen-2xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
