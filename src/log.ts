type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function makeLogger(minLevel: string) {
  const min = LEVELS[(minLevel as Level) ?? "info"] ?? 20;
  function log(level: Level, msg: string, meta?: Record<string, unknown>) {
    if (LEVELS[level] < min) return;
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...meta,
    };
    process.stdout.write(JSON.stringify(line) + "\n");
  }
  return {
    debug: (msg: string, meta?: Record<string, unknown>) => log("debug", msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => log("info", msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => log("warn", msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => log("error", msg, meta),
  };
}

export type Logger = ReturnType<typeof makeLogger>;
