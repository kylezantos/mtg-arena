import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCardDatabase } from "./card-db.js";
import { parseGameData } from "./log-parser.js";
import type { ToolMeta, GameData } from "./types.js";

const VERSION = "1.0.0";

const MTGA_DATA_DIR = join(
  homedir(),
  "Library/Application Support/com.wizards.mtga/Downloads/Raw"
);
const MTGA_LOG_DIR = join(
  homedir(),
  "Library/Logs/Wizards Of The Coast/MTGA"
);

const server = new McpServer({
  name: "mtga-mcp-server",
  version: VERSION,
  description:
    "MTG Arena data server — access your cards, decks, collection, and inventory",
});

// ── Helpers ─────────────────────────────────────────────────────────────

function buildMeta(gameData: GameData): ToolMeta {
  const meta: ToolMeta = {
    parsedAt: gameData.meta.parsedAt,
    logFile: gameData.meta.logFile,
  };

  // Check staleness — warn if log is > 24 hours old
  const logAge = Date.now() - gameData.meta.logModifiedAt;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  if (logAge > TWENTY_FOUR_HOURS) {
    const hoursAgo = Math.round(logAge / (60 * 60 * 1000));
    meta.staleness = `Log file is ${hoursAgo} hours old. Launch MTGA to refresh data.`;
  }

  if (!gameData.meta.detailedLogsEnabled) {
    meta.staleness =
      (meta.staleness ? meta.staleness + " " : "") +
      "WARNING: Detailed Logs are disabled. Enable in MTGA Options > Account > Detailed Logs (Plugin Support), then restart MTGA.";
  }

  return meta;
}

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

// ── Status tool (diagnostic) ────────────────────────────────────────────

