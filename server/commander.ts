// DT-6.2: `commander_profile`, how a commander is usually played. Plain function over the card store (schema 2, DT-6.1);
// mcp.ts only wraps it. The answer is data; the skill turns it into Magic talk.
//   themes        the commander's EDHREC themes: deck count, and share of the commander's theme tag mentions
//   taggerDeck    the strongest tags of the commander's Tagger Deck profile, with weights
//   deckMatch     (with a decklist) how strongly the list matches each of the commander's top themes
//   fallback      why the profile is built from the commander's own card tags instead of its page
// Deterministic: same store, same input, same answer.
//
// A theme's share of a commander is its deck count over the commander's theme tag mentions (every theme's deck count
// added up). EDHREC tags a deck with several themes and only about a quarter of decks carry any, so shares are of
// mentions, not of decks.
//
// How a deck is matched to a theme. A theme's card profile is mined from the commander pages (the store's commander_cards),
// the way mtg-graph-api's strategy.ts mines hooks, but over cards:
//   1. The theme's commanders are those where the theme is at least MIN_SHARE of the commander's tag mentions and has
//      MIN_THEME_DECKS decks. Fewer than MIN_COMMANDERS of them and the theme has no profile (a few commanders' lists
//      are those commanders, not the theme).
//   2. On each such commander's page a card counts with mass = the commander's theme share x the card's EDHREC synergy,
//      when synergy is positive and the commander's decks run it in MIN_CARD_DECKS or more.
//   3. T(card) = the card's share of the theme's mass; B(card) = its share of the same mass over every commander.
//      A card enters the profile when T / B >= MIN_LIFT, with weight T * ln(T / B): common in the theme, and more common
//      than in Commander at large. Staples sit near B and drop out.
//   4. Only cards inside the commander's color identity count, so the match is about what this deck could hold.
//   match = the part of the profile's weight that the deck holds, 0 to 1.

import { z } from "zod";
import { fitsIdentity } from "./color-identity";
import { parseDecklist } from "./deck-pool";
import { type Store, ToolInputError, readDeck, resolveCommander, unresolvedLines } from "./deck-tools";

const THEME_LIMIT = 10;
const TAG_LIMIT = 12;
const MATCH_THEMES = 5;
const NAMED = 5; // cards named per theme, held and missing

const MIN_SHARE = 0.15;
const MIN_THEME_DECKS = 20;
const MIN_CARD_DECKS = 3;
const MIN_LIFT = 1.25;
const MIN_COMMANDERS = 10;

export const commanderProfileShape = {
  commander: z.string().min(1).describe("The commander's exact name or front-face name (case and punctuation ignored)"),
  deckFile: z.string().min(1).optional().describe("Path to a `1 Card Name` decklist file, absolute or relative to the project directory; with it (or `decklist`) the answer also says how strongly the deck matches each top theme"),
  decklist: z.string().min(1).optional().describe("The decklist text itself, `1 Card Name` per line; give this or deckFile, or neither"),
  themeLimit: z.number().int().min(1).max(500).optional().describe(`How many themes to list, strongest first (default ${THEME_LIMIT}); the rest come back as one summed \`otherThemes\` entry`),
  tagLimit: z.number().int().min(1).max(100).optional().describe(`How many Tagger Deck tags to list, strongest first (default ${TAG_LIMIT})`),
  matchThemes: z.number().int().min(1).max(20).optional().describe(`With a decklist, how many of the strongest themes to match it against (default ${MATCH_THEMES})`),
};
const input = z.object(commanderProfileShape).strict();
export type CommanderProfileInput = z.input<typeof input>;

export type FallbackReason = "no page" | "thin" | "no kept tags";
export type ThemeShare = { theme: string; slug: string; decks: number; share: number };
export type ThemeMatch = {
  theme: string; slug: string; share: number;
  match: number | null; // 0 to 1; null when the theme has too few commanders to profile
  held: string[]; // the deck's cards that weigh most in the theme
  missing: string[]; // the theme's heaviest cards, inside the commander's colors, that the deck lacks
  note?: string;
};
export type CommanderProfile = {
  commander: { name: string; colorIdentity: string };
  decks: number | null;
  themeMentions: number;
  themes: ThemeShare[];
  otherThemes: { count: number; decks: number; share: number } | null;
  // "deck": the commander's Tagger Deck vector (built from its EDHREC page); "card": the commander's own card tags
  taggerDeck: { source: "deck" | "card"; tags: { tag: string; weight: number }[] };
  // null when the profile comes from the commander's page; otherwise why it comes from the commander's own card tags
  fallback: { reason: FallbackReason; note: string } | null;
  // with a decklist: the themes it was matched against, best match first
  deckMatch?: {
    deckCards: number; // distinct cards of the list other than the commander
    unresolved: { line: number; text: string; closeMatches: string[] }[];
    strongest: string | null;
    themes: ThemeMatch[];
  };
};

