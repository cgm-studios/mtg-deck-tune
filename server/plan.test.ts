// The player's plan (DT-6.3): named themes, priority cards and themes to avoid resolve, from the card store alone, to
// the profile shape the diagnose and shortlist tools score against (ISA ISC-42, 43, 44, 77). The oracle for the theme
// and card profiles is output recorded from mtg-graph-api on the store's own inputs (fixtures/graph-profiles.json);
// card order differs between the graph's corpus and the store, so cards are compared by identity (name).
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openStore, ToolInputError, type Store } from "./deck-tools";
import { DB_PATH } from "./paths";
import { resolvePlan, ThinThemeError, UnknownThemeError, type PlanProfile } from "./plan";

type Recorded = {
  strategy: Record<string, PlanProfile>;
  cards: Record<string, { plan: { commander: string; priorities: string[] }; profile: PlanProfile }>;
  themes: { name: string; slug: string; qualifying: number; usable: boolean }[];
};
const REC: Recorded = JSON.parse(readFileSync(new URL("../fixtures/graph-profiles.json", import.meta.url), "utf8"));

let store: Store;
beforeAll(() => { store = openStore(DB_PATH); }, 60_000);

/** The graph's profile without the tag side this repo adds: source and hooks, hook for hook. */
const hookSide = (p: PlanProfile) => ({ source: p.source, hooks: p.hooks });

describe("theme plans (ISC-42)", () => {
  for (const theme of Object.keys(REC.strategy)) {
    test(`ISC-42: a plan naming ${theme} resolves to the graph's strategy profile for that theme`, () => {
      const plan = resolvePlan(store, { commander: "Teysa Karlov", plan: { themes: [theme] } });
      expect(plan.themes).toHaveLength(1);
      expect(hookSide(plan.themes[0])).toEqual(hookSide(REC.strategy[theme]));
    }, 60_000);
  }
});

describe("plan errors (ISC-43, ISC-77)", () => {
  const thrown = (plan: Parameters<typeof resolvePlan>[1]["plan"], commander = "Helga, Skittish Seer"): unknown => {
    try { resolvePlan(store, { commander, plan }); } catch (e) { return e; }
    throw new Error("resolvePlan did not throw");
  };

  test("ISC-43: an unknown theme (\"Aristocratz\") is a tool error listing the closest known themes, Aristocrats first", () => {
    const e = thrown({ themes: ["Aristocratz"] });
    expect(e).toBeInstanceOf(ToolInputError);
    expect(e).toBeInstanceOf(UnknownThemeError);
    expect((e as UnknownThemeError).closest[0]).toBe("Aristocrats");
    expect((e as Error).message).toContain('no theme named "Aristocratz"');
    expect((e as Error).message).toContain("Aristocrats");
  });

  test("ISC-43: a theme to avoid is checked the same way", () => {
    expect(thrown({ themes: ["Aristocrats"], avoid: ["Tokenz"] })).toBeInstanceOf(UnknownThemeError);
  });

  test("ISC-77: a known theme under the data floor (Stompy, 3 commanders) says so with its commander count, as a distinct error", () => {
    const e = thrown({ themes: ["Stompy"] });
    expect(e).toBeInstanceOf(ToolInputError);
    expect(e).toBeInstanceOf(ThinThemeError);
    expect(e).not.toBeInstanceOf(UnknownThemeError);
    // the count the graph repo reports for Stompy on the same data (fixtures/graph-profiles.json themes)
    const stompy = REC.themes.find((t) => t.slug === "stompy")!;
    expect(stompy.usable).toBe(false);
    expect((e as ThinThemeError).commanders).toBe(stompy.qualifying);
    expect(stompy.qualifying).toBe(3);
    expect((e as Error).message).toContain("too little data");
    expect((e as Error).message).toContain("only 3 commanders");
    expect((e as Error).message).toMatch(/keystone cards/);
  });

  test("ISC-77: a known theme no commander plays as a main theme reports 0 commanders", () => {
    const zero = REC.themes.find((t) => t.qualifying === 0)!;
    const e = thrown({ themes: [zero.name] });
    expect(e).toBeInstanceOf(ThinThemeError);
    expect((e as ThinThemeError).commanders).toBe(0);
    expect((e as Error).message).toContain("0 commanders");
  });
});

