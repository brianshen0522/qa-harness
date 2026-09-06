import { CredentialType } from "@prisma/client";

/**
 * The credential model the model (LLM) reasons about. A `password` credential is
 * a bound login pair; every other type is a single secret. This module is the one
 * place that knows how a credential's type maps to its fields and to the
 * `{{...}}` references the agent writes — so storage, prompt and rotation agree.
 */

/** Grammar for a `{{reference}}` — unicode names allowed, `.` separates a field. */
export const CREDENTIAL_REF_RE = /\{\{\s*([\p{L}\p{N}_.\-]+)\s*\}\}/gu;
/** A credential name (no dot — the dot is reserved as the field separator). */
export const CREDENTIAL_NAME_RE = /^[\p{L}\p{N}_\-]+$/u;

/** The fields a credential of this type stores. */
export function fieldNames(type: CredentialType): string[] {
  return type === CredentialType.password ? ["username", "password"] : ["value"];
}

/** The `{{...}}` reference for one field: the bare name for a single secret,
 *  `name.field` for a paired login. */
export function refKey(name: string, field: string): string {
  return field === "value" ? name : `${name}.${field}`;
}

/** Every reference a credential exposes (what the agent may write). */
export function refKeys(name: string, type: CredentialType): string[] {
  return fieldNames(type).map((f) => refKey(name, f));
}

/** The one field a run may rotate (the secret): a password, or a single value.
 *  Usernames are identifiers, not secrets, so they are never rotated. */
export function rotatableField(type: CredentialType): string {
  return type === CredentialType.password ? "password" : "value";
}

/** The reference for the rotatable secret (e.g. `member.password`, or `api_key`). */
export function rotatableRefKey(name: string, type: CredentialType): string {
  return refKey(name, rotatableField(type));
}

/** Human label for a type, used in the prompt and UI. */
export function typeLabel(type: CredentialType): string {
  switch (type) {
    case CredentialType.password: return "帳號密碼";
    case CredentialType.api_key: return "API key";
    case CredentialType.bearer_token: return "Bearer token";
    case CredentialType.cookie: return "Cookie";
    default: return "其他";
  }
}
