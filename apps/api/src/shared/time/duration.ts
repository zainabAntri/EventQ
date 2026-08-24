/**
 * Duration parsing for configured TTLs (`15m`, `12h`, `30d`).
 *
 * Config values are human-readable strings so `.env` stays legible, but every
 * consumer wants a number. Parsing in one place means a malformed value fails
 * loudly and identically everywhere.
 */

const MULTIPLIERS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function parseDurationMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) {
    throw new Error(`Unsupported duration "${value}". Expected a form like "15m", "12h" or "30d".`);
  }

  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof MULTIPLIERS;
  return amount * MULTIPLIERS[unit];
}

export function parseDurationSeconds(value: string): number {
  return Math.floor(parseDurationMs(value) / 1000);
}