server.registerTool(
  "status",
  {
    description:
      "Check if the MTGA MCP server is running and whether MTGA data files are found",
    inputSchema: {},
  },
  async () => {
    const dataDir = existsSync(MTGA_DATA_DIR);
    const logFile = existsSync(join(MTGA_LOG_DIR, "Player.log"));
    const prevLogFile = existsSync(join(MTGA_LOG_DIR, "Player-prev.log"));

    const warnings: string[] = [];
    if (!dataDir)
      warnings.push("MTGA data directory not found — is MTG Arena installed?");
    if (!logFile && !prevLogFile)
      warnings.push(
        "No Player.log found — launch MTGA with Detailed Logs enabled"
      );

    return textResult({
      server: "mtga-mcp-server",
      version: VERSION,
      status: warnings.length === 0 ? "ready" : "degraded",
      dataFiles: {
        cardDatabase: dataDir,
        playerLog: logFile,
        playerPrevLog: prevLogFile,
      },
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }
);

// ── get_inventory (R6) ──────────────────────────────────────────────────

server.registerTool(
  "get_inventory",
  {
    description:
      "Get your MTGA inventory — gems, gold, wildcards, vault progress, boosters, and tokens",
    inputSchema: {},
  },
  async () => {
    try {
      const gameData = parseGameData();
      if (!gameData.inventory) {
        return errorResult(
          "No inventory data found. Launch MTGA with Detailed Logs enabled, navigate past the home screen, then try again."
        );
      }
      return textResult({
        ...gameData.inventory,
        _meta: buildMeta(gameData),
      });
    } catch (err) {
      return errorResult(
        `Failed to read inventory: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
);

// ── get_collection (R5) ─────────────────────────────────────────────────

server.registerTool(
  "get_collection",
  {
    description:
      "Get your card collection with optional filters. Returns cards you own with quantities. Note: if GetPlayerCardsV3 is unavailable, collection is inferred from deck lists (incomplete — cards not in any deck are not shown).",
    inputSchema: {
      set: z.string().optional().describe("Filter by set code (e.g., 'FDN', 'DSK')"),
      rarity: z
        .enum(["common", "uncommon", "rare", "mythic", "basic", "token"])
        .optional()
        .describe("Filter by rarity"),
      color: z
        .string()
        .optional()
        .describe("Filter by color (e.g., 'White', 'Blue', 'Red', 'Green', 'Black', 'Colorless')"),
      type: z
        .string()
        .optional()
        .describe("Filter by card type (e.g., 'Creature', 'Instant', 'Sorcery')"),
      limit: z
        .number()
        .min(1)
        .max(200)
        .optional()
        .describe("Max results to return (default 50)"),
    },
  },
  async ({ set, rarity, color, type, limit }) => {
    try {
      const gameData = parseGameData();
      const db = getCardDatabase();
      const maxResults = limit ?? 50;

      // Resolve all collection entries to card data
      let results = gameData.collection
        .map((entry) => {
          const card = db.resolveCard(entry.cardId);
          if (!card) return null;
          return { ...card, quantity: entry.quantity };
        })
        .filter((c) => c !== null);

      // Apply filters
      if (set) {
        const upperSet = set.toUpperCase();
        results = results.filter((c) => c.set === upperSet);
      }
      if (rarity) {
        const lowerRarity = rarity.charAt(0).toUpperCase() + rarity.slice(1).toLowerCase();
        results = results.filter((c) => c.rarity === lowerRarity);
      }
      if (color) {
        const lowerColor = color.toLowerCase();
        results = results.filter((c) =>
          c.colors.some((clr) => clr.toLowerCase() === lowerColor)
        );
      }
      if (type) {
        const lowerType = type.toLowerCase();
        results = results.filter((c) =>
          c.types.some((t) => t.toLowerCase() === lowerType)
        );
      }

      const total = results.length;
      results = results.slice(0, maxResults);

      const meta = buildMeta(gameData);
      meta.dataSource = gameData.meta.dataSource;

      const response: Record<string, unknown> = {
        total,
        showing: results.length,
        cards: results.map((c) => ({
          name: c.name,
          quantity: c.quantity,
          set: c.set,
          rarity: c.rarity,
          colors: c.colors,
          manaCost: c.manaCost,
          types: c.types,
        })),
        _meta: meta,
      };

      if (gameData.meta.dataSource === "inferred_from_decks") {
        response._warning =
          "Collection data inferred from deck lists. Cards not in any deck are not shown. This is a partial view of your collection.";
      }

      return textResult(response);
    } catch (err) {
      return errorResult(
        `Failed to read collection: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
);

// ── get_decks (R7) ──────────────────────────────────────────────────────

server.registerTool(
  "get_decks",
  {
    description: "List all your MTGA decks with names, formats, and card counts",
    inputSchema: {
      format: z
        .string()
        .optional()
        .describe("Filter by format (e.g., 'Standard', 'Historic', 'HistoricBrawl')"),
      hide_precons: z
        .boolean()
        .optional()
        .describe("Hide preconstructed decks (default false)"),
    },
  },
  async ({ format, hide_precons }) => {
    try {
      const gameData = parseGameData();
      let decks = gameData.decks;

      if (hide_precons) {
        decks = decks.filter((d) => !d.isPrecon);
      }
      if (format) {
        const lowerFormat = format.toLowerCase();
        decks = decks.filter((d) => d.format.toLowerCase().includes(lowerFormat));
      }

      return textResult({
        total: decks.length,
        decks: decks.map((d) => ({
          name: d.name,
          format: d.format,
          mainDeckCount: d.mainDeck.reduce((sum, c) => sum + c.quantity, 0),
          sideboardCount: d.sideboard.reduce((sum, c) => sum + c.quantity, 0),
          isPrecon: d.isPrecon,
        })),
        _meta: buildMeta(gameData),
      });
    } catch (err) {
      return errorResult(
        `Failed to read decks: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
);

// ── get_deck (R8) ───────────────────────────────────────────────────────

server.registerTool(
  "get_deck",
  {
    description:
      "Get a specific deck's full card list resolved to names with mana costs, types, and quantities",
    inputSchema: {
      name: z.string().describe("Deck name (partial match supported)"),
    },
  },
  async ({ name }) => {
    try {
      const gameData = parseGameData();
      const db = getCardDatabase();
      const lowerName = name.toLowerCase();

      // Try exact match first, then includes
      let deck = gameData.decks.find(
        (d) => d.name.toLowerCase() === lowerName
      );
      if (!deck) {
        deck = gameData.decks.find((d) =>
          d.name.toLowerCase().includes(lowerName)
        );
      }

      if (!deck) {
        // Find similar deck names for helpful error
        const similar = gameData.decks
          .filter((d) => !d.isPrecon)
          .map((d) => d.name)
          .slice(0, 15);
        return errorResult(
          `Deck "${name}" not found. Your non-precon decks:\n${similar.map((n) => `  - ${n}`).join("\n")}`
        );
      }

      const resolveEntries = (entries: { cardId: number; quantity: number }[]) =>
        entries
          .map((e) => {
            const card = db.resolveCard(e.cardId);
            if (!card) return null;
            return {
              name: card.name,
              quantity: e.quantity,
              manaCost: card.manaCost,
              colors: card.colors,
              types: card.types,
              rarity: card.rarity,
              set: card.set,
            };
          })
          .filter((c) => c !== null);

      return textResult({
        name: deck.name,
        format: deck.format,
        isPrecon: deck.isPrecon,
        mainDeck: resolveEntries(deck.mainDeck),
        sideboard: resolveEntries(deck.sideboard),
        commandZone: resolveEntries(deck.commandZone),
        _meta: buildMeta(gameData),
      });
    } catch (err) {
      return errorResult(
        `Failed to read deck: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
);

// ── get_rank (R9) ───────────────────────────────────────────────────────

server.registerTool(
  "get_rank",
  {
    description:
      "Get your constructed and limited rank info (class, level, step, win/loss)",
    inputSchema: {},
  },
  async () => {
    try {
      const gameData = parseGameData();
      if (!gameData.rank) {
        return errorResult(
          "No rank data found. Launch MTGA and play at least one game, then try again."
        );
      }
      return textResult({
        ...gameData.rank,
        _meta: buildMeta(gameData),
      });
    } catch (err) {
      return errorResult(
        `Failed to read rank: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
);

// ── search_cards (R10) ──────────────────────────────────────────────────

server.registerTool(
  "search_cards",
  {
    description:
      "Search the full MTGA card database (24,413 cards) by name, color, type, rarity, or set. Returns card details including ability text.",
    inputSchema: {
      name: z.string().optional().describe("Card name to search for (partial match)"),
      color: z
        .string()
        .optional()
        .describe("Filter by color: White, Blue, Black, Red, Green, Colorless"),
      type: z
        .string()
        .optional()
        .describe("Filter by card type: Creature, Instant, Sorcery, Enchantment, Artifact, Land, Planeswalker"),
      rarity: z
        .enum(["common", "uncommon", "rare", "mythic", "basic", "token"])
        .optional()
        .describe("Filter by rarity"),
      set: z.string().optional().describe("Filter by set code (e.g., 'FDN', 'DSK', 'MOM')"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe("Max results (default 25, max 100)"),
    },
  },
  async ({ name, color, type, rarity, set, limit }) => {
    try {
      const db = getCardDatabase();
      const results = db.searchCards({
        name,
        color,
        type,
        rarity,
        set,
        limit: limit ?? 25,
      });

      if (results.length === 0) {
        const parts = [];
        if (name) parts.push(`name="${name}"`);
        if (color) parts.push(`color=${color}`);
        if (type) parts.push(`type=${type}`);
        if (rarity) parts.push(`rarity=${rarity}`);
        if (set) parts.push(`set=${set}`);
        return textResult({
          total: 0,
          cards: [],
          message: `No cards found matching: ${parts.join(", ")}. Try broadening your search.`,
        });
      }

      return textResult({
        total: results.length,
        cards: results.map((c) => ({
          name: c.name,
          grpId: c.grpId,
          manaCost: c.manaCost,
          colors: c.colors,
          types: c.types,
          subtypes: c.subtypes,
          rarity: c.rarity,
          power: c.power || undefined,
          toughness: c.toughness || undefined,
          set: c.set,
          abilities: c.abilities || undefined,
        })),
      });
    } catch (err) {
      return errorResult(
        `Search failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
);

// ── get_card (R12) ──────────────────────────────────────────────────────

server.registerTool(
  "get_card",
  {
    description:
      "Get full details for a specific card by name or Arena ID (GrpId)",
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe("Card name (exact match preferred, falls back to partial)"),
      grpId: z.number().optional().describe("Arena card ID (GrpId)"),
    },
  },
  async ({ name, grpId }) => {
    try {
      if (!name && grpId === undefined) {
        return errorResult("Provide either a card name or grpId.");
      }

      const db = getCardDatabase();
      const card = db.getCard(grpId ?? name!);

      if (!card) {
        if (name) {
          // Try to suggest similar cards
          const similar = db.searchCards({ name, limit: 5 });
          if (similar.length > 0) {
            return textResult({
              error: `Card "${name}" not found. Did you mean one of these?`,
              suggestions: similar.map((c) => c.name),
            });
          }
        }
        return errorResult(
          `Card not found: ${name ?? `GrpId ${grpId}`}. Check the name or ID and try again.`
        );
      }

      return textResult(card);
    } catch (err) {
      return errorResult(
        `Failed to get card: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
);

// ── Start server ────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`mtga-mcp-server v${VERSION} running on stdio`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

export { server, MTGA_DATA_DIR, MTGA_LOG_DIR };
