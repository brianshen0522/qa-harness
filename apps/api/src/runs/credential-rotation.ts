import { randomInt } from "node:crypto";

/**
 * Credential rotation — keeping stored credentials in sync with the target.
 *
 * A run can change the target's own state, and a credential is part of that
 * state: if a case changes a user's password (say an admin editing another
 * account), the value the harness has stored is now stale and the next login
 * with it fails. To keep the two in sync, a case declares the change with the
 * `rotate_credential` action. The harness then:
 *   1. generates a fresh strong value (the model never sees or invents it),
 *   2. exposes it under a `{{key__next}}` placeholder for the change request,
 *   3. watches for the change to actually take effect on the target, and
 *   4. syncs the stored credential to the new value.
 *
 * The functions here are the pure pieces; the stateful orchestration (when to
 * commit, DB write-back, audit) lives in run.service.
 */

/** Suffix that turns a credential name into its "the new value" placeholder. */
export const ROTATION_SUFFIX = "__next";

/** `user_pw` -> `user_pw__next`. This is the name the agent references. */
export function rotationPlaceholderKey(credential: string): string {
  return `${credential}${ROTATION_SUFFIX}`;
}

/** True for a name produced by {@link rotationPlaceholderKey}. */
export function isRotationPlaceholderKey(key: string): boolean {
  return key.endsWith(ROTATION_SUFFIX) && key.length > ROTATION_SUFFIX.length;
}

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O — avoid look-alikes
const LOWER = "abcdefghijkmnpqrstuvwxyz"; // no l/o
const DIGIT = "23456789"; // no 0/1
const SYMBOL = "!@#$%*-_"; // widely accepted; no quotes/backslash/space

/** Pick one character uniformly from an alphabet using a CSPRNG. */
function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)];
}

/** Fisher–Yates over a CSPRNG so the guaranteed classes are not front-loaded. */
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * A strong random value that satisfies the common "upper + lower + digit +
 * symbol" policy, so most password fields accept it. Length is clamped so a
 * caller-declared max (some apps cap length) is honoured while never dropping a
 * required class. Never returns a value the model chose — that is the point.
 */
export function generateSecret(opts: { minLength?: number; maxLength?: number } = {}): string {
  // Honour an explicit maxLength even when small (some apps cap length), but never
  // below 8 — enough for the four required classes plus a little entropy. A
  // minLength always wins, so a contradictory max can only raise the ceiling.
  const ceil = Math.max(typeof opts.maxLength === "number" ? opts.maxLength : 24, opts.minLength ?? 0, 8);
  const floor = Math.min(Math.max(opts.minLength ?? Math.min(16, ceil), 8), ceil);
  const length = floor >= ceil ? ceil : randomInt(floor, ceil + 1);

  const required = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  const all = UPPER + LOWER + DIGIT + SYMBOL;
  const rest = Array.from({ length: Math.max(0, length - required.length) }, () => pick(all));
  return shuffle([...required, ...rest]).join("");
}

/** Every `{{name}}` reference in a string (matches the fillCredentials grammar). */
function referencedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/\{\{\s*([\p{L}\p{N}_.\-]+)\s*\}\}/gu)) names.add(m[1]);
  return names;
}

/**
 * Which of `pendingKeys` this action actually referenced — the link between a
 * requested rotation and the request that carries the new value. Scans the whole
 * params object (http body/headers/query, or a `type` action's text) so it works
 * for every executor.
 */
export function usedRotationKeys(params: unknown, pendingKeys: Iterable<string>): string[] {
  const pending = pendingKeys instanceof Set ? pendingKeys : new Set(pendingKeys);
  if (!pending.size) return [];
  let text: string;
  try {
    text = typeof params === "string" ? params : JSON.stringify(params ?? {});
  } catch {
    return [];
  }
  const referenced = referencedNames(text);
  return [...pending].filter((k) => referenced.has(k));
}

/** Read the HTTP status from an http_request outcome's detail, if present. */
export function httpStatusOf(detail: Record<string, unknown> | undefined | null): number | null {
  const status = detail?.status;
  return typeof status === "number" ? status : null;
}

/** A 2xx is the target accepting the change — the ground truth we sync to. */
export function isAppliedStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}
