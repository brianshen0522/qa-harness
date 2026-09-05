import { useTheme, type ThemePref } from "../theme";

const SUN = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const MOON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);
const SYSTEM = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
);

const LABEL: Record<ThemePref, string> = { system: "跟隨系統", light: "淺色", dark: "深色" };
const ICON: Record<ThemePref, React.ReactNode> = { system: SYSTEM, light: SUN, dark: MOON };

/** Cycles 跟隨系統 → 淺色 → 深色. The icon pops on change; colours cross-fade globally. */
export function ThemeToggle({ subtle = false }: { subtle?: boolean }) {
  const { pref, cycle } = useTheme();
  return (
    <button
      type="button"
      onClick={cycle}
      title={`主題:${LABEL[pref]}(點擊切換)`}
      aria-label={`切換主題,目前為${LABEL[pref]}`}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
        subtle
          ? "border-gray-700 text-gray-200 hover:bg-gray-800"
          : "border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
      }`}
    >
      <span key={pref} className="theme-pop inline-flex">
        {ICON[pref]}
      </span>
      <span className="hidden sm:inline">{LABEL[pref]}</span>
    </button>
  );
}
