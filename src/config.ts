import { readFileSync } from "node:fs";
import "dotenv/config";

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env: ${key}`);
  return v;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${key} is not an integer: ${v}`);
  return n;
}

const ALLOWED_CHAINS = ["BASE_MAINNET", "BASE_SEPOLIA"] as const;
type Chain = (typeof ALLOWED_CHAINS)[number];

function chain(): Chain {
  const v = required("CHAIN");
  if (!ALLOWED_CHAINS.includes(v as Chain)) {
    throw new Error(`CHAIN must be one of ${ALLOWED_CHAINS.join(", ")}, got: ${v}`);
  }
  return v as Chain;
}

function loadHmacSecret(path: string): string {
  const raw = readFileSync(path, "utf8");
  const trimmed = raw.trim();
  if (trimmed.length < 32) {
    throw new Error(`HMAC secret at ${path} is suspiciously short (${trimmed.length} chars). Expected ≥32.`);
  }
  return trimmed;
}

export const config = {
  baseRpcUrl: required("BASE_RPC_URL"),
  chain: chain(),
  wtContractAddress: required("WT_CONTRACT_ADDRESS") as `0x${string}`,
  wtDeployBlock: BigInt(required("WT_DEPLOY_BLOCK")),
  iatWebhookUrl: required("IAT_WEBHOOK_URL"),
  iatTenantId: required("IAT_TENANT_ID"),
  hmacSecret: loadHmacSecret(required("WT_WEBHOOK_HMAC_SECRET_PATH")),

  // Optional: also fan events to the wt-emails service. Best-effort. If set,
  // every Purchased event also POSTs to {emailServiceUrl}/v1/internal/purchase-event
  // with HMAC signed by emailHmacSecret. IAT remains the critical path; email
  // failures are logged but do not halt processing.
  emailServiceUrl: process.env["EMAIL_SERVICE_URL"] ?? "",
  emailHmacSecret: process.env["EMAIL_HMAC_SECRET_PATH"]
    ? loadHmacSecret(process.env["EMAIL_HMAC_SECRET_PATH"])
    : "",
  pollIntervalMs: int("POLL_INTERVAL_MS", 12000),
  confirmations: BigInt(int("CONFIRMATIONS", 5)),
  maxBlocksPerQuery: BigInt(int("MAX_BLOCKS_PER_QUERY", 2000)),
  stateFile: optional("STATE_FILE", "./indexer-state.json"),
  logLevel: optional("LOG_LEVEL", "info"),
} as const;

export type Config = typeof config;