const NOTES: Record<FallbackReason, (decks: number) => string> = {
  "no page": () => "this commander has no EDHREC page, so the profile comes from its own card tags",
  thin: (decks) => `its EDHREC page covers ${decks} decks, too few to say how it is usually played, so the profile comes from its own card tags`,
  "no kept tags": () => "the cards on its EDHREC page carry no usable tags, so the profile comes from its own card tags",
};

const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;
const byteCmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// A packed Tagger vector: n float32le weights, then n uint16le tags.id, strongest first (store.ts header).
function unpackVector(blob: Uint8Array): { tagId: number; weight: number }[] {
  const n = blob.byteLength / 6;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  return Array.from({ length: n }, (_, i) => ({ weight: view.getFloat32(i * 4, true), tagId: view.getUint16(n * 4 + i * 2, true) }));
}

// ---------- theme card profiles ----------
type Profile = { weights: Map<number, number>; commanders: number }; // store card id -> weight
type Mined = { mentions: Map<number, number>; baseline: Map<number, number>; baselineMass: number; profiles: Map<number, Profile> };
const mined = new WeakMap<object, Mined>();

function minedFor(store: Store): Mined {
  const hit = mined.get(store.db);
  if (hit) return hit;
  const mentions = new Map((store.db.query("SELECT commander_id AS id, SUM(decks) AS n FROM commander_themes GROUP BY commander_id").all() as { id: number; n: number }[]).map((r) => [r.id, r.n]));
  const baseline = new Map<number, number>();
  let baselineMass = 0;
  for (const r of store.db.query("SELECT card_id AS id, SUM(synergy) AS s FROM commander_cards WHERE synergy > 0 AND decks >= ? GROUP BY card_id ORDER BY card_id").all(MIN_CARD_DECKS) as { id: number; s: number }[]) {
    baseline.set(r.id, r.s);
    baselineMass += r.s;
  }
  const out = { mentions, baseline, baselineMass, profiles: new Map<number, Profile>() };
  mined.set(store.db, out);
  return out;
}

/** The theme's card profile, or the number of commanders that qualified when there are too few. */
function themeProfile(store: Store, themeId: number): Profile {
  const m = minedFor(store);
  const hit = m.profiles.get(themeId);
  if (hit) return hit;
  const chosen = (store.db.query("SELECT commander_id AS id, decks FROM commander_themes WHERE theme_id = ? AND decks >= ? ORDER BY commander_id").all(themeId, MIN_THEME_DECKS) as { id: number; decks: number }[])
    .map((r) => ({ id: r.id, share: r.decks / m.mentions.get(r.id)! }))
    .filter((r) => r.share >= MIN_SHARE);
  const weights = new Map<number, number>();
  if (chosen.length >= MIN_COMMANDERS) {
    const mass = new Map<number, number>();
    let total = 0;
    const cards = store.db.query("SELECT card_id AS id, synergy FROM commander_cards WHERE commander_id = ? AND synergy > 0 AND decks >= ? ORDER BY card_id");
    for (const c of chosen) for (const r of cards.all(c.id, MIN_CARD_DECKS) as { id: number; synergy: number }[]) {
      const x = c.share * r.synergy;
      mass.set(r.id, (mass.get(r.id) ?? 0) + x);
      total += x;
    }
    for (const [id, x] of [...mass].sort((a, b) => a[0] - b[0])) {
      const t = x / total, b = m.baseline.get(id)! / m.baselineMass;
      if (t / b >= MIN_LIFT) weights.set(id, t * Math.log(t / b));
    }
  }
  const out = { weights, commanders: chosen.length };
  m.profiles.set(themeId, out);
  return out;
}

