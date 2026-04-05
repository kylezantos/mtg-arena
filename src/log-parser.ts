import { readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  GameData,
  DeckData,
  DeckCardEntry,
  InventoryData,
  RankData,
  CollectionEntry,
} from "./types.js";

// ── Log file paths ───────────────────────────────────────────────────

const LOG_DIR = join(homedir(), "Library/Logs/Wizards Of The Coast/MTGA");
const PRIMARY_LOG = join(LOG_DIR, "Player.log");
const FALLBACK_LOG = join(LOG_DIR, "Player-prev.log");

// ── Cache ────────────────────────────────────────────────────────────

let cachedData: GameData | null = null;
let cachedMtime: number = 0;
let cachedFileSize: number = 0;
let cachedLogPath: string = "";

// ── Public API ───────────────────────────────────────────────────────

export function parseGameData(): GameData {
  const logPath = resolveLogPath();

  if (!logPath) {
    return emptyGameData("none", "No Player.log found");
  }

  const stat = statSync(logPath);
  const mtime = stat.mtimeMs;
  const size = stat.size;

  // Return cached if same file, same mtime, and file didn't shrink (shrink = MTGA restart)
  if (
    cachedData &&
    cachedLogPath === logPath &&
    cachedMtime === mtime &&
    size >= cachedFileSize
  ) {
    return cachedData;
  }

  const result = parseLogFile(logPath);

  cachedData = result;
  cachedMtime = mtime;
  cachedFileSize = size;
  cachedLogPath = logPath;

  return result;
}

// ── Log path resolution ──────────────────────────────────────────────

function resolveLogPath(): string | null {
  // Try primary log first
  if (existsSync(PRIMARY_LOG)) {
    const content = readFileSync(PRIMARY_LOG, "utf-8");
    if (content.length > 0 && content.includes("<== StartHook(")) {
      return PRIMARY_LOG;
    }
  }

  // Fallback to prev log
  if (existsSync(FALLBACK_LOG)) {
    const content = readFileSync(FALLBACK_LOG, "utf-8");
    if (content.length > 0 && content.includes("<== StartHook(")) {
      return FALLBACK_LOG;
    }
  }

  // If primary exists but has no StartHook, still return it so we report something
  if (existsSync(PRIMARY_LOG)) return PRIMARY_LOG;
  if (existsSync(FALLBACK_LOG)) return FALLBACK_LOG;

  return null;
}

// ── Main parser ──────────────────────────────────────────────────────

function parseLogFile(logPath: string): GameData {
  const raw = readFileSync(logPath, "utf-8");
  const lines = raw.split("\n");

  const detailedLogs = detectDetailedLogs(lines);
  const startHookPayload = extractStartHookPayload(lines);
  const rankPayload = extractRankPayload(lines);
  const collectionPayload = extractCollectionPayload(lines);

  let inventory: InventoryData | null = null;
  let decks: DeckData[] = [];
  let collection: CollectionEntry[] = [];
  let dataSource: "complete" | "inferred_from_decks" = "inferred_from_decks";

  if (startHookPayload) {
    inventory = parseInventory(startHookPayload.InventoryInfo);
    decks = parseDecks(
      startHookPayload.Decks,
      startHookPayload.DeckSummariesV2
    );

    // Collection: prefer GetPlayerCardsV3 if available, otherwise infer from decks
    if (collectionPayload) {
      collection = Object.entries(collectionPayload).map(([id, qty]) => ({
        cardId: Number(id),
        quantity: qty as number,
      }));
      dataSource = "complete";
    } else {
      collection = inferCollectionFromDecks(decks);
      dataSource = "inferred_from_decks";
    }
  }

  const rank = rankPayload ? parseRank(rankPayload) : null;
  const stat = statSync(logPath);

  return {
    inventory,
    decks,
    collection,
    rank,
    meta: {
      logFile: logPath,
      parsedAt: new Date().toISOString(),
      detailedLogsEnabled: detailedLogs,
      dataSource,
      logModifiedAt: stat.mtimeMs,
    },
  };
}

// ── Detailed logs detection ──────────────────────────────────────────

function detectDetailedLogs(lines: string[]): boolean {
  const headerLines = lines.slice(0, 20);
  for (const line of headerLines) {
    if (line.includes("DETAILED LOGS: ENABLED")) return true;
    if (line.includes("DETAILED LOGS: DISABLED")) return false;
  }
  return false;
}

// ── StartHook extraction ─────────────────────────────────────────────
// The JSON payload sits on the line immediately after `<== StartHook(`

interface StartHookData {
  InventoryInfo: Record<string, unknown>;
  Decks: Record<string, RawDeck>;
  DeckSummariesV2: RawDeckSummary[];
  CardMetadataInfo: Record<string, unknown>;
}

interface RawDeck {
  MainDeck: DeckCardEntry[];
  Sideboard: DeckCardEntry[];
  CommandZone: DeckCardEntry[];
  Companions: DeckCardEntry[];
  CardSkins: unknown[];
}

interface RawDeckSummary {
  DeckId: string;
  Name: string;
  Attributes: Array<{ name: string; value: string }>;
  FormatLegalities: Record<string, boolean>;
}

function extractStartHookPayload(lines: string[]): StartHookData | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("<== StartHook(")) {
      const jsonLine = lines[i + 1];
      if (!jsonLine) return null;

      try {
        const parsed = JSON.parse(jsonLine);

        // Allowlist: only extract the fields we need
        return {
          InventoryInfo: parsed.InventoryInfo ?? {},
          Decks: parsed.Decks ?? {},
          DeckSummariesV2: parsed.DeckSummariesV2 ?? [],
          CardMetadataInfo: parsed.CardMetadataInfo ?? {},
        };
      } catch (err) {
        console.error("Failed to parse StartHook JSON:", (err as Error).message);
        return null;
      }
    }
  }
  return null;
}