describe("card plans (ISC-44)", () => {
  for (const [key, rec] of Object.entries(REC.cards)) {
    test(`ISC-44: a priority-card plan (${key}) resolves to the graph's card profile for those cards`, () => {
      const plan = resolvePlan(store, { commander: rec.plan.commander, plan: { priorities: rec.plan.priorities } });
      expect(plan.themes).toEqual([]);
      expect(plan.priorities).toEqual(rec.plan.priorities);
      expect(hookSide(plan.cards!)).toEqual(hookSide(rec.profile));
    }, 60_000);
  }

  /** Every key with the type of its value, all the way down (arrays by their first element). */
  const shape = (x: unknown): unknown =>
    Array.isArray(x) ? (x.length ? [shape(x[0])] : []) : x !== null && typeof x === "object"
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, shape((x as Record<string, unknown>)[k])])) : typeof x;

  test("ISC-44: a priority-card plan and a theme plan resolve to the same profile shape (keys and value types, source aside)", () => {
    const cards = resolvePlan(store, { commander: "Teysa Karlov", plan: { priorities: ["Blood Artist", "Viscera Seer"] } }).cards!;
    const theme = resolvePlan(store, { commander: "Teysa Karlov", plan: { themes: ["Aristocrats"] } }).themes[0];
    const { source: cs, ...cardRest } = cards, { source: ts, ...themeRest } = theme;
    // the gap flag is optional on a hook (graph profile.ts): compare hooks without it
    const noGap = (p: typeof cardRest) => ({ ...p, hooks: p.hooks.map(({ gap: _gap, ...h }) => h) });
    expect(shape(noGap(cardRest))).toEqual(shape(noGap(themeRest)));
    expect(cs.kind).toBe("cards");
    expect(ts.kind).toBe("strategy");
    for (const p of [cards, theme]) {
      expect(p.hooks.length).toBeGreaterThan(0);
      expect(p.tags.length).toBeGreaterThan(0);
      expect(p.hooks[0].weight).toBe(1);
      expect(p.tags[0].weight).toBe(1);
      for (const list of [p.hooks, p.tags]) for (let i = 1; i < list.length; i++) expect(list[i].weight).toBeLessThanOrEqual(list[i - 1].weight);
    }
  }, 60_000);
});

test("the theme floor read from the store matches the graph's: every theme's deck count, commander count, qualifying count and usability", async () => {
  const { listThemes } = await import("./graph/strategy");
  const got = listThemes(store.db).map(({ slug, name, decks, commanders, qualifying, usable }) => ({ slug, name, decks, commanders, qualifying, usable }));
  expect(got).toEqual(REC.themes as typeof got);
  expect(got.filter((t) => t.usable).length).toBe(50);
});

