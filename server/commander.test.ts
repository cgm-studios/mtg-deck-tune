// DT-6.2: the commander-profile tool. How a commander is usually played: its EDHREC themes with shares, its Tagger Deck
// tags, how strongly a decklist matches each top theme, and the fallback for commanders without a usable page.
// ISA ISC-35, ISC-36, ISC-37, ISC-38. Every expected value comes from a source the tool does not read: the EDHREC pages
// under data/edhrec, mtg-vector's app/tagger.ts run over the raw Scryfall files, never the store's own tables.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { commanderProfile } from "./commander";
import { openStore, type Store } from "./deck-tools";
import { createDeckServer } from "./mcp";

let store: Store;
beforeAll(() => { store = openStore(); });
afterAll(() => store?.db.close());

const DATA = new URL("../data/", import.meta.url).pathname;
type RawPage = { container: { json_dict: { card: { name: string; num_decks: number } } }; tag_counts: { count: number; slug: string; value: string }[] };
// mtg-vector's tagger.ts, the builder the store's vectors came from, run here over the raw Scryfall files. It sits beside the
// data folder this checkout links to; a checkout without it skips the tests that need it.
const TAGGER = `${realpathSync(DATA)}/../app/tagger.ts`;
const haveTagger = existsSync(TAGGER);
type Raw = { name: string; oracle_id: string; type_line?: string; card_faces?: { name: string; type_line?: string }[] };
const jsonl = (file: string) => gunzipSync(readFileSync(`${DATA}scryfall/${file}`)).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let rawOracle: Raw[] | undefined, rawTags: unknown[] | undefined;
async function taggerOracle(name: string, page: unknown) {
  const T = await import(TAGGER);
  rawOracle ??= jsonl("oracle_cards.jsonl.gz") as Raw[];
  rawTags ??= jsonl("oracle_tags.jsonl.gz");
  const card = rawOracle.find((c) => c.name === name)!;
  const out = T.buildTaggerLayers({ commanders: [{ oracleId: card.oracle_id, page }], tags: rawTags, cards: rawOracle });
  const c = out.commanders[0];
  const label = (v: [number, number][], n: number) => T.strongest(v, n).map(([i, w]: [number, number]) => ({ tag: out.tagNames[i] as string, weight: w as number }));
  return { deck: (n: number) => label(c.deck, n), card: (n: number) => label(c.card, n), reason: c.deckFallbackReason as string | null };
}
const rawPage = (slug: string): RawPage => JSON.parse(readFileSync(`${DATA}edhrec/${slug}.json`, "utf8"));

test("themes come back with the page's deck counts and shares of tag mentions, adding to 1 (ISC-35)", () => {
  for (const [name, slug] of [["Helga, Skittish Seer", "helga-skittish-seer"], ["Teysa Karlov", "teysa-karlov"], ["Namor the Sub-Mariner", "namor-the-sub-mariner"]] as const) {
    const page = rawPage(slug);
    const tags = page.tag_counts.filter((t) => t.count > 0);
    const mentions = tags.reduce((n, t) => n + t.count, 0);

    const all = commanderProfile(store, { commander: name, themeLimit: 500 });
    expect(all.decks).toBe(page.container.json_dict.card.num_decks);
    expect(all.themeMentions).toBe(mentions);
    expect(all.themes.length).toBe(tags.length);
    for (const t of all.themes) {
      const raw = tags.find((x) => x.slug === t.slug)!;
      expect(raw).toBeDefined();
      expect(t.theme).toBe(raw.value);
      expect(t.decks).toBe(raw.count);
      expect(t.share).toBeCloseTo(raw.count / mentions, 5);
    }
    expect(all.themes.reduce((s, t) => s + t.share, 0)).toBeCloseTo(1, 3);
    expect(all.otherThemes).toBeNull();

    // the default list is the strongest themes first, with the rest summed so the whole still adds to 1
    const top = commanderProfile(store, { commander: name });
    expect(top.themes.length).toBeLessThan(tags.length);
    expect(top.themes.map((t) => t.decks)).toEqual([...tags].map((t) => t.count).sort((a, b) => b - a).slice(0, top.themes.length));
    expect(top.otherThemes!.count).toBe(tags.length - top.themes.length);
    expect(top.themes.reduce((s, t) => s + t.share, 0) + top.otherThemes!.share).toBeCloseTo(1, 3);
  }
  // the numbers the card quotes: Helga leans +1/+1 Counters (1,528 decks) far more than Stompy (156)
  const helga = commanderProfile(store, { commander: "Helga, Skittish Seer", themeLimit: 500 }).themes;
  expect(helga.find((t) => t.theme === "+1/+1 Counters")!.decks).toBe(1528);
  expect(helga.find((t) => t.theme === "Stompy")!.decks).toBe(156);
});

