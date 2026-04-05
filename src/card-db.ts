import Database from "better-sqlite3";
import { globSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CardData } from "./types.js";

// ── Constants ────────────────────────────────────────────────────────────

const MTGA_RAW_DIR = join(
  homedir(),
  "Library/Application Support/com.wizards.mtga/Downloads/Raw"
);

const DB_GLOB_PATTERN = join(MTGA_RAW_DIR, "Raw_CardDatabase_*.mtga");

const RARITY_MAP: Record<number, string> = {
  0: "Token",
  1: "Basic",
  2: "Common",
  3: "Uncommon",
  4: "Rare",
  5: "Mythic",
};

// ── Interfaces ───────────────────────────────────────────────────────────

export interface SearchFilters {
  name?: string;
  color?: string;
  type?: string;
  rarity?: string;
  set?: string;
  limit?: number;
}

// ── Utilities ────────────────────────────────────────────────────────────

/** The sprite tag used for rebalanced card "A-" prefix in Arena's localization */
const REBALANCED_SPRITE =
  '<sprite="SpriteSheet_MiscIcons" name="arena_a">';

/**
 * Strip Arena HTML markup from localized text.
 * Removes <nobr>, </nobr>, <b>, </b>, <i>, </i> tags.
 * Replaces the rebalanced-card sprite tag with "A-" prefix.
 */
function stripHtml(text: string): string {
  return text
    .replace(
      /<sprite="SpriteSheet_MiscIcons"\s+name="arena_a">/g,
      "A-"
    )
    .replace(/<\/?(?:nobr|b|i)>/gi, "");
}

/**
 * Convert user-facing "A-" prefix back to the sprite tag for DB LIKE queries.
 * E.g. "A-Sorin" → '<sprite=...>Sorin' so the LIKE match works on raw Loc text.
 */
function rebalancedNameToDbPattern(name: string): string {
  if (name.startsWith("A-")) {
    return REBALANCED_SPRITE + name.slice(2);
  }
  return name;
}

/**
 * Convert Arena mana notation to standard MTG notation.
 * `o2oRoG` → `{2}{R}{G}`
 */
function parseManaCost(raw: string): string {
  if (!raw) return "";
  // Split on 'o', skip the empty first element
  const parts = raw.split("o").filter(Boolean);
  return parts.map((p) => `{${p}}`).join("");
}

/**
 * Convert Arena ability-text mana symbols to standard notation.
 * `{o1}` → `{1}`, `{oW}` → `{W}`, `{oT}` → `{T}`, etc.
 */
function cleanAbilityManaSymbols(text: string): string {
  return text.replace(/\{o([^}]+)\}/g, "{$1}");
}

// ── CardDatabase class ───────────────────────────────────────────────────

class CardDatabase {
  private db: Database.Database;
  private enumCache: Map<string, string> | null = null;

  // Prepared statements (lazily created)
  private stmtCardById: Database.Statement | null = null;
  private stmtLocById: Database.Statement | null = null;
  private stmtLocByIdFormatted: Database.Statement | null = null;
  private stmtAbilityById: Database.Statement | null = null;
  private stmtCardByExactName: Database.Statement | null = null;
  private stmtCardByLikeName: Database.Statement | null = null;

