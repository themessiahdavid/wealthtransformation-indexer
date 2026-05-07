import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState } from "../state.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wt-indexer-state-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadState", () => {
  it("returns defaultStartBlock - 1 when file doesn't exist", () => {
    const path = join(tmp, "nope.json");
    const state = loadState(path, 1000n);
    expect(state.lastProcessedBlock).toBe("999");
  });

  it("loads existing state", () => {
    const path = join(tmp, "state.json");
    writeFileSync(path, JSON.stringify({ lastProcessedBlock: "12345" }));
    const state = loadState(path, 1n);
    expect(state.lastProcessedBlock).toBe("12345");
  });

  it("throws on malformed state file", () => {
    const path = join(tmp, "bad.json");
    writeFileSync(path, JSON.stringify({ wrongKey: 1 }));
    expect(() => loadState(path, 1n)).toThrow(/malformed/);
  });

  it("throws if lastProcessedBlock is not parseable as BigInt", () => {
    const path = join(tmp, "bad.json");
    writeFileSync(path, JSON.stringify({ lastProcessedBlock: "not-a-number" }));
    expect(() => loadState(path, 1n)).toThrow();
  });
});

describe("saveState", () => {
  it("writes JSON with mode 0600", () => {
    const path = join(tmp, "state.json");
    saveState(path, { lastProcessedBlock: "999" });
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.lastProcessedBlock).toBe("999");
  });

  it("is atomic — temp file is gone after rename", () => {
    const path = join(tmp, "state.json");
    saveState(path, { lastProcessedBlock: "1" });
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("round-trips through load", () => {
    const path = join(tmp, "state.json");
    saveState(path, { lastProcessedBlock: "999999999999" });
    const loaded = loadState(path, 1n);
    expect(loaded.lastProcessedBlock).toBe("999999999999");
    expect(BigInt(loaded.lastProcessedBlock)).toBe(999999999999n);
  });
});
