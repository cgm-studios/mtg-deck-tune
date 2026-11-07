// Cast triggers conditioned on card type and mana value (DT-6.15, ISA ISC-94): "whenever you cast a creature spell with
// mana value 4 or greater" links to every deck card that is both, counts toward the commander's engine partners, and
// reads the same way where plan fit and theme inference read a profile. The oracle is the commanders' own rules text,
// parsed here with a regular expression, and the store's plain type line and mana value columns: never the card graph's
// reading of the trigger. Measured on every commander in the store with such a trigger, Helga excluded (her list is
// reported, not measured: ISA Constraints, no overfitting).
import { beforeAll, expect, test } from "bun:test";
import fc from "fast-check";
import { openStore, resolveCommander, type Store } from "./deck-tools";
import { deckOnGraph } from "./diagnose";
import { DB_PATH } from "./paths";
import { planScorer, resolvePlan } from "./plan";
import { diagnose as graphDiagnose } from "./graph/diagnose";
import { profileFit, profileMatcher, type HookProfile } from "./graph/profile";
import { graphOf, type Graph } from "./graph/store-graph";

const TRIGGER = /whenever you cast (?:an? )?((?:non)?[a-z]+(?: or [a-z]+)?)? ?spell with mana value (\d+) or greater/i;
const REPORTED = "Helga, Skittish Seer";
/** Layouts cast as one face: the front face's type line and the card's mana value are what is cast. */
const ONE_FACE = new Set(["normal", "saga", "class", "case", "leveler", "mutate", "flip", "transform", "meld"]);

type Condition = { types: string; mv: number };
type Card = { id: number; name: string; ci: string; front: string; mv: number; layout: string; land: boolean };
type Commander = { name: string; graphName: string; ci: string; cond: Condition };

let store: Store;
let graph: Graph;
let cards: Card[];
let commanders: Commander[];

/** The card meets the trigger's two conditions, read from its front type line and mana value. */
function meets(c: Card, cond: Condition): boolean {
  const has = (t: string) => new RegExp(`\\b${t}\\b`, "i").test(c.front);
  const t = cond.types.toLowerCase();
  const typeOk = t === "" ? true
    : t.startsWith("non") ? !has(t.slice(3))
    : t.split(" or ").some(has);
  return !c.land && typeOk && c.mv >= cond.mv;
}

beforeAll(() => {
  store = openStore(DB_PATH);
  graph = graphOf(store.db);
  type Row = { id: number; name: string; color_identity: string; type_line: string; mana_value: number; layout: string; is_land: number; oracle_text: string; is_commander: number };
  const rows = store.db.query(`SELECT c.id, c.name, c.color_identity, c.type_line, c.mana_value, c.layout, c.is_land, c.oracle_text,
      (cm.card_id IS NOT NULL) AS is_commander FROM cards c LEFT JOIN commanders cm ON cm.card_id = c.id ORDER BY c.id`).all() as Row[];
  cards = rows.filter((r) => graph.positionOf.has(r.id)).map((r) => ({ id: r.id, name: r.name, ci: r.color_identity, front: r.type_line.split(" // ")[0], mv: r.mana_value, layout: r.layout, land: !!r.is_land }));
  commanders = rows.flatMap((r) => {
    const m = r.is_commander ? TRIGGER.exec(r.oracle_text) : null;
    if (!m || !graph.positionOf.has(r.id)) return [];
    return [{ name: r.name, graphName: graph.index.cards[graph.positionOf.get(r.id)!].name, ci: r.color_identity, cond: { types: m[1] ?? "", mv: +m[2] } }];
  });
}, 120_000);

const inside = (c: Card, ci: string) => [...c.ci].every((x) => ci.includes(x));
/** One-face nonland cards inside the identity, split by whether they meet the condition. */
function pools(cmd: Commander) {
  const pool = cards.filter((c) => c.name !== cmd.name && !c.land && ONE_FACE.has(c.layout) && inside(c, cmd.ci));
  return { yes: pool.filter((c) => meets(c, cmd.cond)), no: pool.filter((c) => !meets(c, cmd.cond)) };
}
const measured = () => commanders.filter((c) => c.name !== REPORTED);

test("ISC-94: the store holds commanders with such a trigger besides Helga, each under every condition shape the rules text uses", () => {
  const names = measured().map((c) => c.name);
  expect(names.length).toBeGreaterThanOrEqual(8);
  const shapes = new Set(measured().map((c) => (c.cond.types === "" ? "any" : c.cond.types.startsWith("non") ? "non" : "type")));
  expect([...shapes].sort()).toEqual(["any", "non", "type"]);
  expect(commanders.map((c) => c.name)).toContain(REPORTED);
});

const deckDraw = fc.record({ k: fc.nat(), yes: fc.array(fc.nat(), { minLength: 6, maxLength: 14 }), no: fc.array(fc.nat(), { minLength: 10, maxLength: 20 }) });

