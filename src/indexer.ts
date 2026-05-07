import { createPublicClient, http, type AbiEvent } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { Config } from "./config.js";
import { PURCHASED_EVENT_ABI } from "./contract-abi.js";
import { loadState, saveState } from "./state.js";
import { postWithRetry, type WebhookPayload } from "./webhook.js";
import type { Logger } from "./log.js";

// Decoded shape of a Purchased event. We don't try to type-link this to
// viem's getLogs return type because viem's generic Log<...> shape is too
// strict for our minimal ABI; we just assert at runtime the args we expect.
export interface DecodedPurchased {
  args: {
    buyer: `0x${string}`;
    tier: number;
    submittedSponsor: `0x${string}`;
    effectiveSponsor: `0x${string}`;
    earningSeller: `0x${string}`;
    commissionRecipient: `0x${string}`;
    productAmount: bigint;
    adminAmount: bigint;
    isPassup: boolean;
    becameAffiliate: boolean;
  };
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
}

function chainFor(name: Config["chain"]) {
  return name === "BASE_MAINNET" ? base : baseSepolia;
}

// Convert a viem event log into the webhook payload IAT expects.
// IAT's PR 3 spec uses `sponsor` (not `effectiveSponsor`) — we send
// effectiveSponsor because that's the sponsor the contract actually used.
export function eventToPayload(
  evt: DecodedPurchased,
  cfg: Pick<Config, "chain" | "iatTenantId">,
  blockTimestamp: number,
): WebhookPayload {
  return {
    txHash: evt.transactionHash,
    logIndex: evt.logIndex,
    blockNumber: Number(evt.blockNumber),
    chain: cfg.chain,
    buyer: evt.args.buyer,
    tier: evt.args.tier,
    sponsor: evt.args.effectiveSponsor,
    tenantId: cfg.iatTenantId,
    occurredAt: new Date(blockTimestamp * 1000).toISOString(),
  };
}

export interface PollResult {
  scannedFrom: bigint;
  scannedTo: bigint;
  eventsFound: number;
  eventsSent: number;
}

// Loose interface so we don't fight viem's chain-generic typing across
// base vs baseSepolia (their getBlock return types differ in edge fields
// that we don't read).
interface IndexerClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  getLogs(args: {
    address: `0x${string}`;
    event: AbiEvent;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<unknown[]>;
}

export async function pollOnce(
  client: IndexerClient,
  cfg: Config,
  log: Logger,
): Promise<PollResult | null> {
  const state = loadState(cfg.stateFile, cfg.wtDeployBlock);
  const lastProcessed = BigInt(state.lastProcessedBlock);

  const head = await client.getBlockNumber();
  const safeHead = head - cfg.confirmations;

  // Nothing new to scan yet.
  if (safeHead <= lastProcessed) {
    log.debug("up_to_date", { lastProcessed: lastProcessed.toString(), safeHead: safeHead.toString() });
    return null;
  }

  const from = lastProcessed + 1n;
  const to = from + cfg.maxBlocksPerQuery - 1n > safeHead ? safeHead : from + cfg.maxBlocksPerQuery - 1n;

  log.info("scan", { from: from.toString(), to: to.toString() });

  const logs = (await client.getLogs({
    address: cfg.wtContractAddress,
    event: PURCHASED_EVENT_ABI as AbiEvent,
    fromBlock: from,
    toBlock: to,
  })) as DecodedPurchased[];

  if (logs.length === 0) {
    saveState(cfg.stateFile, { lastProcessedBlock: to.toString() });
    return { scannedFrom: from, scannedTo: to, eventsFound: 0, eventsSent: 0 };
  }

  log.info("events_found", { count: logs.length });

  // Cache block timestamps so we don't re-fetch the same block N times.
  const blockTsCache = new Map<bigint, number>();
  async function tsFor(blockNumber: bigint): Promise<number> {
    const cached = blockTsCache.get(blockNumber);
    if (cached !== undefined) return cached;
    const block = await client.getBlock({ blockNumber });
    const ts = Number(block.timestamp);
    blockTsCache.set(blockNumber, ts);
    return ts;
  }

  let sent = 0;
  for (const evt of logs) {
    const ts = await tsFor(evt.blockNumber);
    const payload = eventToPayload(evt, cfg, ts);
    log.info("send", {
      tier: payload.tier,
      buyer: payload.buyer,
      txHash: payload.txHash,
      logIndex: payload.logIndex,
    });
    const result = await postWithRetry(cfg.iatWebhookUrl, cfg.hmacSecret, payload, (msg) =>
      log.warn(msg),
    );
    log.info("sent", {
      tier: payload.tier,
      buyer: payload.buyer,
      status: result.status,
      durationMs: result.durationMs,
    });
    sent++;
    // Advance state per-event so a crash mid-batch doesn't replay the prior
    // events. IAT is idempotent on (txHash, logIndex), so a replay would be
    // no-op anyway, but per-event commits keep the recovery surface small.
    saveState(cfg.stateFile, { lastProcessedBlock: (evt.blockNumber - 1n).toString() });
  }

  // After the whole batch, advance state to `to` (we've sent every event ≤ to).
  saveState(cfg.stateFile, { lastProcessedBlock: to.toString() });

  return { scannedFrom: from, scannedTo: to, eventsFound: logs.length, eventsSent: sent };
}

export async function runIndexer(cfg: Config, log: Logger, abortSignal?: AbortSignal): Promise<void> {
  const client = createPublicClient({
    chain: chainFor(cfg.chain),
    transport: http(cfg.baseRpcUrl),
  }) as unknown as IndexerClient;

  log.info("indexer_started", {
    chain: cfg.chain,
    contract: cfg.wtContractAddress,
    pollIntervalMs: cfg.pollIntervalMs,
    confirmations: Number(cfg.confirmations),
  });

  while (!abortSignal?.aborted) {
    try {
      const result = await pollOnce(client, cfg, log);
      if (result && result.eventsSent > 0) {
        log.info("poll_done", {
          from: result.scannedFrom.toString(),
          to: result.scannedTo.toString(),
          sent: result.eventsSent,
        });
      }
    } catch (err) {
      log.error("poll_error", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    // Wait for next poll, but be responsive to shutdown.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, cfg.pollIntervalMs);
      abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }

  log.info("indexer_stopped");
}
