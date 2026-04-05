export interface CardData {
  grpId: number;
  name: string;
  manaCost: string;
  colors: string[];
  colorIdentity: string[];
  types: string[];
  subtypes: string[];
  supertypes: string[];
  rarity: string;
  rarityValue: number;
  power: string;
  toughness: string;
  set: string;
  collectorNumber: string;
  abilities: string;
  isToken: boolean;
  isDigitalOnly: boolean;
  isRebalanced: boolean;
}

export interface DeckCardEntry {
  cardId: number;
  quantity: number;
}

export interface DeckData {
  id: string;
  name: string;
  format: string;
  mainDeck: DeckCardEntry[];
  sideboard: DeckCardEntry[];
  commandZone: DeckCardEntry[];
  companions: DeckCardEntry[];
  isPrecon: boolean;
}

export interface InventoryData {
  gems: number;
  gold: number;
  wildcards: {
    common: number;
    uncommon: number;
    rare: number;
    mythic: number;
  };
  vaultProgress: number;
  boosters: unknown[];
  draftTokens: number;
  sealedTokens: number;
}

export interface RankData {
  constructed: {
    class: string;
    level: number;
    step: number;
    matchesWon: number;
    matchesLost: number;
  };
  limited: {
    class: string | null;
    level: number;
    step: number;
    matchesWon: number;
    matchesLost: number;
  };
}

export interface CollectionEntry {
  cardId: number;
  quantity: number;
}

export interface GameData {
  inventory: InventoryData | null;
  decks: DeckData[];
  collection: CollectionEntry[];
  rank: RankData | null;
  meta: {
    logFile: string;
    parsedAt: string;
    detailedLogsEnabled: boolean;
    dataSource: "complete" | "inferred_from_decks" | "untapped";
    logModifiedAt: number;
  };
}

export interface ToolMeta {
  parsedAt: string;
  logFile: string;
  dataSource?: "complete" | "inferred_from_decks" | "untapped";
  staleness?: string;
}
