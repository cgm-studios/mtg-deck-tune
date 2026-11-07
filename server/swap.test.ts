// The swap tool's cuts under a plan with priority cards (DT-6.15, ISA ISC-93). The priority cards are the player's own
// word for what the deck is about, so swap_candidates never offers one as the card to cut, on any lever, for the whole
// deck; asked to replace one by name, it refuses and says why. Expected values come from the inputs themselves: the
// priority cards the test chose, and the same call without them (which shows a priority card would be cut otherwise).
import { beforeAll, expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { openStore, ToolInputError, type Store } from "./deck-tools";
import { DB_PATH } from "./paths";
import { LEVERS, swapCandidates, type SwapCandidatesInput } from "./swap-tools";

const fixtureLines = (f: string) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8").split("\n").map((l) => l.trim()).filter((l) => /^\d+ /.test(l));
const BASIC = /^(Island|Plains|Swamp|Forest|Mountain|Wastes)$/;
const BASIC_OF: Record<string, string> = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };
const THEMES = ["Tokens", "Aristocrats", "Spellslinger", "+1/+1 Counters", "Ramp"];

let store: Store;
/** Deck sources: two real lists, and two commanders whose decks are drawn from the store inside their identity. */
let sources: { commander: string; lines: string[] }[];
let roleNames: string[];

beforeAll(() => {
  store = openStore(DB_PATH);
  roleNames = store.roles.roleNames;
  type Row = { name: string; color_identity: string };
  const nonland = store.db.query("SELECT name, color_identity FROM cards WHERE is_land = 0 ORDER BY id").all() as Row[];
  const drawn = (commander: string) => {
    const ci = (store.db.query("SELECT color_identity FROM cards WHERE name = ?").get(commander) as { color_identity: string }).color_identity;
    const inside = nonland.filter((r) => r.name !== commander && [...r.color_identity].every((c) => ci.includes(c)));
    // every 97th card inside the identity: a fixed, spread-out pool the property draws its decks from
    return [`1 ${commander}`, ...inside.filter((_, k) => k % 97 === 0).map((r) => `1 ${r.name}`), ...[...ci].map((c) => `8 ${BASIC_OF[c]}`)];
  };
  sources = [
    { commander: "Namor the Sub-Mariner", lines: fixtureLines("namor.txt") },
    { commander: "Teysa Karlov", lines: fixtureLines("teysa.txt") },
    { commander: "Atraxa, Praetors' Voice", lines: drawn("Atraxa, Praetors' Voice") },
    { commander: "Krenko, Mob Boss", lines: drawn("Krenko, Mob Boss") },
  ];
}, 60_000);

const nameOf = (line: string) => line.replace(/^\d+\s+/, "");

test("ISC-93: for random decks and plans with 1 to 4 in-deck priority cards, no candidate on any lever cuts a priority card", () => {
  const offered: Record<string, number> = Object.fromEntries(LEVERS.map((l) => [l, 0]));
  let checked = 0, exposed = 0;
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 3 }).chain((k) => fc.record({
      k: fc.constant(k),
      keep: fc.array(fc.boolean(), { minLength: 400, maxLength: 400 }),
      pick: fc.array(fc.nat(), { minLength: 1, maxLength: 4 }),
      themes: fc.subarray(THEMES, { maxLength: 1 }),
      targets: fc.array(fc.integer({ min: 0, max: 12 }), { minLength: 10, maxLength: 10 }),
    })),
    (r) => {
      const { commander, lines: all } = sources[r.k];
      // a random sub-deck, at least 20 lines, always keeping the commander and the lands
      const lines = all.filter((l, k) => nameOf(l) === commander || BASIC.test(nameOf(l)) || r.keep[k % r.keep.length] || k < 20);
      const decklist = lines.join("\n");
      const names = lines.map(nameOf).filter((n) => n !== commander && !BASIC.test(n));
      const priorities = [...new Set(r.pick.map((p) => names[p % names.length]))];
      const targets = Object.fromEntries(roleNames.map((role, k) => [role, r.targets[k % r.targets.length]]));
      const plan = { ...(r.themes.length ? { themes: r.themes } : {}), priorities };
      const base = { commander, decklist, targets } satisfies Partial<SwapCandidatesInput>;
      const call = (input: SwapCandidatesInput) => {
        try { return swapCandidates(store, input); } catch (e) { if (e instanceof ToolInputError) return null; throw e; }
      };
      for (const lever of LEVERS) {
        const got = call({ ...base, lever, plan });
        if (!got) return; // a priority card without card graph data cannot anchor a plan: the caller's to fix
        offered[lever] += got.candidates.length;
        const cut = got.candidates.flatMap((c) => (c.out ? [c.out.name] : []));
        expect({ lever, priorities, cut: cut.filter((n) => priorities.includes(n)) }).toEqual({ lever, priorities, cut: [] });
        // the same call with the priority cards left out of the plan: how often one of them would have been cut
        const without = call({ ...base, lever, plan: r.themes.length ? { themes: r.themes } : { themes: ["Tokens"] } });
        if (without?.candidates.some((c) => c.out && priorities.includes(c.out.name))) exposed++;
      }
      checked++;
    },
  ), { numRuns: 30, seed: 9301 });
  expect(checked).toBeGreaterThan(20);
  for (const lever of LEVERS) expect({ lever, offered: offered[lever] > 0 }).toEqual({ lever, offered: true });
  // not vacuous: without the protection, priority cards are offered as cuts in many of these calls
  expect(exposed).toBeGreaterThan(10);
}, 600_000);

test("ISC-93: asked to replace a priority card by name, the per-card levers refuse and say it is one of the plan's priority cards", () => {
  const { commander, lines } = sources[0];
  const decklist = lines.join("\n");
  for (const lever of ["plan", "cheaper", "budget"] as const) {
    expect(() => swapCandidates(store, { commander, decklist, lever, card: "Talrand, Sky Summoner", plan: { themes: ["Spellslinger"], priorities: ["Talrand, Sky Summoner"] } }))
      .toThrow(/Talrand, Sky Summoner is one of the plan's priority cards/);
    // the same card without that plan is an ordinary request
    expect(() => swapCandidates(store, { commander, decklist, lever, card: "Talrand, Sky Summoner", plan: { themes: ["Spellslinger"] } })).not.toThrow();
  }
}, 120_000);
