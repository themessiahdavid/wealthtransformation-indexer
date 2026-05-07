import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export interface IndexerState {
  // Last block whose events we have successfully sent to IAT.
  // Next poll resumes at lastProcessedBlock + 1.
  lastProcessedBlock: string; // serialized as string because JSON has no BigInt
}

export function loadState(path: string, defaultStartBlock: bigint): IndexerState {
  if (!existsSync(path)) {
    // Subtract 1 so the first poll starts at defaultStartBlock itself.
    return { lastProcessedBlock: (defaultStartBlock - 1n).toString() };
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as IndexerState;
  if (typeof parsed.lastProcessedBlock !== "string") {
    throw new Error(`State file ${path} is malformed: lastProcessedBlock missing or not a string`);
  }
  // Validate it's a parseable BigInt.
  BigInt(parsed.lastProcessedBlock);
  return parsed;
}

// Atomic write: write to <path>.tmp, then rename. Prevents corruption on crash.
export function saveState(path: string, state: IndexerState): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
