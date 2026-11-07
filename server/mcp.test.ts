// MV-15: the deck MCP (`mtg-deck`). Tests call the plain tool functions in deck-tools.ts directly, and reach the
// server through the MCP client (in memory, and over stdio once) to check what a Claude session sees.
// ISA 20261106-card-galaxy-deck-mcp: ISC-17.1, ISC-17.2, ISC-18, ISC-19, ISC-25.1 and ISC-25.2's precondition.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fc from "fast-check";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpace, normName as normNameOf, parseDecklist, resolveName } from "./deck-pool";
import { cardDetails, deckStats, findCards, findTags, neighbors, openStore, ToolInputError, type FindCardsInput, type FoundCard, type Store } from "./deck-tools";
import { acceptSwap, LABELS_PATH, rejectSwap, swapCandidates } from "./swap-tools";
import { diagnose } from "./diagnose";
import { createDeckServer } from "./mcp";
import { loadRoleIndex, roleSheet } from "./roles";

// A player's confirmed plan for the Namor fixture (DT-6.3): the plan comes from the player, never from Namor's text.
const NAMOR_PLAN = { themes: ["Spellslinger"] };

let store: Store;
let client: Client;

beforeAll(async () => {
  store = openStore();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createDeckServer(store).connect(a);
  client = new Client({ name: "mcp-test", version: "0" });
  await client.connect(b);
});
afterAll(async () => {
  await client?.close();
  store?.db.close();
});

