import type { ButtonHTMLAttributes, ComponentProps, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { useEffect } from "react";

function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT: Record<Variant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300",
  secondary: "bg-white text-gray-800 border border-gray-300 hover:bg-gray-100 disabled:text-gray-400",
  danger: "bg-white text-red-600 border border-red-300 hover:bg-red-50 disabled:text-red-300",
  ghost: "bg-transparent text-gray-600 hover:bg-gray-100 disabled:text-gray-400",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type={props.type ?? "button"}
      {...props}
      className={cx(
        "inline-flex items-center justify-center rounded-md font-medium transition disabled:cursor-not-allowed",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        VARIANT[variant],
        className,
      )}
    />
  );
}

const FIELD =
  "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(FIELD, className)} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={cx(FIELD, "font-mono", className)} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx(FIELD, className)}>
      {children}
    </select>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-gray-200 bg-white shadow-sm", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

type Tone = "gray" | "blue" | "green" | "amber" | "red" | "purple";
const TONE: Record<Tone, string> = {
  gray: "bg-gray-100 text-gray-700",
  blue: "bg-blue-100 text-blue-700",
  green: "bg-green-100 text-green-700",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-700",
  purple: "bg-purple-100 text-purple-700",
};

export function Badge({ tone = "gray", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx("inline-block rounded px-2 py-0.5 text-xs font-medium", TONE[tone])}>{children}</span>;
}

export function RoleBadge({ role }: { role: "viewer" | "editor" | "owner" }) {
  const tone: Tone = role === "owner" ? "purple" : role === "editor" ? "blue" : "gray";
  const label = role === "owner" ? "擁有者" : role === "editor" ? "編輯者" : "檢視者";
  return <Badge tone={tone}>{label}</Badge>;
}

export function KindBadge({ kind }: { kind: "api" | "web" | "desktop" }) {
  const tone: Tone = kind === "api" ? "green" : kind === "web" ? "blue" : "amber";
  return <Badge tone={tone}>{kind.toUpperCase()}</Badge>;
}

export function StatusBadge({ status }: { status: "idle" | "running" }) {
  return <Badge tone={status === "running" ? "amber" : "gray"}>{status === "running" ? "執行中" : "閒置"}</Badge>;
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <p className="mt-2 text-xs text-red-600">{msg}</p>;
}

export function Notice({ tone = "amber", children }: { tone?: "amber" | "red" | "blue"; children: ReactNode }) {
  const cls =
    tone === "red"
      ? "border-red-200 bg-red-50 text-red-800"
      : tone === "blue"
        ? "border-blue-200 bg-blue-50 text-blue-800"
        : "border-amber-200 bg-amber-50 text-amber-800";
  return <div className={cx("rounded-md border px-3 py-2 text-sm", cls)}>{children}</div>;
}

export function Spinner({ label = "載入中…" }: { label?: string }) {
  return <p className="py-6 text-center text-sm text-gray-400">{label}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-4 text-center text-sm text-gray-400">{children}</p>;
}

const DIALOG_SIZE = {
  sm: "max-w-lg",
  lg: "max-w-3xl",
  xl: "max-w-[92rem]",
} as const;

export function Dialog({
  open,
  title,
  onClose,
  children,
  size = "sm",
  bodyClassName,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  size?: keyof typeof DIALOG_SIZE;
  bodyClassName?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={`flex max-h-[92vh] w-full ${DIALOG_SIZE[size]} flex-col rounded-lg bg-white shadow-xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 py-3">
          <h3 className="text-base font-semibold">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="關閉">
            ×
          </button>
        </header>
        <div className={bodyClassName ?? "overflow-y-auto px-5 py-4"}>{children}</div>
      </div>
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm [&_th]:whitespace-nowrap [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_th]:font-medium [&_th]:text-gray-500 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_tbody_tr]:border-t [&_tbody_tr]:border-gray-100">
        {children}
      </table>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: T; label: string }[];
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-gray-200" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={cx(
            "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition",
            active === t.key ? "border-blue-600 text-blue-700" : "border-transparent text-gray-500 hover:text-gray-800",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
