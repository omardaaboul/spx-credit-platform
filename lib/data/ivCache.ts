import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type IvSample = {
  tsIso: string;
  iv_atm: number;
};

const DEFAULT_CACHE_PATH = path.join(process.cwd(), "storage", ".iv_atm_cache.json");

function cachePath(): string {
  return process.env.SPX0DTE_IV_CACHE_PATH || DEFAULT_CACHE_PATH;
}

function toIvDecimal(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 3 ? value / 100 : value;
}

export function loadIvSamples(): IvSample[] {
  try {
    const filePath = cachePath();
    if (!existsSync(filePath)) return [];
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => {
        const tsIso = String((row as Record<string, unknown>).tsIso ?? "");
        const ivRaw = Number((row as Record<string, unknown>).iv_atm);
        const iv = toIvDecimal(ivRaw);
        const ts = Date.parse(tsIso);
        if (!Number.isFinite(ts) || iv == null) return null;
        return { tsIso: new Date(ts).toISOString(), iv_atm: iv } satisfies IvSample;
      })
      .filter((row): row is IvSample => row != null)
      .sort((a, b) => a.tsIso.localeCompare(b.tsIso));
  } catch {
    return [];
  }
}

export function saveIvSamples(rows: IvSample[]): void {
  const filePath = cachePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
}

export function recordIvSample(
  sample: IvSample,
  opts: {
    lookbackDays?: number;
    maxSamples?: number;
  } = {},
): { samples: IvSample[]; sampleCount: number } {
  const lookbackDays = Math.max(7, Number(opts.lookbackDays ?? process.env.VOL_LOOKBACK_DAYS ?? 60));
  const maxSamples = Math.max(100, Number(opts.maxSamples ?? 20_000));

  const ts = Date.parse(sample.tsIso);
  const iv = toIvDecimal(sample.iv_atm);
  if (!Number.isFinite(ts) || iv == null) {
    const existing = loadIvSamples();
    return { samples: existing, sampleCount: existing.length };
  }

  const normalized: IvSample = {
    tsIso: new Date(ts).toISOString(),
    iv_atm: iv,
  };

  const rows = loadIvSamples();
  const byTs = new Map(rows.map((row) => [row.tsIso, row]));
  byTs.set(normalized.tsIso, normalized);

  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const filtered = Array.from(byTs.values())
    .filter((row) => Date.parse(row.tsIso) >= cutoff)
    .sort((a, b) => a.tsIso.localeCompare(b.tsIso))
    .slice(-maxSamples);

  saveIvSamples(filtered);
  return { samples: filtered, sampleCount: filtered.length };
}

export function computePercentile(
  currentIvRaw: number,
  samples: IvSample[],
  lookbackDays: number,
  asOfMs?: number,
): { percentile: number | null; sampleCount: number; insufficient: boolean } {
  const currentIv = toIvDecimal(currentIvRaw);
  if (currentIv == null) return { percentile: null, sampleCount: 0, insufficient: true };

  const anchor = Number.isFinite(asOfMs) ? Number(asOfMs) : Date.now();
  const cutoff = anchor - Math.max(1, lookbackDays) * 24 * 60 * 60 * 1000;
  const values = samples
    .filter((row) => Date.parse(row.tsIso) >= cutoff)
    .map((row) => toIvDecimal(row.iv_atm))
    .filter((row): row is number => row != null)
    .sort((a, b) => a - b);

  if (values.length === 0) return { percentile: null, sampleCount: 0, insufficient: true };
  let lessOrEqual = 0;
  for (const value of values) {
    if (value <= currentIv) lessOrEqual += 1;
  }
  return {
    percentile: Number(((lessOrEqual / values.length) * 100).toFixed(2)),
    sampleCount: values.length,
    insufficient: false,
  };
}