test.skipIf(!haveTagger)("Namor's strongest Tagger Deck tags equal mtg-vector tagger.ts on the same page (ISC-36)", async () => {
  const want = await taggerOracle("Namor the Sub-Mariner", rawPage("namor-the-sub-mariner"));
  expect(want.reason).toBeNull();
  const got = commanderProfile(store, { commander: "Namor the Sub-Mariner", tagLimit: 25 });
  expect(got.taggerDeck.source).toBe("deck");
  expect(got.taggerDeck.tags.length).toBe(25);
  const top = want.deck(25);
  expect(got.taggerDeck.tags.map((t) => t.tag)).toEqual(top.map((t) => t.tag));
  got.taggerDeck.tags.forEach((t, i) => expect(t.weight).toBeCloseTo(top[i].weight, 4));
  // the default length is shorter than the 25 asked for here
  expect(commanderProfile(store, { commander: "Namor the Sub-Mariner" }).taggerDeck.tags.length).toBeLessThan(25);
});

// ISC-38: Círdan the Shipwright has no EDHREC page (data/edhrec/missing.tsv lists it as a 403); Namor, Scourge of the Seas
// has a page of 18 decks, under the 20-deck floor of tagger.ts. Both are profiled from their own card tags.
test.skipIf(!haveTagger)("a commander with no page, and one under the thin floor, get a profile from their own card tags and the reason (ISC-38)", async () => {
  expect(readFileSync(`${DATA}edhrec/missing.tsv`, "utf8")).toContain("Círdan the Shipwright");
  expect(existsSync(`${DATA}edhrec/cirdan-the-shipwright.json`)).toBe(false);
  expect(rawPage("namor-scourge-of-the-seas").container.json_dict.card.num_decks).toBe(18);

  for (const [name, page, reason] of [["Círdan the Shipwright", null, "no page"], ["Namor, Scourge of the Seas", rawPage("namor-scourge-of-the-seas"), "thin"]] as const) {
    const want = await taggerOracle(name, page);
    expect(want.reason).toBe(reason); // tagger.ts itself says why it fell back
    const got = commanderProfile(store, { commander: name, tagLimit: 40 });
    expect(got.fallback?.reason).toBe(reason);
    expect(got.fallback?.note).toContain(reason === "no page" ? "no EDHREC page" : "18 decks");
    expect(got.taggerDeck.source).toBe("card");
    const top = want.card(40);
    expect(top.length).toBeGreaterThan(0);
    expect(got.taggerDeck.tags.map((t) => t.tag)).toEqual(top.map((t) => t.tag));
    got.taggerDeck.tags.forEach((t, i) => expect(t.weight).toBeCloseTo(top[i].weight, 4));
    // a page that thin gives no themes worth quoting
    expect(got.themes).toEqual([]);
    expect(got.otherThemes).toBeNull();
  }
  expect(commanderProfile(store, { commander: "Círdan the Shipwright" }).decks).toBeNull();
  expect(commanderProfile(store, { commander: "Namor, Scourge of the Seas" }).decks).toBe(18);
  // a commander with a full page has no fallback
  expect(commanderProfile(store, { commander: "Namor the Sub-Mariner" }).fallback).toBeNull();
});

