/**
 * Rough cost estimation for the usage page (§4.8 估算成本). Prices are USD per
 * 1M tokens and are necessarily approximate — providers change them, and a
 * self-hosted or local model costs nothing to call. The point is not an invoice
 * but a sense of scale: computer-use spends a vision call per step, 30–100 steps
 * a case, so "is this run cents or dollars" is the question worth answering.
 *
 * Matched by substring against the *resolved* model name recorded on each call,
 * longest match wins; anything unmatched (local/ollama, unknown) is treated as free.
 */
interface Price {
  in: number;
  out: number;
}

const PRICES: Record<string, Price> = {
  "claude-opus": { in: 15, out: 75 },
  "claude-sonnet": { in: 3, out: 15 },
  "claude-haiku": { in: 0.8, out: 4 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4.1": { in: 2, out: 8 },
  "o3": { in: 2, out: 8 },
  "gemini-1.5-pro": { in: 1.25, out: 5 },
  "gemini-1.5-flash": { in: 0.075, out: 0.3 },
};

export function priceFor(model: string | null | undefined): Price | null {
  if (!model) return null;
  const m = model.toLowerCase();
  let best: { key: string; price: Price } | null = null;
  for (const [key, price] of Object.entries(PRICES)) {
    if (m.includes(key) && (!best || key.length > best.key.length)) best = { key, price };
  }
  return best?.price ?? null;
}

/** Estimated USD for one call; 0 when the model has no known price (local/unknown). */
export function estimateCost(model: string | null | undefined, inputTokens: number, outputTokens: number): number {
  const p = priceFor(model);
  if (!p) return 0;
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}

/** True when we have a price for this model, so the UI can flag "免費/未知" vs a real estimate. */
export function isPriced(model: string | null | undefined): boolean {
  return priceFor(model) !== null;
}
