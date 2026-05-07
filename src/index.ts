import { config } from "./config.js";
import { makeLogger } from "./log.js";
import { runIndexer } from "./indexer.js";

const log = makeLogger(config.logLevel);

const abort = new AbortController();
process.on("SIGINT", () => {
  log.info("shutdown_requested", { signal: "SIGINT" });
  abort.abort();
});
process.on("SIGTERM", () => {
  log.info("shutdown_requested", { signal: "SIGTERM" });
  abort.abort();
});

runIndexer(config, log, abort.signal).catch((err) => {
  log.error("indexer_fatal", {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
