// DT-6.1: what the card store carries beyond the card rows: each card's interaction graph (ISC-69.1), the cards the
// graph could not translate (ISC-69.2), and per commander with an EDHREC page its themes, synergy list and Tagger Deck
// profile (ISC-70). Seam: the store file at DB_PATH, read through bun:sqlite. Every expected value comes from a source
// the store was built from, read here on its own: the graph corpus (data/graph/corpus.json, written by the card graph's
// `extract`), the raw Scryfall files (decompressed by the system gunzip, not the app's reader) and the EDHREC commander
// pages on disk (data/edhrec/). The Tagger Deck profile's definition is mtg-vector's app/tagger.ts, the file next to
// the data folder; the test runs it over each page and compares.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DB_PATH } from "./paths";

const DATA = new URL("../data/", import.meta.url).pathname;
const CORPUS = join(DATA, "graph", "corpus.json");
const EDHREC = join(DATA, "edhrec");

type Relation = { relation: string; hook: string; selector: unknown; object?: unknown };
type Ability = { kind: string; face: number; granted: boolean; relations: Relation[]; source?: string };
type CorpusCard = { name: string; oracleId: string; forgeFile: string; abilities: Ability[]; unmapped: { what: string; detail: string; source?: string }[]; mappingVersion: string };
type Oracle = { oracle_id: string; name: string; legalities?: Record<string, string>; card_faces?: { name: string }[] };

let db: Database;
let corpus: CorpusCard[];
let oracle: Oracle[];
let cardId: Map<string, number>; // oracle id → store card id
let oracleOf: Map<number, string>;

