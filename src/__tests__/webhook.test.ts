import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signBody, verifySignature, postWithRetry, WebhookError, type WebhookPayload } from "../webhook.js";

const SECRET = "test-secret-with-enough-bytes-to-look-real-XXXXXXX";

const PAYLOAD: WebhookPayload = {
  txHash: "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  logIndex: 3,
  blockNumber: 12345678,
  chain: "BASE_SEPOLIA",
  buyer: "0x35491f6661b843C130F43CeA61F507839227B43A",
  tier: 1,
  sponsor: "0xC9858b2CcbB0644982750e415B49528C4dEdf6E0",
  tenantId: "550e8400-e29b-41d4-a716-446655440000",
  occurredAt: "2026-05-07T12:00:00.000Z",
};

describe("signBody / verifySignature", () => {
  const TS = "1714000000";

  it("produces deterministic HMAC-SHA256 hex", () => {
    const sig1 = signBody(SECRET, TS, '{"a":1}');
    const sig2 = signBody(SECRET, TS, '{"a":1}');
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies its own signature", () => {
    const body = JSON.stringify(PAYLOAD);
    const sig = signBody(SECRET, TS, body);
    expect(verifySignature(SECRET, TS, body, sig)).toBe(true);
  });

  it("rejects tampered body", () => {
    const sig = signBody(SECRET, TS, '{"a":1}');
    expect(verifySignature(SECRET, TS, '{"a":2}', sig)).toBe(false);
  });

  it("rejects tampered timestamp", () => {
    const sig = signBody(SECRET, TS, '{"a":1}');
    expect(verifySignature(SECRET, "1714000001", '{"a":1}', sig)).toBe(false);
  });

  it("rejects wrong secret", () => {
    const sig = signBody(SECRET, TS, '{"a":1}');
    expect(verifySignature("different-secret", TS, '{"a":1}', sig)).toBe(false);
  });

  it("rejects mismatched signature length", () => {
    expect(verifySignature(SECRET, TS, '{"a":1}', "deadbeef")).toBe(false);
  });
});

describe("postWithRetry", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as ReturnType<typeof vi.spyOn>;
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("succeeds on first 200", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const result = await postWithRetry("http://x", SECRET, PAYLOAD, () => {});
    expect(result.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends correct HMAC signature + timestamp headers", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await postWithRetry("http://x", SECRET, PAYLOAD, () => {});
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = opts.headers as Record<string, string>;
    const ts = headers["x-wt-timestamp"];
    const sig = headers["x-wt-signature"];
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(ts).toMatch(/^\d{10}$/); // Unix seconds
    // Verify the signature corresponds to ${ts}.${body}.
    const body = opts.body as string;
    const expected = signBody(SECRET, ts, body);
    expect(sig).toBe(expected);
  });

  it("retries on 503 and eventually succeeds", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.useFakeTimers();
    const promise = postWithRetry("http://x", SECRET, PAYLOAD, () => {}, 5);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;
    vi.useRealTimers();
    expect(result.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("throws permanent on 401 (HMAC invalid)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"error":"invalid_hmac"}', { status: 401 }),
    );
    await expect(postWithRetry("http://x", SECRET, PAYLOAD, () => {})).rejects.toBeInstanceOf(
      WebhookError,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1); // No retry on permanent 4xx.
  });

  it("throws permanent on 400 (malformed)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    await expect(postWithRetry("http://x", SECRET, PAYLOAD, () => {})).rejects.toBeInstanceOf(
      WebhookError,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 (rate limit)", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("rate limit", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.useFakeTimers();
    const promise = postWithRetry("http://x", SECRET, PAYLOAD, () => {}, 3);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    vi.useRealTimers();
    expect(result.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on network failure", async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.useFakeTimers();
    const promise = postWithRetry("http://x", SECRET, PAYLOAD, () => {}, 3);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    vi.useRealTimers();
    expect(result.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts on persistent 503", async () => {
    // Each call gets a fresh Response — bodies can only be consumed once.
    fetchSpy.mockImplementation(async () => new Response("down", { status: 503 }));
    vi.useFakeTimers();
    const promise = postWithRetry("http://x", SECRET, PAYLOAD, () => {}, 3);
    // Attach a no-op catch so the unhandled-rejection warning doesn't fire
    // while we're advancing fake timers; the real assertion is below.
    const settled = promise.then(
      (r) => ({ ok: true, r }),
      (e) => ({ ok: false, e }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await settled;
    vi.useRealTimers();
    expect(result.ok).toBe(false);
    expect((result as { e: unknown }).e).toBeInstanceOf(WebhookError);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
