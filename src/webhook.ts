import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookPayload {
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: number;
  chain: "BASE_MAINNET" | "BASE_SEPOLIA";
  buyer: `0x${string}`;
  tier: number;
  sponsor: `0x${string}`;
  tenantId: string;
  occurredAt: string; // ISO-8601 UTC
}

export interface WebhookResult {
  status: number;
  body: string;
  durationMs: number;
}

export class WebhookError extends Error {
  constructor(public readonly result: WebhookResult, message: string) {
    super(message);
  }
}

// HMAC-SHA256 over the raw JSON body. The IAT side signs/verifies the same way
// (mirrors PR 3 webhook handler in apps/api/src/routes/webhooks/wt.ts).
export function signBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// Used by tests only — proves our signature shape is byte-identical to what
// IAT computes. timingSafeEqual sanity check.
export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = signBody(secret, body);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function postWebhook(
  url: string,
  secret: string,
  payload: WebhookPayload,
): Promise<WebhookResult> {
  const body = JSON.stringify(payload);
  const signature = signBody(secret, body);
  const start = Date.now();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-WT-Signature": signature,
      "User-Agent": "wt-indexer/1.0",
    },
    body,
  });

  const text = await res.text();
  return { status: res.status, body: text, durationMs: Date.now() - start };
}

// Retries the webhook with exponential backoff for transient failures.
// Throws on permanent failure (4xx that isn't 408/429) so the indexer halts
// instead of silently dropping events. 5xx and network errors retry.
export async function postWithRetry(
  url: string,
  secret: string,
  payload: WebhookPayload,
  log: (msg: string) => void,
  maxAttempts = 5,
): Promise<WebhookResult> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await postWebhook(url, secret, payload);
      // 2xx → success. IAT returns 200 even for idempotent replays.
      if (result.status >= 200 && result.status < 300) return result;
      // 408 (timeout), 429 (rate limit), 5xx → transient, retry.
      if (result.status === 408 || result.status === 429 || result.status >= 500) {
        lastErr = new WebhookError(result, `Transient ${result.status}: ${result.body.slice(0, 200)}`);
      } else {
        // 4xx → permanent. HMAC mismatch, malformed body, tenant rejection, etc.
        // Halt so we don't burn through events that all fail the same way.
        throw new WebhookError(result, `Permanent ${result.status}: ${result.body.slice(0, 200)}`);
      }
    } catch (err) {
      // fetch() failure (DNS, connection refused, network reset) → retry.
      if (err instanceof WebhookError) throw err; // permanent — propagate.
      lastErr = err;
    }
    if (attempt < maxAttempts) {
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 30_000);
      log(`Webhook attempt ${attempt}/${maxAttempts} failed, retrying in ${backoffMs}ms`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Webhook failed after ${maxAttempts} attempts`);
}
