import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

type Tone = "success" | "error" | "info";
export interface ToastOptions {
  tone?: Tone;
  /** ms before auto-dismiss; 0 keeps it until closed. */
  duration?: number;
  /** Optional action link/button shown on the toast. */
  action?: { label: string; onClick: () => void };
}
interface Toast extends Required<Pick<ToastOptions, "tone">> {
  id: number;
  message: ReactNode;
  duration: number;
  action?: ToastOptions["action"];
}

interface ToastApi {
  toast: (message: ReactNode, opts?: ToastOptions) => number;
  success: (message: ReactNode, opts?: ToastOptions) => number;
  error: (message: ReactNode, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const TONE_STYLE: Record<Tone, string> = {
  success: "border-l-green-500 dark:border-l-green-400",
  error: "border-l-red-500 dark:border-l-red-400",
  info: "border-l-blue-500 dark:border-l-blue-400",
};
const TONE_ICON: Record<Tone, string> = { success: "✓", error: "✕", info: "ℹ" };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message: ReactNode, opts: ToastOptions = {}) => {
      const id = ++seq.current;
      const tone = opts.tone ?? "info";
      const duration = opts.duration ?? (tone === "error" ? 6000 : 4000);
      setToasts((t) => [...t, { id, message, tone, duration, action: opts.action }]);
      if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss],
  );

  const api: ToastApi = {
    toast: push,
    success: (m, o) => push(m, { ...o, tone: "success" }),
    error: (m, o) => push(m, { ...o, tone: "error" }),
    dismiss,
  };

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`toast-in pointer-events-auto flex items-start gap-2 rounded-md border border-l-4 bg-white px-3 py-2.5 text-sm shadow-lg dark:bg-gray-900 border-gray-200 dark:border-gray-700 ${TONE_STYLE[t.tone]}`}
          >
            <span className={`mt-0.5 font-bold ${t.tone === "success" ? "text-green-600 dark:text-green-400" : t.tone === "error" ? "text-red-600 dark:text-red-400" : "text-blue-600 dark:text-blue-400"}`}>
              {TONE_ICON[t.tone]}
            </span>
            <div className="min-w-0 flex-1 text-gray-800 dark:text-gray-100">{t.message}</div>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
                className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
              >
                {t.action.label}
              </button>
            )}
            <button type="button" onClick={() => dismiss(t.id)} aria-label="關閉" className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
