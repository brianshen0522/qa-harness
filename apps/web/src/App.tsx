import { Navigate, Route, Routes } from "react-router-dom";
import { AdminLayout, UserLayout } from "./components/Layouts";
import LoginPage from "./pages/LoginPage";
import ProjectsPage from "./pages/ProjectsPage";
import TeamsPage from "./pages/TeamsPage";
import ProjectDetailPage from "./pages/ProjectDetailPage";
import TargetDetailPage from "./pages/TargetDetailPage";
import AdminUsersPage from "./pages/admin/AdminUsersPage";
import AdminLlmPage from "./pages/admin/AdminLlmPage";
import AdminSandboxPage from "./pages/admin/AdminSandboxPage";
import AdminSkillsPage from "./pages/admin/AdminSkillsPage";
import AdminMcpPage from "./pages/admin/AdminMcpPage";
import AdminAuditPage from "./pages/admin/AdminAuditPage";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<UserLayout />}>
        <Route index element={<ProjectsPage />} />
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route path="/targets/:id" element={<TargetDetailPage />} />
      </Route>

      <Route path="/admin/login" element={<Navigate to="/login" replace />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Navigate to="/admin/llm" replace />} />
        <Route path="users" element={<AdminUsersPage />} />
        <Route path="llm" element={<AdminLlmPage />} />
        <Route path="sandbox" element={<AdminSandboxPage />} />
        <Route path="skills" element={<AdminSkillsPage />} />
        <Route path="mcp" element={<AdminMcpPage />} />
        <Route path="audit" element={<AdminAuditPage />} />
      </Route>

      <Route path="*" element={<p className="p-6 text-sm text-gray-500 dark:text-gray-400">找不到頁面。</p>} />
    </Routes>
  );
}
