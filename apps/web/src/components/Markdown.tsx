import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

/** Render trusted-ish markdown (a target description / handoff doc) safely.
 *  marked parses it; DOMPurify strips scripts/handlers so a pasted doc can't XSS. */
export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(children ?? "", { async: false, gfm: true, breaks: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [children]);
  return <div className={`md-body ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
