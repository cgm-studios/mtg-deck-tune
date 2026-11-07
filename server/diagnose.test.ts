// The deck diagnosis (DT-6.4, ISA ISC-49 to 56, ISC-72). Two seams:
//   graph/diagnose.ts  the port of mtg-graph-api's diagnose over the store's interaction index. Its tests are the graph
//                      repo's test/diagnose.test.ts, ported (ISC-72), and the oracle is output recorded from the graph
//                      repo on the store's own inputs (fixtures/graph-diagnoses.json). Card order differs between the
//                      graph's corpus and the store, so lists are compared by card name.
//   diagnose.ts        the diagnose tool: the same diagnosis measured against the player's plan.
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deckStats, openStore, ToolInputError, type Store } from "./deck-tools";
import { DB_PATH } from "./paths";
import { graphOf } from "./graph/store-graph";
import type { InteractionIndex } from "./graph/interact";
import { deckGraph, parseDeckList, type DeckGraph } from "./graph/deck";
import { diagnose as graphDiagnose, hookPhrase, type Diagnosis, type RoleTargets } from "./graph/diagnose";
import { diagnose } from "./diagnose";

type Recorded = {
  decks: Record<string, { roleCounts: Record<string, number> | null; unresolved: string[]; diagnosis: Diagnosis }> & {
    teysaAll: { starved: { hook: string; candidates: [string, number, number][] }[] };
  };
};
const REC: Recorded = JSON.parse(readFileSync(new URL("../fixtures/graph-diagnoses.json", import.meta.url), "utf8"));
const fixtureText = (f: string) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8");
const DEFAULT_TARGETS: RoleTargets = { targets: JSON.parse(readFileSync(new URL("./role-targets.json", import.meta.url), "utf8")).targets, source: "default" };

const KRENKO = ["Krenko, Mob Boss", "Skullclamp", "Goblin Bombardment", "Impact Tremors", "Siege-Gang Commander", "Goblin Warrens",
  "Pashalik Mons", "Goblin Instigator", "Beetleback Chief", "Mogg War Marshal", "Gray Ogre", "Glorious Anthem", "Fervor", "Mass Hysteria", "Lightning Bolt", "10 Mountain"].join("\n");
/** Two Dies payoffs fed by two outlets (balanced), a drain trigger on opponents, and an opponent-cast trigger. */
const SMALL = ["Blood Artist", "Zulaport Cutthroat", "Viscera Seer", "Carrion Feeder", "Mindcrank", "Rhystic Study", "Opt", "Toxic Deluge"].join("\n");

let store: Store;
let idx: InteractionIndex;
let namorG: DeckGraph, teysaG: DeckGraph, krenkoG: DeckGraph;
let namor: Diagnosis, teysa: Diagnosis, krenko: Diagnosis, small: Diagnosis, teysaAll: Diagnosis;

beforeAll(() => {
  store = openStore(DB_PATH);
  idx = graphOf(store.db).index;
  const opts = { targets: DEFAULT_TARGETS };
  namorG = deckGraph(idx, parseDeckList(fixtureText("namor.txt")), ["Namor the Sub-Mariner"], store.roles);
  teysaG = deckGraph(idx, parseDeckList(fixtureText("teysa.txt")), ["Teysa Karlov"], store.roles);
  krenkoG = deckGraph(idx, parseDeckList(KRENKO), ["Krenko, Mob Boss"], store.roles);
  namor = graphDiagnose(idx, namorG, opts);
  teysa = graphDiagnose(idx, teysaG, opts);
  krenko = graphDiagnose(idx, krenkoG, opts);
  small = graphDiagnose(idx, deckGraph(idx, parseDeckList(SMALL)), {});
  teysaAll = graphDiagnose(idx, teysaG, { top: 10_000 });
}, 120_000);

const card = (d: Diagnosis, name: string) => {
  const c = d.engine.find((e) => e.name === name);
  if (!c) throw new Error(`${name} is not in the diagnosis`);
  return c;
};
const sorted = (xs: string[]) => [...xs].sort();

