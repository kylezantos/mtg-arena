import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────

const CACHE_DIR = join(homedir(), ".cache", "mtga-mcp", "17lands");

const API_BASE = "https://www.17lands.com/card_ratings/data";

const DEFAULT_FORMAT = "PremierDraft";

/** Cache is valid for 7 days */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Interfaces ───────────────────────────────────────────────────────────

export interface DraftRating {
  name: string;
  color: string;
  rarity: string;
  gihwr: number; // Games In Hand Win Rate
  gdwr: number; // Games Drawn Win Rate
  ohwr: number; // Opening Hand Win Rate
  iwd: number; // Improvement When Drawn
  alsa: number; // Average Last Seen At
  ata: number; // Average Taken At
}

/** Raw shape of a single card entry from the 17Lands API */
interface RawCardRating {
  name: string;
  color: string;
  rarity: string;
  ever_drawn_win_rate: number | null;
  games_drawn_win_rate: number | null;
  opening_hand_win_rate: number | null;
  drawn_improvement_win_rate: number | null;
  avg_seen: number | null;
  avg_pick: number | null;
  [key: string]: unknown;
}

interface CachedResponse {
  _cachedAt: string;
  data: RawCardRating[];
}

// ── Cache helpers ────────────────────────────────────────────────────────

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function cacheFilePath(set: string, format: string): string {
  return join(CACHE_DIR, `${set.toUpperCase()}_${format}.json`);
}

function readCache(
  set: string,
  format: string
): { data: RawCardRating[]; cachedAt: string; stale: boolean } | null {
  const filePath = cacheFilePath(set, format);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const cached: CachedResponse = JSON.parse(raw);

    if (!cached._cachedAt || !Array.isArray(cached.data)) return null;

    const age = Date.now() - new Date(cached._cachedAt).getTime();
    const stale = age > CACHE_TTL_MS;

    return { data: cached.data, cachedAt: cached._cachedAt, stale };
  } catch (err) {
    console.error(`Failed to read 17Lands cache for ${set}/${format}:`, err);
    return null;
  }
}

function writeCache(set: string, format: string, data: RawCardRating[]): string {
  ensureCacheDir();
  const cachedAt = new Date().toISOString();
  const payload: CachedResponse = { _cachedAt: cachedAt, data };
  writeFileSync(cacheFilePath(set, format), JSON.stringify(payload), "utf-8");
  return cachedAt;
}

// ── Date helpers ─────────────────────────────────────────────────────────

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function defaultDateRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 90 * 24 * 60 * 60 * 1000);
  return { start: formatDate(start), end: formatDate(end) };
}

// ── Field mapping ────────────────────────────────────────────────────────

function mapRating(raw: RawCardRating): DraftRating | null {
  // Filter out cards with null/undefined GIHWR — insufficient data
  if (raw.ever_drawn_win_rate == null) return null;

  return {
    name: raw.name,
    color: raw.color ?? "",
    rarity: raw.rarity ?? "",
    gihwr: raw.ever_drawn_win_rate,
    gdwr: raw.games_drawn_win_rate ?? 0,
    ohwr: raw.opening_hand_win_rate ?? 0,
    iwd: raw.drawn_improvement_win_rate ?? 0,
    alsa: raw.avg_seen ?? 0,
    ata: raw.avg_pick ?? 0,
  };
}

// ── API fetch ────────────────────────────────────────────────────────────

async function fetchFromApi(
  set: string,
  format: string
): Promise<RawCardRating[]> {
  const { start, end } = defaultDateRange();
  const upperSet = set.toUpperCase();

  const url = new URL(API_BASE);
  url.searchParams.set("expansion", upperSet);
  url.searchParams.set("format", format);
  url.searchParams.set("start_date", start);
  url.searchParams.set("end_date", end);

  console.error(`Fetching 17Lands data: ${url.toString()}`);

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      // Identify ourselves as a reasonable user-agent
      "User-Agent": "mtga-mcp-server/1.0.0",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `17Lands API returned ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as RawCardRating[];
  return data;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch 17Lands card performance data for a given set and draft format.
 *
 * - Uses a 7-day file cache to avoid hammering the API.
 * - Falls back to stale cache if the API is unreachable.
 * - Returns ratings sorted by GIHWR descending.
 */
export async function getDraftRatings(
  set: string,
  format?: string
): Promise<{
  ratings: DraftRating[];
  cachedAt: string | null;
  fromCache: boolean;
}> {
  const resolvedFormat = format ?? DEFAULT_FORMAT;
  const upperSet = set.toUpperCase();

  // Check cache first
  const cached = readCache(upperSet, resolvedFormat);

  if (cached && !cached.stale) {
    // Fresh cache — use it directly
    console.error(
      `Using cached 17Lands data for ${upperSet}/${resolvedFormat} (cached ${cached.cachedAt})`
    );
    const ratings = cached.data
      .map(mapRating)
      .filter((r): r is DraftRating => r !== null)
      .sort((a, b) => b.gihwr - a.gihwr);

    return { ratings, cachedAt: cached.cachedAt, fromCache: true };
  }

  // Cache is missing or stale — try fetching fresh data
  try {
    const rawData = await fetchFromApi(upperSet, resolvedFormat);

    if (rawData.length === 0) {
      // API returned empty — set might not have data yet
      if (cached) {
        // Return stale cache if available
        console.error(
          `17Lands returned no data for ${upperSet}/${resolvedFormat}, using stale cache`
        );
        const ratings = cached.data
          .map(mapRating)
          .filter((r): r is DraftRating => r !== null)
          .sort((a, b) => b.gihwr - a.gihwr);

        return { ratings, cachedAt: cached.cachedAt, fromCache: true };
      }

      return {
        ratings: [],
        cachedAt: null,
        fromCache: false,
      };
    }

    // Write fresh data to cache
    const cachedAt = writeCache(upperSet, resolvedFormat, rawData);

    const ratings = rawData
      .map(mapRating)
      .filter((r): r is DraftRating => r !== null)
      .sort((a, b) => b.gihwr - a.gihwr);

    return { ratings, cachedAt, fromCache: false };
  } catch (err) {
    // API is unreachable — fall back to stale cache if available
    const message =
      err instanceof Error ? err.message : String(err);
    console.error(`17Lands API error: ${message}`);

    if (cached) {
      console.error(
        `Falling back to stale 17Lands cache for ${upperSet}/${resolvedFormat} (cached ${cached.cachedAt})`
      );
      const ratings = cached.data
        .map(mapRating)
        .filter((r): r is DraftRating => r !== null)
        .sort((a, b) => b.gihwr - a.gihwr);

      return { ratings, cachedAt: cached.cachedAt, fromCache: true };
    }

    // No cache at all — propagate a clear error
    throw new Error(
      `Failed to fetch 17Lands data for ${upperSet}/${resolvedFormat} and no cached data is available. ` +
        `Error: ${message}`
    );
  }
}