test("ISC-94: for random decks under every such commander but Helga, the trigger links to every deck card meeting both conditions and to no other, and each link counts toward the commander's engine partners", () => {
  let linked = 0;
  fc.assert(fc.property(deckDraw, (r) => {
    const cmd = measured()[r.k % measured().length];
    const { yes, no } = pools(cmd);
    const deck = [...new Set([...r.yes.map((s) => yes[s % yes.length]), ...r.no.map((s) => no[s % no.length])])];
    const text = [`1 ${cmd.name}`, ...deck.map((c) => `1 ${c.name}`)].join("\n");
    const { g, ctx } = deckOnGraph(store, resolveCommander(store, cmd.name).card, text);
    // the deck cards whose own casting reaches the commander's cast trigger over a link that counts
    const into = new Set(g.links.filter((l) => l.to === cmd.graphName && l.hook === "SpellCast" && l.emittedBy === "card" && ctx.counts(l)).map((l) => l.from));
    const want = deck.filter((c) => meets(c, cmd.cond)).map((c) => c.name).sort();
    expect({ commander: cmd.name, linked: [...into].sort() }).toEqual({ commander: cmd.name, linked: want });
    // the links count: the commander's engine partners include every one of them
    const partners = graphDiagnose(graph.index, g, {}, ctx).engine.find((e) => e.name === cmd.graphName)!.partners;
    expect({ commander: cmd.name, enough: partners >= want.length }).toEqual({ commander: cmd.name, enough: true });
    linked += want.length;
  }), { numRuns: 60, seed: 9401 });
  expect(linked).toBeGreaterThan(60 * 4);
}, 240_000);

test("ISC-94: in theme inference, a theme profile whose payoff is such a trigger reads every card meeting both conditions as fitting it by being cast, and no card failing either", () => {
  // The reader theme inference scores priority cards with (plan.ts inferTheme: profileMatcher and profileFit over each
  // theme's profile), given a theme-shaped profile whose one hook is the commander's cast trigger.
  const idx = graph.index;
  let fits = 0;
  fc.assert(fc.property(fc.nat(), fc.array(fc.nat(), { minLength: 20, maxLength: 20 }), (k, picks) => {
    const cmd = measured()[k % measured().length];
    const profile: HookProfile = { source: { kind: "strategy", theme: "cast trigger", commanders: 1 }, hooks: [{ hook: "SpellCast", side: "spends", weight: 1, evidence: [cmd.graphName] }] };
    const match = profileMatcher(idx, profile);
    const { yes, no } = pools(cmd);
    for (const [s, j] of picks.entries()) {
      const c = s % 2 ? yes[j % yes.length] : no[j % no.length];
      const byCasting = match(graph.positionOf.get(c.id)!).filter((m) => m.source.startsWith("own"));
      expect({ commander: cmd.name, card: c.name, fits: byCasting.length > 0 }).toEqual({ commander: cmd.name, card: c.name, fits: meets(c, cmd.cond) });
      if (byCasting.length) { fits++; expect(profileFit(byCasting).score).toBe(1); }
    }
  }), { numRuns: 40, seed: 9402 });
  expect(fits).toBeGreaterThan(40 * 5);
}, 240_000);

test("ISC-94: a plan of the commander and three priority cards meeting the trigger, read under the theme they infer, puts every deck card meeting both conditions on plan", () => {
  for (const cmd of measured()) {
    const { yes } = pools(cmd);
    const priorities = [yes[0], yes[Math.floor(yes.length / 2)], yes[yes.length - 1]].map((c) => c.name);
    const plan = resolvePlan(store, { commander: cmd.name, plan: { priorities } });
    const fit = planScorer(store, plan);
    const off = yes.filter((_, j) => j % 7 === 0).filter((c) => fit(store.names[c.id - 1].oracleId).score === 0).map((c) => c.name);
    expect({ commander: cmd.name, offPlan: off }).toEqual({ commander: cmd.name, offPlan: [] });
  }
}, 300_000);

test("ISC-94 (report): Helga on a list of her 60 most-run nonland cards links to every creature of mana value 4 or more in it", () => {
  const cmd = commanders.find((c) => c.name === REPORTED)!;
  const id = store.names.find((n) => n.name === REPORTED)!.id;
  const top = (store.db.query("SELECT card_id FROM commander_cards cc JOIN cards c ON c.id = cc.card_id WHERE cc.commander_id = ? AND c.is_land = 0 ORDER BY cc.decks DESC, c.id LIMIT 60").all(id) as { card_id: number }[])
    .map((r) => cards.find((c) => c.id === r.card_id)).filter((c): c is Card => !!c);
  const text = [`1 ${REPORTED}`, ...top.map((c) => `1 ${c.name}`), "13 Forest", "12 Island", "12 Plains"].join("\n");
  const { g, ctx } = deckOnGraph(store, resolveCommander(store, REPORTED).card, text);
  const partners = graphDiagnose(graph.index, g, {}, ctx).engine.find((e) => e.name === cmd.graphName)!.partners;
  const qualifying = top.filter((c) => ONE_FACE.has(c.layout) && meets(c, cmd.cond)).map((c) => c.name);
  const into = new Set(g.links.filter((l) => l.to === cmd.graphName && l.hook === "SpellCast" && l.emittedBy === "card" && ctx.counts(l)).map((l) => l.from));
  console.log(`ISC-94 report: Helga partners ${partners} on her top-60 list; ${qualifying.length} one-face creatures of mana value 4+, ${qualifying.filter((n) => into.has(n)).length} linked`);
  for (const n of qualifying) expect(into.has(n)).toBe(true);
  expect(partners).toBeGreaterThanOrEqual(qualifying.length);
}, 120_000);
