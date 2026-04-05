---
date: 2026-04-04
topic: mtga-mcp-server
---

# MTG Arena MCP Server for Claude Code

## Problem Frame

Kyle plays MTG Arena but has no way for Claude Code to see his cards, decks, or game state. This makes it impossible for Claude to help with deck building, draft picks, collection analysis, or strategic advice grounded in what Kyle actually owns. All this data exists locally on the machine — it just needs to be surfaced through a programmatic interface.

## Verified Data Sources

These data sources were verified on Kyle's machine during brainstorming:

**Local Files (confirmed working)**

| Source | Path | Contents |
|---|---|---|
| SQLite Card DB | `~/Library/Application Support/com.wizards.mtga/Downloads/Raw/Raw_CardDatabase_*.mtga` | 24,413 cards — names (via `Localizations_enUS`, `Formatted=0` for clean text; `Formatted=1` contains HTML markup), mana costs (Arena-internal notation: `o2oRoG` = `{2}{R}{G}`), colors (comma-separated enum IDs: 1=W, 2=U, 3=B, 4=R, 5=G), types (comma-separated enum IDs via Enums table), rarities (int: 2=C, 3=U, 4=R, 5=M), power/toughness, expansion codes, and rules text (via Abilities table + Localizations_enUS). `GrpId` is the primary key (= Arena card ID). |
| Player.log | `~/Library/Logs/Wizards Of The Coast/MTGA/Player.log` | With detailed logging enabled: inventory (gems/gold/wildcards/vault), all 93 decks with full card lists, rank info, quests, match events. Request lines are prefixed with `[UnityCrossThreadLogger]==>`. Response lines (`<==`) and their JSON payloads appear as bare lines without prefix. JSON blocks can span multiple lines (StartHook is 1.4MB single payload). |
| Player-prev.log | Same directory | Previous session's log (backup). |
| Preferences plist | `~/Library/Preferences/com.wizards.mtga.plist` | Account ID, login email, refresh token (JWT), graphics settings. **Note: contains sensitive credentials — the MCP server must not read or expose this file.** |
| MTGA Proto Schema | `~/Library/Application Support/untapped-companion/mtga.proto` | 4,233-line protobuf schema for the GRE (Game Rules Engine) — describes all in-match game state messages. Extracted by HearthSim/proto-extractor. |
| MTGA App | `/Users/Shared/Epic Games/MagicTheGathering/MTGA.app` | The game itself (Epic Games install). |

**External APIs (researched)**

| API | Use | Key Endpoint |
|---|---|---|
| Scryfall | Card enrichment — oracle text, images, prices, legality | `GET /cards/arena/{grpId}` or bulk download `default_cards` (~70MB JSON). Arena ID field: `arena_id`. Rate limit: 10 req/s. |
| 17Lands | Draft card performance metrics (GIHWR, ALSA, ATA, IWD) | `GET https://www.17lands.com/card_ratings/data?expansion={SET}&format={FORMAT}&start_date={START}&end_date={END}` (date params required for non-null metrics). Also public CSV datasets at `17lands-public.s3.amazonaws.com`. |
| MTGJSON | Alternative bulk card data with `mtgArenaId` mapping | `https://mtgjson.com/api/v5/AllPrintings.json` |

**Key Log Events (from `StartHook` response, verified)**

The `StartHook` response (1.4MB) contains in a single payload:
- `InventoryInfo` — gems, gold, wildcards (C/U/R/M), vault progress, boosters, cosmetics
- `Decks` — dict keyed by deck UUID (not an array), each value containing `{MainDeck, Sideboard, CommandZone, Companions, CardSkins}` with Arena card IDs (`cardId` field = `GrpId` in SQLite)
- `DeckSummariesV2` — array of deck metadata (name, format, legality per format). Link to `Decks` dict via `DeckSummariesV2[].DeckId` matching the dict keys.
- `CardMetadataInfo` — non-craftable (43) and non-collectible (167) card lists

**Known Log Events (from open-source research, not yet verified on this machine)**

| Event | Data |
|---|---|
| `PlayerInventory.GetPlayerCardsV3` | Full collection as `{arenaId: quantity}` map |
| `Deck.GetDeckListsV3` | All decks (older format) |
| `EventGetCombinedRankInfo` | Constructed + Limited rank details |
| `MatchStart` / `MatchEnd` / `MatchCompleted` | Match history with opponent info |
| `CrackBooster` | Pack opening results |
| `IncomingInventoryUpdate` | Delta inventory changes |
| `[Client GRE]` messages | In-match game state (protobuf-encoded) |

## Requirements

**MCP Server Core**

- R1. Build an MCP server (TypeScript, stdio transport) that Claude Code connects to via `.mcp.json`
- R2. Parse the MTGA Player.log file on-demand to extract game data (inventory, decks, rank, collection)
- R3. Resolve Arena card IDs (`GrpId`) to card names and metadata by querying the local SQLite card database directly — no API calls needed for basic resolution
- R4. Prerequisite: MTGA must have "Detailed Logs (Plugin Support)" enabled (Options > Account). The MCP server should detect and warn when detailed logging is disabled (`DETAILED LOGS: DISABLED` in log header)

**Collection & Inventory Tools**

*Terminology: "collection" = owned cards with quantities; "inventory" = account resources (gems, gold, wildcards, vault progress).*

- R5. `get_collection` tool — return the player's card collection with filtering by set, rarity, color, type, format legality. Include quantity owned per card.
- R6. `get_inventory` tool — return gems, gold, wildcards (common/uncommon/rare/mythic), vault progress, boosters, draft/sealed tokens
- R7. `get_decks` tool — list all decks with names, formats, and card counts
- R8. `get_deck` tool — return a specific deck's full card list resolved to names with mana costs, types, and quantities
- R9. `get_rank` tool — return constructed and limited rank info (tier, level, step, win/loss)

