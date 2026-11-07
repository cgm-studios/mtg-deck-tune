// The shortlist tool (DT-6.5, ISA ISC-45.2, ISC-59 to 65). One seam: shortlist(store, input), the plain function the MCP
// tool wraps (the tool itself, ISC-41 and ISC-67, is tested in mcp.test.ts). Expected values come from outside the code
// under test: the card tool's roles, the store's plain columns, the fixtures' own lines, and the diagnose tool's payoffs.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cardDetails, openStore, type Store } from "./deck-tools";
import { DB_PATH } from "./paths";
import { SHORTLIST_LABELS, shortlist, type ShortlistResult } from "./shortlist";

const fixture = (f: string) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8");
/** The card names a fixture lists, front face and lower case, read straight off its counted lines. */
const listed = (f: string) => new Set(fixture(f).split("\n").map((l) => l.trim().match(/^\d+\s+(.+)$/)?.[1]).filter((n): n is string => !!n).map((n) => n.split(" // ")[0].toLowerCase()));
const front = (n: string) => n.split(" // ")[0].toLowerCase();

const NAMOR = { commander: "Namor the Sub-Mariner", deckFile: "fixtures/namor.txt" };
const TEYSA = { commander: "Teysa Karlov", deckFile: "fixtures/teysa.txt" };
const SPELLSLINGER = { themes: ["Spellslinger"] };
const ARISTOCRATS = { themes: ["Aristocrats"] };

let store: Store;
type Facts = { mv: number; usd: number | null; ci: string; legal: boolean };
let facts: Map<string, Facts>;

beforeAll(() => {
  store = openStore(DB_PATH);
  // the store's plain columns, read without the tool's code: every row is a commander-legal card (store.ts)
  facts = new Map((store.db.query("SELECT name, mana_value, usd_price, color_identity FROM cards").all() as { name: string; mana_value: number; usd_price: number | null; color_identity: string }[])
    .map((r) => [r.name, { mv: r.mana_value, usd: r.usd_price, ci: r.color_identity, legal: true }]));
}, 60_000);

const inside = (ci: string, identity: string) => [...ci].every((c) => identity.includes(c));

describe("one shortlist (ISC-59, ISC-60)", () => {
  let r: ShortlistResult;
  beforeAll(() => { r = shortlist(store, { ...NAMOR, plan: SPELLSLINGER, problem: { role: "removal" } }); }, 120_000);

  test("ISC-59: Namor's removal shortlist is at most 30 commander-legal blue cards outside the deck, each holding removal", () => {
    expect(r.cards.length).toBeGreaterThan(20);
    expect(r.cards.length).toBeLessThanOrEqual(30);
    const deck = listed("namor.txt");
    for (const c of r.cards) {
      const f = facts.get(c.name);
      expect([c.name, !!f]).toEqual([c.name, true]);
      expect([c.name, inside(f!.ci, "U")]).toEqual([c.name, true]);
      expect([c.name, deck.has(front(c.name))]).toEqual([c.name, false]);
      expect([c.name, cardDetails(store, { name: c.name }).card.roles.map((x) => x.role)]).toEqual([c.name, expect.arrayContaining(["removal"])]);
    }
    expect(new Set(r.cards.map((c) => c.name)).size).toBe(r.cards.length);
  });

  test("ISC-60: every card carries at least one known source label, and the four labels all occur", () => {
    for (const c of r.cards) {
      expect(c.labels.length).toBeGreaterThan(0);
      for (const l of c.labels) expect(SHORTLIST_LABELS).toContain(l);
    }
    expect(new Set(r.cards.flatMap((c) => c.labels))).toEqual(new Set(SHORTLIST_LABELS));
  });
});