describe("ported from mtg-graph-api: the diagnosis matches the graph repo's on the same inputs (ISC-72)", () => {
  test("ISC-72: starved hooks, their payoffs, enablers and ratios match the recording", () => {
    for (const k of ["namor", "teysa", "krenko", "small"] as const) {
      const d = { namor, teysa, krenko, small }[k], rec = REC.decks[k].diagnosis;
      expect(d.starved.map((s) => [s.hook, s.ratio, sorted(s.payoffs), sorted(s.enablers)])).toEqual(rec.starved.map((s) => [s.hook, s.ratio, sorted(s.payoffs), sorted(s.enablers)]));
    }
  });
});

describe("ported from mtg-graph-api: the graph repo's own diagnosis tests, on the store (ISC-72)", () => {
  test("ISC-72: every engine card's partners, degree, roles, bucket and reason match the recording, card by card", () => {
    for (const k of ["namor", "teysa", "krenko", "small"] as const) {
      const d = { namor, teysa, krenko, small }[k], rec = REC.decks[k].diagnosis;
      const byName = (xs: Diagnosis["engine"]) => Object.fromEntries(xs.map((e) => [e.name, e]));
      expect([k, byName(d.engine)]).toEqual([k, byName(rec.engine)]);
      expect([k, d.lowPartners]).toEqual([k, rec.lowPartners]);
      expect([k, d.colorIdentity]).toEqual([k, rec.colorIdentity]);
    }
  });

  test("ISC-72: every mechanic, roles over and under (with trims) and the role counts match the recording", () => {
    const g = { namor: namorG, teysa: teysaG, krenko: krenkoG };
    for (const k of ["namor", "teysa", "krenko"] as const) {
      const d = { namor, teysa, krenko }[k], rec = REC.decks[k];
      const mech = (m: Diagnosis["mechanics"]) => Object.fromEntries(m.map((x) => [x.hook, [sorted(x.payoffs), sorted(x.enablers)]]));
      expect([k, mech(d.mechanics)]).toEqual([k, mech(rec.diagnosis.mechanics)]);
      expect([k, g[k].roles!.counts]).toEqual([k, rec.roleCounts!]);
      expect([k, g[k].unresolved]).toEqual([k, rec.unresolved]);
      const side = (xs: { role: string; count: number; target: number; trims?: { name: string; partners: number }[] }[]) =>
        xs.map((r) => ({ role: r.role, count: r.count, target: r.target, trims: r.trims ? Object.fromEntries(r.trims.map((t) => [t.name, t.partners])) : undefined }));
      expect([k, side(d.roles!.over), side(d.roles!.under)]).toEqual([k, side(rec.diagnosis.roles!.over), side(rec.diagnosis.roles!.under)]);
    }
    expect(small.mechanics.map((m) => m.hook).sort()).toEqual(REC.decks.small.diagnosis.mechanics.map((m) => m.hook).sort());
  });

  test("ISC-72: the outside enablers of each starved hook match the recording, by name, payoffs fed and repeatability", () => {
    // Every candidate (top 10,000), not just the ten shown: equal-score cards may come in another order, so compare as sets
    // grouped by payoffs fed, and check the shown ten follow the same ranking keys.
    for (const rec of REC.decks.teysaAll.starved) {
      const got = teysaAll.starved.find((s) => s.hook === rec.hook)!;
      const key = (name: string, feeds: number, rep: number) => `${feeds}|${rep}|${name}`;
      expect(got.candidates.map((c) => key(c.name, c.feeds.length, c.repeatable ? 1 : 0)).sort()).toEqual(rec.candidates.map(([n, f, r]) => key(n, f, r)).sort());
    }
    const shown = teysa.starved.find((s) => s.hook === "Dies")!.candidates.map((c) => c.name);
    expect(sorted(shown)).toEqual(sorted(REC.decks.teysa.diagnosis.starved.find((s) => s.hook === "Dies")!.candidates.map((c) => c.name)));
  });

  test("graph ISC-25: hooks whose payoffs outnumber enablers are flagged with the ratio", () => {
    const dies = teysa.starved.find((s) => s.hook === "Dies");
    expect(dies).toBeDefined();
    expect(dies!.payoffs.length).toBeGreaterThan(dies!.enablers.length);
    expect(dies!.ratio).toBe(`${dies!.payoffs.length}:${dies!.enablers.length}`);
    expect(dies!.payoffs).toContain("Blood Artist");
    expect(dies!.enablers).toContain("Viscera Seer");
    // Removal and wipes aim at any creature, so they are not the deck's way of making its own creatures die.
    expect(dies!.enablers).not.toContain("Austere Command");
    // Every starved hook has at least two payoffs: one lonely trigger is a card detail, not a mechanic.
    for (const s of [...teysa.starved, ...namor.starved]) expect(s.payoffs.length).toBeGreaterThanOrEqual(2);
    // Namor's payoffs wait on spells being cast, and the deck is full of them.
    expect(namor.starved).toEqual([]);
    // Starved is exactly the mechanics with at least two payoffs and more payoffs than enablers.
    for (const d of [namor, teysa, small]) expect(d.starved.map((x) => x.hook).sort()).toEqual(d.mechanics.filter((m) => m.payoffs.length >= 2 && m.payoffs.length > m.enablers.length).map((m) => m.hook).sort());
    // Two payoffs fed by two outlets is balanced, not starved.
    expect(small.mechanics.find((m) => m.hook === "Dies")).toMatchObject({ payoffs: ["Blood Artist", "Zulaport Cutthroat"], enablers: ["Carrion Feeder", "Viscera Seer"] });
    expect(small.starved.map((x) => x.hook)).not.toContain("Dies");
  });

  test("graph ISC-25: a payoff is a listen another deck card must feed", () => {
    const hooks = (d: Diagnosis) => d.mechanics.map((m) => m.hook);
    const payoffsOf = (d: Diagnosis, h: string) => d.mechanics.find((m) => m.hook === h)?.payoffs ?? [];
    // The turn feeds steps and combat (Twilight Prophet at upkeep, High-Society Hunter attacking).
    for (const h of ["Upkeep", "EndStep", "Attacks", "CombatDamage"]) expect(hooks(teysa)).not.toContain(h);
    // A {T} cost is refilled by the untap step; paying life is not fed by gaining it.
    expect(hooks(namor)).not.toContain("Untap");
    expect(payoffsOf(small, "LifeGain")).not.toContain("Toxic Deluge");
    // "When this dies" is fed by the card itself, not a deck mechanic.
    expect(payoffsOf(namor, "Dies")).not.toContain("Chasm Skulker");
    // An opponent casting is up to the opponent; an opponent losing life can be your doing.
    expect(payoffsOf(small, "SpellCast")).not.toContain("Rhystic Study");
    expect(payoffsOf(small, "LifeLoss")).toContain("Mindcrank");
    // An opponent's creature dying is removal's doing, never the engine's (Sangromancer watches that).
    expect(payoffsOf(teysa, "Dies")).not.toContain("Sangromancer");
    expect(small.mechanics.find((m) => m.hook === "LifeLoss")!.enablers).toEqual(expect.arrayContaining(["Blood Artist", "Zulaport Cutthroat"]));
  });

  test("graph ISC-57: each starved hook lists in-color enablers from outside the deck, ranked by payoffs fed", () => {
    const dies = teysa.starved.find((s) => s.hook === "Dies")!;
    const names = new Set(teysaG.cards.map((c) => c.name));
    const ci = new Set(teysa.colorIdentity);
    expect(dies.candidates.length).toBeGreaterThan(0);
    for (const c of dies.candidates) {
      expect(names.has(c.name)).toBe(false);
      expect(idx.cards[idx.indexOf(c.name)].colorIdentity.every((x) => ci.has(x))).toBe(true);
      expect(c.feeds.length).toBeGreaterThanOrEqual(2);
      for (const p of c.feeds) expect(dies.payoffs).toContain(p);
    }
    for (let i = 1; i < dies.candidates.length; i++) expect(dies.candidates[i - 1].feeds.length).toBeGreaterThanOrEqual(dies.candidates[i].feeds.length);
    const allC = teysaAll.starved.find((s) => s.hook === "Dies")!.candidates;
    const all = allC.map((c) => c.name);
    expect(all).toContain("Carrion Feeder");
    expect(all).not.toContain("Infernal Grasp");
    // Every turn: activated and mana abilities. Once: sacrificing only itself, Bargain, Exploit, a trigger on its own leaving.
    const rep = (n: string) => { const c = allC.find((x) => x.name === n); if (!c) throw new Error(`${n} is not a candidate`); return c.repeatable; };
    expect(rep("Carrion Feeder")).toBe(true);
    expect(rep("Phyrexian Altar")).toBe(true);
    // The shown list leads with real outlets, not removal that happens to have a sacrifice cost.
    expect(dies.candidates.map((c) => c.name)).toContain("Phyrexian Altar");
    for (const n of ["Burnished Hart", "Beseech the Mirror", "Sidisi, Undead Vizier", "Yukora, the Prisoner"]) expect(rep(n)).toBe(false);
  });

  test("graph ISC-54: the engine score counts distinct deck partners over non-generic links", () => {
    const cut = card(namor, "Brineborn Cutthroat");
    // Brineborn responds to any spell, so almost all of its many links are generic.
    expect(cut.degree).toBeGreaterThan(40);
    expect(cut.partners).toBeLessThan(cut.degree / 4);
    expect(card(namor, "Talrand, Sky Summoner").partners).toBeGreaterThan(0);
    // Pinned on the fixture: the one-third breadth line decides these (Brineborn takes any spell; Talrand only instants and sorceries).
    expect(card(namor, "Brineborn Cutthroat").partners).toBe(4);
    expect(card(namor, "Talrand, Sky Summoner").partners).toBe(30);
    // Impact Tremors takes any creature entering (about half the pool): those links are generic, so only the token makers count.
    expect(card(krenko, "Impact Tremors").partners).toBe(7);
    // Breadth pools a card's listens on one hook as the ranking does: a red-or-white spell trigger takes 40% of the pool.
    const bh = idx.indexOf("Belligerent Hatchling");
    const pooled = new Set<number>();
    for (const l of idx.listensOf(bh)) if (l.hook === "SpellCast") for (const f of idx.castFeeders(l)) pooled.add(f);
    const rankStyle = new Set(idx.linksTo(bh).filter((k) => k.emittedBy === "card" && k.hook === "SpellCast").map((k) => k.from));
    expect(pooled.size).toBe(rankStyle.size);
    expect(pooled.size / idx.cards.length).toBeGreaterThanOrEqual(1 / 3);
    // A partner count never exceeds the number of other deck cards.
    for (const e of namor.engine) expect(e.partners).toBeLessThan(namorG.cards.length);
  });

  test("graph ISC-55: roleless, loosely linked, non-commander cards are cut candidates with reasons", () => {
    expect(card(krenko, "Gray Ogre").bucket).toBe("cut");
    for (const d of [namor, teysa, krenko]) {
      // The quartile, recomputed here from the partner counts.
      const ps = d.engine.filter((e) => e.bucket !== "commander").map((e) => e.partners).sort((a, b) => a - b);
      expect(d.lowPartners).toBe(ps[Math.floor((ps.length - 1) / 4)]);
    }
    for (const d of [namor, teysa, krenko]) for (const e of d.engine.filter((x) => x.bucket === "cut")) {
      expect(e.roles).toEqual([]);
      expect(d.commanders).not.toContain(e.name);
      expect(e.partners).toBeLessThanOrEqual(d.lowPartners);
      expect((e.reason ?? "").length).toBeGreaterThan(0);
    }
  });

  test("graph ISC-55: without role data nothing is named a cut", () => {
    const d = graphDiagnose(idx, deckGraph(idx, parseDeckList(fixtureText("teysa.txt")), ["Teysa Karlov"]), {});
    expect(d.engine.filter((e) => e.bucket === "cut")).toEqual([]);
    expect(d.engine.some((e) => e.bucket === "unjudged")).toBe(true);
    const byName = (xs: Diagnosis["engine"]) => Object.fromEntries(xs.map((e) => [e.name, e]));
    expect(byName(d.engine)).toEqual(byName(REC.decks.teysaNoRoles.diagnosis.engine));
  });

  test("graph ISC-56: a card working through a static effect is graph-unread, never a cut candidate", () => {
    for (const name of ["Coralhelm Commander", "Master of the Pearl Trident", "Leyline of Transformation"]) expect(card(namor, name).bucket).not.toBe("cut");
    expect(card(namor, "Leyline of Transformation").bucket).toBe("unread");
    expect(card(teysa, "Teysa Karlov").bucket).toBe("commander");
    expect(card(krenko, "Glorious Anthem").bucket).toBe("unread");
    // Keyword grants to other creatures are static effects too.
    expect(card(krenko, "Fervor").bucket).toBe("unread");
    expect(card(krenko, "Mass Hysteria").bucket).toBe("unread");
  });

  test("graph ISC-61: a payoff of a starved hook points at the gap, not at a cut", () => {
    for (const name of ["Blade of the Bloodchief", "Cordial Vampire"]) {
      const c = card(teysa, name);
      expect(c.bucket).not.toBe("cut");
      if (c.partners <= teysa.lowPartners && !c.roles.length) {
        expect(c.bucket).toBe("starved");
        expect(c.reason).toContain("a creature dying");
      }
    }
  });

  test("graph ISC-24: roles over their target are flagged", () => {
    const cs = namor.roles!.over.find((r) => r.role === "counterspell");
    expect(cs).toMatchObject({ count: 11, target: 6 });
    expect(namor.roles!.over.map((r) => r.role).sort()).toEqual(["card draw", "card selection", "counterspell", "protection"]);
  });

  test("graph ISC-53: roles under their target are flagged with count and target", () => {
    expect(namor.roles!.under.find((r) => r.role === "removal")).toMatchObject({ count: 5, target: 8 });
    for (const r of namor.roles!.under) expect(r.count).toBeLessThan(r.target);
    for (const r of namor.roles!.over) expect(r.count).toBeGreaterThan(r.target);
  });

  test("graph ISC-58: an overfull role lists its own cards as trims, fewest partners first", () => {
    const trims = namor.roles!.over.find((r) => r.role === "counterspell")!.trims!;
    expect(trims.length).toBe(11);
    for (const t of trims) expect(card(namor, t.name).roles).toContain("counterspell");
    for (let i = 1; i < trims.length; i++) expect(trims[i - 1].partners).toBeLessThanOrEqual(trims[i].partners);
  });

  test("graph ISC-60: hook phrases never leak a grammar identifier, and counter kinds stay distinct", () => {
    expect(hookPhrase("Dies")).toBe("a creature dying");
    const kinds = ["CounterPlaced:LOYALTY", "CounterPlaced:LORE", "CounterPlaced:M1M1", "CounterPlaced:P1P1"].map(hookPhrase);
    expect(new Set(kinds).size).toBe(4);
    for (const k of [...kinds, hookPhrase("SomeNewHook")]) expect(k).not.toMatch(/[a-z][A-Z]|:/);
  });
});

