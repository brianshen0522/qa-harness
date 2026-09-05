import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "./api/client";
import type { MyRun } from "./api/types";
import { useToast } from "./components/Toast";
import { browserNotify, flashTitle } from "./notify";

const ACTIVE = new Set(["running", "paused", "queued"]);
const TERMINAL = new Set(["succeeded", "failed", "aborted"]);

const STATUS_LABEL: Record<string, string> = { succeeded: "已完成", failed: "失敗", aborted: "已中止" };

/**
 * Polls the user's runs app-wide so a run that finishes while they are on another
 * page still gets a toast, a tab-title flash, and (if allowed) a browser notice.
 * Returns the currently-active runs for the header indicator.
 */
export function useRunWatcher(): { active: MyRun[] } {
  const toast = useToast();
  const navigate = useNavigate();
  const seenActive = useRef(new Set<string>()); // run ids we've observed active
  const notified = useRef(new Set<string>()); // run ids already announced
  const first = useRef(true);

  const q = useQuery({
    queryKey: ["me", "runs"],
    queryFn: () => api<MyRun[]>("/me/runs"),
    refetchInterval: (query) => {
      const data = query.state.data as MyRun[] | undefined;
      return data && data.some((r) => ACTIVE.has(r.status)) ? 6000 : 30000;
    },
    // Do not poll a hidden/background tab: a backgrounded app tab should not be a
    // permanent load generator. The interval resumes when the tab is focused.
    refetchIntervalInBackground: false,
    retry: false,
  });

  useEffect(() => {
    const runs = q.data;
    if (!runs) return;
    for (const r of runs) {
      const wasActive = seenActive.current.has(r.id);
      if (ACTIVE.has(r.status)) {
        seenActive.current.add(r.id);
        continue;
      }
      // Terminal now. Announce only runs we actually watched go active this session
      // (skip the historical backlog present on the very first poll).
      if (TERMINAL.has(r.status) && wasActive && !notified.current.has(r.id)) {
        notified.current.add(r.id);
        seenActive.current.delete(r.id);
        const v = r.verdicts;
        const summary = `通過 ${v.pass} / 失敗 ${v.fail}${v.blocked ? ` / 受阻 ${v.blocked}` : ""}`;
        const body = `「${r.targetName}」執行${STATUS_LABEL[r.status] ?? r.status} · ${summary}`;
        toast.toast(body, {
          tone: r.status === "failed" || v.fail > 0 ? "error" : r.status === "aborted" ? "info" : "success",
          duration: 8000,
          action: { label: "查看", onClick: () => navigate(`/targets/${r.targetId}?tab=runs`) },
        });
        flashTitle(`✓ 執行完成 · QA Harness`);
        browserNotify("QA Harness 執行完成", body);
      }
    }
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  return { active: (q.data ?? []).filter((r) => ACTIVE.has(r.status)) };
}