type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; items?: JsonSchema; anyOf?: JsonSchema[] };
const toolSchema = async (name: string) => {
  const { tools } = await client.listTools();
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}; have ${tools.map((x) => x.name).join(", ")}`);
  return t.inputSchema as JsonSchema;
};

test("find schema: find_cards takes color identity, card type, mana value range, Tagger tags, keywords and power/toughness (ISC-17.1)", async () => {
  const props = (await toolSchema("find_cards")).properties ?? {};
  // the six ISC-17.1 filters, plus subtypes and the price ceiling the card adds
  for (const k of ["colorIdentity", "types", "subtypes", "manaValue", "tags", "keywords", "power", "toughness", "maxPrice"]) expect(props).toHaveProperty(k);
  expect(props.types.type).toBe("array");
  expect(props.tags.type).toBe("array");
  expect(props.keywords.type).toBe("array");
  for (const range of ["manaValue", "power", "toughness"]) expect(Object.keys(props[range].properties ?? {}).sort()).toEqual(["max", "min"]);
});

// ---------- find filters (ISC-17.2) ----------
// The oracle: every card loaded straight from the store's plain columns (types/subtypes text, the keywords JSON, the
// color identity letters) and the Tagger tree walked from tag_edges, not from card_types, card_keywords or
// tag_closure, which the tool uses. A filter set is drawn from a random seed card so most runs match something.

type OracleCard = {
  id: number; name: string; normName: string; ci: string; mv: number; types: Set<string>; subtypes: Set<string>;
  keywords: Set<string>; power: string | null; toughness: string | null; usd: number | null; land: boolean; tags: Set<number>;
  lc: { types: Set<string>; subtypes: Set<string>; keywords: Set<string>; tags: Set<string> }; // lower case, for matching
};
let cards: OracleCard[] = [];
let tagLabel = new Map<number, string>();

beforeAll(() => {
  const db = store.db;
  const parents = new Map<number, number[]>();
  for (const e of db.query("SELECT parent_id, child_id FROM tag_edges").all() as { parent_id: number; child_id: number }[])
    (parents.get(e.child_id) ?? parents.set(e.child_id, []).get(e.child_id)!).push(e.parent_id);
  const upward = (t: number, out: Set<number>) => { if (out.has(t)) return; out.add(t); for (const p of parents.get(t) ?? []) upward(p, out); };
  tagLabel = new Map((db.query("SELECT id, label FROM tags").all() as { id: number; label: string }[]).map((t) => [t.id, t.label]));
  const tagsOf = new Map<number, Set<number>>();
  for (const r of db.query("SELECT card_id, tag_id FROM card_tags").all() as { card_id: number; tag_id: number }[])
    upward(r.tag_id, tagsOf.get(r.card_id) ?? tagsOf.set(r.card_id, new Set()).get(r.card_id)!);
  type Row = { id: number; name: string; norm_name: string; color_identity: string; mana_value: number; supertypes: string; types: string; subtypes: string; keywords: string; power: string | null; toughness: string | null; usd_price: number | null; is_land: number };
  const words = (s: string) => new Set(s.split(" ").filter(Boolean));
  const lower = (xs: Iterable<string>) => new Set([...xs].map((x) => x.toLowerCase()));
  cards = (db.query("SELECT * FROM cards").all() as Row[]).map((r) => {
    const types = words(`${r.supertypes} ${r.types}`), subtypes = words(r.subtypes), keywords = new Set(JSON.parse(r.keywords) as string[]);
    const tags = tagsOf.get(r.id) ?? new Set<number>();
    return {
      id: r.id, name: r.name, normName: r.norm_name, ci: r.color_identity, mv: r.mana_value, types, subtypes, keywords,
      power: r.power, toughness: r.toughness, usd: r.usd_price, land: !!r.is_land, tags,
      lc: { types: lower(types), subtypes: lower(subtypes), keywords: lower(keywords), tags: lower([...tags].map((t) => tagLabel.get(t)!)) },
    };
  });
});

const num = (s: string | null) => (s !== null && /^-?\d+$/.test(s) ? +s : null);
const inRange = (v: number | null, r?: { min?: number; max?: number }) => !r || (v !== null && (r.min === undefined || v >= r.min) && (r.max === undefined || v <= r.max));

function oracleMatches(c: OracleCard, f: FindCardsInput): boolean {
  const ci = f.colorIdentity?.toUpperCase();
  if (ci !== undefined && ![...c.ci].every((x) => ci !== "C" && ci.includes(x))) return false;
  const { types: ty, subtypes: st, keywords: kw, tags: tg } = c.lc;
  if (f.types && !f.types.every((t) => ty.has(t.toLowerCase()))) return false;
  if (f.subtypes && !f.subtypes.every((t) => st.has(t.toLowerCase()))) return false;
  if (f.keywords && !f.keywords.every((k) => kw.has(k.toLowerCase()))) return false;
  if (f.tags && !f.tags.every((t) => tg.has(t.toLowerCase()))) return false;
  if (!inRange(c.mv, f.manaValue) || !inRange(num(c.power), f.power) || !inRange(num(c.toughness), f.toughness)) return false;
  if (f.maxPrice !== undefined && (c.usd === null || c.usd > f.maxPrice)) return false;
  if (f.land !== undefined && c.land !== f.land) return false;
  if (f.name !== undefined && !c.normName.includes(normNameOf(f.name))) return false;
  return true;
}

const byteCmp = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const ORDER: Record<NonNullable<FindCardsInput["sort"]>, (a: OracleCard, b: OracleCard) => number> = {
  name: (a, b) => byteCmp(a.name, b.name) || a.id - b.id,
  mana_value: (a, b) => a.mv - b.mv || byteCmp(a.name, b.name) || a.id - b.id,
  price: (a, b) => (a.usd === null ? 1 : 0) - (b.usd === null ? 1 : 0) || (a.usd ?? 0) - (b.usd ?? 0) || byteCmp(a.name, b.name) || a.id - b.id,
};

// a random subset of a seed card's own attributes, ranges widened at random, so the seed always matches
const FILTERS = ["colorIdentity", "types", "subtypes", "manaValue", "tags", "keywords", "power", "toughness", "maxPrice", "land", "name"] as const;
const draw = fc.record({
  seed: fc.nat(), pick: fc.subarray([...FILTERS], { minLength: 1, maxLength: 5 }), extraColors: fc.subarray(["W", "U", "B", "R", "G"]),
  lo: fc.integer({ min: 0, max: 3 }), hi: fc.integer({ min: 0, max: 3 }), openEnd: fc.constantFrom("none", "min", "max"),
  subset: fc.nat(), sort: fc.constantFrom("name", "mana_value", "price") as fc.Arbitrary<"name" | "mana_value" | "price">,
  limit: fc.integer({ min: 1, max: 100 }), offset: fc.constantFrom(0, 0, 0, 3), lowerCase: fc.boolean(),
});

function filtersFrom(c: OracleCard, d: fc.RecordValue<typeof draw extends fc.Arbitrary<infer T> ? T : never>): FindCardsInput {
  const some = <T>(xs: T[]) => xs.filter((_, i) => ((d.subset >> i) & 1) === 1 || i === d.subset % xs.length);
  const rng = (v: number) => ({ ...(d.openEnd !== "min" && { min: v - d.lo }), ...(d.openEnd !== "max" && { max: v + d.hi }) });
  const cs = (s: string) => (d.lowerCase ? s.toLowerCase() : s);
  const f: FindCardsInput = { sort: d.sort, limit: d.limit, offset: d.offset };
  for (const k of d.pick) {
    if (k === "colorIdentity") { const ci = [...new Set([...c.ci, ...d.extraColors])].join(""); f.colorIdentity = ci || "C"; }
    if (k === "types" && c.types.size) f.types = some([...c.types]).map(cs);
    if (k === "subtypes" && c.subtypes.size) f.subtypes = some([...c.subtypes]).map(cs);
    if (k === "keywords" && c.keywords.size) f.keywords = some([...c.keywords]).map(cs);
    if (k === "tags" && c.tags.size) f.tags = some([...c.tags].sort((a, b) => a - b)).slice(0, 2).map((t) => cs(tagLabel.get(t)!));
    if (k === "manaValue") f.manaValue = rng(c.mv);
    if (k === "power" && num(c.power) !== null) f.power = rng(num(c.power)!);
    if (k === "toughness" && num(c.toughness) !== null) f.toughness = rng(num(c.toughness)!);
    if (k === "maxPrice" && c.usd !== null) f.maxPrice = c.usd + d.hi;
    if (k === "land") f.land = c.land;
    if (k === "name") f.name = c.name.slice(0, 4 + (d.subset % 6));
  }
  return f;
}

test("find filters: for random filter combinations every result satisfies every filter, and the page is exactly the matching cards in order (ISC-17.2)", () => {
  let nonEmpty = 0, runs = 0;
  fc.assert(fc.property(draw, (d) => {
    const seed = cards[d.seed % cards.length];
    const f = filtersFrom(seed, d);
    const expected = cards.filter((c) => oracleMatches(c, f)).sort(ORDER[f.sort!]);
    expect(expected.some((c) => c.id === seed.id)).toBe(true); // the generator's promise
    const got = findCards(store, f);
    runs++;
    if (got.cards.length) nonEmpty++;
    for (const r of got.cards) expect(oracleMatches(cards.find((c) => c.name === r.name)!, f)).toBe(true);
    expect(got.total).toBe(expected.length);
    expect(got.cards.map((r: FoundCard) => r.name)).toEqual(expected.slice(f.offset, f.offset! + f.limit!).map((c) => c.name));
  }), { numRuns: 200, seed: 1506 });
  console.log(`find filters: ${runs} runs, ${nonEmpty} non-empty`);
  expect(nonEmpty / runs).toBeGreaterThan(0.8);
}, 60_000);

test("find filters: a parent tag finds cards tagged only with its descendants", () => {
  const ramp = findCards(store, { tags: ["ramp"], colorIdentity: "U", limit: 100 });
  const direct = findCards(store, { tags: ["mana rock"], colorIdentity: "U", limit: 100 });
  expect(direct.total).toBeGreaterThan(0);
  expect(ramp.total).toBeGreaterThan(direct.total);
  expect(findCards(store, { tags: ["ramp"], name: "Sol Ring" }).cards.map((c) => c.name)).toEqual(["Sol Ring"]);
});

test("find filters: an unknown type, subtype, tag or keyword is an error naming close matches, not an empty list", () => {
  expect(() => findCards(store, { tags: ["rampp"] })).toThrow(/unknown Tagger tag "rampp".*ramp/);
  expect(() => findCards(store, { subtypes: ["Merfolks"] })).toThrow(/unknown subtype "Merfolks".*Merfolk/);
  expect(() => findCards(store, { types: ["Creture"] })).toThrow(/unknown type "Creture"/);
  expect(() => findCards(store, { keywords: ["Flyin"] })).toThrow(/unknown keyword "Flyin".*Flying/);
});

test("tags tool: concepts no lever names (anthem, evasion) resolve to Tagger tags whose card count equals what find_cards returns for that tag (ISC-27)", async () => {
  for (const [text, label] of [["anthem", "anthem"], ["evasion", "evasion"], ["unblockable", "unblockable"]] as const) {
    const r = findTags(store, { text, colorIdentity: "U" });
    expect(r.tags[0].label).toBe(label);
    for (const tag of r.tags.slice(0, 5)) {
      expect(tag.cards).toBe(findCards(store, { tags: [tag.label], colorIdentity: "U", limit: 1 }).total);
      expect(`${tag.label} ${tag.description ?? ""}`.toLowerCase()).toContain(text);
    }
  }
  // every word must match, results never exceed the limit, and a word nothing carries is an empty list, not an error
  for (const tag of findTags(store, { text: "sacrifice outlet", limit: 50 }).tags)
    for (const w of ["sacrifice", "outlet"]) expect(`${tag.label} ${tag.description ?? ""}`.toLowerCase()).toContain(w);
  expect(findTags(store, { text: "e", limit: 7 }).tags).toHaveLength(7);
  expect(findTags(store, { text: "zzqqxx" })).toEqual({ total: 0, tags: [] });
  const viaMcp = await client.callTool({ name: "tags", arguments: { text: "anthem", colorIdentity: "U" } });
  expect(viaMcp.structuredContent).toEqual(findTags(store, { text: "anthem", colorIdentity: "U" }) as unknown as Record<string, unknown>);
});

test("find filters: results are capped at 100 and the default page is 25", () => {
  const all = findCards(store, { colorIdentity: "U" });
  expect(all.cards.length).toBe(25);
  expect(all.total).toBeGreaterThan(1000);
  expect(findCards(store, { colorIdentity: "U", limit: 100 }).cards.length).toBe(100);
  expect(() => findCards(store, { limit: 101 })).toThrow(/limit/);
});

// ---------- card ----------

test("card: full details with Tagger tags and roles, by exact, renamed, front-face, prefix and misspelled names", () => {
  const sol = cardDetails(store, { name: "Sol Ring" });
  expect(sol.matchedBy).toBe("exact");
  expect(sol.card).toMatchObject({ name: "Sol Ring", manaCost: "{1}", manaValue: 1, typeLine: "Artifact", colorIdentity: "", types: ["Artifact"] });
  expect(sol.card.oracleText).toContain("Add {C}{C}");
  expect(sol.card.tags.map((t) => t.label)).toContain("mana rock");
  expect(sol.card.roles.map((r) => r.role)).toEqual(["ramp"]);

  // Scryfall renamed "Namor, the Sub-Mariner"; punctuation and case are ignored
  expect(cardDetails(store, { name: "namor, THE sub-mariner" })).toMatchObject({ matchedBy: "exact", card: { name: "Namor the Sub-Mariner", power: "*", toughness: "4", keywords: ["Flying"], subtypes: ["Mutant", "Merfolk", "Villain"] } });
  expect(cardDetails(store, { name: "Bonecrusher Giant" })).toMatchObject({ matchedBy: "face", card: { name: "Bonecrusher Giant // Stomp" } });
  expect(cardDetails(store, { name: "Talrand" })).toMatchObject({ matchedBy: "prefix", card: { name: "Talrand, Sky Summoner" } });
  expect(cardDetails(store, { name: "Sol Rnig" })).toMatchObject({ matchedBy: "fuzzy", card: { name: "Sol Ring" } });
});

test("card: an ambiguous partial name picks one and lists the others; a name nothing resembles is an error", () => {
  const namor = cardDetails(store, { name: "Namor" });
  expect(namor.matchedBy).toBe("prefix");
  expect([namor.card.name, ...namor.alternatives].sort()).toEqual(["Namor the Sub-Mariner", "Namor, Atlantean King", "Namor, Scourge of the Seas", "Namora, the Sea Queen"].sort());
  expect(cardDetails(store, { name: "Namor" })).toEqual(namor); // same answer every time
  expect(() => cardDetails(store, { name: "qqqzzzxxyy" })).toThrow(/no card matches "qqqzzzxxyy"/);
});

// ---------- deck stats (ISC-19) ----------

// Hand count of fixtures/namor.txt, card by card from the raw Scryfall dump (data/scryfall/oracle_cards.jsonl.gz),
// not the store: 64 nonland cards (Namor included, 36 lands left out) whose mana values sum to 177.
//   MV 1: Consider, High Tide, Magic Damper, Opt, Shore Up, Wash Away, Aquitect's Will, Sol Ring, Curiosity (9)
//   MV 2: ten two-drop creatures, nine two-mana instants, Finale of Revelation (X counts 0), six two-mana artifacts,
//         Deeproot Pilgrimage (27)
//   MV 3: seven creatures with Namor, Narset, Frantic Search, Sinister Sabotage, Twist Reality, Solve the Equation,
//         Commander's Sphere, Deeproot Waters, Imprisoned in the Moon (15)
//   MV 4: Seafloor Oracle, Talrand, Tempest Caller, Aetherize, Deep Analysis, Leyline of Transformation (6)
//   MV 5: Archmage of Runes, Mist Dancer, Evacuation (3)
//   MV 7+: Hullbreaker Horror 7, Blatant Thievery 7, Slinn Voda 8, Dig Through Time 8 (4)
// Blue pips: 81 (creatures 40 with Narset, instants 27, sorceries 8, enchantments 6, artifacts 0).
const NAMOR_DECK = new URL("../fixtures/namor.txt", import.meta.url).pathname;

test("deck stats: Namor returns average mana value, curve, role counts, pip load and plan fit, and the average matches the hand count (ISC-19)", async () => {
  const s = deckStats(store, { deckFile: "fixtures/namor.txt", commander: "Namor the Sub-Mariner" });
  expect(s.commander).toMatchObject({ name: "Namor the Sub-Mariner", colorIdentity: "U" });
  expect(s.commanderInDeck).toBe(true);
  expect(s.unresolved).toEqual([]);
  expect(s).toMatchObject({ cards: 100, lands: 36, nonland: 64 });

  expect(s.averageManaValue).toBeCloseTo(177 / 64, 3);
  expect(s.curve).toEqual({ "0": 0, "1": 9, "2": 27, "3": 15, "4": 6, "5": 3, "6": 0, "7+": 4 });
  expect(s.pipLoad).toEqual({ W: 0, U: 81, B: 0, R: 0, G: 0 });

  // MV-14's Namor counts (role-map notes), and the same as roles.ts over the Oracle Tags file
  expect(s.roleCounts).toEqual({ ramp: 8, "card draw": 12, "card selection": 8, removal: 5, "board wipe": 3, counterspell: 11, protection: 6, tutor: 1, recursion: 1, "cost reducer": 2 });
  const [space, { index }] = await Promise.all([loadSpace(), loadRoleIndex()]);
  const sheet = roleSheet(index, parseDecklist(space, await Bun.file(NAMOR_DECK).text()).entries);
  expect(s.roleCounts).toEqual(sheet.counts);
  expect(s.unroled).toEqual(sheet.unroled);

  // plan fit comes from the player's plan only (ISC-48): without one there is none, never a reading of Namor's text
  expect(s.planFit).toBeNull();
  const p = deckStats(store, { deckFile: "fixtures/namor.txt", commander: "Namor the Sub-Mariner", plan: NAMOR_PLAN }).planFit!;
  expect(p.plan).toEqual({ themes: ["Spellslinger"], priorities: [], avoid: [] });
  expect(p.of).toBe(63); // nonland cards other than the commander
  expect(p.onPlan + p.offPlan.length).toBe(63);
  // a spellslinger plan: mana rocks and equipment do nothing for it; spell payoffs and cantrips do (checked by hand)
  for (const off of ["Sol Ring", "Mind Stone", "Lightning Greaves", "Swiftfoot Boots"]) expect(p.offPlan).toContain(off);
  for (const on of ["Opt", "Consider", "Talrand, Sky Summoner", "Archmage of Runes"]) expect(p.offPlan).not.toContain(on);
});

test("deck stats: a pasted list works like a file, misses are flagged by line with close names, off-identity cards are named", () => {
  const s = deckStats(store, { decklist: "1 Sol Ring\n1 Lightnig Bolt\n2 Island\n1 Counterspell", commander: "Namor the Sub-Mariner" });
  expect(s.unresolved).toEqual([{ line: 2, text: "Lightnig Bolt", closeMatches: expect.arrayContaining(["Lightning Bolt"]) }]);
  expect(s).toMatchObject({ cards: 4, lands: 2, nonland: 2, commanderInDeck: false, curve: { "1": 1, "2": 1 }, pipLoad: { U: 2 } });
  expect(s.averageManaValue).toBe(1.5);
  expect(deckStats(store, { decklist: "1 Lightning Bolt\n1 Opt", commander: "Namor the Sub-Mariner" }).offIdentity).toEqual(["Lightning Bolt"]);
  expect(() => deckStats(store, { decklist: "1 Opt", deckFile: "fixtures/namor.txt", commander: "Namor" })).toThrow(/exactly one of deckFile or decklist/);
  expect(() => deckStats(store, { deckFile: "fixtures/nope.txt", commander: "Namor" })).toThrow(/cannot read deck file/);
});

// ---------- no raw sql (ISC-18) ----------
// Every free-text string a tool accepts, by tool and path, with what it holds. A new string field fails this test
// until it is listed here, so adding one means saying what it is (and it must never be SQL).
const DATA_STRINGS: Record<string, string> = {
  "find_cards.colorIdentity": "WUBRG letters or C (pattern-checked)",
  "find_cards.types[]": "a type from the store's vocabulary (unknown values are an error)",
  "find_cards.subtypes[]": "a subtype from the store's vocabulary",
  "find_cards.tags[]": "a Tagger tag label from the store's vocabulary",
  "find_cards.keywords[]": "a keyword from the store's vocabulary",
  "find_cards.name": "part of a card name, matched with instr() on a bound parameter",
  "card.name": "a card name, resolved in TypeScript",
  "commander_profile.commander": "a card name, resolved in TypeScript (exact or front face only)",
  "commander_profile.deckFile": "a file path, read from disk",
  "commander_profile.decklist": "decklist text, parsed in TypeScript",
  "deck_stats.commander": "a card name, resolved in TypeScript",
  "deck_stats.deckFile": "a file path, read from disk",
  "deck_stats.decklist": "decklist text, parsed in TypeScript",
  "deck_stats.plan.themes[]": "a theme name, matched against the store's theme list in TypeScript (unknown names are an error)",
  "deck_stats.plan.priorities[]": "a card name, resolved in TypeScript (exact or front face only)",
  "deck_stats.plan.avoid[]": "a theme name, matched against the store's theme list in TypeScript (unknown names are an error)",
  "diagnose.commander": "a card name, resolved in TypeScript (exact or front face only)",
  "diagnose.deckFile": "a file path, read from disk",
  "diagnose.decklist": "decklist text, parsed in TypeScript",
  "diagnose.plan.themes[]": "a theme name, matched against the store's theme list in TypeScript (unknown names are an error)",
  "diagnose.plan.priorities[]": "a card name, resolved in TypeScript (exact or front face only)",
  "diagnose.plan.avoid[]": "a theme name, matched against the store's theme list in TypeScript (unknown names are an error)",
  "swap_candidates.plan.themes[]": "a theme name, matched against the store's theme list in TypeScript (unknown names are an error)",
  "swap_candidates.plan.priorities[]": "a card name, resolved in TypeScript (exact or front face only)",
  "swap_candidates.plan.avoid[]": "a theme name, matched against the store's theme list in TypeScript (unknown names are an error)",
  "neighbors.card": "a card name, resolved in TypeScript",
  "tags.text": "words matched against tag labels and descriptions in TypeScript",
  "tags.colorIdentity": "WUBRG letters, checked by a regex and turned into a bitmask",
  "neighbors.commander": "a card name, resolved in TypeScript (exact or front face only)",
  "swap_candidates.commander": "a card name, resolved in TypeScript",
  "swap_candidates.deckFile": "a file path, read from disk",
  "swap_candidates.decklist": "decklist text, parsed in TypeScript",
  "swap_candidates.card": "a card name, resolved in TypeScript",
  "swap_candidates.targets{key}": "a role name from app/roles.json (unknown names are an error)",
  "accept_swap.commander": "a card name, resolved in TypeScript (exact or front face only)",
  "accept_swap.out": "a card name, resolved in TypeScript (exact or front face only)",
  "accept_swap.in": "a card name, resolved in TypeScript (exact or front face only)",
  "accept_swap.deckFile": "a file path, read and rewritten on disk",
  "accept_swap.note": "free text kept in the label row as JSON, never parsed",
  "reject_swap.commander": "a card name, resolved in TypeScript (exact or front face only)",
  "reject_swap.out": "a card name, resolved in TypeScript (exact or front face only)",
  "reject_swap.in": "a card name, resolved in TypeScript (exact or front face only)",
  "reject_swap.deckFile": "a file path, kept in the label row (never read or written)",
  "reject_swap.note": "free text kept in the label row as JSON, never parsed",
};
const SQLISH = /sql|query|where|statement|clause|expr|order_?by|raw/i;

test("no raw sql: the MCP has exactly its ten tools, no SQL-like parameter, and every free string is a listed data field (ISC-18)", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["accept_swap", "card", "commander_profile", "deck_stats", "diagnose", "find_cards", "neighbors", "reject_swap", "swap_candidates", "tags"]);
  const strings: string[] = [];
  const walk = (s: JsonSchema & { enum?: unknown[]; propertyNames?: JsonSchema; additionalProperties?: JsonSchema | boolean }, path: string) => {
    if (s.type === "string" && !s.enum) strings.push(path);
    for (const [k, v] of Object.entries(s.properties ?? {})) {
      expect(k).not.toMatch(SQLISH);
      walk(v, `${path}.${k}`);
    }
    if (s.items) walk(s.items, `${path}[]`);
    for (const alt of s.anyOf ?? []) walk(alt, path);
    // a map (zod record): its keys are free strings too, and its values are walked like any field
    if (typeof s.additionalProperties === "object") {
      strings.push(`${path}{key}`);
      walk(s.additionalProperties, `${path}{value}`);
    }
  };
  for (const t of tools) {
    expect(`${t.name} ${t.description}`).not.toMatch(/\bsql\b/i);
    walk(t.inputSchema as JsonSchema, t.name);
  }
  expect(strings.sort()).toEqual(Object.keys(DATA_STRINGS).sort());
});

test("no raw sql: SQL typed into any string field is data: it matches nothing or is rejected, and the store is unchanged", async () => {
  const before = (store.db.query("SELECT COUNT(*) AS n FROM cards").get() as { n: number }).n;
  const evil = "x' OR '1'='1'; DROP TABLE cards; --";
  expect(findCards(store, { name: evil }).total).toBe(0);
  expect(findCards(store, { name: "' OR 1=1 --" }).total).toBe(0);
  expect(() => findCards(store, { tags: [evil] })).toThrow(/unknown Tagger tag/);
  expect(() => findCards(store, { types: [evil] })).toThrow(/unknown type/);
  expect(() => findCards(store, { colorIdentity: evil })).toThrow();
  expect(() => findCards(store, { sort: "name; DROP TABLE cards" as "name" })).toThrow();
  expect(() => cardDetails(store, { name: evil })).toThrow(/no card matches/);
  expect(deckStats(store, { decklist: `1 ${evil}`, commander: "Namor the Sub-Mariner" }).unresolved).toHaveLength(1);
  const viaMcp = await client.callTool({ name: "find_cards", arguments: { sort: "name; DROP TABLE cards" } });
  expect(viaMcp.isError).toBe(true);
  expect((store.db.query("SELECT COUNT(*) AS n FROM cards").get() as { n: number }).n).toBe(before);
  expect(() => store.db.run("DELETE FROM cards WHERE id = 1")).toThrow(/readonly/); // opened read-only
});

// ---------- wiring (ISC-25.1, ISC-25.2's precondition) ----------
// Starts the server exactly as the repo's .mcp.json tells Claude Code to, from the repo root, and talks MCP over stdio.

test("stdio smoke: .mcp.json registers mtg-deck, and the registered command answers tools/list and a find_cards call that returns Namor (ISC-25.1)", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const config = await Bun.file(`${root}.mcp.json`).json();
  const entry = config.mcpServers["mtg-deck"];
  expect(entry).toMatchObject({ type: "stdio", command: "bun" });
  const stdio = new Client({ name: "mcp-smoke", version: "0" });
  await stdio.connect(new StdioClientTransport({ command: entry.command, args: entry.args, cwd: root, stderr: "pipe" }));
  try {
    const { tools } = await stdio.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["accept_swap", "card", "commander_profile", "deck_stats", "diagnose", "find_cards", "neighbors", "reject_swap", "swap_candidates", "tags"]);
    const res = await stdio.callTool({ name: "find_cards", arguments: { colorIdentity: "U", types: ["Legendary", "Creature"], subtypes: ["Merfolk"], keywords: ["Flying"], manaValue: { max: 3 } } });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as { cards: { name: string }[] };
    expect(out.cards.map((c) => c.name)).toContain("Namor the Sub-Mariner");
    expect(JSON.parse((res.content as { text: string }[])[0].text)).toEqual(out);
  } finally {
    await stdio.close();
  }
}, 30_000);

test("deck stats: the commander must be named exactly (or by its front face); a partial name is an error listing candidates, never a silent guess", () => {
  expect(() => deckStats(store, { decklist: "1 Opt", commander: "Namor" })).toThrow(/commander "Namor" is not an exact card name.*Namor the Sub-Mariner/);
  expect(deckStats(store, { decklist: "1 Opt", commander: "namor, the sub-mariner" }).commander.name).toBe("Namor the Sub-Mariner");
});

// ---------- swap candidates (MV-16: ISC-7, 8, 9, 10, 11, 21, 24) ----------
// A spread of commanders, so the color-identity and lever checks run on more than mono-blue. Cards are drawn from
// inside each commander's identity, straight from the store's plain columns (the oracle above), not from the tool.
const SWAP_COMMANDERS = ["Namor the Sub-Mariner", "Krenko, Mob Boss", "Meren of Clan Nel Toth", "Atraxa, Praetors' Voice"];
const ciOf = (name: string) => cards.find((c) => c.name === name)!.ci;
const fitsIn = (ci: string, cmd: string) => [...ci].every((x) => cmd.includes(x));
const swapDraw = fc.record({ commander: fc.constantFrom(...SWAP_COMMANDERS), seed: fc.nat() });
// a nonland card inside the commander's identity, other than the commander, with mana value 1 or more
function drawDeckCard(commander: string, seed: number): OracleCard {
  const cmd = ciOf(commander);
  const pool = cards.filter((c) => !c.land && c.mv >= 1 && c.name !== commander && fitsIn(c.ci, cmd));
  return pool[seed % pool.length];
}

test("cheaper lever: for random cards and commanders, every candidate has a lower mana value than the card it replaces (ISC-7)", () => {
  let offered = 0;
  fc.assert(fc.property(swapDraw, ({ commander, seed }) => {
    const c = drawDeckCard(commander, seed);
    const r = swapCandidates(store, { commander, decklist: `1 ${c.name}`, card: c.name, lever: "cheaper" });
    offered += r.candidates.length;
    for (const s of r.candidates) {
      expect(s.out!.name).toBe(c.name);
      expect(cards.find((x) => x.name === s.in!.name)!.mv).toBeLessThan(c.mv);
    }
  }), { numRuns: 60, seed: 716 });
  expect(offered).toBeGreaterThan(60); // the lever is not vacuously empty
}, 120_000);

test("budget lever: for random priced cards and commanders, every candidate has a lower Scryfall USD price than the card it replaces (ISC-8)", () => {
  let offered = 0;
  fc.assert(fc.property(swapDraw, ({ commander, seed }) => {
    const cmd = ciOf(commander);
    const pool = cards.filter((c) => !c.land && c.usd !== null && c.usd > 0.25 && c.name !== commander && fitsIn(c.ci, cmd));
    const c = pool[seed % pool.length];
    const r = swapCandidates(store, { commander, decklist: `1 ${c.name}`, card: c.name, lever: "budget" });
    offered += r.candidates.length;
    for (const s of r.candidates) {
      const usd = cards.find((x) => x.name === s.in!.name)!.usd;
      expect(usd).not.toBeNull();
      expect(usd!).toBeLessThan(c.usd!);
    }
  }), { numRuns: 60, seed: 808 });
  expect(offered).toBeGreaterThan(60);
  // an unpriced card has nothing cheaper in dollars: no candidates, and a note says why
  const unpriced = cards.find((c) => !c.land && c.usd === null && fitsIn(c.ci, "U") && c.name !== "Namor the Sub-Mariner")!;
  const r = swapCandidates(store, { commander: "Namor the Sub-Mariner", decklist: `1 ${unpriced.name}`, card: unpriced.name, lever: "budget" });
  expect(r.candidates).toEqual([]);
  expect(r.notes.join(" ")).toMatch(/no Scryfall price/);
}, 120_000);

// Twelve Namor swaps a player rated good on 2026-11-06, under the old plan lever that read Namor's text (blue pips per
// spell, Merfolk). That reading is retired (ISA ISC-48: the plan comes from the player), so these are no longer a pass
// bar for the lever; they stay as a measurement. Under a Spellslinger plan the lever keeps 3 of the 12 (measured
// 2026-11-07: Chasm Skulker → Kaito, The Reality Chip → Counterbalance, Thought Vessel → Ms. Marvel); the old lever's
// pip count, which made Neutralize beat Censor, is not a hook or a tag. The shortlist (DT-6.5) replaces this lever.
const RATED_NAMOR: [string, string][] = [
  ["Archmage of Runes", "Spellweaver Volute"], ["Blink of an Eye", "Distorting Wake"], ["Censor", "Neutralize"], ["Chasm Skulker", "Kaito, Cunning Infiltrator"],
  ["Deeproot Pilgrimage", "Daughter of the Deep"], ["Dig Through Time", "Ancestral Memories"], ["Essence Scatter", "Mystic Denial"], ["Evacuation", "Inundate"],
  ["Imprisoned in the Moon", "In Too Deep"], ["Remand", "Archmage's Charm"], ["The Reality Chip", "Counterbalance"], ["Thought Vessel", "Ms. Marvel, Kamala Khan"],
];

test("plan lever: under a Spellslinger plan, at least the 3 of the 12 rated Namor swaps measured on 2026-11-07 stay in the top 3 for their card", () => {
  const kept = RATED_NAMOR.filter(([out, inn]) => swapCandidates(store, { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt", card: out, lever: "plan", limit: 3, plan: NAMOR_PLAN })
    .candidates.some((c) => c.in!.name === inn));
  expect(kept.length).toBeGreaterThanOrEqual(3);
}, 60_000);

test("plan lever: it needs the player's plan, and every candidate fits that plan strictly better than the card it replaces, at most 1 mana value more (ISC-48)", () => {
  const base = { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt", lever: "plan" as const };
  expect(() => swapCandidates(store, base)).toThrow(/needs|pass plan/);
  expect(() => swapCandidates(store, base)).toThrow(ToolInputError);
  const r = swapCandidates(store, { ...base, plan: NAMOR_PLAN });
  expect(r.plan).toEqual({ themes: ["Spellslinger"], priorities: [], avoid: [] });
  expect(r.candidates.length).toBeGreaterThan(5);
  for (const c of r.candidates) {
    expect(c.evidence.planGain!).toBeGreaterThan(0);
    expect(c.evidence.manaValueDelta).toBeLessThanOrEqual(1);
    expect(c.reason).toMatch(/^plan: /);
  }
  // the same plan named another way reads the same; a plan the data cannot read is a tool error saying which
  expect(swapCandidates(store, { ...base, plan: { themes: ["spellslinger"] } }).candidates).toEqual(r.candidates);
  expect(() => swapCandidates(store, { ...base, plan: { themes: ["Stompy"] } })).toThrow(/too little data/);
  expect(() => swapCandidates(store, { ...base, plan: { themes: ["Spellslingr"] } })).toThrow(/closest known themes: Spellslinger/);
}, 60_000);

// Commander legality and color identity read from the raw Scryfall dump (deck-pool loadSpace), not from the store. Names
// repeat in the dump (the token "Storm Crow" is not legal; the card is), so a name passes when a same-named entry does.
let rawByName: Map<string, { legal: boolean; ci: string[] }[]> = new Map();
beforeAll(async () => {
  const base = await loadSpace();
  for (const c of base.cards.values()) (rawByName.get(c.name) ?? rawByName.set(c.name, []).get(c.name)!).push({ legal: c.legal, ci: c.ci });
});
const legalInside = (name: string, cmdCi: string) => {
  return (rawByName.get(name) ?? []).some((raw) => raw.legal && raw.ci.every((x) => cmdCi.includes(x)));
};
// a random deck: ten nonland cards from inside the commander's identity, plus one off-identity card when the identity allows one
const deckDraw = fc.record({ commander: fc.constantFrom(...SWAP_COMMANDERS), seeds: fc.array(fc.nat(), { minLength: 10, maxLength: 10 }), off: fc.nat() });
function drawDeck(commander: string, seeds: number[], off: number): string {
  const cmd = ciOf(commander);
  const inside = cards.filter((c) => !c.land && c.name !== commander && fitsIn(c.ci, cmd));
  const outside = cards.filter((c) => !c.land && !fitsIn(c.ci, cmd));
  const names = [...new Set(seeds.map((s) => inside[s % inside.length].name))];
  if (outside.length) names.push(outside[off % outside.length].name);
  return names.map((n) => `1 ${n}`).join("\n");
}

test("swap identity: for random commanders, decks and cards, every candidate under every lever is commander-legal and inside the commander's identity (ISC-21.1)", () => {
  const LEVER_LIST = ["plan", "cheaper", "budget", "roles"] as const;
  const wholeDeck: Record<string, number> = { plan: 0, cheaper: 0, budget: 0, roles: 0 };
  let seen = 0;
  fc.assert(fc.property(deckDraw, fc.constantFrom(...LEVER_LIST), ({ commander, seeds, off }, lever) => {
    const decklist = drawDeck(commander, seeds, off);
    const cmd = ciOf(commander);
    const plan = lever === "plan" ? { themes: ["Tokens"] } : undefined; // a theme plan fits any commander
    const deckRun = swapCandidates(store, { commander, decklist, lever, plan });
    wholeDeck[lever] += deckRun.candidates.length;
    const runs = [deckRun];
    if (lever !== "roles") runs.push(swapCandidates(store, { commander, decklist, lever, plan, card: decklist.split("\n")[0].slice(2) }));
    for (const r of runs) for (const s of r.candidates) {
      if (s.in) { seen++; expect({ card: s.in.name, ok: legalInside(s.in.name, cmd) }).toEqual({ card: s.in.name, ok: true }); }
      if (s.out) expect(decklist).toContain(`1 ${s.out.name}`);
    }
  }), { numRuns: 60, seed: 2101 });
  expect(seen).toBeGreaterThan(100);
  for (const lever of LEVER_LIST) expect({ lever, offered: wholeDeck[lever] > 0 }).toEqual({ lever, offered: true });
}, 180_000);

// Namor candidates under every per-card lever, whole deck and a few single cards, for the reason and stats checks.
function namorCandidates() {
  const runs = [];
  for (const lever of ["plan", "cheaper", "budget"] as const) {
    runs.push(swapCandidates(store, { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt", lever, plan: NAMOR_PLAN }));
    for (const card of ["Dig Through Time", "Remand", "Sol Ring"]) runs.push(swapCandidates(store, { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt", lever, card, plan: NAMOR_PLAN }));
  }
  return runs;
}

test("candidate reasons: every Namor candidate's reason names its link (shared Tagger tags or neighbor rank) and its mana value and price difference (ISC-11)", () => {
  let n = 0;
  for (const r of namorCandidates()) for (const c of r.candidates) {
    n++;
    const e = c.evidence;
    expect(c.reason.length).toBeGreaterThan(0);
    // the link: a neighbor rank either way, or shared tags, and the reason says which
    expect(e.neighborRank !== null || e.reverseRank !== null || e.sharedTags.length > 0).toBe(true);
    if (e.neighborRank !== null) expect(c.reason).toContain(`in-color neighbor #${e.neighborRank} of ${c.out!.name}`);
    else if (e.reverseRank !== null) expect(c.reason).toContain(`lists ${c.out!.name} as its in-color neighbor #${e.reverseRank}`);
    else expect(c.reason).toContain(`shares Tagger tags: ${e.sharedTags[0]}`);
    // the difference, checked against the card tool's own numbers
    const out = cardDetails(store, { name: c.out!.name }).card, inn = cardDetails(store, { name: c.in!.name }).card;
    expect(e.manaValueDelta).toBe(inn.manaValue - out.manaValue);
    expect(c.reason).toContain(`mana value ${inn.manaValue} vs ${out.manaValue}`);
    if (inn.usd !== null && out.usd !== null) expect(c.reason).toContain(`$${inn.usd.toFixed(2)} vs $${out.usd.toFixed(2)}`);
    for (const t of e.sharedTags) {
      expect(inn.tags.map((x) => x.label)).toContain(t);
      expect(out.tags.map((x) => x.label)).toContain(t);
    }
  }
  expect(n).toBeGreaterThan(40);
}, 120_000);