export function commanderProfile(store: Store, raw: CommanderProfileInput): CommanderProfile {
  const f = input.parse(raw);
  if (f.deckFile !== undefined && f.decklist !== undefined) throw new ToolInputError("give deckFile or decklist, not both");
  const { card } = resolveCommander(store, f.commander);
  const id = store.names.find((n) => n.oracleId === card.id)!.id;
  const page = store.db.query("SELECT decks, tagger_deck, tagger_deck_fallback FROM commanders WHERE card_id = ?").get(id) as
    { decks: number; tagger_deck: Uint8Array; tagger_deck_fallback: string | null } | null;

  const reason: FallbackReason | null = !page ? "no page" : page.tagger_deck_fallback ? (page.tagger_deck_fallback as FallbackReason) : null;
  // a page too thin to quote (under 20 decks) or missing has no themes worth listing
  const themed = reason !== "no page" && reason !== "thin";
  const rows = !themed ? [] : store.db.query(
    "SELECT t.id AS themeId, t.name AS theme, t.slug, ct.decks FROM commander_themes ct JOIN themes t ON t.id = ct.theme_id WHERE ct.commander_id = ? ORDER BY ct.decks DESC, t.slug",
  ).all(id) as { themeId: number; theme: string; slug: string; decks: number }[];
  const mentions = rows.reduce((n, r) => n + r.decks, 0);
  const share = (n: number) => (mentions ? n / mentions : 0);
  const shown = rows.slice(0, f.themeLimit ?? THEME_LIMIT);
  const rest = rows.slice(shown.length);

  const own = store.db.query("SELECT vector FROM card_tagger WHERE card_id = ?").get(id) as { vector: Uint8Array } | null;
  const deckVector = page && !page.tagger_deck_fallback ? page.tagger_deck : null;
  const vector = deckVector ?? own?.vector;
  const labels = new Map((store.db.query("SELECT id, label FROM tags").all() as { id: number; label: string }[]).map((t) => [t.id, t.label]));
  const tags = (vector ? unpackVector(vector) : []).slice(0, f.tagLimit ?? TAG_LIMIT)
    .map((v) => ({ tag: labels.get(v.tagId)!, weight: round(v.weight, 5) }));

  const out: CommanderProfile = {
    commander: { name: card.name, colorIdentity: card.ci.join("") },
    decks: page?.decks ?? null,
    themeMentions: mentions,
    themes: shown.map(({ themeId: _, ...r }) => ({ ...r, share: round(share(r.decks), 6) })),
    otherThemes: rest.length ? { count: rest.length, decks: rest.reduce((n, r) => n + r.decks, 0), share: round(share(rest.reduce((n, r) => n + r.decks, 0)), 6) } : null,
    taggerDeck: { source: deckVector ? "deck" : "card", tags },
    fallback: reason ? { reason, note: NOTES[reason](page?.decks ?? 0) } : null,
  };

  if (f.deckFile !== undefined || f.decklist !== undefined) {
    const deck = parseDecklist(store.space, readDeck(f));
    const held = new Set(deck.entries.filter((e) => e.card && e.card.id !== card.id).map((e) => store.names.find((n) => n.oracleId === e.card!.id)!.id));
    const storeId = new Map(store.names.map((n) => [n.id, n]));
    const themes: ThemeMatch[] = rows.slice(0, f.matchThemes ?? MATCH_THEMES).map((r) => {
      const prof = themeProfile(store, r.themeId);
      const base = { theme: r.theme, slug: r.slug, share: round(share(r.decks), 6) };
      if (prof.commanders < MIN_COMMANDERS) {
        return { ...base, match: null, held: [], missing: [], note: `only ${prof.commanders} ${prof.commanders === 1 ? "commander plays" : "commanders play"} ${r.theme} as at least ${MIN_SHARE * 100}% of their themes, too few commanders to say what the theme looks like` };
      }
      const usable = [...prof.weights].filter(([cid]) => cid !== id && fitsIdentity(store.space.cards.get(storeId.get(cid)!.oracleId)!, card.ci));
      const sorted = usable.sort((a, b) => b[1] - a[1] || byteCmp(storeId.get(a[0])!.name, storeId.get(b[0])!.name));
      const total = sorted.reduce((s, [, w]) => s + w, 0);
      const heldW = sorted.filter(([cid]) => held.has(cid));
      return {
        ...base,
        match: total ? round(heldW.reduce((s, [, w]) => s + w, 0) / total, 6) : 0,
        held: heldW.slice(0, NAMED).map(([cid]) => storeId.get(cid)!.name),
        missing: sorted.filter(([cid]) => !held.has(cid)).slice(0, NAMED).map(([cid]) => storeId.get(cid)!.name),
      };
    });
    themes.sort((a, b) => (b.match ?? -1) - (a.match ?? -1) || b.share - a.share || byteCmp(a.slug, b.slug));
    out.deckMatch = {
      deckCards: held.size,
      unresolved: unresolvedLines(store, deck.unresolved),
      strongest: themes[0]?.match != null ? themes[0].theme : null,
      themes,
    };
  }
  return out;
}
