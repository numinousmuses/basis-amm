export type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.BASIS_LOG_LEVEL as Level) ?? "info"] ?? 20;
export function log(level: Level, svc: string, msg: string, extra?: Record<string, unknown>) {
  if (order[level] < min) return;
  const line = { t: new Date().toISOString(), level, svc, msg, ...extra };
  (level === "error" || level === "warn" ? console.error : console.log)(JSON.stringify(line, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