// The list as text with one copy of `out` removed and one `in` added, for deck_stats to read on its own.
function editedList(text: string, out: string, inn: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => normNameOf(l.replace(/^\d+\s+/, "")) === normNameOf(out));
  if (at < 0) throw new Error(`${out} not in the list`);
  const qty = +lines[at].match(/^(\d+)/)![1];
  if (qty > 1) lines[at] = `${qty - 1} ${out}`;
  else lines.splice(at, 1);
  return [...lines, `1 ${inn}`].join("\n");
}

test("swap deltas: every Namor candidate carries the deck numbers after the swap, equal to deck_stats on the edited list, and the change from before (ISC-21.2)", async () => {
  const text = await Bun.file(NAMOR_DECK).text();
  const before = deckStats(store, { deckFile: "fixtures/namor.txt", commander: "Namor the Sub-Mariner", plan: NAMOR_PLAN });
  let n = 0;
  for (const r of namorCandidates()) {
    expect(r.before).toMatchObject({ cards: before.cards, averageManaValue: before.averageManaValue, curve: before.curve, roleCounts: before.roleCounts, pipLoad: before.pipLoad, onPlan: before.planFit!.onPlan });
    for (const c of r.candidates) {
      n++;
      const after = deckStats(store, { decklist: editedList(text, c.out!.name, c.in!.name), commander: "Namor the Sub-Mariner", plan: NAMOR_PLAN });
      expect(c.after).toEqual({ cards: after.cards, nonland: after.nonland, averageManaValue: after.averageManaValue, curve: after.curve, roleCounts: after.roleCounts, pipLoad: after.pipLoad, onPlan: after.planFit!.onPlan, planOf: after.planFit!.of });
      expect(c.delta.averageManaValue).toBeCloseTo(after.averageManaValue - before.averageManaValue, 3);
      expect(c.delta.onPlan).toBe(after.planFit!.onPlan - before.planFit!.onPlan);
      for (const [role, k] of Object.entries(after.roleCounts)) expect(c.delta.roleCounts[role] ?? 0).toBe(k - before.roleCounts[role]);
      for (const [b, k] of Object.entries(after.curve)) expect(c.delta.curve[b] ?? 0).toBe(k - before.curve[b as keyof typeof before.curve]);
    }
  }
  expect(n).toBeGreaterThan(40);
}, 120_000);