// ── Rank extraction ──────────────────────────────────────────────────
// JSON payload is on the line after `<== RankGetCombinedRankInfo(`

function extractRankPayload(lines: string[]): Record<string, unknown> | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("<== RankGetCombinedRankInfo(")) {
      const jsonLine = lines[i + 1];
      if (!jsonLine) return null;

      try {
        return JSON.parse(jsonLine);
      } catch (err) {
        console.error("Failed to parse rank JSON:", (err as Error).message);
        return null;
      }
    }
  }
  return null;
}

// ── Collection extraction (GetPlayerCardsV3) ─────────────────────────

function extractCollectionPayload(
  lines: string[]
): Record<string, number> | null {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("GetPlayerCardsV3")) {
      // The JSON could be on the same line or the next line
      // Try the next line first (matching the StartHook pattern)
      const jsonLine = lines[i + 1];
      if (!jsonLine) continue;

      try {
        const parsed = JSON.parse(jsonLine);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed as Record<string, number>;
        }
      } catch {
        // Not valid JSON on next line — try same line after the marker
        const idx = lines[i].indexOf("{");
        if (idx !== -1) {
          try {
            return JSON.parse(lines[i].slice(idx));
          } catch {
            // Give up on this occurrence
          }
        }
      }
    }
  }
  return null;
}

// ── Inventory parsing ────────────────────────────────────────────────

function parseInventory(raw: Record<string, unknown>): InventoryData {
  const customTokens = (raw.CustomTokens ?? {}) as Record<string, number>;

  return {
    gems: asNumber(raw.Gems),
    gold: asNumber(raw.Gold),
    wildcards: {
      common: asNumber(raw.WildCardCommons),
      uncommon: asNumber(raw.WildCardUnCommons),
      rare: asNumber(raw.WildCardRares),
      mythic: asNumber(raw.WildCardMythics),
    },
    vaultProgress: asNumber(raw.TotalVaultProgress),
    boosters: Array.isArray(raw.Boosters) ? raw.Boosters : [],
    draftTokens: asNumber(customTokens.Token_Draft),
    sealedTokens: asNumber(customTokens.Token_Sealed),
  };
}

// ── Deck parsing ─────────────────────────────────────────────────────

function parseDecks(
  decksMap: Record<string, RawDeck>,
  summaries: RawDeckSummary[]
): DeckData[] {
  const result: DeckData[] = [];

  for (const summary of summaries) {
    const deckCards = decksMap[summary.DeckId];
    if (!deckCards) continue;

    const formatAttr = summary.Attributes?.find((a) => a.name === "Format");
    const format = formatAttr?.value ?? "Unknown";
    const isPrecon = summary.Name.startsWith("?=?Loc/Decks/Precon/");

    result.push({
      id: summary.DeckId,
      name: summary.Name,
      format,
      mainDeck: normalizeDeckEntries(deckCards.MainDeck),
      sideboard: normalizeDeckEntries(deckCards.Sideboard),
      commandZone: normalizeDeckEntries(deckCards.CommandZone),
      companions: normalizeDeckEntries(deckCards.Companions),
      isPrecon,
    });
  }

  return result;
}

function normalizeDeckEntries(entries: unknown): DeckCardEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((e) => ({
    cardId: asNumber((e as Record<string, unknown>).cardId),
    quantity: asNumber((e as Record<string, unknown>).quantity),
  }));
}

// ── Rank parsing ─────────────────────────────────────────────────────

function parseRank(raw: Record<string, unknown>): RankData {
  return {
    constructed: {
      class: asString(raw.constructedClass),
      level: asNumber(raw.constructedLevel),
      step: asNumber(raw.constructedStep),
      matchesWon: asNumber(raw.constructedMatchesWon),
      matchesLost: asNumber(raw.constructedMatchesLost),
    },
    limited: {
      // limitedClass does NOT exist in the 2026 client
      class: raw.limitedClass != null ? asString(raw.limitedClass) : null,
      level: asNumber(raw.limitedLevel),
      step: asNumber(raw.limitedStep),
      matchesWon: asNumber(raw.limitedMatchesWon),
      matchesLost: asNumber(raw.limitedMatchesLost),
    },
  };
}

// ── Collection inference from decks ──────────────────────────────────

function inferCollectionFromDecks(decks: DeckData[]): CollectionEntry[] {
  const cardQuantities = new Map<number, number>();

  for (const deck of decks) {
    const allEntries = [
      ...deck.mainDeck,
      ...deck.sideboard,
      ...deck.commandZone,
    ];

    for (const entry of allEntries) {
      const existing = cardQuantities.get(entry.cardId) ?? 0;
      if (entry.quantity > existing) {
        cardQuantities.set(entry.cardId, entry.quantity);
      }
    }
  }

  return Array.from(cardQuantities.entries()).map(([cardId, quantity]) => ({
    cardId,
    quantity,
  }));
}

// ── Empty / error state ──────────────────────────────────────────────

function emptyGameData(logFile: string, _reason: string): GameData {
  return {
    inventory: null,
    decks: [],
    collection: [],
    rank: null,
    meta: {
      logFile,
      parsedAt: new Date().toISOString(),
      detailedLogsEnabled: false,
      dataSource: "inferred_from_decks",
      logModifiedAt: 0,
    },
  };
}

// ── Utilities ────────────────────────────────────────────────────────

function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value != null) return String(value);
  return "";
}
