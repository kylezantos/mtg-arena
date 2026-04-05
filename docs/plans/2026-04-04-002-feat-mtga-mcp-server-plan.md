---
title: "feat: MTG Arena MCP Server for Claude Code"
type: feat
status: completed
date: 2026-04-04
origin: docs/brainstorms/2026-04-04-mtga-mcp-server-requirements.md
---

# feat: MTG Arena MCP Server for Claude Code

## Overview

Build a TypeScript MCP server that gives Claude Code real-time access to Kyle's MTG Arena data — card collection, decks, inventory, rank, and the full card database. The server reads from MTGA's local files (Player.log + SQLite card database) and exposes MCP tools that Claude can query conversationally.

Phased delivery: Phase 1 ships a fully functional offline server using only local data. Phase 2 adds optional external enrichment (Scryfall prices/legality, 17Lands draft ratings) that degrades gracefully if unavailable.

## Problem Frame

Kyle plays MTG Arena but Claude Code can't see his cards, decks, or game state. All the data exists locally — a 222MB SQLite card database and a Player.log with inventory/deck/rank data. This server bridges the gap so Claude can help with deck building and collection analysis grounded in what Kyle actually owns. (see origin: `docs/brainstorms/2026-04-04-mtga-mcp-server-requirements.md`)

## Requirements Trace

**Phase 1 — Core (must ship):**
- R1. MCP server (TypeScript, stdio transport, `.mcp.json`)
- R2. Parse Player.log on-demand for inventory, decks, rank, collection
- R3. Resolve Arena card IDs via local SQLite database
- R4. Detect and warn when detailed logging is disabled
- R5. `get_collection` — card collection with filtering (warn when inferred from decks)
- R6. `get_inventory` — gems, gold, wildcards, vault progress
- R7. `get_decks` — list all decks with names and formats
- R8. `get_deck` — full card list resolved to names
- R9. `get_rank` — constructed and limited rank info
- R10. `search_cards` — search card database by name, color, type, rarity, set
- R12. `get_card` — full details for a specific card
- R17. Fall back to Player-prev.log when current log is empty

**Phase 2 — Enrichment (ship next, degrades gracefully):**
- R11. Scryfall enrichment for prices, images, format legality
- R13. `get_draft_ratings` — 17Lands card performance data
- R15. Scryfall bulk data cache (weekly refresh)
- R16. 17Lands cache per set

**Descoped from R14:** `evaluate_draft_pack` is removed. Claude can rank draft picks conversationally given the raw 17Lands data from R13 — building a ranking algorithm into the server adds complexity without value over Claude's reasoning.

## Scope Boundaries

