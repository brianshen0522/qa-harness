import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button, Dialog } from "./ui";

interface ConfirmOptions {
  title?: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmCtx = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { open: boolean }) | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setState({ ...opts, open: true });
    });
  }, []);

  const settle = (result: boolean) => {
    resolver.current?.(result);
    resolver.current = null;
    setState((s) => (s ? { ...s, open: false } : s));
  };

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog open={!!state?.open} title={state?.title ?? "請確認"} onClose={() => settle(false)}>
        <div className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-200">{state?.body}</div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => settle(false)}>
            {state?.cancelLabel ?? "取消"}
          </Button>
          <Button variant={state?.tone === "danger" ? "danger" : "primary"} onClick={() => settle(true)}>
            {state?.confirmLabel ?? "確認"}
          </Button>
        </div>
      </Dialog>
    </ConfirmCtx.Provider>
  );
}
