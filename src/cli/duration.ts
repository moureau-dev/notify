const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/i.exec(value.trim());

  if (!match) {
    throw new Error("Invalid duration. Use a suffix: 15m, 24h, or 7d.");
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() as keyof typeof UNIT_MS | undefined;
  const unitMs = unit ? UNIT_MS[unit] : undefined;

  if (!Number.isSafeInteger(amount) || amount <= 0 || !unitMs) {
    throw new Error("Invalid duration. Use a positive value like 15m, 24h, or 7d.");
  }

  return amount * unitMs;
}

export function parseTtl(value: string): number {
  const ms = parseDuration(value);

  if (ms < 60_000) throw new Error("--ttl must be at least 1m.");
  if (ms > 24 * 60 * 60 * 1000) throw new Error("--ttl must be at most 24h.");

  return ms;
}