test("role drop flag: swapping the deck's only counterspell for a card that is not one flags counterspell 1 → 0; a counterspell for a counterspell is not flagged (ISC-21.3)", () => {
  const decklist = "1 Counterspell\n1 Sol Ring\n1 Opt\n1 Merfolk Looter\n30 Island";
  let flagged = 0, kept = 0;
  for (const lever of ["plan", "cheaper", "budget"] as const) {
    const r = swapCandidates(store, { commander: "Namor the Sub-Mariner", decklist, card: "Counterspell", lever, limit: 50, plan: NAMOR_PLAN });
    expect(r.before.roleCounts.counterspell).toBe(1);
    for (const c of r.candidates) {
      const counters = cardDetails(store, { name: c.in!.name }).card.roles.some((x) => x.role === "counterspell");
      expect({ card: c.in!.name, dropsRole: c.dropsRole }).toEqual({ card: c.in!.name, dropsRole: !counters });
      if (counters) {
        kept++;
        expect(c.roleDrops.map((d) => d.role)).not.toContain("counterspell");
      } else {
        flagged++;
        expect(c.roleDrops).toContainEqual({ role: "counterspell", before: 1, after: 0 });
        expect(c.reason).toContain("drops counterspell 1 → 0");
      }
    }
  }
  expect(flagged).toBeGreaterThan(0);
  expect(kept).toBeGreaterThan(0);
}, 60_000);

