// JEV provider — probabilistic interpretation only. Knows nothing about offers.
// Sends { model, state, questions } and returns the raw typed answers, untouched.
import { config } from './config.mjs';

const PROVIDERS = {
  typesafe: { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' },
  openrouter: { url: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13' },
};

// TypeSafe-direct returns tokens but no cost. OpenRouter publicly lists the same model at
// $0.042 per million input tokens, output free. Used ONLY to label an estimate.
const EST_INPUT_PER_TOKEN = 0.000000042;
const RETRYABLE = new Set([429, 500, 502, 503, 504, 520, 522, 524]);

export async function askJev(state, questions) {
  const p = PROVIDERS[config.JEV_PROVIDER] || PROVIDERS.typesafe;
  const body = JSON.stringify({ model: p.model, state, questions });
  const t0 = performance.now();
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.JEV_API_KEY}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const text = await res.text();
        lastErr = new Error(`Jev HTTP ${res.status}: ${text.slice(0, 300)}`);
        if (RETRYABLE.has(res.status)) { await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); continue; }
        throw lastErr;
      }
      const raw = await res.json();
      const latency_ms = performance.now() - t0;
      const usage = raw.usage || {};
      const actual = typeof usage.cost === 'number';
      return {
        raw,
        latency_ms,
        attempts: attempt + 1,
        model: raw.model,
        provider: config.JEV_PROVIDER,
        usage,
        cost: actual ? usage.cost : (usage.input_tokens != null ? usage.input_tokens * EST_INPUT_PER_TOKEN : null),
        cost_basis: actual
          ? 'actual (reported by the API)'
          : 'estimated: input tokens x $0.042 per million (OpenRouter public list price for this model; TypeSafe-direct returns no cost)',
      };
    } catch (e) {
      lastErr = e;
      if (attempt === 2) break;
    }
  }
  throw lastErr;
}