// ---------- the diagnose tool, against the player's plan ----------
const ARISTOCRATS = { themes: ["Aristocrats"] };
const SPELLSLINGER = { themes: ["Spellslinger"] };
const teysaDeck = { commander: "Teysa Karlov", decklist: fixtureText("teysa.txt") };
const namorDeck = { commander: "Namor the Sub-Mariner", decklist: fixtureText("namor.txt") };

describe("the diagnose tool", () => {
  test("ISC-49: Teysa under an Aristocrats plan flags the death engine gap with payoff and enabler counts", () => {
    const d = diagnose(store, { ...teysaDeck, plan: ARISTOCRATS });
    const dies = d.engineGaps.find((g) => g.mechanic === "a creature dying");
    expect(dies).toBeDefined();
    // the graph repo's measurement on the owner's list (graph ISA F6 Status, 2026-11-07): 16 payoffs, 3 enablers
    expect(dies).toMatchObject({ payoffCount: 16, enablerCount: 3 });
    expect(dies!.payoffs).toHaveLength(16);
    expect(sorted(dies!.enablers)).toEqual(["Ashnod's Altar", "Viscera Seer", "Yahenni, Undying Partisan"]);
    expect(dies!.toTry.map((c) => c.name)).toContain("Phyrexian Altar");
    // every gap is a real one: at least two payoffs, more payoffs than enablers
    for (const g of d.engineGaps) { expect(g.payoffCount).toBeGreaterThanOrEqual(2); expect(g.payoffCount).toBeGreaterThan(g.enablerCount); }
  }, 60_000);
});