test("below target flag: a swap that leaves a role under its target sets belowTarget; a cut that keeps the role at or above target drops it without the flag", async () => {
  // the deck's only counterspell, against a target of 6: losing it leaves counterspell 0, under target
  const decklist = "1 Counterspell\n1 Sol Ring\n1 Opt\n1 Merfolk Looter\n30 Island";
  const r = swapCandidates(store, { commander: "Namor the Sub-Mariner", decklist, card: "Counterspell", lever: "cheaper", limit: 50, targets: { counterspell: 6 } });
  let under = 0, fine = 0;
  for (const c of r.candidates) {
    if (c.dropsRole) {
      under++;
      expect(c.belowTarget).toBe(true);
      expect(c.rolesBelowTarget).toContainEqual({ role: "counterspell", after: 0, target: 6 });
      expect(c.reason).toContain("drops counterspell 1 → 0, under its target 6");
    } else {
      // ramp is under its target in this deck (Sol Ring alone), but a swap that leaves ramp alone is not flagged
      fine++;
      expect(c.belowTarget).toBe(false);
      expect(c.rolesBelowTarget).toEqual([]);
    }
  }
  expect(under).toBeGreaterThan(0);
  expect(fine).toBeGreaterThan(0);

  // Namor plus four ramp cards is ramp 12 against 10: a ramp cut drops ramp to 11 and stays above target
  const pads = ["Arcane Signet", "Fellwar Stone", "Thran Dynamo", "Worn Powerstone"];
  const text = `${await Bun.file(NAMOR_DECK).text()}\n${pads.map((p) => `1 ${p}`).join("\n")}`;
  const cutsR = swapCandidates(store, { commander: "Namor the Sub-Mariner", decklist: text, lever: "redundancy", targets: { ramp: 10 }, limit: 50 });
  const rampCuts = cutsR.candidates.filter((c) => c.out!.roles.includes("ramp"));
  expect(rampCuts.length).toBeGreaterThan(0);
  for (const c of rampCuts) {
    expect(c.roleDrops).toContainEqual({ role: "ramp", before: 12, after: 11 });
    expect(c.dropsRole).toBe(true); // ISC-21.3: the count went down
    expect(c.belowTarget).toBe(false); // but nothing is left short
    expect(c.reason).toContain("drops ramp 12 → 11, still at or above its target 10");
  }
}, 60_000);