async function rawJSONL(file: string): Promise<any[]> {
  const p = Bun.spawn(["gunzip", "-c", join(DATA, "scryfall", file)], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`gunzip ${file}: ${await new Response(p.stderr).text()}`);
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

beforeAll(async () => {
  db = new Database(DB_PATH, { readonly: true });
  corpus = JSON.parse(readFileSync(CORPUS, "utf8"));
  oracle = await rawJSONL("oracle_cards.jsonl.gz");
  const rows = db.query("SELECT id, oracle_id FROM cards").all() as { id: number; oracle_id: string }[];
  cardId = new Map(rows.map((r) => [r.oracle_id, r.id]));
  oracleOf = new Map(rows.map((r) => [r.id, r.oracle_id]));
}, 60_000);
afterAll(() => db?.close());

// The Forge script line each ability and unmapped construct came from is evidence for the graph's own pages; the store
// leaves it out. Everything else is carried as the corpus has it.
const withoutSource = <T extends { source?: string }>(x: T) => { const { source: _, ...rest } = x; return rest; };

test("ISC-69.1: every card the graph translates is in the store with the events it makes happen and listens for, as the corpus has them", () => {
  expect(corpus.length).toBeGreaterThan(30000); // the corpus is the real one, not an empty file
  const graphRows = db.query("SELECT card_id, forge_file, abilities, unmapped FROM card_graph").all() as { card_id: number; forge_file: string; abilities: string; unmapped: string }[];
  const byCard = new Map(graphRows.map((r) => [r.card_id, r]));
  const hookRows = db.query("SELECT card_id, relation, hook FROM card_graph_hooks").all() as { card_id: number; relation: string; hook: string }[];
  const hooks = new Map<number, Set<string>>();
  for (const h of hookRows) (hooks.get(h.card_id) ?? hooks.set(h.card_id, new Set()).get(h.card_id)!).add(`${h.relation} ${h.hook}`);

  let relations = 0;
  for (const c of corpus) {
    const id = cardId.get(c.oracleId);
    expect(id, `${c.name} is a store card`).toBeDefined();
    const row = byCard.get(id!);
    expect(row, `${c.name} has graph data`).toBeDefined();
    expect(row!.forge_file).toBe(c.forgeFile);
    expect(JSON.parse(row!.abilities)).toEqual(c.abilities.map(withoutSource));
    expect(JSON.parse(row!.unmapped)).toEqual(c.unmapped.map(withoutSource));
    const want = new Set(c.abilities.flatMap((a) => a.relations.map((r) => `${r.relation} ${r.hook}`)));
    expect(hooks.get(id!) ?? new Set()).toEqual(want);
    relations += c.abilities.reduce((n, a) => n + a.relations.length, 0);
  }
  expect(relations).toBeGreaterThan(100000);
  // nothing beyond the corpus: no graph rows, and no hook rows, for a card the graph did not translate
  expect(graphRows.length).toBe(corpus.length);
  expect(new Set(hookRows.map((h) => h.card_id)).size).toBeLessThanOrEqual(corpus.length);
  for (const id of hooks.keys()) expect(byCard.has(id)).toBe(true);
  // the store says which mapping of Forge's vocabulary its graph was translated with
  const meta = new Map((db.query("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((m) => [m.key, m.value]));
  expect(meta.get("graph_mapping_version")).toBe([...new Set(corpus.map((c) => c.mappingVersion))].join(","));
}, 120_000);

test("ISC-69.2: the store's list of commander-legal cards the graph could not translate equals the corpus's misses", () => {
  const legal = new Set(oracle.filter((o) => o.legalities?.commander === "legal").map((o) => o.oracle_id));
  const translated = new Set(corpus.map((c) => c.oracleId));
  const misses = new Set([...legal].filter((o) => !translated.has(o)));
  expect(misses.size).toBeGreaterThan(0); // the graph really misses some cards, so equality below is not two empty sets
  expect(misses.size).toBeLessThan(legal.size / 100);
  const listed = db.query("SELECT card_id FROM graph_untranslated").all() as { card_id: number }[];
  expect(listed.length).toBe(new Set(listed.map((r) => r.card_id)).size);
  expect(new Set(listed.map((r) => oracleOf.get(r.card_id)))).toEqual(misses);
  // an untranslated card carries no graph data
  const both = db.query("SELECT COUNT(*) AS n FROM graph_untranslated u JOIN card_graph g ON g.card_id = u.card_id").get() as { n: number };
  expect(both.n).toBe(0);
}, 60_000);

// The packed Tagger vector: n float32 weights, then the n uint16 store tag ids they belong to, little-endian, strongest
// first. Decoded here on its own from the bytes.
function unpack(blob: Uint8Array): [number, number][] {
  const v = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const n = blob.byteLength / 6;
  expect(Number.isInteger(n)).toBe(true);
  return Array.from({ length: n }, (_, i) => [v.getUint16(4 * n + 2 * i, true), v.getFloat32(4 * i, true)] as [number, number]);
}

test("ISC-70: every commander page in the build data has its themes, synergy list and Tagger Deck profile in the store", async () => {
  // Card names as the pages spell them → oracle id: every commander-legal Scryfall card by its full name, then by its
  // front face (EDHREC names a two-faced card by its front face; a token may share that name, so only legal cards).
  const legalCards = oracle.filter((o) => o.legalities?.commander === "legal");
  const byName = new Map<string, string>();
  for (const o of legalCards) byName.set(o.name, o.oracle_id);
  for (const o of legalCards) { const front = o.card_faces?.[0]?.name ?? o.name.split(" // ")[0]; if (!byName.has(front)) byName.set(front, o.oracle_id); }
  const tagLabel = new Map((db.query("SELECT id, label FROM tags").all() as { id: number; label: string }[]).map((t) => [t.id, t.label]));

  const files = readdirSync(EDHREC).filter((f) => f.endsWith(".json")).sort();
  expect(files.length).toBeGreaterThan(3000);
  const pages: { slug: string; page: any; commander: number }[] = [];
  for (const f of files) {
    const page = JSON.parse(readFileSync(join(EDHREC, f), "utf8"));
    const o = byName.get(page.container.json_dict.card.name);
    expect(o, `${f}: its commander is a Scryfall card`).toBeDefined();
    pages.push({ slug: f.slice(0, -5), page, commander: cardId.get(o!)! });
  }

  const commanders = db.query("SELECT card_id, edhrec_slug, decks, tagger_deck, tagger_deck_fallback FROM commanders").all() as { card_id: number; edhrec_slug: string; decks: number; tagger_deck: Uint8Array; tagger_deck_fallback: string | null }[];
  const cmd = new Map(commanders.map((c) => [c.card_id, c]));
  expect(commanders.length).toBe(pages.length);
  const themesOf = db.query("SELECT t.slug, t.name, ct.decks FROM commander_themes ct JOIN themes t ON t.id = ct.theme_id WHERE ct.commander_id = ?");
  const cardsOf = db.query("SELECT card_id, decks, potential_decks, synergy FROM commander_cards WHERE commander_id = ?");

  let synergyRows = 0, themed = 0;
  for (const { slug, page, commander } of pages) {
    const d = page.container.json_dict;
    const c = cmd.get(commander);
    expect(c, `${slug} is in the store`).toBeDefined();
    expect(c!.edhrec_slug).toBe(slug);
    expect(c!.decks).toBe(d.card.num_decks);

    // themes: the page's tag list with each tag's deck count
    const want = (page.tag_counts ?? []).map((t: any) => `${t.slug}|${t.value}|${t.count}`).sort();
    const got = (themesOf.all(commander) as { slug: string; name: string; decks: number }[]).map((t) => `${t.slug}|${t.name}|${t.decks}`).sort();
    expect(got).toEqual(want);
    if (want.length) themed++;

    // synergy list: every card the page lists that is a commander-legal store card, once, with the page's numbers
    const expected = new Map<number, [number, number, number]>();
    for (const list of d.cardlists) for (const v of list.cardviews) {
      const id = cardId.get(byName.get(v.name) ?? "");
      if (id === undefined) continue;
      const nums: [number, number, number] = [v.num_decks, v.potential_decks, v.synergy];
      if (expected.has(id)) { expect(expected.get(id)).toEqual(nums); continue; } // a card on two lists says the same
      expected.set(id, nums);
    }
    const rows = cardsOf.all(commander) as { card_id: number; decks: number; potential_decks: number; synergy: number }[];
    expect(new Map(rows.map((r) => [r.card_id, [r.decks, r.potential_decks, r.synergy]]))).toEqual(expected);
    synergyRows += rows.length;
  }
  expect(synergyRows).toBeGreaterThan(500000);
  expect(themed).toBeGreaterThan(3000);

  // Tagger Deck profile: what mtg-vector's tagger.ts makes of each page, with the same Scryfall tags and cards
  const T = await import(join(realpathSync(DATA), "..", "app", "tagger.ts"));
  const tags = await rawJSONL("oracle_tags.jsonl.gz");
  const built = T.buildTaggerLayers({ commanders: pages.map((p) => ({ oracleId: oracleOf.get(p.commander)!, page: p.page })), tags, cards: oracle }, T.DEFAULT_SETTINGS);
  let fallbacks = 0;
  pages.forEach((p, i) => {
    const want = built.commanders[i];
    const got = unpack(cmd.get(p.commander)!.tagger_deck);
    expect(got.map(([t]) => tagLabel.get(t))).toEqual(want.deck.map(([k]: [number, number]) => built.tagNames[k]));
    got.forEach(([, w], k) => expect(Math.abs(w - want.deck[k][1])).toBeLessThan(1e-7)); // float32 of the same weight
    expect(cmd.get(p.commander)!.tagger_deck_fallback).toBe(want.deckFallbackReason);
    if (want.deckFallbackReason) fallbacks++;
  });
  expect(fallbacks).toBeGreaterThan(0);
  expect(fallbacks).toBeLessThan(pages.length / 4);
}, 300_000);

test("Tagger Card vectors: every card's own Tagger vector, the one a commander's Tagger Deck profile is matched against, is in the store", async () => {
  const T = await import(join(realpathSync(DATA), "..", "app", "tagger.ts"));
  const tags = await rawJSONL("oracle_tags.jsonl.gz");
  const ids = [...cardId.keys()];
  const built = T.buildTaggerLayers({ commanders: ids.map((oracleId) => ({ oracleId, page: null })), tags, cards: oracle }, T.DEFAULT_SETTINGS);
  const tagLabel = new Map((db.query("SELECT id, label FROM tags").all() as { id: number; label: string }[]).map((t) => [t.id, t.label]));
  const rows = new Map((db.query("SELECT card_id, vector FROM card_tagger").all() as { card_id: number; vector: Uint8Array }[]).map((r) => [r.card_id, r.vector]));
  let withTags = 0;
  ids.forEach((o, i) => {
    const want: [number, number][] = built.commanders[i].card;
    const blob = rows.get(cardId.get(o)!);
    if (!want.length) { expect(blob, `${o} has no kept tags, so no vector`).toBeUndefined(); return; }
    withTags++;
    const got = unpack(blob!);
    expect(got.map(([t]) => tagLabel.get(t))).toEqual(want.map(([k]) => built.tagNames[k]));
    got.forEach(([, w], k) => expect(Math.abs(w - want[k][1])).toBeLessThan(1e-7));
  });
  expect(withTags).toBeGreaterThan(25000);
  expect(rows.size).toBe(withTags);
}, 300_000);

// What the interaction rule reads besides the graph itself (the graph's cardInfos and subtype facts), so links can be
// computed from the store alone: the Scryfall fields the cards table does not keep, and the subtype facts the card
// graph computes over every Scryfall card (a legal-only store cannot recompute them).
test("graph card fields: every store card has its Scryfall colors, faces (type line, cost, colors) and global EDHREC rank as Scryfall gives them", () => {
  const raw = new Map(oracle.map((o: any) => [o.oracle_id, o]));
  const rows = db.query("SELECT card_id, colors, card_faces, edhrec_rank FROM card_scryfall").all() as { card_id: number; colors: string | null; card_faces: string | null; edhrec_rank: number | null }[];
  expect(rows.length).toBe(cardId.size);
  let faced = 0, ranked = 0, colorless = 0;
  for (const r of rows) {
    const o: any = raw.get(oracleOf.get(r.card_id)!);
    expect(r.colors === null ? undefined : JSON.parse(r.colors)).toEqual(o.colors);
    const faces = o.card_faces?.map((f: any) => Object.fromEntries(["name", "type_line", "mana_cost", "colors"].filter((k) => f[k] !== undefined).map((k) => [k, f[k]])));
    expect(r.card_faces === null ? undefined : JSON.parse(r.card_faces)).toEqual(faces);
    expect(r.edhrec_rank).toBe(o.edhrec_rank ?? null);
    if (faces) faced++;
    if (r.edhrec_rank !== null) ranked++;
    if (o.colors && !o.colors.length) colorless++;
  }
  expect(faced).toBeGreaterThan(500);
  expect(ranked).toBeGreaterThan(30000);
  expect(colorless).toBeGreaterThan(500);
}, 60_000);

test("subtype facts: the store carries the card graph's creature-only, land-only and printed subtype lists", () => {
  const facts = JSON.parse(readFileSync(join(DATA, "graph", "subtype-facts.json"), "utf8")) as { creatureOnly: string[]; landOnly: string[]; known: string[] };
  expect(facts.known.length).toBeGreaterThan(400);
  const rows = db.query("SELECT subtype, creature_only, land_only FROM subtype_facts").all() as { subtype: string; creature_only: number; land_only: number }[];
  expect(new Set(rows.map((r) => r.subtype))).toEqual(new Set(facts.known));
  expect(new Set(rows.filter((r) => r.creature_only === 1).map((r) => r.subtype))).toEqual(new Set(facts.creatureOnly));
  expect(new Set(rows.filter((r) => r.land_only === 1).map((r) => r.subtype))).toEqual(new Set(facts.landOnly));
  expect(rows.every((r) => [0, 1].includes(r.creature_only) && [0, 1].includes(r.land_only))).toBe(true);
});
