/**
 * Linear scans over untrusted HTML. Fetched pages reach 2MB, and regexes such as
 * `<[^>]+>` go quadratic on input like a long run of `<`, which stalls the event
 * loop for the whole API. Every search here resumes where the last one stopped.
 */

/** Lowercases ASCII only, so indexes stay valid in the original string. */
function lowerAscii(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** Replaces each `<tag ...>...</tag>` with a space. An unclosed one is left alone. */
export function removeElement(html: string, tag: string): string {
  const lower = lowerAscii(html);
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start < 0) break;
    const end = lower.indexOf(close, start + open.length);
    if (end < 0) break;
    out.push(html.slice(pos, start), " ");
    pos = end + close.length;
  }
  out.push(html.slice(pos));
  return out.join("");
}

/** Replaces every `<...>` with a space. `<>` and a `<` with no `>` stay as text. */
export function replaceTags(html: string): string {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) break;
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break;
    out.push(html.slice(pos, lt), gt === lt + 1 ? "<>" : " ");
    pos = gt + 1;
  }
  out.push(html.slice(pos));
  return out.join("");
}

export interface ScannedTag {
  index: number;
  attrs: string;
}

/** Every opening `<tag ...>`, in document order. */
export function* openTags(html: string, tag: string): Generator<ScannedTag> {
  const lower = lowerAscii(html);
  const open = `<${tag}`;
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start < 0) return;
    const after = start + open.length;
    if (/\w/.test(lower[after] ?? "")) {
      pos = after;
      continue;
    }
    const gt = lower.indexOf(">", after);
    if (gt < 0) return;
    yield { index: start, attrs: html.slice(after, gt) };
    pos = gt + 1;
  }
}

/** Every `<tag ...>inner</tag>`, in document order. */
export function* elements(html: string, tag: string): Generator<ScannedTag & { inner: string }> {
  const lower = lowerAscii(html);
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start < 0) return;
    const after = start + open.length;
    if (/\w/.test(lower[after] ?? "")) {
      pos = after;
      continue;
    }
    const gt = lower.indexOf(">", after);
    if (gt < 0) return;
    const end = lower.indexOf(close, gt + 1);
    if (end < 0) return;
    yield { index: start, attrs: html.slice(after, gt), inner: html.slice(gt + 1, end) };
    pos = end + close.length;
  }
}
