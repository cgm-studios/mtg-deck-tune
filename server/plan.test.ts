// The player's plan (DT-6.3): named themes, priority cards and themes to avoid resolve, from the card store alone, to
// the profile shape the diagnose and shortlist tools score against (ISA ISC-42, 43, 44, 77). The oracle for the theme
// and card profiles is output recorded from mtg-graph-api on the store's own inputs (fixtures/graph-profiles.json);
// card order differs between the graph's corpus and the store, so cards are compared by identity (name).
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openStore, ToolInputError, type Store } from "./deck-tools";
import { DB_PATH } from "./paths";
import { inferTheme, planEcho, resolvePlan, ThinThemeError, UnknownThemeError, type PlanProfile } from "./plan";

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
      expect(planEcho(plan).themes).toEqual([]); // no theme named; DT-6.12 reads the cards under an inferred one (plan.inference)
      expect(plan.themes.length).toBe(plan.inference?.theme ? 1 : 0);
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
      const lists = (["namor.txt", "teysa.txt"] as const).map((f) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8").split("\n").map((l) => l.trim()).filter((l) => /^\d+ /.test(l)));
      const commanders = ["Namor the Sub-Mariner", "Teysa Karlov"];
      const extras = commanders.map((c) => {
        const ci = new Set(store.space.cards.get(store.names.find((n) => n.name === c)!.oracleId)!.ci);
        return [...store.space.cards.values()].filter((x) => !x.land && x.ci.every((k) => ci.has(k))).map((x) => x.name).sort().slice(0, 4000);
      });
      const THEMES = ["Aristocrats", "Tokens", "Spellslinger", "+1/+1 Counters", "Voltron"];
      const arb = fc.integer({ min: 0, max: 1 }).chain((k) => fc.record({
        k: fc.constant(k),
        lines: fc.subarray(lists[k], { minLength: 10, maxLength: lists[k].length }),
        extra: fc.subarray(extras[k], { maxLength: 4 }),
        themes: fc.subarray(THEMES, { maxLength: 2 }),
        priorities: fc.subarray(lists[k].map((l) => l.replace(/^\d+ /, "")).filter((n) => n !== commanders[k]).slice(0, 30), { maxLength: 2 }),
        avoid: fc.subarray(THEMES, { maxLength: 1 }),
        seed: fc.integer(),
      })).filter((r) => r.themes.length + r.priorities.length > 0 && !r.avoid.some((a) => r.themes.includes(a)));
      fc.assert(fc.property(arb, (r) => {
        const lines = [...r.lines, ...r.extra.map((n) => `1 ${n}`)];
        const plan = { ...(r.themes.length ? { themes: r.themes } : {}), ...(r.priorities.length ? { priorities: r.priorities } : {}), ...(r.avoid.length ? { avoid: r.avoid } : {}) };
        const input = { commander: commanders[r.k], decklist: lines.join("\n"), plan };
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

/** A small string hash (FNV-1a), for a seeded shuffle. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// DT-6.12: a plan of priority cards and no theme is read under the usable theme those cards fit best (ISA ISC-82).
// The inference is general: no rule for a named commander or card (ISC-83). Namor and Teysa are probes here, never
// the commanders the rate is measured on.
describe("a plan of cards alone is read under the theme those cards fit best (ISC-82)", () => {
  const NAMOR_KEYSTONES = ["Talrand, Sky Summoner", "Archmage of Runes", "Brineborn Cutthroat", "Hullbreaker Horror"];
  const NAMOR_OFF_PLAN_BEFORE = 55; // of 63 nonland cards, measured by DT-6.4 on the keystone-only plan

  test("ISC-82: the resolved plan names the theme it inferred, and reads under that theme's profile", () => {
    const plan = resolvePlan(store, { commander: "Namor the Sub-Mariner", plan: { priorities: NAMOR_KEYSTONES } });
    expect(plan.inference).not.toBeNull();
    const inferred = plan.inference!.theme!;
    expect(typeof inferred).toBe("string");
    expect(plan.themes.map((t) => (t.source.kind === "strategy" ? t.source.theme : null))).toEqual([inferred]);
    expect(plan.priorities).toEqual(NAMOR_KEYSTONES); // the priority cards still count as priorities
    expect(plan.cards).not.toBeNull();
    const echo = planEcho(plan);
    expect(echo.themes).toEqual([]); // the player named no theme
    expect(echo.priorities).toEqual(NAMOR_KEYSTONES);
    expect(echo.inferred?.theme).toBe(inferred);
    expect(echo.inferred!.runnersUp.length).toBeGreaterThan(0);
  }, 60_000);

  test("ISC-82: a plan that names a theme is never inferred over, and an avoided theme is never inferred", () => {
    const named = resolvePlan(store, { commander: "Namor the Sub-Mariner", plan: { themes: ["Tokens"], priorities: NAMOR_KEYSTONES } });
    expect(named.inference).toBeNull();
    expect(planEcho(named).themes).toEqual(["Tokens"]);
    expect(planEcho(named).inferred).toBeUndefined();
    const first = resolvePlan(store, { commander: "Namor the Sub-Mariner", plan: { priorities: NAMOR_KEYSTONES } }).inference!.theme!;
    const avoided = resolvePlan(store, { commander: "Namor the Sub-Mariner", plan: { priorities: NAMOR_KEYSTONES, avoid: [first] } });
    expect(avoided.inference!.theme).not.toBe(first);
    expect(avoided.inference!.runnersUp.map((r) => r.theme)).not.toContain(first);
  }, 60_000);

  test("ISC-82: the same commander and cards infer the same theme, in any order of the priority cards", () => {
    const a = resolvePlan(store, { commander: "Namor the Sub-Mariner", plan: { priorities: NAMOR_KEYSTONES } }).inference;
    const b = resolvePlan(store, { commander: "Namor the Sub-Mariner", plan: { priorities: [...NAMOR_KEYSTONES].reverse() } }).inference;
    expect(b).toEqual(a);
  }, 60_000);

  test("ISC-82: with no usable theme to read the cards under, the plan stays cards alone and the inference says why", async () => {
    const { listThemes } = await import("./graph/strategy");
    const everyUsable = new Set(listThemes(store.db).filter((t) => t.usable).map((t) => t.slug));
    const { card } = (await import("./deck-tools")).resolveCommander(store, "Namor the Sub-Mariner");
    const id = store.names.findIndex((n) => n.oracleId === card.id) + 1;
    const cards = NAMOR_KEYSTONES.map((n) => { const i = store.names.findIndex((x) => x.name === n) + 1; return { id: i, name: n }; });
    const none = inferTheme(store, { id, name: card.name, ci: card.ci }, cards, everyUsable);
    expect(none.inference.theme).toBeNull();
    expect(none.inference.considered).toBe(0);
    expect(none.inference.note).toMatch(/usable/);
    expect(none.profile).toBeNull();
  }, 60_000);

  // ----- the rate -----
  // Commanders drawn from the store without choosing: every commander with at least 200 decks on its page (a page thin
  // enough to have no stable top themes is not a test of anything) and four nonland, graph-readable keystones; in name
  // order, every k-th, Namor and Teysa excluded. Keystones: the four highest-synergy cards of the commander's stored
  // synergy list (positive synergy, at least minCardDecks decks, the pipeline's own floor). Hit: the inferred theme is
  // one of the commander's three themes with the most decks.
  const SAMPLE = 40;
  function sample(): { id: number; name: string; keystones: string[] }[] {
    const keys = store.db.query(`SELECT cc.card_id id, c.name FROM commander_cards cc JOIN cards c ON c.id = cc.card_id JOIN card_graph g ON g.card_id = c.id
      WHERE cc.commander_id = ? AND cc.synergy > 0 AND cc.decks >= 3 AND c.is_land = 0 AND cc.card_id <> ? ORDER BY cc.synergy DESC, cc.card_id LIMIT 4`);
    const cmds = (store.db.query("SELECT cm.card_id id, c.name FROM commanders cm JOIN cards c ON c.id = cm.card_id JOIN card_graph g ON g.card_id = cm.card_id WHERE cm.decks >= 200 ORDER BY cm.card_id").all() as { id: number; name: string }[])
      .filter((c) => !/^(Namor|Teysa)\b/.test(c.name))
      .map((c) => ({ ...c, keystones: (keys.all(c.id, c.id) as { name: string }[]).map((k) => k.name) }))
      .filter((c) => c.keystones.length === 4);
    const stride = Math.floor(cmds.length / SAMPLE);
    return Array.from({ length: SAMPLE }, (_, i) => cmds[i * stride]);
  }
  const topThemes = (id: number, n: number) =>
    (store.db.query("SELECT t.name FROM commander_themes ct JOIN themes t ON t.id = ct.theme_id WHERE ct.commander_id = ? ORDER BY ct.decks DESC, t.slug LIMIT ?").all(id, n) as { name: string }[]).map((t) => t.name);

  test("ISC-82: over 40 commanders drawn from the store (Namor and Teysa excluded), the inferred theme is among the commander's top themes at the measured rate", () => {
    const rows = sample();
    expect(rows.length).toBe(SAMPLE);
    expect(rows.some((r) => /^(Namor|Teysa)/.test(r.name))).toBe(false);
    let hits3 = 0, hits5 = 0, inferred = 0;
    const report: string[] = [];
    for (const r of rows) {
      const plan = resolvePlan(store, { commander: r.name, plan: { priorities: r.keystones } });
      const theme = plan.inference?.theme ?? null;
      if (theme !== null) inferred++;
      const hit3 = theme !== null && topThemes(r.id, 3).includes(theme), hit5 = theme !== null && topThemes(r.id, 5).includes(theme);
      if (hit3) hits3++;
      if (hit5) hits5++;
      report.push(`${r.name}: ${theme} (${hit3 ? "top 3" : hit5 ? "top 5" : "miss"})`);
    }
    console.log(`ISC-82 rate: ${hits3}/${SAMPLE} in the top 3, ${hits5}/${SAMPLE} in the top 5, ${inferred}/${SAMPLE} inferred\n${report.join("\n")}`);
    // The floor is the rate measured on 2026-11-07 against this store (data release in server/store.json), on this
    // draw: 24 of 40 in the top 3 (60%), 31 of 40 in the top 5, a theme chosen for all 40. For scale, on the same draw:
    // picking at random among the usable themes plausible for the commander's colors (23 to 45 of the 50) would land
    // in its top 3 for about 3 commanders, and always choosing the most-played theme (Tokens) for 11. Three disjoint
    // 40-commander draws of the same store gave 24, 28 and 22 in the top 3, so the rate is about 55 to 70%, not a
    // precise figure. A change that lowers the rate on this draw fails here; a new data release that moves it is a
    // re-measurement, not a reason to lower the floor unexamined.
    expect(inferred).toBe(SAMPLE);
    expect(hits3).toBeGreaterThanOrEqual(24);
    expect(hits5).toBeGreaterThanOrEqual(31);
  }, 600_000);

  test("ISC-82: Namor with four spellslinger keystones: off-plan cards fall from 55 of 63, and the counterspells read on plan", async () => {
    const { diagnose } = await import("./diagnose");
    const { rolesOf } = await import("./roles");
    const decklist = readFileSync(new URL("../fixtures/namor.txt", import.meta.url), "utf8");
    const d = diagnose(store, { commander: "Namor the Sub-Mariner", decklist, plan: { priorities: NAMOR_KEYSTONES } });
    expect(d.plan.inferred?.theme).toBeTruthy();
    expect(d.plan.themes).toEqual([]);
    expect(d.plan.priorities).toEqual(NAMOR_KEYSTONES);
    // before: 55 off plan; measured 2026-11-07 under the inferred theme: 37 (a regression floor, not a target)
    console.log(`ISC-82 Namor: inferred ${d.plan.inferred?.theme}, ${d.offPlan.length} off plan (was ${NAMOR_OFF_PLAN_BEFORE})`);
    expect(d.offPlan.length).toBeLessThan(NAMOR_OFF_PLAN_BEFORE);
    expect(d.offPlan.length).toBeLessThanOrEqual(37);
    const held = (name: string) => rolesOf(store.roles, store.names.find((n) => n.name === name)!.oracleId).roles.some((r) => r.role === "counterspell");
    const counterspells = d.cards.map((c) => c.name).filter(held);
    expect(counterspells.length).toBeGreaterThanOrEqual(10);
    const off = d.offPlan.map((o) => o.name).filter((n) => counterspells.includes(n));
    // every instant or sorcery with the counterspell role reads on plan; a creature with it can still be off plan
    // (Vodalian Hexcatcher, a Merfolk lord that sacrifices to counter, was the one such card measured: 10 of 11 on plan)
    const typeOf = (name: string) => store.space.cards.get(store.names.find((n) => n.name === name)!.oracleId)!.meta.type;
    console.log(`ISC-82 Namor counterspells: ${counterspells.length - off.length} of ${counterspells.length} on plan; off plan: ${off.join(", ") || "none"}`);
    expect(off.filter((n) => /Instant|Sorcery/.test(typeOf(n)))).toEqual([]);
    expect(off.length).toBeLessThanOrEqual(1);
    // the diagnosis under the inferred theme: roles read from that theme's decks, and the basis says it was inferred
    expect(d.roles.some((r) => r.source === "plan" && r.basis.includes("the theme inferred from the priority cards"))).toBe(true);
  }, 120_000);
});