// ISC-37. The oracle re-derives each theme's card profile from the 3,406 raw EDHREC pages and the raw Scryfall oracle,
// not from the store's tables. A theme's cards are weighted across the commanders that play it (theme at least 15% of the
// commander's tag mentions and 20+ decks, at least 10 such commanders, or no profile): a card's mass is the commander's
// theme share times the card's positive EDHREC synergy (run in 3+ of its decks); the card's weight is T * ln(T / B) when
// T / B >= 1.25, where T is its share of the theme's mass and B its share of the same mass over every commander. The
// match is the part of that weight, over cards inside the commander's colors, that the deck holds.
type Page = RawPage & { container: { json_dict: { cardlists: { cardviews: { name: string; num_decks: number; synergy: number }[] }[] } } };
let oracleWorld: { pages: Page[]; byName: Map<string, { id: string; ci: string }> } | undefined;
function world() {
  if (oracleWorld) return oracleWorld;
  const pages = readdirSync(`${DATA}edhrec`).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(`${DATA}edhrec/${f}`, "utf8")) as Page);
  rawOracle ??= jsonl("oracle_cards.jsonl.gz") as Raw[];
  const byName = new Map<string, { id: string; ci: string }>();
  const legal = (rawOracle as (Raw & { legalities: { commander: string }; color_identity: string[] })[]).filter((c) => c.legalities.commander === "legal");
  for (const c of legal) if (!byName.has(c.name)) byName.set(c.name, { id: c.oracle_id, ci: c.color_identity.join("") });
  for (const c of legal) { const front = c.name.split(" // ")[0]; if (!byName.has(front)) byName.set(front, { id: c.oracle_id, ci: c.color_identity.join("") }); }
  return (oracleWorld = { pages, byName });
}
function oracleMatch(commander: string, slug: string, deckNames: string[]): number | null {
  const { pages, byName } = world();
  const mentions = (p: Page) => p.tag_counts.reduce((n, t) => n + t.count, 0);
  const cardsOf = (p: Page) => {
    const m = new Map<string, number>();
    for (const l of p.container.json_dict.cardlists) for (const v of l.cardviews) {
      const hit = byName.get(v.name);
      if (hit && v.synergy > 0 && v.num_decks >= 3) m.set(hit.id, v.synergy);
    }
    return m;
  };
  const chosen = pages.filter((p) => { const t = p.tag_counts.find((x) => x.slug === slug); return !!t && t.count >= 20 && t.count / mentions(p) >= 0.15; });
  if (chosen.length < 10) return null;
  const T = new Map<string, number>(), B = new Map<string, number>();
  let tt = 0, bt = 0;
  for (const p of pages) {
    const share = (p.tag_counts.find((x) => x.slug === slug)?.count ?? 0) / mentions(p);
    const isChosen = chosen.includes(p);
    for (const [id, syn] of cardsOf(p)) {
      B.set(id, (B.get(id) ?? 0) + syn); bt += syn;
      if (isChosen) { T.set(id, (T.get(id) ?? 0) + share * syn); tt += share * syn; }
    }
  }
  const cmd = byName.get(commander)!;
  const fits = (ci: string) => [...ci].every((c) => cmd.ci.includes(c));
  const ciOf = new Map([...byName.values()].map((c) => [c.id, c.ci]));
  const deck = new Set(deckNames.map((n) => byName.get(n)?.id).filter((x): x is string => !!x));
  let held = 0, all = 0;
  for (const [id, mass] of T) {
    const t = mass / tt, b = B.get(id)! / bt;
    if (id === cmd.id || t / b < 1.25 || !fits(ciOf.get(id)!)) continue;
    const w = t * Math.log(t / b);
    all += w;
    if (deck.has(id)) held += w;
  }
  return held / all;
}
const deckNames = (file: string) => readFileSync(file, "utf8").split("\n").map((l) => l.match(/^\d+\s+(.+?)\s*$/)?.[1]).filter((x): x is string => !!x);

test("given Teysa's list, Aristocrats is the strongest theme match, and every match equals the one rebuilt from the pages (ISC-37)", () => {
  const file = new URL("../fixtures/teysa.txt", import.meta.url).pathname;
  const got = commanderProfile(store, { commander: "Teysa Karlov", deckFile: file });
  const dm = got.deckMatch!;
  expect(dm).toBeDefined();
  expect(dm.strongest).toBe("Aristocrats");
  expect(dm.themes[0].theme).toBe("Aristocrats");
  // the list is in Teysa's strongest themes, each judged
  expect(dm.themes.map((t) => t.theme).sort()).toEqual(got.themes.slice(0, dm.themes.length).map((t) => t.theme).sort());
  const names = deckNames(file);
  let judged = 0;
  for (const t of dm.themes) {
    const want = oracleMatch("Teysa Karlov", t.slug, names);
    if (want === null) { expect(t.match).toBeNull(); expect(t.note).toContain("commanders"); continue; }
    judged++;
    expect(t.match).toBeCloseTo(want, 4);
  }
  expect(judged).toBeGreaterThanOrEqual(3);
  // strongest means highest: every judged match sits at or below Aristocrats'
  for (const t of dm.themes) if (t.match !== null) expect(t.match).toBeLessThanOrEqual(dm.themes[0].match!);
  // the cards that make the match are named, and they are in the list
  const aristocrats = dm.themes[0];
  expect(aristocrats.held.length).toBeGreaterThan(0);
  for (const n of aristocrats.held) expect(names).toContain(n);
  for (const n of aristocrats.missing) expect(names).not.toContain(n);
}, 60_000); // re-derives every theme from 3,406 raw pages; about 6 s on a busy machine

test("the MCP lists commander_profile and answers it: data for a real commander, an error the model can read for a bad name", async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createDeckServer(store).connect(a);
  const client = new Client({ name: "commander-test", version: "0" });
  await client.connect(b);
  try {
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("commander_profile");
    const ok = await client.callTool({ name: "commander_profile", arguments: { commander: "Teysa Karlov", themeLimit: 3 } });
    expect(ok.isError).toBeFalsy();
    const sc = ok.structuredContent as { themes: { theme: string }[]; decks: number };
    expect(sc.themes.map((t) => t.theme)).toEqual(["Aristocrats", "Tokens", "Sacrifice"]);
    expect(sc.decks).toBe(21882);
    const bad = await client.callTool({ name: "commander_profile", arguments: { commander: "Teysa Karlo" } });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain("Teysa Karlov");
    const both = await client.callTool({ name: "commander_profile", arguments: { commander: "Teysa Karlov", deckFile: "x.txt", decklist: "1 Sol Ring" } });
    expect(both.isError).toBe(true);
  } finally {
    await client.close();
  }
});
