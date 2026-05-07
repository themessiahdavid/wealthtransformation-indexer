// Minimal ABI for the indexer — only the Purchased event.
//
// Source of truth: src/WealthTransformation.sol in the contract repo.
// If the contract event signature ever changes, update this ABI to match
// or the indexer will silently miss events.
export const PURCHASED_EVENT_ABI = {
  type: "event",
  name: "Purchased",
  inputs: [
    { indexed: true, name: "buyer", type: "address" },
    { indexed: true, name: "tier", type: "uint8" },
    { indexed: false, name: "submittedSponsor", type: "address" },
    { indexed: false, name: "effectiveSponsor", type: "address" },
    { indexed: true, name: "earningSeller", type: "address" },
    { indexed: false, name: "commissionRecipient", type: "address" },
    { indexed: false, name: "productAmount", type: "uint256" },
    { indexed: false, name: "adminAmount", type: "uint256" },
    { indexed: false, name: "isPassup", type: "bool" },
    { indexed: false, name: "becameAffiliate", type: "bool" },
  ],
} as const;