describe("role targets from the plan (ISC-50 to ISC-52)", () => {
  const ROLES = Object.keys(DEFAULT_TARGETS.targets);

  test("ISC-51: every role carries its target source; a theme plan with enough data in the deck's colors sets every target from its decks", () => {
    for (const [deck, plan] of [[teysaDeck, ARISTOCRATS], [namorDeck, SPELLSLINGER]] as const) {
      const d = diagnose(store, { ...deck, plan });
      expect(d.roles.map((r) => r.role)).toEqual(ROLES);
      for (const r of d.roles) {
        expect(r.source).toBe("plan");
        expect(r.basis).toContain(plan.themes[0]);
        expect(Number.isInteger(r.target)).toBe(true);
        expect(r.target).toBe(Math.round(r.expected!));
      }
    }
  }, 60_000);

  test("ISC-51: a plan of priority cards alone has no theme decks to read, so every target is the default table's and says so", () => {
    const d = diagnose(store, { ...teysaDeck, plan: { priorities: ["Blood Artist", "Viscera Seer"] } });
    expect(d.roles.map((r) => [r.role, r.target, r.source])).toEqual(ROLES.map((r) => [r, DEFAULT_TARGETS.targets[r], "default"]));
    for (const r of d.roles) expect(r.expected).toBeUndefined();
  }, 60_000);

  test("ISC-51: a theme whose commanders barely share the deck's colors falls back to the default table, naming why", () => {
    // Spellslinger's qualifying commanders are almost all blue or red; a colorless-identity deck shares no color with them.
    const d = diagnose(store, { commander: "Karn, Silver Golem", decklist: "1 Karn, Silver Golem\n1 Sol Ring\n1 Mind Stone", plan: SPELLSLINGER });
    for (const r of d.roles) { expect(r.source).toBe("default"); expect(r.basis).toMatch(/share/); }
  }, 60_000);

  test("ISC-52: Teysa under an Aristocrats plan is not flagged short on counterspells (the default table asks for 6)", () => {
    const d = diagnose(store, { ...teysaDeck, plan: ARISTOCRATS });
    expect(d.under.map((r) => r.role)).not.toContain("counterspell");
    expect(d.roles.find((r) => r.role === "counterspell")).toMatchObject({ count: 0, target: 0, source: "plan" });
    // under the default table the same deck is short on counterspells: the plan is what changes it
    const byDefault = diagnose(store, { ...teysaDeck, plan: { priorities: ["Blood Artist"] } });
    expect(byDefault.under.find((r) => r.role === "counterspell")).toMatchObject({ count: 0, target: 6, source: "default" });
  }, 60_000);

  test("ISC-50: Namor under a Spellslinger plan flags counterspells over and removal under, each with count and target", () => {
    const d = diagnose(store, { ...namorDeck, plan: SPELLSLINGER });
    const cs = d.over.find((r) => r.role === "counterspell"), rem = d.under.find((r) => r.role === "removal");
    expect(cs).toMatchObject({ count: 11, source: "plan" });
    expect(cs!.target).toBeLessThan(11);
    expect(rem).toMatchObject({ count: 5, source: "plan" });
    expect(rem!.target).toBeGreaterThan(5);
    // over and under are exactly the roles whose count differs from the target, and trims list the role's own cards
    for (const r of d.roles) {
      expect(d.over.some((o) => o.role === r.role)).toBe(r.count > r.target);
      expect(d.under.some((u) => u.role === r.role)).toBe(r.count < r.target);
    }
    expect(cs!.trims).toHaveLength(11);
    // the counts are deck_stats' counts
    expect(Object.fromEntries(d.roles.map((r) => [r.role, r.count]))).toEqual(deckStats(store, namorDeck).roleCounts);
  }, 60_000);
});