  public readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? CardDatabase.findDatabase();
    this.db = new Database(this.dbPath, { readonly: true });
  }

  /**
   * Find the MTGA SQLite database file via glob.
   * Expects exactly one match.
   */
  private static findDatabase(): string {
    const matches = globSync(DB_GLOB_PATTERN);
    if (matches.length === 0) {
      throw new Error(
        `No MTGA card database found. Expected Raw_CardDatabase_*.mtga in ${MTGA_RAW_DIR}. ` +
          "Is MTG Arena installed?"
      );
    }
    if (matches.length > 1) {
      console.error(
        `Warning: Found ${matches.length} card database files, using the first one.`
      );
    }
    return matches[0];
  }

  // ── Enum cache ──────────────────────────────────────────────────────

  /**
   * Load all enum values into a Map keyed by "Type:Value" for O(1) lookups.
   * Uses Formatted=1 (the only row available for most enums).
   */
  private getEnumCache(): Map<string, string> {
    if (this.enumCache) return this.enumCache;

    const rows = this.db
      .prepare(
        `SELECT e.Type, e.Value, l.Loc
         FROM Enums e
         JOIN Localizations_enUS l ON e.LocId = l.LocId
         WHERE l.Formatted = 1`
      )
      .all() as Array<{ Type: string; Value: number; Loc: string }>;

    this.enumCache = new Map();
    for (const row of rows) {
      this.enumCache.set(`${row.Type}:${row.Value}`, row.Loc);
    }
    return this.enumCache;
  }

  /**
   * Resolve a comma-separated list of enum IDs to their localized names.
   */
  private resolveEnums(enumType: string, csv: string): string[] {
    if (!csv || csv.trim() === "") return [];
    const cache = this.getEnumCache();
    return csv
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => cache.get(`${enumType}:${v}`) ?? `Unknown(${v})`)
  }

  // ── Prepared statement getters ──────────────────────────────────────

  private getCardByIdStmt(): Database.Statement {
    if (!this.stmtCardById) {
      this.stmtCardById = this.db.prepare(
        `SELECT c.*, l.Loc as Name
         FROM Cards c
         JOIN Localizations_enUS l ON c.TitleId = l.LocId
         WHERE c.GrpId = ? AND l.Formatted = 1`
      );
    }
    return this.stmtCardById;
  }

  private getAbilityByIdStmt(): Database.Statement {
    if (!this.stmtAbilityById) {
      this.stmtAbilityById = this.db.prepare(
        `SELECT a.Id, a.TextId FROM Abilities a WHERE a.Id = ?`
      );
    }
    return this.stmtAbilityById;
  }

  private getLocByIdStmt(): Database.Statement {
    if (!this.stmtLocById) {
      this.stmtLocById = this.db.prepare(
        `SELECT Loc, Formatted FROM Localizations_enUS WHERE LocId = ? ORDER BY Formatted ASC`
      );
    }
    return this.stmtLocById;
  }

  private getLocByIdFormattedStmt(): Database.Statement {
    if (!this.stmtLocByIdFormatted) {
      this.stmtLocByIdFormatted = this.db.prepare(
        `SELECT Loc FROM Localizations_enUS WHERE LocId = ? AND Formatted = ?`
      );
    }
    return this.stmtLocByIdFormatted;
  }

  private getCardByExactNameStmt(): Database.Statement {
    if (!this.stmtCardByExactName) {
      this.stmtCardByExactName = this.db.prepare(
        `SELECT c.GrpId
         FROM Cards c
         JOIN Localizations_enUS l ON c.TitleId = l.LocId
         WHERE l.Loc = ? AND l.Formatted = 1
         LIMIT 1`
      );
    }
    return this.stmtCardByExactName;
  }

  private getCardByLikeNameStmt(): Database.Statement {
    if (!this.stmtCardByLikeName) {
      this.stmtCardByLikeName = this.db.prepare(
        `SELECT c.GrpId
         FROM Cards c
         JOIN Localizations_enUS l ON c.TitleId = l.LocId
         WHERE l.Loc LIKE ? AND l.Formatted = 1
         LIMIT 25`
      );
    }
    return this.stmtCardByLikeName;
  }

  // ── Ability text resolution ─────────────────────────────────────────

  /**
   * Resolve ability IDs to their text.
   * AbilityIds format: "20264:826381,15:137" — comma-separated abilityId:hash pairs.
   * We look up each abilityId in the Abilities table, get its TextId,
   * then resolve TextId → Localizations_enUS.
   *
   * Prefer Formatted=0 for clean text, fall back to Formatted=1 + stripHtml().
   */
  private resolveAbilities(abilityIds: string): string {
    if (!abilityIds || abilityIds.trim() === "") return "";

    const pairs = abilityIds.split(",").map((p) => p.trim()).filter(Boolean);
    const texts: string[] = [];

    for (const pair of pairs) {
      const abilityId = parseInt(pair.split(":")[0], 10);
      if (isNaN(abilityId)) continue;

      const ability = this.getAbilityByIdStmt().get(abilityId) as
        | { Id: number; TextId: number }
        | undefined;
      if (!ability || !ability.TextId) continue;

      // Try Formatted=0 first (clean text)
      const clean = this.getLocByIdFormattedStmt().get(
        ability.TextId,
        0
      ) as { Loc: string } | undefined;

      if (clean?.Loc) {
        texts.push(cleanAbilityManaSymbols(clean.Loc));
      } else {
        // Fall back to Formatted=1 + stripHtml
        const formatted = this.getLocByIdFormattedStmt().get(
          ability.TextId,
          1
        ) as { Loc: string } | undefined;

        if (formatted?.Loc) {
          texts.push(cleanAbilityManaSymbols(stripHtml(formatted.Loc)));
        }
      }
    }

    return texts.join("\n");
  }

  // ── Core API ────────────────────────────────────────────────────────

  /**
   * Resolve a GrpId to a full CardData object.
   * Returns null if the GrpId doesn't exist.
   */
  resolveCard(grpId: number): CardData | null {
    try {
      const row = this.getCardByIdStmt().get(grpId) as
        | (Record<string, unknown> & { Name: string })
        | undefined;
      if (!row) return null;

      const name = stripHtml(row.Name);
      const colors = this.resolveEnums("CardColor", row.Colors as string);
      const colorIdentity = this.resolveEnums(
        "CardColor",
        row.ColorIdentity as string
      );
      const types = this.resolveEnums("CardType", row.Types as string);
      const subtypes = this.resolveEnums("SubType", row.Subtypes as string);
      const supertypes = this.resolveEnums(
        "SuperType",
        row.Supertypes as string
      );

      const rarityValue = row.Rarity as number;
      const rarity = RARITY_MAP[rarityValue] ?? `Unknown(${rarityValue})`;
      const manaCost = parseManaCost(row.OldSchoolManaText as string);
      const abilities = this.resolveAbilities(row.AbilityIds as string);

      return {
        grpId,
        name,
        manaCost,
        colors,
        colorIdentity,
        types,
        subtypes,
        supertypes,
        rarity,
        rarityValue,
        power: (row.Power as string) || "",
        toughness: (row.Toughness as string) || "",
        set: (row.ExpansionCode as string) || "",
        collectorNumber: (row.CollectorNumber as string) || "",
        abilities,
        isToken: Boolean(row.IsToken),
        isDigitalOnly: Boolean(row.IsDigitalOnly),
        isRebalanced: Boolean(row.IsRebalanced),
      };
    } catch (err) {
      console.error(`Error resolving card GrpId ${grpId}:`, err);
      return null;
    }
  }

  /**
   * Search the card database with optional filters.
   *
   * - name: LIKE '%name%' match (SQL-side)
   * - set: exact match on ExpansionCode (SQL-side)
   * - rarity: converted to int, exact match (SQL-side)
   * - color: application-side filtering after resolving enum IDs
   * - type: application-side filtering after resolving enum IDs
   * - limit: max results (default 25)
   */
  searchCards(filters: SearchFilters = {}): CardData[] {
    const limit = Math.min(filters.limit ?? 25, 100);

    // Build SQL query dynamically — only SQL-safe filters go in WHERE
    const conditions: string[] = ["l.Formatted = 1"];
    const params: unknown[] = [];

    if (filters.name) {
      conditions.push("l.Loc LIKE ?");
      // Convert "A-" prefix to the sprite tag so LIKE matches raw DB text
      params.push(`%${rebalancedNameToDbPattern(filters.name)}%`);
    }

    if (filters.set) {
      conditions.push("c.ExpansionCode = ?");
      params.push(filters.set);
    }

    if (filters.rarity) {
      const rarityInt = this.rarityStringToInt(filters.rarity);
      if (rarityInt !== null) {
        conditions.push("c.Rarity = ?");
        params.push(rarityInt);
      }
    }

    // For color and type, we need to query broadly and filter in application code
    // because they're comma-separated enum IDs in the DB
    const needsColorFilter = Boolean(filters.color);
    const needsTypeFilter = Boolean(filters.type);

    // If we need app-side filtering, fetch more rows to compensate for filtering
    const fetchLimit = needsColorFilter || needsTypeFilter ? limit * 10 : limit;

    const sql = `
      SELECT c.GrpId
      FROM Cards c
      JOIN Localizations_enUS l ON c.TitleId = l.LocId
      WHERE ${conditions.join(" AND ")}
      LIMIT ?
    `;

    params.push(fetchLimit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      GrpId: number;
    }>;

    // Resolve each card and apply app-side filters
    const results: CardData[] = [];
    const colorFilter = filters.color?.toLowerCase();
    const typeFilter = filters.type?.toLowerCase();

    for (const row of rows) {
      if (results.length >= limit) break;

      const card = this.resolveCard(row.GrpId);
      if (!card) continue;

      // Color filter: check if any of the card's colors match
      if (colorFilter) {
        const matches = card.colors.some(
          (c) => c.toLowerCase() === colorFilter
        );
        if (!matches) continue;
      }

      // Type filter: check types, subtypes, and supertypes
      if (typeFilter) {
        const allTypes = [
          ...card.types,
          ...card.subtypes,
          ...card.supertypes,
        ].map((t) => t.toLowerCase());
        const matches = allTypes.some((t) => t === typeFilter);
        if (!matches) continue;
      }

      results.push(card);
    }

    return results;
  }

  /**
   * Get a single card by name or GrpId.
   *
   * - If a number, resolve directly by GrpId.
   * - If a string, try exact match first, then LIKE fallback.
   *   Returns null if no match found.
   *   If multiple LIKE matches, returns the first one.
   */
  getCard(nameOrId: string | number): CardData | null {
    // Numeric GrpId
    if (typeof nameOrId === "number") {
      return this.resolveCard(nameOrId);
    }

    // String — could be a numeric string
    const asNum = parseInt(nameOrId, 10);
    if (!isNaN(asNum) && String(asNum) === nameOrId.trim()) {
      return this.resolveCard(asNum);
    }

    // Convert "A-" prefix to sprite tag for DB matching
    const dbName = rebalancedNameToDbPattern(nameOrId);

    // Exact name match (works for non-rebalanced cards and sprite-tag names)
    const exact = this.getCardByExactNameStmt().get(dbName) as
      | { GrpId: number }
      | undefined;
    if (exact) {
      return this.resolveCard(exact.GrpId);
    }

    // LIKE fallback — handles partial matches and rebalanced card names
    const likeResults = this.getCardByLikeNameStmt().all(
      `%${dbName}%`
    ) as Array<{ GrpId: number }>;

    if (likeResults.length > 0) {
      return this.resolveCard(likeResults[0].GrpId);
    }

    return null;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  /**
   * Convert a rarity string to its integer value.
   */
  private rarityStringToInt(rarity: string): number | null {
    const map: Record<string, number> = {
      token: 0,
      basic: 1,
      common: 2,
      uncommon: 3,
      rare: 4,
      mythic: 5,
    };
    return map[rarity.toLowerCase()] ?? null;
  }
}

// ── Singleton factory ────────────────────────────────────────────────────

let instance: CardDatabase | null = null;

/**
 * Get or create the shared CardDatabase instance.
 * Call this from MCP tool handlers — it lazily opens the DB on first use.
 */
export function getCardDatabase(dbPath?: string): CardDatabase {
  if (!instance) {
    instance = new CardDatabase(dbPath);
  }
  return instance;
}

/**
 * Close the shared instance (for cleanup on server shutdown).
 */
export function closeCardDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export { CardDatabase, stripHtml, parseManaCost, cleanAbilityManaSymbols };