describe("links into the deck (ISC-61)", () => {
  test("ISC-61: every card on Teysa's death-enabler shortlist lists its deck links or says it has none; Carrion Feeder feeds two or more of the deck's death payoffs", async () => {
    const { diagnose } = await import("./diagnose");
    const r = shortlist(store, { ...TEYSA, plan: ARISTOCRATS, problem: { engineGap: "a creature dying" } });
    expect(r.problem).toMatchObject({ kind: "engine gap", mechanic: "a creature dying" });
    // the payoffs come from the diagnose tool, a separate reading of the same deck
    const gap = diagnose(store, { ...TEYSA, plan: ARISTOCRATS }).engineGaps.find((g) => g.mechanic === "a creature dying")!;
    expect(r.problem.kind === "engine gap" && r.problem.payoffs).toEqual([...gap.payoffs].sort());
    const deck = listed("teysa.txt");
    for (const c of r.cards) {
      expect([c.name, c.links.length > 0 || typeof c.noLinks === "string"]).toEqual([c.name, true]);
      // every linked card is a card of the list, and the partner count is the distinct cards linked
      const linked = new Set(c.links.flatMap((l) => [...l.feeds, ...l.fedBy]));
      for (const n of linked) expect([c.name, n, deck.has(front(n))]).toEqual([c.name, n, true]);
      expect([c.name, c.evidence.partners]).toEqual([c.name, linked.size]);
      // a gap's candidates each feed at least one payoff, and say which
      expect(c.evidence.feeds!.length).toBeGreaterThan(0);
      for (const p of c.evidence.feeds!) expect(gap.payoffs).toContain(p);
    }
    const feeder = r.cards.find((c) => c.name === "Carrion Feeder");
    expect(feeder).toBeDefined();
    const fedPayoffs = feeder!.links.find((l) => l.on === "a creature dying")!.feeds.filter((n) => gap.payoffs.includes(n));
    expect(fedPayoffs.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  test("ISC-61: a card that links to nothing in the deck says so", () => {
    // Namor's counterspell pool on a five-card list: most candidates link to none of five lands-and-rocks cards
    const r = shortlist(store, { commander: "Namor the Sub-Mariner", decklist: "1 Namor the Sub-Mariner\n1 Island\n1 Sol Ring\n1 Mind Stone\n1 Arcane Signet", plan: SPELLSLINGER, problem: { role: "counterspell" } });
    const lonely = r.cards.filter((c) => c.links.length === 0);
    expect(lonely.length).toBeGreaterThan(0);
    for (const c of lonely) { expect(c.noLinks).toMatch(/no card in the deck|generic|cannot read/); expect(c.evidence.partners).toBe(0); }
  }, 60_000);
});

describe("the plan shapes the shortlist (ISC-62)", () => {
  test("ISC-62: Namor's removal shortlist under a spellslinger plan differs from the one under a tokens plan", () => {
    const names = (themes: string[]) => shortlist(store, { ...NAMOR, plan: { themes }, problem: { role: "removal" } }).cards.map((c) => c.name);
    const spell = new Set(names(["Spellslinger"])), tokens = new Set(names(["Tokens"]));
    const onlySpell = [...spell].filter((n) => !tokens.has(n)), onlyTokens = [...tokens].filter((n) => !spell.has(n));
    console.log(`ISC-62: ${onlySpell.length} cards only under Spellslinger (${onlySpell.join("; ")}), ${onlyTokens.length} only under Tokens (${onlyTokens.join("; ")})`);
    expect(onlySpell.length).toBeGreaterThan(0);
    expect(onlyTokens.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("ceilings (ISC-64)", () => {
  test("ISC-64: under random mana value and price ceilings, every shortlist card is at or under each ceiling given", async () => {
    const fc = (await import("fast-check")).default;
    const ROLES = store.roles.roleNames;
    let runs = 0, cardsSeen = 0;
    const arb = fc.record({
      k: fc.integer({ min: 0, max: 1 }),
      role: fc.constantFrom(...ROLES),
      mv: fc.option(fc.integer({ min: 0, max: 12 }).map((x) => x / 2), { nil: undefined }),
      usd: fc.option(fc.integer({ min: 5, max: 4000 }).map((x) => x / 100), { nil: undefined }),
    }).filter((r) => r.mv !== undefined || r.usd !== undefined);
    fc.assert(fc.property(arb, (r) => {
      const [base, plan] = r.k === 0 ? [NAMOR, SPELLSLINGER] : [TEYSA, ARISTOCRATS];
      const res = shortlist(store, { ...base, plan, problem: { role: r.role }, ...(r.mv !== undefined ? { maxManaValue: r.mv } : {}), ...(r.usd !== undefined ? { maxPrice: r.usd } : {}) });
      expect(res.ceilings).toEqual({ maxManaValue: r.mv ?? null, maxPrice: r.usd ?? null });
      runs++;
      for (const c of res.cards) {
        cardsSeen++;
        const f = facts.get(c.name)!;
        if (r.mv !== undefined) expect([c.name, f.mv <= r.mv]).toEqual([c.name, true]);
        if (r.usd !== undefined) expect([c.name, f.usd !== null && f.usd <= r.usd]).toEqual([c.name, true]);
      }
    }), { numRuns: 40, seed: 6401 });
    console.log(`ISC-64: ${runs} runs, ${cardsSeen} cards checked`);
    expect(cardsSeen).toBeGreaterThan(runs * 10);
  }, 240_000);
});

// ---------- leave-one-out (ISC-65) ----------
// Each nonland, non-commander card of the list is taken out in turn, and for each role it holds the shortlist for that
// role is asked of the list without it, under the deck's own plan; a held-out role slot counts when the card comes back.
// A card holding two roles is two slots. The floors are the graph prototype's union on the same decks (ISA ISC-65).
function leaveOneOut(file: string, commander: string, plan: { themes: string[] }): { slots: number; found: number; missed: string[] } {
  const lines = fixture(file).split("\n");
  const entries = lines.map((l, k) => ({ k, name: l.trim().match(/^\d+\s+(.+)$/)?.[1] })).filter((e): e is { k: number; name: string } => !!e.name);
  let slots = 0, found = 0;
  const missed: string[] = [];
  for (const e of entries) {
    const d = cardDetails(store, { name: e.name }).card;
    if (d.name === commander || d.typeLine.split(" // ")[0].includes("Land")) continue;
    for (const role of d.roles.map((x) => x.role)) {
      const decklist = lines.filter((_, k) => k !== e.k).join("\n");
      const r = shortlist(store, { commander, decklist, plan, problem: { role } });
      slots++;
      if (r.cards.some((c) => c.name === d.name)) found++;
      else missed.push(`${role}: ${d.name}`);
    }
  }
  return { slots, found, missed };
}

describe("recall on real decks (ISC-65)", () => {
  test("ISC-65: on the Namor and Teysa leave-one-outs the shortlist holds at least 30 of 57 and 24 of 39 held-out role slots", () => {
    const namor = leaveOneOut("namor.txt", "Namor the Sub-Mariner", SPELLSLINGER);
    const teysa = leaveOneOut("teysa.txt", "Teysa Karlov", ARISTOCRATS);
    console.log(`ISC-65: Namor ${namor.found} of ${namor.slots}, Teysa ${teysa.found} of ${teysa.slots}`);
    expect(namor.slots).toBe(57);
    expect(teysa.slots).toBe(39);
    expect(namor.found).toBeGreaterThanOrEqual(30);
    expect(teysa.found).toBeGreaterThanOrEqual(24);
  }, 300_000);
});

// ---------- random decks, plans and problems (ISC-59, ISC-60, ISC-63) ----------
// A shortlist call is a few hundred milliseconds once a deck's links are read (the graph index and every card's link
// tests are kept per store), so the property draws from a small pool: random subsets of the Namor and Teysa lists plus a
// few random in-color cards, random plans from five usable themes with the deck's own cards as priorities and themes to
// avoid, every role, six engine events and the off-plan problem, and random ceilings. Each run computes one shortlist and
// checks all three criteria on it.
const THEMES = ["Aristocrats", "Tokens", "Spellslinger", "+1/+1 Counters", "Voltron"];
const EVENTS = ["a creature dying", "casting a spell", "drawing a card", "making a token", "gaining life", "something entering the battlefield"];
const COMMANDERS = ["Namor the Sub-Mariner", "Teysa Karlov"];

async function randomCases(s: Store) {
  const fc = (await import("fast-check")).default;
  const lists = (["namor.txt", "teysa.txt"] as const).map((f) => fixture(f).split("\n").map((l) => l.trim()).filter((l) => /^\d+ /.test(l)));
  const extras = COMMANDERS.map((c) => {
    const ci = new Set(s.space.cards.get(s.names.find((n) => n.name === c)!.oracleId)!.ci);
    return [...s.space.cards.values()].filter((x) => !x.land && x.ci.every((k) => ci.has(k))).map((x) => x.name).sort().slice(0, 4000);
  });
  const problem = fc.oneof(
    fc.constantFrom(...s.roles.roleNames).map((role) => ({ role })),
    fc.constantFrom(...EVENTS).map((engineGap) => ({ engineGap })),
    fc.constant({ offPlan: true as const }),
  );
  return fc.integer({ min: 0, max: 1 }).chain((k) => fc.record({
    k: fc.constant(k),
    lines: fc.subarray(lists[k], { minLength: 10, maxLength: lists[k].length }),
    extra: fc.subarray(extras[k], { maxLength: 4 }),
    themes: fc.subarray(THEMES, { maxLength: 2 }),
    priorities: fc.subarray(lists[k].map((l) => l.replace(/^\d+ /, "")).filter((n) => n !== COMMANDERS[k]).slice(0, 30), { maxLength: 2 }),
    avoid: fc.subarray(THEMES, { maxLength: 1 }),
    problem,
    mv: fc.option(fc.integer({ min: 1, max: 12 }).map((x) => x / 2), { nil: undefined, freq: 3 }),
    usd: fc.option(fc.integer({ min: 25, max: 4000 }).map((x) => x / 100), { nil: undefined, freq: 3 }),
    seed: fc.integer(),
  })).filter((r) => r.themes.length + r.priorities.length > 0 && !r.avoid.some((a) => r.themes.includes(a))).map((r) => {
    const lines = [...r.lines, ...r.extra.map((n) => `1 ${n}`)];
    const plan = { ...(r.themes.length ? { themes: r.themes } : {}), ...(r.priorities.length ? { priorities: r.priorities } : {}), ...(r.avoid.length ? { avoid: r.avoid } : {}) };
    return {
      lines, seed: r.seed,
      input: { commander: COMMANDERS[r.k], decklist: lines.join("\n"), plan, problem: r.problem, ...(r.mv !== undefined ? { maxManaValue: r.mv } : {}), ...(r.usd !== undefined ? { maxPrice: r.usd } : {}) },
    };
  });
}

describe("every shortlist (ISC-59, ISC-60, ISC-63)", () => {
  test("ISC-59, ISC-60, ISC-63: for random decks, plans and problems, at most 30 in-identity cards outside the deck, every card labeled, and at most 10 in only through the widely played list", async () => {
    const fc = (await import("fast-check")).default;
    const { ToolInputError } = await import("./deck-tools");
    const ci = new Map(COMMANDERS.map((c) => [c, facts.get(c)!.ci]));
    let runs = 0, answered = 0, full = 0, onlyWide = 0;
    fc.assert(fc.property(await randomCases(store), ({ input, lines }) => {
      runs++;
      let r: ShortlistResult;
      try { r = shortlist(store, input); } catch (e) {
        // an engine event this deck has no payoff on, or a priority card without graph data, is the caller's to fix
        if (!(e instanceof ToolInputError)) throw e;
        return;
      }
      answered++;
      const deck = new Set(lines.map((l) => front(l.replace(/^\d+\s+/, ""))));
      // ISC-59
      expect(r.cards.length).toBeLessThanOrEqual(30);
      if (r.cards.length === 30) full++;
      expect(new Set(r.cards.map((c) => c.name)).size).toBe(r.cards.length);
      for (const c of r.cards) {
        const f = facts.get(c.name);
        expect([c.name, !!f && f.legal]).toEqual([c.name, true]);
        expect([c.name, inside(f!.ci, ci.get(input.commander)!)]).toEqual([c.name, true]);
        expect([c.name, deck.has(front(c.name)), c.name === input.commander]).toEqual([c.name, false, false]);
      }
      // ISC-60
      for (const c of r.cards) {
        expect(c.labels.length).toBeGreaterThan(0);
        for (const l of c.labels) expect(SHORTLIST_LABELS).toContain(l);
      }
      // ISC-63
      const only = r.cards.filter((c) => c.labels.length === 1 && c.labels[0] === "widely played").length;
      onlyWide = Math.max(onlyWide, only);
      expect(only).toBeLessThanOrEqual(10);
    }), { numRuns: 30, seed: 5901 });
    console.log(`ISC-59/60/63: ${runs} runs, ${answered} answered, ${full} full shortlists, at most ${onlyWide} cards in only through the widely played list`);
    expect(answered / runs).toBeGreaterThan(0.6);
    expect(full).toBeGreaterThan(answered / 2);
  }, 300_000);
});

describe("the plan's other parts", () => {
  test("the off-plan problem returns only cards that fit the plan", () => {
    const r = shortlist(store, { ...TEYSA, plan: ARISTOCRATS, problem: { offPlan: true } });
    expect(r.problem).toEqual({ kind: "off plan" });
    expect(r.cards.length).toBe(30);
    for (const c of r.cards) expect([c.name, c.evidence.planFit.score > 0]).toEqual([c.name, true]);
  }, 60_000);

  test("a theme to avoid leaves out cards that fit it and not the plan, and the notes say how many", async () => {
    const { resolvePlan, planScorer } = await import("./plan");
    const plan = { themes: ["Spellslinger"], avoid: ["Tokens"] };
    const r = shortlist(store, { ...NAMOR, plan, problem: { role: "removal" } });
    // the fits are read by the plan module, apart from the shortlist
    const resolved = resolvePlan(store, { commander: NAMOR.commander, plan });
    const tokens = planScorer(store, { ...resolved, themes: resolved.avoid, cards: null });
    const spells = planScorer(store, resolved);
    const id = (n: string) => store.names.find((x) => x.name === n)!.oracleId;
    for (const c of r.cards) expect([c.name, tokens(id(c.name)).score > 0 && spells(id(c.name)).score === 0]).toEqual([c.name, false]);
    expect(r.notes.join(" ")).toMatch(/\d+ cards? left out: .* a theme the plan avoids/);
    const free = shortlist(store, { ...NAMOR, plan: { themes: ["Spellslinger"] }, problem: { role: "removal" } });
    expect(free.pool).toBeGreaterThan(r.pool);
  }, 60_000);
});

describe("commanders without a full page, and caller mistakes", () => {
  test("a commander with no EDHREC page gets no commander-synergy cards, deeper cuts fit to its own card tags, and a note saying so", () => {
    // any legendary creature the graph reads that has no page, chosen from the store, not by name
    const row = store.db.query(`SELECT c.name FROM cards c JOIN card_graph g ON g.card_id = c.id JOIN card_tagger t ON t.card_id = c.id
      WHERE c.type_line LIKE 'Legendary Creature%' AND c.color_identity <> '' AND c.id NOT IN (SELECT card_id FROM commanders) ORDER BY c.name LIMIT 1`).get() as { name: string };
    const r = shortlist(store, { commander: row.name, decklist: `1 ${row.name}`, plan: { themes: ["Voltron"] }, problem: { role: "removal" } });
    expect(r.notes.join(" ")).toMatch(/no EDHREC page/);
    expect(r.cards.length).toBeGreaterThan(0);
    for (const c of r.cards) { expect(c.labels).not.toContain("fits this commander"); expect(c.evidence.commanderSynergy).toBeNull(); }
    expect(r.cards.some((c) => c.labels.includes("deeper cut"))).toBe(true);
  }, 60_000);

  test("a thin page says its deeper cuts are fit to the commander's own card tags", () => {
    const row = store.db.query(`SELECT c.name FROM commanders m JOIN cards c ON c.id = m.card_id JOIN card_graph g ON g.card_id = c.id
      WHERE m.tagger_deck_fallback = 'thin' AND c.color_identity <> '' ORDER BY c.name LIMIT 1`).get() as { name: string };
    const r = shortlist(store, { commander: row.name, decklist: `1 ${row.name}`, plan: { themes: ["Voltron"] }, problem: { role: "removal" } });
    expect(r.notes.join(" ")).toMatch(/thin \(under 20 decks\).*own card tags/);
  }, 60_000);

  test("an out card that is not an exact name, or not in the deck, is a tool error; a known role or event is matched whatever its capitals", () => {
    expect(() => shortlist(store, { ...NAMOR, plan: SPELLSLINGER, problem: { role: "removal" }, out: "Counterspel" })).toThrow(/not an exact card name; candidates: Counterspell/);
    expect(() => shortlist(store, { ...NAMOR, plan: SPELLSLINGER, problem: { role: "removal" }, out: "Swords to Plowshares" })).toThrow(/Swords to Plowshares is not in the deck/);
    // roles and engine events match whatever the capitals
    expect(shortlist(store, { ...NAMOR, plan: SPELLSLINGER, problem: { role: " Removal" } }).problem).toEqual({ kind: "role", role: "removal" });
    expect(shortlist(store, { ...TEYSA, plan: ARISTOCRATS, problem: { engineGap: "A Creature Dying" } }).problem).toMatchObject({ mechanic: "a creature dying" });
  }, 60_000);
});