describe("cards against the plan and the engine (ISC-53 to ISC-56)", () => {
  test("ISC-53: a go-wide token maker added to Namor under a Spellslinger plan is named off-plan, with a reason", () => {
    const deck = { commander: "Namor the Sub-Mariner", decklist: fixtureText("namor.txt") + "\n1 Myr Battlesphere\n" };
    const d = diagnose(store, { ...deck, plan: SPELLSLINGER });
    const myr = d.offPlan.find((c) => c.name === "Myr Battlesphere");
    expect(myr).toBeDefined();
    expect(myr!.reason).toContain("Spellslinger");
    expect(myr!.does).toContain("makes happen: making a token");
    // the plan's main hooks and tags, the ones no off-plan card carries, are given once
    expect(d.plan.leansOn.hooks).toContain("casting a spell");
    expect(d.plan.leansOn.tags.length).toBeGreaterThan(0);
    // off-plan is exactly the nonland, non-commander cards deck_stats counts as off the same plan
    expect(sorted(d.offPlan.map((c) => c.name))).toEqual(sorted(deckStats(store, { ...deck, plan: SPELLSLINGER }).planFit!.offPlan));
    expect(d.offPlan.map((c) => c.name)).not.toContain("Namor the Sub-Mariner");
    expect(d.offPlan.map((c) => c.name)).not.toContain("Talrand, Sky Summoner");
  }, 60_000);
});