// ---------- role balance and redundancy (ISC-9, ISC-10) ----------
// Role targets are ISA fog; the levers read app/role-targets.json (a proposal) unless the call gives its own table.

test("role lever counts: the roles lever reports Namor's per-role counts from the role map, each with its target and status (ISC-9.1)", async () => {
  const r = swapCandidates(store, { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt", lever: "roles" });
  // MV-14's Namor sheet (role-map notes), and the same counts from roles.ts over the Oracle Tags file
  const namor = { ramp: 8, "card draw": 12, "card selection": 8, removal: 5, "board wipe": 3, counterspell: 11, protection: 6, tutor: 1, recursion: 1, "cost reducer": 2 };
  const [space, { index }] = await Promise.all([loadSpace(), loadRoleIndex()]);
  const sheet = roleSheet(index, parseDecklist(space, await Bun.file(NAMOR_DECK).text()).entries);
  expect(sheet.counts).toEqual(namor);
  expect(r.roles!.map((x) => x.role)).toEqual(Object.keys(namor));
  for (const x of r.roles!) {
    expect(x.count).toBe(namor[x.role as keyof typeof namor]);
    expect(x.status).toBe(x.count < x.target ? "under" : x.count > x.target ? "over" : "at");
  }
  // a call's own table replaces the file's targets for the roles it names
  const own = swapCandidates(store, { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt", lever: "roles", targets: { ramp: 8, tutor: 0 } });
  expect(own.roles!.find((x) => x.role === "ramp")).toMatchObject({ count: 8, target: 8, status: "at" });
  expect(own.roles!.find((x) => x.role === "tutor")).toMatchObject({ count: 1, target: 0, status: "over" });
  expect(() => swapCandidates(store, { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt", lever: "roles", targets: { rampp: 3 } })).toThrow(/unknown role "rampp".*ramp/);
}, 60_000);

test("redundancy flags: Namor padded with four more ramp cards gets ramp flagged over its target, and cut candidates that relieve it (ISC-10.1)", async () => {
  const pads = ["Arcane Signet", "Fellwar Stone", "Thran Dynamo", "Worn Powerstone"];
  for (const p of pads) expect(cardDetails(store, { name: p }).card.roles.map((x) => x.role)).toContain("ramp");
  const text = await Bun.file(NAMOR_DECK).text();
  const plain = swapCandidates(store, { commander: "Namor the Sub-Mariner", decklist: text, lever: "redundancy", targets: { ramp: 10 } });
  expect(plain.roles!.find((x) => x.role === "ramp")).toMatchObject({ count: 8, status: "under" });
  const padded = swapCandidates(store, { commander: "Namor the Sub-Mariner", decklist: `${text}\n${pads.map((p) => `1 ${p}`).join("\n")}`, lever: "redundancy", targets: { ramp: 10 }, limit: 50 });
  expect(padded.roles!.find((x) => x.role === "ramp")).toMatchObject({ count: 12, target: 10, status: "over" });
  const rampCuts = padded.candidates.filter((c) => c.out!.roles.includes("ramp"));
  expect(rampCuts.length).toBeGreaterThan(0);
  for (const c of rampCuts) expect(c.reason).toContain("ramp 12 over target 10");
  // every over role has at least one cut naming it, unless no cut keeps the deck's other roles at target
  for (const over of padded.roles!.filter((x) => x.status === "over")) {
    expect(padded.candidates.some((c) => c.reason.includes(`${over.role} ${over.count} over target ${over.target}`)) || padded.notes.some((n) => n.includes(over.role))).toBe(true);
  }
}, 60_000);

test("redundancy cuts: for random decks, every cut candidate is a card in the current deck, removing it keeps every role at or above its target, and nothing is added (ISC-10.2)", () => {
  let cuts = 0;
  fc.assert(fc.property(deckDraw, fc.nat(4), ({ commander, seeds, off }, tight) => {
    const decklist = drawDeck(commander, seeds, off);
    // low targets so random ten-card decks have roles over target
    const targets = Object.fromEntries(store.roles.roleNames.map((r) => [r, tight % 2]));
    const r = swapCandidates(store, { commander, decklist, lever: "redundancy", targets, limit: 50 });
    for (const c of r.candidates) {
      cuts++;
      expect(c.in).toBeNull();
      expect(decklist.split("\n")).toContain(`1 ${c.out!.name}`);
      for (const role of store.roles.roleNames) {
        const before = r.before.roleCounts[role], after = c.after.roleCounts[role];
        expect(after >= targets[role] || after === before).toBe(true);
      }
      expect(c.after.cards).toBe(r.before.cards - 1);
    }
  }), { numRuns: 60, seed: 1002 });
  expect(cuts).toBeGreaterThan(30);
}, 120_000);

test("role lever fills: for random decks, every gap fill is a card the store's own tools return (find_cards in the identity, the card tool showing the role), filling a role under target (ISC-9.2)", () => {
  let fills = 0;
  fc.assert(fc.property(deckDraw, ({ commander, seeds, off }) => {
    const decklist = drawDeck(commander, seeds, off);
    const cmd = ciOf(commander);
    // high targets so every random ten-card deck has gaps; one role over target so cuts exist to pair with
    const targets = { ...Object.fromEntries(store.roles.roleNames.map((r) => [r, 3])), "card draw": 0 };
    const r = swapCandidates(store, { commander, decklist, lever: "roles", targets, limit: 12 });
    const under = new Map(r.roles!.filter((x) => x.status === "under").map((x) => [x.role, x]));
    for (const c of r.candidates) {
      fills++;
      expect(c.in).not.toBeNull();
      // tool-returned: find_cards finds it by name inside the identity, and the card tool gives it a gap role
      const found = findCards(store, { colorIdentity: cmd || "C", name: c.in!.name, land: false, limit: 100 }).cards.map((x) => x.name);
      expect(found).toContain(c.in!.name);
      const roles = cardDetails(store, { name: c.in!.name }).card.roles.map((x) => x.role);
      const filled = roles.filter((x) => under.has(x));
      expect(filled.length).toBeGreaterThan(0);
      expect(filled.some((x) => c.after.roleCounts[x] === under.get(x)!.count + 1)).toBe(true);
      expect(decklist.split("\n")).not.toContain(`1 ${c.in!.name}`);
      if (c.out) expect(decklist.split("\n")).toContain(`1 ${c.out.name}`);
    }
  }), { numRuns: 40, seed: 902 });
  expect(fills).toBeGreaterThan(40);
}, 120_000);

// Role-lever pairing: each fill gets a cut chosen by role, not by list position. Roles here come from the card tool.
const rolesOfName = (name: string) => cardDetails(store, { name }).card.roles.map((x) => x.role);

test("role lever pairing: fills take cuts from an over-target role first, then a card that costs no role, and the cuts together never take a role below target", () => {
  // Counterspell 3 against a target of 1 (Counterspell, Negate, Mana Leak); Lord of Atlantis has no role; ramp 0
  // against 2 is the only gap. So: two counterspell cuts (3 → 2 → 1), then Lord of Atlantis, never a third counterspell.
  const counters = ["Counterspell", "Negate", "Mana Leak"];
  const decklist = `1 Lord of Atlantis\n${counters.map((n) => `1 ${n}`).join("\n")}\n30 Island`;
  for (const n of counters) expect(rolesOfName(n)).toEqual(["counterspell"]);
  expect(rolesOfName("Lord of Atlantis")).toEqual([]);
  const targets = { ...Object.fromEntries(store.roles.roleNames.map((r) => [r, 0])), ramp: 2, counterspell: 1 };
  const r = swapCandidates(store, { commander: "Namor the Sub-Mariner", decklist, lever: "roles", targets });
  expect(r.candidates.length).toBe(3); // three fills for the one gap
  for (const c of r.candidates) expect(rolesOfName(c.in!.name)).not.toContain("counterspell"); // so no fill offsets a counterspell cut
  const outs = r.candidates.map((c) => c.out?.name ?? null);
  expect(outs.slice(0, 2).every((n) => n !== null && counters.includes(n))).toBe(true);
  expect(outs[2]).toBe("Lord of Atlantis");
  expect(r.candidates[0].reason).toContain("counterspell 3 over target 1");
  expect(r.candidates[2].reason).toContain("cut Lord of Atlantis: counts toward no role");
  for (const c of r.candidates) expect(c.belowTarget).toBe(false);

  // nothing over target, but a card with no role: the fill is paired with it instead of standing as an add
  const flat = swapCandidates(store, { commander: "Namor the Sub-Mariner", decklist: "1 Lord of Atlantis\n1 Negate\n30 Island", lever: "roles", targets });
  expect(flat.candidates[0].out?.name).toBe("Lord of Atlantis");
  expect(flat.candidates.slice(1).every((c) => c.out === null)).toBe(true); // Negate would leave counterspell under target
}, 60_000);

test("role lever pairing: for random decks, no paired cut lowers a role below target or undoes its fill, and a fill stands alone only when no deck card is a safe cut for it", () => {
  let paired = 0, alone = 0;
  fc.assert(fc.property(deckDraw, fc.nat(2), ({ commander, seeds, off }, t) => {
    const decklist = drawDeck(commander, seeds, off);
    const targets = Object.fromEntries(store.roles.roleNames.map((r, i) => [r, (i + t) % 3])); // a mix of under, at and over
    const r = swapCandidates(store, { commander, decklist, lever: "roles", targets, limit: 6 });
    const count = Object.fromEntries(r.roles!.map((x) => [x.role, x.count]));
    for (const c of r.candidates) {
      if (!c.out) continue;
      for (const role of store.roles.roleNames) {
        if (c.after.roleCounts[role] < count[role]) expect(c.after.roleCounts[role]).toBeGreaterThanOrEqual(targets[role]);
      }
      expect(r.roles!.some((x) => x.status === "under" && c.after.roleCounts[x.role] > x.count)).toBe(true);
    }
    expect(new Set(r.candidates.flatMap((c) => (c.out ? [c.out.name] : []))).size).toBe(r.candidates.filter((c) => c.out).length);
    // the first fill sees the whole deck: if it stands alone, no deck card was a safe cut for it
    const first = r.candidates[0];
    if (!first) return;
    if (first.out) { paired++; return; }
    alone++;
    const fillRoles = new Set(rolesOfName(first.in!.name));
    const cmd = r.commander.name;
    const deckCards = [...new Set(decklist.split("\n").map((l) => l.replace(/^1 /, "")))]
      .filter((n) => n !== cmd && !cardDetails(store, { name: n }).card.land && !r.unresolved.some((u) => u.text === n));
    for (const d of deckCards) {
      const dRoles = new Set(rolesOfName(d));
      const delta = (role: string) => (fillRoles.has(role) ? 1 : 0) - (dRoles.has(role) ? 1 : 0);
      const raises = r.roles!.some((x) => x.status === "under" && delta(x.role) > 0);
      const safe = store.roles.roleNames.every((role) => delta(role) >= 0 || count[role] + delta(role) >= targets[role]);
      expect({ fill: first.in!.name, d, safeCut: raises && safe }).toEqual({ fill: first.in!.name, d, safeCut: false });
    }
  }), { numRuns: 40, seed: 1103 });
  expect(paired).toBeGreaterThan(10);
}, 120_000);

// ---------- neighbors (ISC-26) ----------
// Expected lists come from MV-10's in-color graph (in-color.ts loadInColor, data/card-space/in-color/knn-U-k30.json),
// built from the Card Space features, not from the store.

test("neighbors tool: each Namor card's in-color neighbors, with scores, equal MV-10's mono-blue top 30, every one commander-legal and inside the identity (ISC-26)", async () => {
  const { loadInColor } = await import("./in-color");
  const base = await loadSpace();
  const knn = await loadInColor(["U"], (id) => base.cards.get(id)?.ci ?? ["?"]);
  const cmd = resolveName(base, "Namor the Sub-Mariner")!;
  const deck = parseDecklist(base, await Bun.file(NAMOR_DECK).text()).entries.map((e) => e.card!).filter((c) => c.inSpace && c.id !== cmd.id);
  expect(deck.length).toBe(63);
  let full = 0;
  for (const c of deck) {
    const r = neighbors(store, { card: c.name, commander: "Namor the Sub-Mariner" });
    const want = knn.get(c.id)!;
    expect({ card: r.card.name, names: r.neighbors.map((n) => n.name) }).toEqual({ card: c.name, names: want.nb.map((id) => base.cards.get(id)!.name) });
    r.neighbors.forEach((n, i) => {
      expect(n.rank).toBe(i + 1);
      expect(n.score).toBeCloseTo(want.ns[i], 3);
      expect(legalInside(n.name, "U")).toBe(true);
    });
    if (r.neighbors.length === 30) full++;
  }
  expect(full).toBeGreaterThan(55); // text-less cards may have fewer; the deck's cards mostly have 30
  expect(neighbors(store, { card: "Remand", commander: "Namor the Sub-Mariner", limit: 5 }).neighbors.map((n) => n.rank)).toEqual([1, 2, 3, 4, 5]);
  expect(r0().commander).toEqual({ name: "Namor the Sub-Mariner", colorIdentity: "U" });
  expect(r0().neighbors[0]).toMatchObject({ rank: 1, name: expect.any(String), score: expect.any(Number), manaValue: expect.any(Number), roles: expect.any(Array) });
}, 120_000);

const r0 = () => neighbors(store, { card: "Remand", commander: "Namor the Sub-Mariner" });

test("neighbors tool: a card outside the commander's identity, a land, and an inexact commander are errors; the MCP answers like the function", async () => {
  expect(() => neighbors(store, { card: "Lightning Bolt", commander: "Namor the Sub-Mariner" })).toThrow(/Lightning Bolt is outside Namor the Sub-Mariner's color identity/);
  expect(() => neighbors(store, { card: "Island", commander: "Namor the Sub-Mariner" })).toThrow(/Island is not in the Card Space/);
  expect(() => neighbors(store, { card: "Remand", commander: "Namor" })).toThrow(/not an exact card name/);
  const viaMcp = await client.callTool({ name: "neighbors", arguments: { card: "Remand", commander: "Namor the Sub-Mariner", limit: 3 } });
  expect(viaMcp.isError).toBeFalsy();
  expect(viaMcp.structuredContent).toEqual(neighbors(store, { card: "Remand", commander: "Namor the Sub-Mariner", limit: 3 }));
  const bad = await client.callTool({ name: "neighbors", arguments: { card: "Lightning Bolt", commander: "Namor the Sub-Mariner" } });
  expect(bad.isError).toBe(true);
});

test("swap tools over MCP: swap_candidates answers through the client with the same result as the function; mistakes and SQL come back as tool errors", async () => {
  const args = { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt", lever: "plan", card: "Remand", limit: 3, plan: NAMOR_PLAN };
  const res = await client.callTool({ name: "swap_candidates", arguments: args });
  expect(res.isError).toBeFalsy();
  expect(res.structuredContent).toEqual(JSON.parse(JSON.stringify(swapCandidates(store, args as Parameters<typeof swapCandidates>[1]))));
  const evil = "x' OR '1'='1'; DROP TABLE cards; --";
  for (const bad of [
    { ...args, card: evil }, { ...args, commander: evil }, { ...args, lever: "roles; DROP TABLE cards" },
    { ...args, card: undefined, lever: "roles", targets: { [evil]: 1 } }, { ...args, lever: "roles" },
  ]) {
    const r = await client.callTool({ name: "swap_candidates", arguments: bad });
    expect(r.isError).toBe(true);
  }
  const r = await client.callTool({ name: "reject_swap", arguments: { commander: "Namor the Sub-Mariner" } });
  expect(r.isError).toBe(true);
  expect((r.content as { text: string }[])[0].text).toMatch(/out, in or both/);
  expect((store.db.query("SELECT COUNT(*) AS n FROM cards").get() as { n: number }).n).toBe(cards.length);
});

// ---------- accept and reject (ISC-24) ----------
// Each test works on a copy of the Namor fixture in a fresh temp folder, with its own label file.
function scratchDeck() {
  const dir = mkdtempSync(join(tmpdir(), "mv16-"));
  const deckFile = join(dir, "namor.txt");
  copyFileSync(NAMOR_DECK, deckFile);
  return { dir, deckFile, labelsPath: join(dir, "labels.jsonl") };
}

test("accept writes: accepting a swap rewrites the deck file (out line swapped for in, nothing else touched) with a dated change-log line appended (ISC-24.1)", async () => {
  const { dir, deckFile, labelsPath } = scratchDeck();
  try {
    const original = readFileSync(deckFile, "utf8");
    const res = acceptSwap(store, { commander: "Namor the Sub-Mariner", deckFile, out: "Remand", in: "Archmage's Charm", lever: "plan" }, { labelsPath, today: "2026-11-06" });
    const now = readFileSync(deckFile, "utf8");
    const was = original.split("\n"), is = now.split("\n");
    // the Remand line became the Archmage's Charm line; one change-log line at the end; every other line byte-identical
    const at = was.findIndex((l) => l.trim() === "1 Remand");
    expect(is.slice(0, was.length)).toEqual([...was.slice(0, at), "1 Archmage's Charm", ...was.slice(at + 1)]);
    expect(is.slice(was.length)).toEqual(["# 2026-11-06 accepted swap (plan): -1 Remand, +1 Archmage's Charm"]);
    expect(res.changeLog).toBe("# 2026-11-06 accepted swap (plan): -1 Remand, +1 Archmage's Charm");
    // the rewritten file still reads as a 100-card deck with the swap in it, and the change-log line is not a card
    const s = deckStats(store, { deckFile, commander: "Namor the Sub-Mariner" });
    expect(s).toMatchObject({ cards: 100, unresolved: [] });
    expect(res.after.cards).toBe(100);
    const names = parseDecklist(store.space, now).entries.map((e) => e.card!.name);
    expect(names).toContain("Archmage's Charm");
    expect(names).not.toContain("Remand");

    // a second accept appends a second line; a pure cut (no incoming card) drops the line
    acceptSwap(store, { commander: "Namor the Sub-Mariner", deckFile, out: "Sol Ring" }, { labelsPath, today: "2026-11-07" });
    const third = readFileSync(deckFile, "utf8").split("\n");
    expect(third.slice(-2)).toEqual(["# 2026-11-06 accepted swap (plan): -1 Remand, +1 Archmage's Charm", "# 2026-11-07 accepted swap: -1 Sol Ring"]);
    expect(third.some((l) => l.trim() === "1 Sol Ring")).toBe(false);

    // refusals leave the file alone: card not in the deck, off-identity or already-present incoming card, inexact names
    const before = readFileSync(deckFile, "utf8");
    expect(() => acceptSwap(store, { commander: "Namor the Sub-Mariner", deckFile, out: "Lightning Bolt", in: "Opt" }, { labelsPath })).toThrow(/Lightning Bolt is not in the deck/);
    expect(() => acceptSwap(store, { commander: "Namor the Sub-Mariner", deckFile, out: "Opt", in: "Lightning Bolt" }, { labelsPath })).toThrow(/outside the commander's color identity/);
    expect(() => acceptSwap(store, { commander: "Namor the Sub-Mariner", deckFile, out: "Opt", in: "Consider" }, { labelsPath })).toThrow(/Consider is already in the deck/);
    expect(() => acceptSwap(store, { commander: "Namor the Sub-Mariner", deckFile, out: "Rema", in: "Opt" }, { labelsPath })).toThrow(/not an exact card name/);
    expect(() => acceptSwap(store, { commander: "Namor the Sub-Mariner", deckFile }, { labelsPath })).toThrow(/out, in or both/);
    expect(() => acceptSwap(store, { commander: "Namor the Sub-Mariner", deckFile: join(dir, "nope.txt"), out: "Opt" }, { labelsPath })).toThrow(/cannot read deck file/);
    expect(readFileSync(deckFile, "utf8")).toBe(before);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("verdict labels: every accept and every reject appends one label row with its card pair, verdict, commander and lever; the default label file is gitignored (ISC-24.2)", async () => {
  const { dir, deckFile, labelsPath } = scratchDeck();
  try {
    acceptSwap(store, { commander: "Namor the Sub-Mariner", deckFile, out: "Remand", in: "Archmage's Charm", lever: "plan", note: "strictly better here" }, { labelsPath, today: "2026-11-06" });
    rejectSwap(store, { commander: "Namor the Sub-Mariner", out: "Dig Through Time", in: "Ancestral Memories", lever: "plan" }, { labelsPath, today: "2026-11-06" });
    rejectSwap(store, { commander: "Namor the Sub-Mariner", deckFile, out: "Opt", in: "Preordain", lever: "cheaper" }, { labelsPath, today: "2026-11-07" });
    const rows = readFileSync(labelsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toEqual([
      { date: "2026-11-06", verdict: "accept", commander: "Namor the Sub-Mariner", out: "Remand", in: "Archmage's Charm", lever: "plan", deckFile, note: "strictly better here" },
      { date: "2026-11-06", verdict: "reject", commander: "Namor the Sub-Mariner", out: "Dig Through Time", in: "Ancestral Memories", lever: "plan", deckFile: null, note: null },
      { date: "2026-11-07", verdict: "reject", commander: "Namor the Sub-Mariner", out: "Opt", in: "Preordain", lever: "cheaper", deckFile, note: null },
    ]);
    // a reject never touches the deck file; a refused accept writes no label
    const deck = readFileSync(deckFile, "utf8");
    expect(() => acceptSwap(store, { commander: "Namor the Sub-Mariner", deckFile, out: "Lightning Bolt", in: "Opt" }, { labelsPath })).toThrow();
    expect(readFileSync(labelsPath, "utf8").trim().split("\n")).toHaveLength(3);
    expect(readFileSync(deckFile, "utf8")).toBe(deck);
    // the default label file lives in the repo and is gitignored (per-user verdicts)
    expect(LABELS_PATH).toBe(join(new URL("../", import.meta.url).pathname, "labels", "swap-verdicts.jsonl"));
    const ignored = Bun.spawnSync(["git", "check-ignore", "-q", "labels/swap-verdicts.jsonl"], { cwd: new URL("../", import.meta.url).pathname });
    expect(ignored.exitCode).toBe(0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

// ---------- diagnose (DT-6.4) ----------

test("ISC-41: the diagnose tool's input schema takes the plan (themes, priority cards, themes to avoid), and a call without it is refused", async () => {
  const schema = (await toolSchema("diagnose")) as JsonSchema & { required?: string[] };
  expect(schema.required).toEqual(expect.arrayContaining(["commander", "plan"]));
  const plan = schema.properties!.plan as JsonSchema & { anyOf?: unknown };
  expect(Object.keys(plan.properties ?? {}).sort()).toEqual(["avoid", "priorities", "themes"]);
  for (const k of ["avoid", "priorities", "themes"]) expect(plan.properties![k].type).toBe("array");
  const noPlan = await client.callTool({ name: "diagnose", arguments: { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt" } });
  expect(noPlan.isError).toBe(true);
  const emptyPlan = await client.callTool({ name: "diagnose", arguments: { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt", plan: {} } });
  expect(emptyPlan.isError).toBe(true);
  expect((emptyPlan.content as { text: string }[])[0].text).toMatch(/at least one theme or one priority card/);
});

test("diagnose over MCP: the tool answers with the same result as the function; an unknown theme comes back as a tool error naming close themes", async () => {
  const args = { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt", plan: NAMOR_PLAN };
  const res = await client.callTool({ name: "diagnose", arguments: args });
  expect(res.isError).toBeFalsy();
  expect(res.structuredContent).toEqual(JSON.parse(JSON.stringify(diagnose(store, args))));
  const bad = await client.callTool({ name: "diagnose", arguments: { ...args, plan: { themes: ["Spellslingr"] } } });
  expect(bad.isError).toBe(true);
  expect((bad.content as { text: string }[])[0].text).toContain("Spellslinger");
}, 60_000);
