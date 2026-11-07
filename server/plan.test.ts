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