- macOS-only (Kyle's machine)
- Read-only — no game file modification, no process injection, no data uploads
- No real-time game state tracking (protobuf decoding is future work)
- The Preferences plist (`com.wizards.mtga.plist`) must NEVER be read — it contains JWT tokens and login credentials
- Phase 2 enrichment is optional — the server must be fully useful without internet

## Context & Research

### Relevant Data (verified on disk)

**SQLite Card Database** (`~/Library/Application Support/com.wizards.mtga/Downloads/Raw/Raw_CardDatabase_*.mtga`):
- 24,413 cards across tables: `Cards`, `Abilities`, `Enums`, `Localizations_enUS`
- Card names: `Cards.TitleId` → `Localizations_enUS.LocId` where `Formatted=1` (primary — covers 24,409 cards). `Formatted=0` exists only for ~785 hyphenated names. Use `Formatted=1` and strip HTML tags (`<nobr>`, `<sprite>`) from the result.
- Rules text: `Cards.AbilityIds` is comma-separated `abilityId:hash` pairs → `Abilities.Id` → `Abilities.TextId` → `Localizations_enUS.LocId` (`Formatted=0` for clean text; `Formatted=1` has HTML markup like `<nobr>+1/+1</nobr>`)
- Colors: comma-separated enum IDs (0=Colorless, 1=W, 2=U, 3=B, 4=R, 5=G, 6=Land, 7=Artifact) — requires Enums table lookup (`Formatted=1` only; no `Formatted=0` rows for enums)
- Types/Subtypes: comma-separated enum IDs — requires Enums table lookup (`Formatted=1`)
- Rarity: integer (0=Token, 1=Basic, 2=Common, 3=Uncommon, 4=Rare, 5=Mythic)
- Mana cost: `OldSchoolManaText` in Arena notation (`o2oRoG` = `{2}{R}{G}`)
- Database filename includes a content hash that changes with game updates

**Player.log** (`~/Library/Logs/Wizards Of The Coast/MTGA/Player.log`):
- `[UnityCrossThreadLogger]==>` prefix for request lines; `<==` response lines are bare (no prefix)
- StartHook response is a single 1.4MB JSON payload containing most session data
- `InventoryInfo`: gems, gold, wildcards, vault progress, boosters, cosmetics
- `Decks`: dict keyed by UUID → `{MainDeck, Sideboard, CommandZone, Companions, CardSkins}`
- `DeckSummariesV2`: array with `Name`, `DeckId`, `Attributes` (array of `{name, value}` pairs — format is at `Attributes.find(a => a.name === 'Format').value`, not a top-level field), `FormatLegalities`. Link via `DeckId` = Decks dict key
- `RankGetCombinedRankInfo`: constructed + limited rank details
- `GetPlayerCardsV3`: full collection — **not yet observed in 2026 client**, fallback is to infer from deck card lists (1,961 unique cards across 93 decks)
- MTGA clears the log on startup — previous session saved as `Player-prev.log`
- `DETAILED LOGS: DISABLED` or `DETAILED LOGS: ENABLED` appears near the top of the log

### MCP SDK (TypeScript)

- Package: `@modelcontextprotocol/sdk` (^1.29.0), ESM-only
- Server class: `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`
- Transport: `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`
- Tools registered via `server.registerTool(name, { description, inputSchema }, handler)`
- Input schemas use Zod objects (plain object of Zod schemas, not `z.object()` wrapper)
- Return format: `{ content: [{ type: "text", text: "..." }] }` with optional `isError: true`
- **Critical**: never use `console.log()` — it corrupts the stdio JSON-RPC stream. Use `console.error()` only.
- tsconfig requires `module: "Node16"` and `moduleResolution: "Node16"`
- package.json requires `"type": "module"`

### SQLite in Node.js

- Package: `better-sqlite3` — synchronous API (ideal for request-response MCP tools), reads from disk (not into memory), prebuilt binaries for macOS ARM
- Open with `{ readonly: true }` since we only read MTGA's database
- Prepared statements for repeated queries

### Open Source References

- `gathering-gg/parser` (Go): best log format documentation with 21 typed event categories
- `MagicTheGatheringArena-Tools` (TypeScript/oclif): closest existing CLI, collection export + Scryfall resolution

## Key Technical Decisions

- **`better-sqlite3` over `sql.js`**: Native speed, reads from disk (not 222MB into memory), synchronous API fits MCP's request-response model. Prebuilt binaries available for macOS ARM — no compiler needed.
- **Formatted=1 + HTML stripping for card names**: `Formatted=1` is the primary localization row (24,409 cards). `Formatted=0` exists for only ~785 hyphenated names. Use `Formatted=1` and strip `<nobr>`, `<sprite>` tags. For ability text, use `Formatted=0` (clean text) with `Formatted=1` as fallback with HTML stripping.
- **Local ability text over Scryfall for oracle text**: The Abilities table provides rules text via `AbilityIds → Abilities.TextId → Localizations_enUS`. Format uses `{oN}` instead of `{N}` but is parseable. Scryfall enrichment becomes optional, not required.
- **LIKE matching over fuzzy search**: Claude can clarify card names conversationally. Prefix/LIKE matching against the SQLite DB is simple and fast. No need for edit-distance algorithms.
- **Collection inference from decks as primary path**: `GetPlayerCardsV3` hasn't been observed in the 2026 client. The server will search for it in the log but default to inferring collection from all deck card lists. Tool responses will include a `dataSource` field indicating whether the data is "complete" or "inferred_from_decks".
- **Weekly Scryfall refresh (not daily)**: Card data changes quarterly with set releases. 70MB daily downloads add no value.
- **Pre-process Scryfall into SQLite index**: Parsing 70MB JSON on every MCP server startup is too slow. Download once, build a local SQLite lookup table, query from that.
- **No evaluate_draft_pack tool**: Claude can rank picks given the raw 17Lands data. Building a ranking algorithm into the server adds maintenance cost without value.
- **Data freshness metadata in every response**: Every tool response includes when the underlying data was last parsed, and warnings when data appears stale (log older than 24 hours) or when expected events are missing. (see origin: review finding #12)
- **File access allowlist**: The server only reads from: the SQLite card DB path, Player.log, Player-prev.log, and its own cache directory. The Preferences plist is explicitly excluded. (see origin: review finding #9)

## Open Questions

### Resolved During Planning

- **Collection data source**: Use `GetPlayerCardsV3` if found in the log. Fall back to inferring from all deck card lists in the StartHook. Include `dataSource: "complete" | "inferred_from_decks"` in responses. The inferred path covers 1,961 unique cards — incomplete but useful with a clear warning.
- **17Lands API endpoint**: The correct endpoint is `GET https://www.17lands.com/card_ratings/data?expansion={SET}&format={FORMAT}&start_date={START}&end_date={END}`. Date params are required for non-null metrics. Response field names differ from display names (e.g., `ever_drawn_win_rate` not `GIHWR`).
- **Scryfall arena_id coverage**: Not all GrpIds map to Scryfall (confirmed: GrpId 27212 returns 404). Digital-only and rebalanced cards (~5-8%) may lack mappings. The enrichment layer must handle missing mappings gracefully — return local-only data for unmapped cards.

### Deferred to Implementation

- **Exact GetPlayerCardsV3 trigger**: Test whether navigating to the MTGA Collection tab fires the event in 2026. If it does, document the required navigation in server instructions.
- **Abilities table completeness**: Verify whether all cards have complete rules text or if some are partial (missing reminder text, multi-ability formatting). Sample 100 cards during implementation.
- **Concurrent log reads**: Verify macOS file behavior when MTGA is writing to Player.log while the server reads it. `Player.log` is not a high-frequency write; reads should be safe.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Code                           │
│  "What rare cards do I own in Standard?"                │
└──────────────────────┬──────────────────────────────────┘
                       │ MCP stdio
                       ▼
┌──────────────────────────────────────────────────────────┐
│                   MCP Server (index.ts)                  │
│                                                          │
│  Tools: get_collection, get_inventory, get_decks,        │
│         get_deck, get_rank, search_cards, get_card,      │
│         get_draft_ratings (Phase 2)                      │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Card DB      │  │  Log Parser  │  │  Cache Layer  │  │
│  │  (card-db.ts) │  │  (log-       │  │  (Phase 2)    │  │
│  │              │  │   parser.ts) │  │               │  │
│  │  SQLite      │  │  Player.log  │  │  Scryfall     │  │
│  │  read-only   │  │  Player-     │  │  17Lands      │  │
│  │              │  │  prev.log    │  │               │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         │                 │                   │          │
└─────────┼─────────────────┼───────────────────┼──────────┘
          ▼                 ▼                   ▼
   Raw_CardDatabase   Player.log          Scryfall API
   _*.mtga (SQLite)   Player-prev.log     17Lands API
```

**Data flow for `get_deck("Hwalter Hwhite")`:**
1. Log parser reads StartHook from Player.log
2. Find deck UUID in DeckSummariesV2 by name match
3. Get card list from Decks[uuid].MainDeck
4. For each `{cardId, quantity}`, resolve via Card DB: name, mana cost, colors, types, abilities
5. Return formatted deck list with metadata

## Implementation Units

### Phase 1 — Core (offline, no external dependencies)

- [ ] **Unit 1: Project Scaffold + MCP Server Skeleton**

**Goal:** Working MCP server that Claude Code can connect to, with a `status` tool confirming the server is running.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`
- Create: `.mcp.json`
- Create: `.gitignore`
- Create: `.nvmrc` (pin Node.js version for consistent better-sqlite3 prebuild availability)
- Create: `src/types.ts` (shared type definitions: CardData, GameData, InventoryData, DeckData, RankData)

**Approach:**
- ESM project with `"type": "module"` and `module: "Node16"`
- `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod` as dependencies
- `tsx` for dev, `tsc` for build
- `status` tool returns server version, connection status, and whether MTGA data files are found (implementation convenience for debugging — not traced to a specific requirement)
- `.mcp.json` configured for `node build/index.js` with the server

**Patterns to follow:**
- MCP SDK `McpServer` + `StdioServerTransport` pattern from research
- `console.error()` for all logging (never `console.log()`)

**Test scenarios:**
- Happy path: `npm run build` succeeds, server starts without errors on stderr
- Happy path: `.mcp.json` is valid JSON with correct stdio transport config
- Edge case: server handles missing MTGA data directory gracefully (returns status with warnings)

**Verification:**
- `claude mcp list` shows the server
- Calling the `status` tool from Claude Code returns version info

---

- [ ] **Unit 2: Card Database Reader**

**Goal:** Read the MTGA SQLite card database and resolve Arena card IDs to full card data including names, mana costs, colors, types, rarity, and ability text.

**Requirements:** R3 (R10 and R12 are fulfilled when the MCP tools in Unit 5 expose this module's functions)

**Dependencies:** Unit 1

**Files:**
- Create: `src/card-db.ts`
- Create: `src/tests/card-db.test.ts`

**Approach:**
- Dynamic file discovery: glob for `Raw_CardDatabase_*.mtga` in `~/Library/Application Support/com.wizards.mtga/Downloads/Raw/`, pick the file (should be exactly one)
- Open with `better-sqlite3` in readonly mode
- Build an enum resolution cache on first access: load all Enums rows into a Map keyed by `(Type, Value)` for O(1) lookups
- Utility function: `stripHtml(text: string)` — remove `<nobr>`, `</nobr>`, `<b>`, `</b>`, `<i>`, `</i>`, and replace `<sprite="SpriteSheet_MiscIcons" name="arena_a">` with `A-` (rebalanced card prefix)
- Card resolution function: `resolveCard(grpId: number) → CardData`
  - Join `Cards` with `Localizations_enUS` (`Formatted=1`) for name, then `stripHtml()` the result
  - Parse `Colors` field: split by comma, map each int via Enums (`Formatted=1`) → "Colorless", "White", "Blue", "Black", "Red", "Green", "Land", "Artifact"
  - Parse `Types` and `Subtypes` similarly via Enums (`Formatted=1`)
  - Map `Rarity` int: 0→Token, 1→Basic, 2→Common, 3→Uncommon, 4→Rare, 5→Mythic
  - Convert `OldSchoolManaText`: strip `o` prefix from each segment, wrap in braces: `o2oRoG` → `{2}{R}{G}`
  - Parse `AbilityIds`: split by comma, take first value of each colon pair, look up `Abilities.TextId` → `Localizations_enUS.Loc` (prefer `Formatted=0` for clean text, fall back to `Formatted=1` with `stripHtml()`). Concatenate ability texts with newlines.
  - Convert ability text mana symbols: `{o1}` → `{1}`, `{oW}` → `{W}`
- Note: color/type/subtype filtering requires application-side filtering after SQL query, since Colors/Types are comma-separated enum IDs in TEXT columns — not directly queryable with SQL WHERE clauses. Query broadly, then filter in code.
- Card search function: `searchCards(filters) → CardData[]`
  - Build SQL WHERE clause dynamically from provided filters
  - Name filter: `WHERE name LIKE '%query%'` (case-insensitive via SQLite LIKE)
  - Color filter: match against parsed colors
  - Other filters: direct column matches
  - Limit results to 25 by default (consistent with MCP tool default in Unit 5; max 100 enforced at tool layer)

**Patterns to follow:**
- `better-sqlite3` prepared statements for repeated queries
- Enums table for all enum resolution (CardColor, CardType, SubType, SuperType)

**Test scenarios:**
- Happy path: resolve a known GrpId (e.g., 75521 → "Ogre Battledriver") returns correct name, mana cost, colors, rarity
- Happy path: search by name "Shock" returns matching cards with correct data
- Happy path: multi-ability card (e.g., Colossus of Sardia) returns all ability texts concatenated
- Edge case: card with hyphenated name (e.g., "Half-Elf Monk") returns clean text without HTML tags
- Edge case: card with no abilities (basic land) returns empty ability text
- Edge case: multicolor card (e.g., colors "1,3") resolves to ["White", "Black"]
- Edge case: rebalanced card (A- prefix) resolves correctly
- Error path: invalid GrpId returns null/undefined, not a crash
- Error path: missing database file returns clear error message

**Verification:**
- Can resolve any GrpId from the Decks data to a complete CardData object
- Search by name, color, and rarity returns correct results

---

- [ ] **Unit 3: Log Parser**

**Goal:** Parse MTGA's Player.log to extract inventory, decks, deck summaries, rank, and collection data.

**Requirements:** R2, R4, R17

**Dependencies:** Unit 1

**Files:**
- Create: `src/log-parser.ts`
- Create: `src/tests/log-parser.test.ts`

**Approach:**
- Read entire Player.log into memory (typically 1-3MB, acceptable)
- Check for `DETAILED LOGS: ENABLED` / `DISABLED` near the top (first 20 lines)
- Find the StartHook response: scan for `<== StartHook(` line, then read the next line and `JSON.parse()` it directly (the current 2026 client emits the entire 1.4MB payload as a single line). Keep brace-depth tracking as a defensive fallback for future format changes.
- Cache the parsed `GameData` object after first parse — return from cache on subsequent tool calls. Check Player.log file modification time before returning cached data; if the file has changed (especially shrunk, indicating MTGA restart), re-parse.
- From the parsed StartHook, extract only these named sub-objects (allowlist pattern — discard all other fields to prevent leaking auth tokens or session data):
  - `InventoryInfo` → inventory data
  - `Decks` → dict of deck card lists (keyed by UUID)
  - `DeckSummariesV2` → array of deck metadata, linked via `DeckId`
  - `CardMetadataInfo` → non-craftable/non-collectible lists
- Scan the full log for `<== RankGetCombinedRankInfo(` and parse its JSON response
- Scan for `GetPlayerCardsV3` — if found, parse the `{arenaId: quantity}` map as the complete collection
- If `GetPlayerCardsV3` not found, infer collection from all `Decks[*].MainDeck` + `Sideboard` + `CommandZone` entries (deduplicate, take max quantity per cardId)
- Fallback chain: try Player.log first, if empty or no StartHook found, try Player-prev.log
- Return a typed `GameData` object with all extracted data plus metadata (log path used, parse timestamp, data completeness flags)

**Patterns to follow:**
- Line-by-line scanning with brace-depth tracking for multi-line JSON extraction (similar to `gathering-gg/parser`)

**Test scenarios:**
- Happy path: parse a log with StartHook → returns inventory, decks, deck summaries
- Happy path: parse a log with RankGetCombinedRankInfo → returns rank data
- Happy path: detect `DETAILED LOGS: ENABLED` correctly
- Happy path: detect `DETAILED LOGS: DISABLED` and return warning
- Edge case: log file is empty → fall back to Player-prev.log
- Edge case: log has no StartHook event → fall back to Player-prev.log
- Edge case: GetPlayerCardsV3 absent → infer collection from decks with `dataSource: "inferred_from_decks"`
- Edge case: GetPlayerCardsV3 present → use it with `dataSource: "complete"`
- Error path: both log files missing → return structured error with guidance
- Error path: malformed JSON in StartHook → handle gracefully, return partial data with warning
- Integration: verify Decks dict keys match DeckSummariesV2[].DeckId

**Verification:**
- Can extract all data from the actual Player.log on Kyle's machine
- Fallback to Player-prev.log works when current log is insufficient

---

- [ ] **Unit 4: MCP Tools — Collection, Inventory, Decks, Rank**

**Goal:** Register the core MCP tools that expose player-specific data from the log parser.

**Requirements:** R5, R6, R7, R8, R9

**Dependencies:** Unit 2, Unit 3

**Files:**
- Modify: `src/index.ts`

**Approach:**
- Initialize card-db and log-parser on first tool call (lazy init), cache the parsed data in memory for the session
- Each tool returns data with a `_meta` field containing: `parsedAt` (ISO timestamp), `logFile` (which log was used), `dataSource` (for collection: "complete" | "inferred_from_decks"), `staleness` warning if log is >24h old
- `get_collection`: accepts optional filters (set, rarity, color, type). Returns array of `{name, quantity, set, rarity, colors, manaCost}`. If inferred from decks, include warning: "Collection data inferred from deck lists. Cards not in any deck are not shown."
- `get_inventory`: returns `{gems, gold, wildcards: {common, uncommon, rare, mythic}, vaultProgress, boosters, tokens}`
- `get_decks`: returns array of `{id, name, format, cardCount, isPrecon}` — detect precons by `?=?Loc/Decks/Precon/` prefix in name
- `get_deck`: accepts deck name (fuzzy match via includes/toLowerCase). Returns full card list resolved via card-db: `{name, quantity, manaCost, colors, types, rarity}`
- `get_rank`: returns `{constructed: {class, level, step}, limited: {level, step}}` — note: `limitedClass` field is absent from the 2026 client's `RankGetCombinedRankInfo` response. `constructedClass` exists (e.g., "Gold") but limited only has level/step. Consider inferring limited class from level or returning null.

**Patterns to follow:**
- MCP `registerTool` with Zod input schemas
- `isError: true` with actionable error messages for tool failures
- Return `type: "text"` content blocks with JSON.stringify

**Test scenarios:**
- Happy path: `get_collection({rarity: "rare", set: "FDN"})` returns only rare cards from Foundations
- Happy path: `get_inventory` returns gems, gold, wildcards matching the log data
- Happy path: `get_decks` lists all 93 decks with correct names and formats
- Happy path: `get_deck("Hwalter Hwhite")` returns full card list with resolved names
- Happy path: `get_rank` returns rank info
- Edge case: `get_deck("nonexistent")` returns helpful "deck not found" message with list of similar deck names
- Edge case: `get_collection` with no filters returns all inferred cards with quantity
- Edge case: collection response includes `_meta.dataSource` field
- Error path: MTGA never launched → tools return "No MTGA data found. Launch MTGA with Detailed Logs enabled, navigate past the home screen, then try again."

**Verification:**
- Claude Code can ask "what rare cards do I own?" and get a meaningful answer
- Claude Code can ask "show me my Hwalter Hwhite deck" and see the full card list

---

- [ ] **Unit 5: MCP Tools — Card Search & Lookup**

**Goal:** Register search_cards and get_card tools for querying the full card database.

**Requirements:** R10, R12

**Dependencies:** Unit 2

**Files:**
- Modify: `src/index.ts`

**Approach:**
- `search_cards`: accepts `{name?, color?, type?, rarity?, set?, limit?}`. Builds SQL dynamically. Returns up to `limit` (default 25, max 100) results with card details including ability text.
- `get_card`: accepts `{name?  grpId?}`. Returns single card with full details. If name, use exact match first, then LIKE fallback. If multiple matches, return all and let Claude choose.
- Both tools use the card-db module from Unit 2
- No Scryfall dependency — fully offline using local SQLite data

**Patterns to follow:**
- Parameterized SQL queries (never string interpolation for user input)
- Return structured data Claude can reason about

**Test scenarios:**
- Happy path: `search_cards({name: "Lightning"})` returns cards with "Lightning" in the name
- Happy path: `search_cards({color: "red", rarity: "mythic", set: "FDN"})` returns only matching cards
- Happy path: `get_card({name: "Shock"})` returns full card details including ability text
- Happy path: `get_card({grpId: 75521})` returns Ogre Battledriver
- Edge case: `search_cards({name: "zzznotacard"})` returns empty result with helpful message
- Edge case: `get_card({name: "Elf"})` matches multiple → returns all matches
- Edge case: search with no filters returns first 25 cards (not all 24,413)

**Verification:**
- Claude Code can search for cards by any combination of filters
- Card details include ability text from the local database

---

### Phase 2 — Enrichment (optional, external dependencies)

- [ ] **Unit 6: Scryfall Bulk Data Cache & Enrichment**

**Goal:** Download Scryfall bulk data, index by Arena ID, and enrich card responses with prices, images, and format legality.

**Requirements:** R11, R15

**Dependencies:** Unit 2, Unit 5

**Files:**
- Create: `src/scryfall.ts`
- Create: `src/tests/scryfall.test.ts`

**Approach:**
- On first call to any enrichment-needing tool, check for local cache at `~/.cache/mtga-mcp/scryfall.db`
- If missing or >7 days old, download `default_cards` bulk data:
  1. `GET https://api.scryfall.com/bulk-data/default-cards` → get `download_uri`
  2. Download the JSON file (~70MB)
  3. Parse and insert into a local SQLite DB: `arena_id → {oracle_text, image_uris, prices, legalities}`
  4. Only index cards where `arena_id` is not null
- Enrichment function: given a GrpId, look up in the Scryfall SQLite index. Return enrichment data or null if not found (~5-8% of Arena cards lack Scryfall mappings).
- Add a `refresh_scryfall` tool for manual cache refresh (covers the "on-demand" aspect of R15)
- Enrichment data is merged into card responses when available but never blocks them

**Patterns to follow:**
- `better-sqlite3` for the cache DB (same package as card-db)
- Cache directory: `~/.cache/mtga-mcp/` with user-only permissions

**Test scenarios:**
- Happy path: after cache download, enriching a known card (GrpId 87681) returns prices and legalities
- Edge case: card with no Scryfall mapping (digital-only) returns local-only data without error
- Edge case: cache is fresh (<7 days) → no re-download
- Edge case: no internet → tools work with local data only, no crash
- Error path: Scryfall API down → return local-only data with warning

**Verification:**
- Card responses include prices and legality when cache is populated
- Server works completely without ever downloading Scryfall data

---

- [ ] **Unit 7: 17Lands Draft Ratings**

**Goal:** Fetch and cache 17Lands card performance data for draft analysis.

**Requirements:** R13, R16

**Dependencies:** Unit 2

**Files:**
- Create: `src/seventeen-lands.ts`
- Create: `src/tests/seventeen-lands.test.ts`

**Approach:**
- `get_draft_ratings` tool: accepts `{set: string, format?: string}` (format defaults to "PremierDraft")
- Fetch from `https://www.17lands.com/card_ratings/data?expansion={SET}&format={FORMAT}&start_date={START}&end_date={END}`
  - Default date range: set release date to today
  - Map response fields to friendly names: `ever_drawn_win_rate` → `gihwr`, `avg_seen` → `alsa`, `avg_pick` → `ata`, `drawn_improvement_win_rate` → `iwd`
- Cache response JSON in `~/.cache/mtga-mcp/17lands/{SET}_{FORMAT}.json` with timestamp
- Cache TTL: 7 days (card ratings are stable within a set's lifecycle)
- Return cards sorted by GIHWR descending, include name, color, rarity, and all metrics

**Patterns to follow:**
- Same cache directory as Scryfall (`~/.cache/mtga-mcp/`)
- Graceful degradation: if 17Lands is down, return cached data with staleness warning

**Test scenarios:**
- Happy path: `get_draft_ratings({set: "FDN"})` returns card ratings sorted by win rate
- Edge case: cache is fresh → no re-fetch
- Edge case: 17Lands returns empty/null metrics → filter out cards with no data
- Error path: 17Lands API unreachable → return cached data if available, error if not
- Error path: invalid set code → return helpful error listing recent valid sets

**Verification:**
- Claude Code can ask "what are the best commons in FDN draft?" and get 17Lands-backed answers

## System-Wide Impact

- **File access**: Server reads from 3 specific paths (SQLite DB, Player.log, Player-prev.log) plus its own cache at `~/.cache/mtga-mcp/`. No other file access. Plist is explicitly excluded.
- **Error propagation**: All tool errors return `isError: true` with actionable messages. No unhandled exceptions should crash the server.
- **State lifecycle**: Parsed game data is cached in memory for the MCP session lifetime. Stale data is flagged via `_meta.staleness` warnings. No persistent state beyond the Scryfall/17Lands cache.
- **Data sensitivity**: Tool responses must never include email, account ID, or authentication tokens. The log parser should strip any PII fields from the parsed data.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| GetPlayerCardsV3 never fires in 2026 client | Deck inference is the default path with clear incomplete-data warnings. Users can still get useful deck-building help from cards in their decks. |
| MTGA update changes SQLite schema or log format | Dynamic file discovery for the DB. Log parser uses pattern matching, not hardcoded line numbers. Both can be updated quickly. |
| better-sqlite3 native compilation fails | Prebuilt binaries cover macOS ARM. Fallback: document Xcode CLI tools requirement. |
| Scryfall/17Lands APIs change or go down | Phase 2 features degrade gracefully — server works fully offline on Phase 1 alone. |
| Large MCP responses hit context limits | Limit default result counts (25 cards for search, 50 for collection). Include result count and pagination hint in responses. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-04-mtga-mcp-server-requirements.md](docs/brainstorms/2026-04-04-mtga-mcp-server-requirements.md)
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MCP Build Server Tutorial: https://modelcontextprotocol.io/docs/develop/build-server
- Claude Code MCP Docs: https://code.claude.com/docs/en/mcp
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3
- Scryfall API: https://scryfall.com/docs/api
- 17Lands Card Ratings: https://www.17lands.com/card_ratings
- gathering-gg/parser (log format reference): https://github.com/gathering-gg/parser
