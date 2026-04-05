import Database from "better-sqlite3";
import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

// ── Constants ────────────────────────────────────────────────────────────

const CACHE_DIR = join(homedir(), ".cache", "mtga-mcp");
const CACHE_DB_PATH = join(CACHE_DIR, "scryfall.db");
const BULK_DATA_URL = "https://api.scryfall.com/bulk-data/default-cards";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Interfaces ───────────────────────────────────────────────────────────

export interface ScryfallEnrichment {
  scryfallUri: string;
  imageUri: string | null;
  prices: Record<string, string | null>;
  legalities: Record<string, string>;
}

/** Shape of a card object in the Scryfall bulk JSON (only the fields we use). */
interface ScryfallBulkCard {
  arena_id?: number | null;
  name: string;
  oracle_text?: string;
  image_uris?: Record<string, string>;
  prices?: Record<string, string | null>;
  legalities?: Record<string, string>;
  scryfall_uri?: string;
  set?: string;
  rarity?: string;
}

// ── Cache directory ──────────────────────────────────────────────────────

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  }
}

// ── Cache age helpers ────────────────────────────────────────────────────

function getCacheAgeMs(): number | null {
  if (!existsSync(CACHE_DB_PATH)) return null;
  try {
    const stat = statSync(CACHE_DB_PATH);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

function formatAge(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function isCacheFresh(): boolean {
  const age = getCacheAgeMs();
  if (age === null) return false;
  return age < CACHE_TTL_MS;
}

// ── SQLite cache DB ──────────────────────────────────────────────────────

let dbInstance: Database.Database | null = null;

function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  ensureCacheDir();

  if (!existsSync(CACHE_DB_PATH)) {
    throw new Error("Scryfall cache DB does not exist yet");
  }

  dbInstance = new Database(CACHE_DB_PATH, { readonly: true });
  return dbInstance;
}

function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function initWritableDb(): Database.Database {
  ensureCacheDir();
  // Close any existing read-only handle
  closeDb();

  const db = new Database(CACHE_DB_PATH);

  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      arena_id      INTEGER PRIMARY KEY,
      name          TEXT NOT NULL,
      oracle_text   TEXT,
      image_uris    TEXT,
      prices        TEXT,
      legalities    TEXT,
      scryfall_uri  TEXT,
      "set"         TEXT,
      rarity        TEXT
    )
  `);

  return db;
}

// ── Download & index ─────────────────────────────────────────────────────

/**
 * Download the Scryfall default-cards bulk data and index it into the cache DB.
 * Streams to a temp file first, then parses, to avoid holding ~70MB in memory
 * during the network transfer.
 */
async function downloadAndIndex(): Promise<{ cardCount: number; downloadedAt: string }> {
  // Step 1: Get the bulk data download URI
  console.error("Scryfall: fetching bulk data manifest...");
  const metaRes = await fetch(BULK_DATA_URL, {
    headers: { "User-Agent": "mtga-mcp-server/1.0 (local CLI tool)" },
  });
  if (!metaRes.ok) {
    throw new Error(`Scryfall API error ${metaRes.status}: ${metaRes.statusText}`);
  }
  const meta = (await metaRes.json()) as { download_uri: string };
  const downloadUri = meta.download_uri;
  if (!downloadUri) {
    throw new Error("Scryfall bulk data response missing download_uri");
  }

  // Step 2: Download bulk JSON to a temp file
  console.error("Scryfall: downloading bulk card data (~70MB)...");
  const tmpFile = join(tmpdir(), `scryfall-bulk-${Date.now()}.json`);

  try {
    const dataRes = await fetch(downloadUri, {
      headers: { "User-Agent": "mtga-mcp-server/1.0 (local CLI tool)" },
    });
    if (!dataRes.ok) {
      throw new Error(`Scryfall download error ${dataRes.status}: ${dataRes.statusText}`);
    }
    if (!dataRes.body) {
      throw new Error("Scryfall download returned no body");
    }

    // Stream the response body to disk
    const nodeStream = Readable.fromWeb(dataRes.body as import("node:stream/web").ReadableStream);
    await pipeline(nodeStream, createWriteStream(tmpFile));

    // Step 3: Parse the JSON file
    console.error("Scryfall: parsing bulk data...");
    const raw = await readFile(tmpFile, "utf-8");
    const cards = JSON.parse(raw) as ScryfallBulkCard[];

    // Step 4: Index into SQLite
    console.error(`Scryfall: indexing ${cards.length} cards...`);
    const db = initWritableDb();

    // Clear existing data for a clean re-index
    db.exec("DELETE FROM cards");

    const insert = db.prepare(`
      INSERT OR REPLACE INTO cards (arena_id, name, oracle_text, image_uris, prices, legalities, scryfall_uri, "set", rarity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((batch: ScryfallBulkCard[]) => {
      for (const card of batch) {
        if (card.arena_id == null) continue;
        insert.run(
          card.arena_id,
          card.name,
          card.oracle_text ?? null,
          card.image_uris ? JSON.stringify(card.image_uris) : null,
          card.prices ? JSON.stringify(card.prices) : null,
          card.legalities ? JSON.stringify(card.legalities) : null,
          card.scryfall_uri ?? null,
          card.set ?? null,
          card.rarity ?? null,
        );
      }
    });

    // Insert in batches of 5000 for efficiency
    const BATCH_SIZE = 5000;
    for (let i = 0; i < cards.length; i += BATCH_SIZE) {
      insertMany(cards.slice(i, i + BATCH_SIZE));
    }

    const countRow = db.prepare("SELECT COUNT(*) as count FROM cards").get() as { count: number };
    const cardCount = countRow.count;

    db.close();

    const downloadedAt = new Date().toISOString();
    console.error(`Scryfall: cached ${cardCount} Arena-mapped cards at ${downloadedAt}`);

    return { cardCount, downloadedAt };
  } finally {
    // Clean up temp file
    try {
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
    } catch {
      // Non-critical — temp cleanup failure is fine
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Ensure the Scryfall cache exists and is fresh.
 * If the cache is missing or stale (>7 days), download fresh data.
 * If download fails but a stale cache exists, reports "stale" and continues.
 */
export async function ensureScryfallCache(): Promise<{
  status: "fresh" | "downloaded" | "failed";
  cardCount: number;
  age?: string;
  error?: string;
}> {
  // Cache is fresh — nothing to do
  if (isCacheFresh()) {
    const age = getCacheAgeMs()!;
    try {
      const db = getDb();
      const row = db.prepare("SELECT COUNT(*) as count FROM cards").get() as { count: number };
      return { status: "fresh", cardCount: row.count, age: formatAge(age) };
    } catch {
      // DB exists but is unreadable — treat as missing and re-download
    }
  }

  // Cache is missing or stale — attempt download
  try {
    const result = await downloadAndIndex();
    return { status: "downloaded", cardCount: result.cardCount };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Scryfall cache download failed: ${errorMsg}`);

    // If a stale cache exists, use it with a warning
    if (existsSync(CACHE_DB_PATH)) {
      const age = getCacheAgeMs()!;
      try {
        const db = getDb();
        const row = db.prepare("SELECT COUNT(*) as count FROM cards").get() as { count: number };
        console.error(`Scryfall: using stale cache (${formatAge(age)} old)`);
        return {
          status: "failed",
          cardCount: row.count,
          age: formatAge(age),
          error: `Download failed (using stale cache): ${errorMsg}`,
        };
      } catch {
        // Stale cache is also unreadable
      }
    }

    return { status: "failed", cardCount: 0, error: errorMsg };
  }
}

/**
 * Force re-download the Scryfall bulk data regardless of cache freshness.
 */
export async function refreshScryfallCache(): Promise<{
  cardCount: number;
  downloadedAt: string;
}> {
  // Close any open read handle before we overwrite the DB
  closeDb();
  return downloadAndIndex();
}

/**
 * Enrich a card by its Arena ID with Scryfall data (prices, images, legalities).
 * Returns null if no mapping exists or the cache isn't available.
 *
 * ~5-8% of Arena cards (digital-only, rebalanced) lack Scryfall mappings — this is expected.
 */
export function enrichCard(arenaId: number): ScryfallEnrichment | null {
  try {
    const db = getDb();

    const row = db
      .prepare(
        `SELECT scryfall_uri, image_uris, prices, legalities FROM cards WHERE arena_id = ?`
      )
      .get(arenaId) as
      | {
          scryfall_uri: string | null;
          image_uris: string | null;
          prices: string | null;
          legalities: string | null;
        }
      | undefined;

    if (!row) return null;

    // Parse image_uris — prefer "normal", fall back to "large", then "small"
    let imageUri: string | null = null;
    if (row.image_uris) {
      try {
        const uris = JSON.parse(row.image_uris) as Record<string, string>;
        imageUri = uris.normal ?? uris.large ?? uris.small ?? null;
      } catch {
        // Malformed JSON — skip
      }
    }

    let prices: Record<string, string | null> = {};
    if (row.prices) {
      try {
        prices = JSON.parse(row.prices) as Record<string, string | null>;
      } catch {
        // Malformed JSON — skip
      }
    }

    let legalities: Record<string, string> = {};
    if (row.legalities) {
      try {
        legalities = JSON.parse(row.legalities) as Record<string, string>;
      } catch {
        // Malformed JSON — skip
      }
    }

    return {
      scryfallUri: row.scryfall_uri ?? "",
      imageUri,
      prices,
      legalities,
    };
  } catch (err) {
    // Graceful degradation — cache not available, DB error, etc.
    console.error(
      `Scryfall enrichment failed for arena_id ${arenaId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Close the Scryfall cache DB (for cleanup on server shutdown).
 */
export function closeScryfallCache(): void {
  closeDb();
}