**Card Search & Data**

- R10. `search_cards` tool — search the full 24,413-card database by name (fuzzy), color, type, subtype, rarity, set, mana cost, power/toughness. Return card details including oracle text.
- R11. Enrich card data with Scryfall bulk data (cached locally, refreshed periodically) for images, prices, and format legality that the local SQLite DB doesn't provide. (Note: rules text IS available locally via the Abilities table, but Scryfall provides standardized oracle text formatting.)
- R12. `get_card` tool — return full details for a specific card by name or Arena ID

**Draft Analysis**

- R13. `get_draft_ratings` tool — return 17Lands performance data for cards in a specific set (GIHWR, ALSA, ATA, IWD). Cache data locally per set.
- R14. `evaluate_draft_pack` tool — given a list of card names/IDs in a draft pack, return ranked picks using 17Lands data plus color signals

**Data Layer**

- R15. Cache Scryfall bulk data locally (refresh daily or on-demand). Build an Arena ID lookup index on first load.
- R16. Cache 17Lands card ratings per set (refresh weekly or on-demand)
- R17. Handle the Player.log clearing behavior — MTGA clears the log on startup, so the server should read data from the most recent session and fall back to `Player-prev.log` if the current log is empty or does not contain a StartHook event

## Success Criteria

- Claude Code can answer "what rare cards do I own in Standard?" by querying the MCP server — no manual data gathering
- Claude Code can help build a deck by searching cards in the player's collection and suggesting synergies
- Draft evaluation works: given a pack of cards, Claude can rank picks using real 17Lands data
- Card resolution from Arena IDs to names works fully offline using the local SQLite database
- Setup is a single `npm install` + adding to `.mcp.json`

## Scope Boundaries

- **Not in scope**: Real-time game state tracking during matches (protobuf decoding). This is a future enhancement using the `mtga.proto` schema.
- **Not in scope**: Automated gameplay or bot behavior — this is strictly an information/analysis tool
- **Not in scope**: Uploading data to any external service (17Lands, Untapped, etc.)
- **Not in scope**: Modifying game files, injecting into the MTGA process, or any approach that could trigger anti-cheat
- **Not in scope**: Windows/Linux support — macOS-only for now (Kyle's machine)

## Key Decisions

- **MCP server over CLI**: Tightest Claude Code integration — Claude can query data conversationally rather than the user running terminal commands
- **Local SQLite for card resolution**: The MTGA card database is already on disk as SQLite. Querying it directly is instant and works offline. No need for API calls for basic card name/metadata lookups.
- **Scryfall for enrichment**: The local DB lacks oracle text, images, prices, and format legality. Scryfall bulk data fills these gaps.
- **Log parsing (same as Untapped/17Lands)**: All major MTGA companion tools read the Player.log. This is the established, safe approach. No memory injection or API hacking needed.
- **TypeScript**: Matches Kyle's stack (React + Vite / Next.js). MCP SDK has first-class TypeScript support.

## Dependencies / Assumptions

- MTGA must be launched at least once per session to populate the log with current data
- "Detailed Logs (Plugin Support)" must remain enabled in MTGA settings
- The SQLite card database filename includes a hash that changes with game updates — the server should find the most recent `Raw_CardDatabase_*.mtga` file dynamically
- Scryfall bulk data requires internet access for initial download and periodic refresh
- The `GetPlayerCardsV3` event (full collection) may require specific navigation in MTGA (e.g., opening the Collection tab) to trigger. If the event doesn't appear in 2026 MTGA, the collection can be inferred from deck card lists (1,961 unique cards identified across 93 decks in the StartHook)

## Outstanding Questions

### Resolve Before Planning

*None — all product decisions resolved.*

### Deferred to Planning

- [Affects R5][Needs research] How does the 2026 MTGA version surface the full card collection? The `GetPlayerCardsV3` event wasn't observed in the current log session. Investigate whether it fires on specific UI navigation, or if the collection is now embedded in the `StartHook` payload or another event. Fallback: infer collection from deck card lists.
- [Affects R3][Technical] The local SQLite card database filename includes a content hash (`Raw_CardDatabase_7ca9cfb987aa05e873c170add16238ca.mtga`). Implement dynamic file discovery to handle game updates.
- [Affects R11][Technical] Determine the best mapping strategy between the local SQLite DB's `GrpId` and Scryfall's `arena_id`. Verify coverage — do all 24,413 local cards have Scryfall matches?
- [Affects R13][Needs research] Confirm 17Lands API endpoint format and rate limits for card data. The `https://api.17lands.com/card_data` endpoint needs set parameter format validation.
- [Affects R2][Technical] Design the log parser to handle MTGA's mixed-format log: `[UnityCrossThreadLogger]` prefix lines + multi-line JSON blocks + trailing non-JSON text. Reference `gathering-gg/parser` (Go) for the most complete event type documentation.

## Open Source References

| Project | Language | Value |
|---|---|---|
| [gathering-gg/parser](https://github.com/gathering-gg/parser) | Go | Most complete log format documentation (21 event types, fully typed) |
| [MagicTheGatheringArena-Tools](https://github.com/AdamManuel-dev/MagicTheGatheringArena-Tools) | TypeScript | Closest existing CLI — collection export, card resolution via Scryfall |
| [mtga-utils](https://github.com/kelesi/mtga-utils) | Python | Collection export to MTGGoldfish/DeckStats |
| [MTGA_Draft_17Lands](https://github.com/bstaple1/MTGA_Draft_17Lands) | Python | Draft overlay using 17Lands data |

## Next Steps

→ `/ce:plan` for structured implementation planning
