// Attention helpers for long-running work that finishes while the user is elsewhere.

let originalTitle: string | null = null;
let restoring = false;

/** Flash the tab title until the tab regains focus. */
export function flashTitle(text: string) {
  if (typeof document === "undefined") return;
  if (!document.hidden) return; // no need if the user is already looking
  if (originalTitle === null) originalTitle = document.title;
  document.title = text;
  if (!restoring) {
    restoring = true;
    const restore = () => {
      if (document.hidden) return;
      if (originalTitle !== null) document.title = originalTitle;
      originalTitle = null;
      restoring = false;
      document.removeEventListener("visibilitychange", restore);
      window.removeEventListener("focus", restore);
    };
    document.addEventListener("visibilitychange", restore);
    window.addEventListener("focus", restore);
  }
}

/** Ask once (best-effort) — call from a user gesture such as starting a run. */
export function requestNotifyPermission() {
  try {
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  } catch {
    // ignore
  }
}

export function browserNotify(title: string, body: string) {
  try {
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
      new Notification(title, { body });
    }
  } catch {
    // ignore
  }
}
