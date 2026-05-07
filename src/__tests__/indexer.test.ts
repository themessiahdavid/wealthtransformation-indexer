import { describe, it, expect } from "vitest";
import { eventToPayload } from "../indexer.js";

describe("eventToPayload", () => {
  it("maps a Purchased log to the IAT webhook shape", () => {
    const evt = {
      transactionHash: "0xabc" as `0x${string}`,
      logIndex: 7,
      blockNumber: 12345678n,
      blockHash: "0xdef" as `0x${string}`,
      args: {
        buyer: "0x1111111111111111111111111111111111111111" as `0x${string}`,
        tier: 5,
        submittedSponsor: "0x2222222222222222222222222222222222222222" as `0x${string}`,
        effectiveSponsor: "0x3333333333333333333333333333333333333333" as `0x${string}`,
        earningSeller: "0x4444444444444444444444444444444444444444" as `0x${string}`,
        commissionRecipient: "0x5555555555555555555555555555555555555555" as `0x${string}`,
        productAmount: 60_000_000n,
        adminAmount: 6_000_000n,
        isPassup: false,
        becameAffiliate: true,
      },
    };
    // Cast through unknown so we don't have to reproduce viem's full Log shape.
    const payload = eventToPayload(
      evt as unknown as Parameters<typeof eventToPayload>[0],
      { chain: "BASE_SEPOLIA", iatTenantId: "tenant-x" },
      1714000000,
    );
    expect(payload).toEqual({
      txHash: "0xabc",
      logIndex: 7,
      blockNumber: 12345678,
      chain: "BASE_SEPOLIA",
      buyer: "0x1111111111111111111111111111111111111111",
      tier: 5,
      sponsor: "0x3333333333333333333333333333333333333333", // effectiveSponsor, not submittedSponsor
      tenantId: "tenant-x",
      occurredAt: new Date(1714000000 * 1000).toISOString(),
    });
  });

  it("uses effectiveSponsor when it differs from submittedSponsor", () => {
    const evt = {
      transactionHash: "0xa" as `0x${string}`,
      logIndex: 0,
      blockNumber: 1n,
      blockHash: "0xb" as `0x${string}`,
      args: {
        buyer: "0xa".padEnd(42, "0") as `0x${string}`,
        tier: 1,
        submittedSponsor: "0xfa".padEnd(42, "0") as `0x${string}`, // user passed this in
        effectiveSponsor: "0xeb".padEnd(42, "0") as `0x${string}`, // contract used this (their stored directSponsor)
        earningSeller: "0xa".padEnd(42, "0") as `0x${string}`,
        commissionRecipient: "0xa".padEnd(42, "0") as `0x${string}`,
        productAmount: 1n,
        adminAmount: 1n,
        isPassup: false,
        becameAffiliate: false,
      },
    };
    const payload = eventToPayload(
      evt as unknown as Parameters<typeof eventToPayload>[0],
      { chain: "BASE_SEPOLIA", iatTenantId: "t" },
      0,
    );
    expect(payload.sponsor).toBe("0xeb".padEnd(42, "0"));
    expect(payload.sponsor).not.toBe("0xfa".padEnd(42, "0"));
  });
});