describe("cards doing the least, cards the graph cannot read, payoffs waiting on a gap (ISC-54 to ISC-56)", () => {
  const krenkoList = KRENKO.split("\n").map((l) => (/^\d+ /.test(l) ? l : `1 ${l}`)).join("\n");
  const krenkoDeck = { commander: "Krenko, Mob Boss", decklist: krenkoList };
  const TOKENS = { themes: ["Tokens"] };

  test("ISC-54: a vanilla creature in a Krenko list is named among the cards doing least, with its links into the deck", () => {
    const d = diagnose(store, { ...krenkoDeck, plan: TOKENS });
    const ogre = d.doingLeast.find((c) => c.name === "Gray Ogre");
    expect(ogre).toBeDefined();
    expect(ogre!.partners).toBe(0);
    // its two links (graph recording: degree 2) are both generic: cards that take any creature entering
    expect(ogre!.links).toHaveLength(2);
    for (const l of ogre!.links) { expect(l.generic).toBe(true); expect(krenkoList).toContain(l.card); expect(l.on).not.toMatch(/[a-z][A-Z]/); }
    expect(ogre!.links.map((l) => l.card)).toContain("Impact Tremors");
    expect(ogre!.reason).toMatch(/2 links/);
    // doing least is exactly the roleless, loosely linked cards the graph names cuts
    for (const c of d.doingLeast) {
      const e = d.cards.find((x) => x.name === c.name)!;
      expect(e).toMatchObject({ bucket: "cut", roles: [] });
      expect(e.partners).toBeLessThanOrEqual(d.lowPartners);
      expect(c.links.filter((l) => !l.generic).map((l) => l.card).sort()).toEqual([...new Set(c.links.filter((l) => !l.generic).map((l) => l.card))].sort());
    }
  }, 60_000);

  test("ISC-55: Glorious Anthem, Fervor and Coralhelm Commander are never named as cuts and are each marked unread", () => {
    const krenko = diagnose(store, { ...krenkoDeck, plan: TOKENS });
    const namor = diagnose(store, { ...namorDeck, plan: SPELLSLINGER });
    for (const [d, name] of [[krenko, "Glorious Anthem"], [krenko, "Fervor"], [krenko, "Mass Hysteria"], [namor, "Coralhelm Commander"], [namor, "Leyline of Transformation"]] as const) {
      expect([name, d.doingLeast.map((c) => c.name)]).not.toEqual([name, expect.arrayContaining([name])]);
      expect([name, d.unread.find((u) => u.name === name)?.reason]).toEqual([name, expect.stringContaining("static effect")]);
      for (const o of d.over) for (const t of o.trims) if (t.name === name) expect(t.unread).toBe(true);
    }
    // Coralhelm is well linked (a core engine card), yet still marked: its lord effect is a link the graph cannot see
    expect(namor.cards.find((c) => c.name === "Coralhelm Commander")!.bucket).not.toBe("unread");
  }, 60_000);

  test("ISC-56: Teysa's loosely linked death payoffs point at the gap, never at a cut", () => {
    const d = diagnose(store, { ...teysaDeck, plan: ARISTOCRATS });
    const dies = d.engineGaps.find((g) => g.mechanic === "a creature dying")!;
    // the graph recording: Blade of the Bloodchief, Cordial Vampire and Syr Konrad wait on the gap
    expect(sorted(dies.waitingOnIt)).toEqual(["Blade of the Bloodchief", "Cordial Vampire", "Syr Konrad, the Grim"]);
    for (const name of dies.waitingOnIt) {
      expect(d.doingLeast.map((c) => c.name)).not.toContain(name);
      expect(dies.payoffs).toContain(name);
      expect(d.cards.find((c) => c.name === name)!.reason).toContain("a creature dying");
    }
    // every starved card waits on exactly one gap, one it pays off on (Teysa also has a small discard gap)
    expect(d.engineGaps.length).toBeGreaterThan(1);
    const starved = d.cards.filter((c) => c.bucket === "starved").map((c) => c.name);
    expect(sorted(d.engineGaps.flatMap((g) => g.waitingOnIt))).toEqual(sorted(starved));
    for (const g of d.engineGaps) for (const n of g.waitingOnIt) expect(g.payoffs).toContain(n);
  }, 60_000);
});

