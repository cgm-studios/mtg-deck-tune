// The card graph's interaction index, built from the card store alone: each card's abilities (card_graph), the Scryfall
// fields the link rule reads (cards, card_scryfall) and the subtype facts (subtype_facts), with the closure and supply
// tables ported as source. Built once per open store, on the first call that needs it (about a second), so the server
// answers tools/list before any graph work. Index order is store id order (name order), not the graph corpus order.
import type { Database } from "bun:sqlite";
import { Closure, MAPPING_VERSION } from "./closure";
import type { Ability, CardGraph } from "./grammar";
import { InteractionIndex, cardInfo, loadSupply, type CardFields, type CardInfo, type SubtypeFacts } from "./interact";

export type Graph = {
  index: InteractionIndex;
  /** Store card id → index position. A commander-legal card the graph could not translate has none. */
  positionOf: Map<number, number>;
};

type Row = {
  id: number; oracle_id: string; name: string; layout: string; type_line: string; mana_cost: string; keywords: string; color_identity: string;
  colors: string | null; card_faces: string | null; edhrec_rank: number | null; abilities: string;
};

/** Throws unless the store's graph was extracted under the mapping this server's closure and zone tables come from. */
export function checkMappingVersion(db: Database): void {
  const row = db.query("SELECT value FROM meta WHERE key = 'graph_mapping_version'").get() as { value: string } | null;
  if (row?.value !== MAPPING_VERSION) {
    throw new Error(`the card store's graph was extracted under mapping ${row ? row.value : "(none recorded)"}, but this server's ` +
      `closure and zone tables are mapping ${MAPPING_VERSION}; rebuild the store from a corpus of mapping ${MAPPING_VERSION}`);
  }
}

function subtypeFacts(db: Database): SubtypeFacts {
  const rows = db.query("SELECT subtype, creature_only, land_only FROM subtype_facts ORDER BY subtype").all() as { subtype: string; creature_only: number; land_only: number }[];
  if (!rows.length) throw new Error("the card store has no subtype facts (subtype_facts is empty)");
  return {
    creatureOnly: new Set(rows.filter((r) => r.creature_only).map((r) => r.subtype)),
    landOnly: new Set(rows.filter((r) => r.land_only).map((r) => r.subtype)),
    known: new Set(rows.map((r) => r.subtype)),
  };
}

/** Build the index from an open store. Prefer graphOf, which keeps one per store. */
export function buildGraph(db: Database): Graph {
  checkMappingVersion(db);
  const rows = db.query(`SELECT c.id, c.oracle_id, c.name, c.layout, c.type_line, c.mana_cost, c.keywords, c.color_identity,
      s.colors, s.card_faces, s.edhrec_rank, g.abilities
    FROM card_graph g JOIN cards c ON c.id = g.card_id LEFT JOIN card_scryfall s ON s.card_id = c.id ORDER BY c.id`).all() as Row[];
  if (!rows.length) throw new Error("the card store has no card graph (card_graph is empty)");
  const infos: CardInfo[] = rows.map((r) => {
    const abilities = JSON.parse(r.abilities) as Ability[];
    if (!Array.isArray(abilities)) throw new Error(`card_graph row for ${r.name} is not an ability list`);
    const graph: CardGraph = { name: r.name, oracleId: r.oracle_id, abilities };
    return cardInfo(graph, {
      id: r.id, layout: r.layout, typeLine: r.type_line, manaCost: r.mana_cost, keywords: JSON.parse(r.keywords) as string[],
      colorIdentity: [...r.color_identity], colors: r.colors === null ? null : (JSON.parse(r.colors) as string[]),
      faces: r.card_faces === null ? null : (JSON.parse(r.card_faces) as NonNullable<CardFields["faces"]>), edhrecRank: r.edhrec_rank,
    });
  });
  const index = new InteractionIndex(infos, new Closure(), loadSupply(), subtypeFacts(db));
  return { index, positionOf: new Map(infos.map((c, i) => [c.id, i])) };
}

const GRAPHS = new WeakMap<Database, Graph>();

/** The store's interaction index, built on first use and kept for the store's lifetime. */
export function graphOf(db: Database): Graph {
  let g = GRAPHS.get(db);
  if (!g) GRAPHS.set(db, (g = buildGraph(db)));
  return g;
}
