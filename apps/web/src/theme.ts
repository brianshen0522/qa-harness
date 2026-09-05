import { useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";
const KEY = "qa-theme";

function systemDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function getPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function resolved(pref: ThemePref): "light" | "dark" {
  return pref === "system" ? (systemDark() ? "dark" : "light") : pref;
}

function apply(pref: ThemePref) {
  const root = document.documentElement;
  // Animate the switch: a short-lived class enables colour transitions, then off.
  root.classList.add("theme-anim");
  root.classList.toggle("dark", resolved(pref) === "dark");
  window.setTimeout(() => root.classList.remove("theme-anim"), 350);
}

export function setPref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // ignore storage failures; the class change below still takes effect
  }
  apply(pref);
}

/** Reactive theme preference + a cycle helper (system → light → dark → system). */
export function useTheme(): { pref: ThemePref; effective: "light" | "dark"; cycle: () => void; set: (p: ThemePref) => void } {
  const [pref, setState] = useState<ThemePref>(getPref);
  const [effective, setEffective] = useState<"light" | "dark">(() => resolved(getPref()));

  // When following the system, react to the OS theme changing live.
  useEffect(() => {
    if (pref !== "system" || typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      apply("system");
      setEffective(mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const set = (p: ThemePref) => {
    setPref(p);
    setState(p);
    setEffective(resolved(p));
  };
  const cycle = () => set(pref === "system" ? "light" : pref === "light" ? "dark" : "system");
  return { pref, effective, cycle, set };
}