describe("the plan's other input checks", () => {
  const err = (commander: string, plan: Parameters<typeof resolvePlan>[1]["plan"]) => {
    try { resolvePlan(store, { commander, plan }); } catch (e) { return e as Error; }
    throw new Error("resolvePlan did not throw");
  };

  test("an empty plan, an inexact or off-identity priority card, a repeated card and an untranslated card are tool errors that say why", () => {
    for (const [commander, plan, why] of [
      ["Teysa Karlov", {}, /at least one theme or one priority card/],
      ["Teysa Karlov", { avoid: ["Tokens"] }, /at least one theme or one priority card/],
      ["Teysa Karlov", { priorities: ["Blood Art"] }, /not an exact card name; candidates: Blood Artist/],
      ["Teysa Karlov", { priorities: ["Krenko, Mob Boss"] }, /outside Teysa Karlov's color identity/],
      ["Teysa Karlov", { priorities: ["Blood Artist", "Blood Artist"] }, /must all be different/],
      ["Teysa Karlov", { priorities: ["Teysa Karlov"] }, /must all be different/],
      ["Teysa Karlov", { priorities: ["Gisa's Favorite Shovel"] }, /no card graph data/],
    ] as const) {
      const e = err(commander, plan as Parameters<typeof resolvePlan>[1]["plan"]);
      expect({ plan, error: e instanceof ToolInputError }).toEqual({ plan, error: true });
      expect(e.message).toMatch(why);
    }
  });

  test("the same commander and plan resolve to the same profiles, card for card, however the theme is spelled", () => {
    const plan = { themes: ["Aristocrats", "+1/+1 Counters"], priorities: ["Blood Artist", "Viscera Seer"], avoid: ["Tokens"] };
    const a = resolvePlan(store, { commander: "Teysa Karlov", plan });
    const b = resolvePlan(store, { commander: "teysa karlov", plan: { ...plan, themes: ["aristocrats", "plus-1-plus-1-counters"] } });
    expect(b).toEqual(a);
    expect(a.themes.map((t) => t.source)).toEqual([
      { kind: "strategy", theme: "Aristocrats", commanders: 86 }, { kind: "strategy", theme: "+1/+1 Counters", commanders: 275 },
    ]);
    expect(a.avoid.map((t) => t.source)).toEqual([{ kind: "strategy", theme: "Tokens", commanders: 269 }]);
  }, 60_000);
});

describe("the ported graph reads only the store", () => {
  test("the store's graph mapping version must match the ported mapping, or the graph is refused", async () => {
    const { Database } = await import("bun:sqlite");
    const { checkMappingVersion } = await import("./graph/store-graph");
    const { MAPPING_VERSION } = await import("./graph/closure");
    expect(MAPPING_VERSION).toBe("0.4.0");
    expect(() => checkMappingVersion(store.db)).not.toThrow();
    for (const value of ["0.3.0", null]) {
      const db = new Database(":memory:");
      db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
      if (value) db.run("INSERT INTO meta VALUES ('graph_mapping_version', ?)", [value]);
      expect(() => checkMappingVersion(db)).toThrow(/mapping/);
      db.close();
    }
  });

  test("the ported mapping file is the graph repo's mapping 0.4.0 byte for byte (its lock hash)", async () => {
    const { createHash } = await import("node:crypto");
    const dir = new URL("./graph/mapping/", import.meta.url);
    const lock = JSON.parse(readFileSync(new URL("forge-map.lock.json", dir), "utf8")) as Record<string, string>;
    expect(createHash("sha256").update(readFileSync(new URL("forge-map.json", dir))).digest("hex")).toBe(lock["0.4.0"]);
  });

  test("no ported module or the plan resolver opens a file, a sibling checkout or the network", async () => {
    const { readdirSync } = await import("node:fs");
    const dir = new URL("./graph/", import.meta.url);
    const sources = [...readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => new URL(f, dir)), new URL("./plan.ts", import.meta.url)];
    expect(sources.length).toBeGreaterThanOrEqual(6);
    for (const f of sources) {
      const text = readFileSync(f, "utf8");
      expect({ f: f.pathname.split("/").pop(), fs: /node:fs|readFileSync|Bun\.file|fetch\(|\.\.\/mtg-|import\.meta\.dir/.test(text) }).toEqual({ f: f.pathname.split("/").pop(), fs: false });
    }
  });
});

describe("the same deck and plan give the same diagnosis (ISC-45.1)", () => {
  // A diagnose call is a few hundred milliseconds warm (the graph index, theme profiles and theme role shares are built
  // once per store), so the property runs over a small pool: random subsets of the Namor and Teysa lists plus a few
  // random in-color cards, under random plans drawn from five usable themes, each deck's own cards as priorities, and
  // themes to avoid. Each run diagnoses the deck twice on one store, once more with its lines shuffled, and once on a
  // second store opened cold (its own index and caches), and all four must agree finding for finding.
  test("ISC-45.1: for random decks and plans, repeated, reordered and cold-store diagnoses are identical", async () => {
    const fc = (await import("fast-check")).default;
    const { diagnose } = await import("./diagnose");
    const cold = openStore(DB_PATH);
    try {
      fc.assert(fc.property(deckAndPlan(fc), (r) => {
        const { lines, plan } = deckOf(r);
        const input = { commander: COMMANDERS[r.k], decklist: lines.join("\n"), plan };
        let a: unknown;
        try { a = diagnose(store, input); } catch (e) {
          // a priority card without graph data, or an avoided theme too thin to profile, is the caller's to fix: the same error every time
          if (!(e instanceof ToolInputError)) throw e;
          expect(() => diagnose(store, input)).toThrow(e.message);
          return;
        }
        const shuffled = [...lines].sort((x, y) => ((hash(x + r.seed) - hash(y + r.seed)) || (x < y ? -1 : 1)));
        expect(diagnose(store, input)).toEqual(a);
        expect(diagnose(store, { ...input, decklist: shuffled.join("\n") })).toEqual(a);
        expect(diagnose(cold, input)).toEqual(a);
      }), { numRuns: 12, seed: 4501 });
    } finally {
      cold.db.close();
    }
  }, 300_000);
});

describe("the same deck, plan and problem give the same shortlist (ISC-45.2)", () => {
  // The same pool of decks and plans as ISC-45.1, each with a random problem (a role, an engine event, or cards off the
  // plan) and random mana value and price ceilings. Each run asks for the shortlist twice on one store, once more with the
  // deck's lines shuffled, and once on a second store opened cold (its own index, link memos and caches): all four must
  // agree card for card, labels, links and numbers included. A shortlist call is a few hundred milliseconds once a deck's
  // links are read, so the run count matches ISC-45.1's.
  test("ISC-45.2: for random decks, plans and problems, repeated, reordered and cold-store shortlists are identical", async () => {
    const fc = (await import("fast-check")).default;
    const { shortlist } = await import("./shortlist");
    const EVENTS = ["a creature dying", "casting a spell", "drawing a card", "making a token", "something entering the battlefield"];
    const problem = fc.oneof(
      fc.constantFrom(...store.roles.roleNames).map((role) => ({ role })),
      fc.constantFrom(...EVENTS).map((engineGap) => ({ engineGap })),
      fc.constant({ offPlan: true as const }),
    );
    const ceilings = fc.record({
      mv: fc.option(fc.integer({ min: 1, max: 12 }).map((x) => x / 2), { nil: undefined, freq: 3 }),
      usd: fc.option(fc.integer({ min: 25, max: 4000 }).map((x) => x / 100), { nil: undefined, freq: 3 }),
    });
    const cold = openStore(DB_PATH);
    let answered = 0, runs = 0;
    try {
      fc.assert(fc.property(deckAndPlan(fc), problem, ceilings, (r, p, c) => {
        runs++;
        const { lines, plan } = deckOf(r);
        const input = { commander: COMMANDERS[r.k], decklist: lines.join("\n"), plan, problem: p, ...(c.mv !== undefined ? { maxManaValue: c.mv } : {}), ...(c.usd !== undefined ? { maxPrice: c.usd } : {}) };
        let a: unknown;
        try { a = shortlist(store, input); } catch (e) {
          // an engine event the deck has no payoff on, or a priority card without graph data: the same error every time
          if (!(e instanceof ToolInputError)) throw e;
          expect(() => shortlist(store, input)).toThrow(e.message);
          expect(() => shortlist(cold, input)).toThrow(e.message);
          return;
        }
        answered++;
        const shuffled = [...lines].sort((x, y) => ((hash(x + r.seed) - hash(y + r.seed)) || (x < y ? -1 : 1)));
        expect(shortlist(store, input)).toEqual(a);
        expect(shortlist(store, { ...input, decklist: shuffled.join("\n") })).toEqual(a);
        expect(shortlist(cold, input)).toEqual(a);
      }), { numRuns: 12, seed: 4502 });
    } finally {
      cold.db.close();
    }
    console.log(`ISC-45.2: ${runs} runs, ${answered} answered`);
    expect(answered).toBeGreaterThan(runs / 2);
  }, 300_000);
});

// ---------- random decks and plans, shared by ISC-45.1 and ISC-45.2 ----------
// Random subsets of the Namor and Teysa lists plus up to four random in-color cards, under random plans drawn from five
// usable themes, each deck's own cards as priorities, and themes to avoid.
const COMMANDERS = ["Namor the Sub-Mariner", "Teysa Karlov"];
const THEMES = ["Aristocrats", "Tokens", "Spellslinger", "+1/+1 Counters", "Voltron"];
type FastCheck = typeof import("fast-check").default;

function deckAndPlan(fc: FastCheck) {
  const lists = (["namor.txt", "teysa.txt"] as const).map((f) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8").split("\n").map((l) => l.trim()).filter((l) => /^\d+ /.test(l)));
  const extras = COMMANDERS.map((c) => {
    const ci = new Set(store.space.cards.get(store.names.find((n) => n.name === c)!.oracleId)!.ci);
    return [...store.space.cards.values()].filter((x) => !x.land && x.ci.every((k) => ci.has(k))).map((x) => x.name).sort().slice(0, 4000);
  });
  return fc.integer({ min: 0, max: 1 }).chain((k) => fc.record({
    k: fc.constant(k),
    lines: fc.subarray(lists[k], { minLength: 10, maxLength: lists[k].length }),
    extra: fc.subarray(extras[k], { maxLength: 4 }),
    themes: fc.subarray(THEMES, { maxLength: 2 }),
    priorities: fc.subarray(lists[k].map((l) => l.replace(/^\d+ /, "")).filter((n) => n !== COMMANDERS[k]).slice(0, 30), { maxLength: 2 }),
    avoid: fc.subarray(THEMES, { maxLength: 1 }),
    seed: fc.integer(),
  })).filter((r) => r.themes.length + r.priorities.length > 0 && !r.avoid.some((a) => r.themes.includes(a)));
}

function deckOf(r: { lines: string[]; extra: string[]; themes: string[]; priorities: string[]; avoid: string[] }) {
  const lines = [...r.lines, ...r.extra.map((n) => `1 ${n}`)];
  const plan = { ...(r.themes.length ? { themes: r.themes } : {}), ...(r.priorities.length ? { priorities: r.priorities } : {}), ...(r.avoid.length ? { avoid: r.avoid } : {}) };
  return { lines, plan };
}

/** A small string hash (FNV-1a), for a seeded shuffle. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