describe("decks the graph reads only in part", () => {
  test("a card with no card graph data is counted in the roles, listed as unread by the graph, and judged nowhere else", () => {
    const d = diagnose(store, { commander: "Teysa Karlov", decklist: fixtureText("teysa.txt") + "\n1 Gisa's Favorite Shovel\n1 Wicker Picker\n", plan: ARISTOCRATS });
    expect(d.noGraphData).toEqual(["Gisa's Favorite Shovel", "Wicker Picker"]);
    for (const n of d.noGraphData) {
      expect(d.cards.map((c) => c.name)).not.toContain(n);
      expect(d.doingLeast.map((c) => c.name)).not.toContain(n);
    }
    expect(Object.fromEntries(d.roles.map((r) => [r.role, r.count]))).toEqual(deckStats(store, { commander: "Teysa Karlov", decklist: fixtureText("teysa.txt") + "\n1 Gisa's Favorite Shovel\n1 Wicker Picker\n" }).roleCounts);
  }, 60_000);

  test("a list that leaves the commander out is read with the commander in play, as in a game", () => {
    const without = fixtureText("namor.txt").split("\n").filter((l) => !l.includes("Namor the Sub-Mariner")).join("\n");
    const a = diagnose(store, { commander: "Namor the Sub-Mariner", decklist: without, plan: SPELLSLINGER });
    const b = diagnose(store, { ...namorDeck, plan: SPELLSLINGER });
    expect(a.cards.find((c) => c.name === "Namor the Sub-Mariner")?.bucket).toBe("commander");
    expect(a.cards).toEqual(b.cards);
    expect(a.engineGaps).toEqual(b.engineGaps);
  }, 60_000);

  test("a commander with no card graph data cannot anchor a diagnosis: a tool error that says so", () => {
    expect(() => diagnose(store, { commander: "Sophina, Spearsage Deserter", decklist: "1 Sophina, Spearsage Deserter\n1 Lightning Bolt", plan: { themes: ["Voltron"] } }))
      .toThrow(/Sophina, Spearsage Deserter has no card graph data/);
    expect(() => diagnose(store, { commander: "Sophina, Spearsage Deserter", decklist: "1 Lightning Bolt", plan: { themes: ["Voltron"] } })).toThrow(ToolInputError);
  }, 60_000);
});
