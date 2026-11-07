// MV-15: `mtg-deck`, the local stdio MCP server over the card store. It only wraps the plain functions in
// deck-tools.ts and (MV-16) swap-tools.ts: each tool validates its input against the same zod shape, calls the function, and returns the
// result as JSON text plus structured content. A caller mistake (unknown name, bad value) comes back as a tool
// error the model can read and fix; anything else is a real fault and is reported the same way with its message.
// Registered for Claude Code in the plugin's .mcp.json (and in a checkout of this repo, the same file).
//   bun server/mcp.ts       (speaks MCP on stdin/stdout)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { commanderProfile, commanderProfileShape } from "./commander";
import { diagnose, diagnoseShape } from "./diagnose";
import {
  cardDetails, cardShape, deckStats, deckStatsShape, findCards, findCardsShape, findTags, neighbors, neighborsShape, openStore, tagsShape, type Store,
} from "./deck-tools";
import { shortlist, shortlistShape } from "./shortlist";
import { ensureStore } from "./store";
import { acceptSwap, acceptSwapShape, rejectSwap, rejectSwapShape, swapCandidates, swapCandidatesShape } from "./swap-tools";

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export function toolResult(run: () => object): ToolResult {
  try {
    const out = run() as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  } catch (e) {
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

// Each tool waits for the store: in a plugin the first start downloads it (store.ts) while the server already answers.
async function withStore(store: Store | Promise<Store>, run: (s: Store) => object): Promise<ToolResult> {
  let s: Store;
  try {
    s = await store;
  } catch (e) {
    return { content: [{ type: "text", text: `card data is not available: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
  return toolResult(() => run(s));
}

export function createDeckServer(store: Store | Promise<Store>): McpServer {
  const server = new McpServer({ name: "mtg-deck", version: "0.1.0" });
  server.registerTool("find_cards", {
    title: "Find cards",
    description: "Find commander-legal cards in the card store (Scryfall, Tagger tags). Every filter given must hold. " +
      "Find tag labels with the tags tool. Returns the total match count and one page of cards (default 25, at most 100) in a stable order. " +
      "Two filters let you search for what a commander or the player's plan rewards: `manaSymbols` asks for a minimum count of one color's " +
      "mana symbols in the cost (two or more blue symbols = [{color: \"U\", min: 2}]; a hybrid or Phyrexian symbol counts once for each color " +
      "it can be paid with), and `rulesText` asks for words or phrases in the card's rules text (\"noncreature spell\", \"whenever you cast\"; " +
      "capitals ignored, part of a word matches). Both combine with every other filter. When a search misses (no cards, too few, or too many), " +
      "change it and search again: loosen a count, use a shorter or longer phrase, or drop a filter. `types` must all hold, so there is no " +
      "\"not a creature\" filter: for noncreature spells search Instant, Sorcery, Artifact and Enchantment (and others) in turn.",
    inputSchema: findCardsShape,
  }, async (args) => withStore(store, (s) => findCards(s, args)));
  server.registerTool("tags", {
    title: "Find Tagger tags",
    description: "Look up Scryfall Tagger tags by words in their label or description, to use in find_cards `tags`. " +
      "The store has ~4,600 tags covering far more than the deck roles and levers (anthems, evasion, sacrifice outlets, " +
      "tribal payoffs, ...). Each tag comes with its description, its parent tags and how many cards carry it or a " +
      "child tag (inside colorIdentity when given, the count find_cards would return).",
    inputSchema: tagsShape,
  }, async (args) => withStore(store, (s) => findTags(s, args)));
  server.registerTool("card", {
    title: "Card details",
    description: "Full details for one card: cost, types, oracle text, power/toughness, keywords, color identity, price, " +
      "its Scryfall Tagger tags and its deck roles. The name resolves fuzzily; `matchedBy` and `alternatives` show how.",
    inputSchema: cardShape,
  }, async (args) => withStore(store, (s) => cardDetails(s, args)));
  server.registerTool("deck_stats", {
    title: "Deck stats",
    description: "Numbers for a Commander deck: average mana value, mana curve, role counts (ramp, card draw, removal, ...), " +
      "colored pip load, plus unresolved lines and off-identity cards; with the player's confirmed plan (`plan`: themes, " +
      "priority cards, themes to avoid), plan fit: which cards fit it and which do not. " +
      "Give the commander and either a decklist file path or the pasted list.",
    inputSchema: deckStatsShape,
  }, async (args) => withStore(store, (s) => deckStats(s, args)));
  server.registerTool("commander_profile", {
    title: "Commander profile",
    description: "How a commander is usually played: its EDHREC themes with deck counts and shares (a share is of the commander's " +
      "theme tag mentions, not of its decks), the strongest tags of its Tagger Deck profile with weights, and, when given a " +
      "decklist, how strongly the list matches each of its top themes (0 to 1, with the cards held and the heaviest cards " +
      "missing). A commander with no EDHREC page, or one with under 20 decks, is profiled from its own card tags, and " +
      "`fallback` says why.",
    inputSchema: commanderProfileShape,
  }, async (args) => withStore(store, (s) => commanderProfile(s, args)));
  server.registerTool("diagnose", {
    title: "Diagnose a deck against the plan",
    description: "What a Commander deck lacks and overdoes against the player's confirmed plan (`plan`, required: themes, " +
      "priority cards, themes to avoid). Returns engine gaps (payoffs waiting on something too few cards make happen, with both " +
      "counts and in-color cards that would feed them), every role against its target with the target's source (the plan's " +
      "theme decks, or the default table when the plan's themes do not cover it) and the roles over and under, cards off the " +
      "plan with the reason, the cards doing the least with their links into the deck, and the cards the card graph cannot " +
      "read (static effects), which are never judged by their links. Give the commander and either a decklist file path or " +
      "the pasted list. Same deck and plan, same answer.",
    inputSchema: diagnoseShape,
  }, async (args) => withStore(store, (s) => diagnose(s, args)));
  server.registerTool("shortlist", {
    title: "Shortlist for one problem",
    description: "About 30 cards to add for one diagnosed problem, under the player's confirmed plan (`plan`, required). `problem` is " +
      "one of: {role} (cards holding a deck role), {engineGap} (cards that make an event happen for the deck's payoffs, in the words " +
      "diagnose gives an engine gap's mechanic, e.g. \"a creature dying\"), or {offPlan: true} (cards that fit the plan, to replace " +
      "cards off it or doing the least). Every card is commander-legal, inside the commander's color identity and outside the deck, " +
      "and at or under `maxManaValue` and `maxPrice` when given. Each card is labeled by where it came from, with the evidence: " +
      "fits this commander (the commander's EDHREC synergy), deeper cut (fit to the tags of the commander's decks), widely played " +
      "(global EDHREC rank; at most 10 cards come in on popularity alone), engine partner (card graph links into the deck's cards " +
      "that fit the plan). Each also carries its links into the deck by event, its plan fit, and what adding it changes in the deck's " +
      "numbers; with `out` (a card in the deck), what swapping it in for that card changes, with the numbers after (`before` is " +
      "given once). The list narrows the pool; it does not judge card quality. Same deck, plan and problem, same answer.",
    inputSchema: shortlistShape,
  }, async (args) => withStore(store, (s) => shortlist(s, args)));
  server.registerTool("neighbors", {
    title: "Card Space neighbors",
    description: "A card's nearest Card Space neighbors that a commander can play, nearest first, each with its similarity " +
      "score, mana value, type line, color identity, price and deck roles (up to 30). The card must be inside the " +
      "commander's color identity; lands have no neighbors.",
    inputSchema: neighborsShape,
  }, async (args) => withStore(store, (s) => neighbors(s, args)));
  server.registerTool("swap_candidates", {
    title: "Swap candidates",
    description: "Swap candidates for one card in a Commander deck, or for the whole deck, under a lever: plan (fits the " +
      "player's confirmed plan better; needs `plan`), cheaper (lower mana value), budget (lower USD price), roles (role counts against targets, and cards " +
      "that fill roles under target) or redundancy (roles over target, and cuts). Every candidate is a commander-legal card " +
      "inside the commander's color identity, with its reason, its evidence, the deck numbers after the swap (`before` is " +
      "given once), `dropsRole` when it leaves a role with fewer cards, and `belowTarget` when that leaves a role under its " +
      "target. Role targets are a proposal; pass `targets` to change them. A plan that names a theme the data does not know, " +
      "or one with too little data to profile, comes back as an error saying which.",
    inputSchema: swapCandidatesShape,
  }, async (args) => withStore(store, (s) => swapCandidates(s, args)));
  server.registerTool("accept_swap", {
    title: "Accept a swap",
    description: "Record that the player accepted a swap: rewrites the deck file (the outgoing card's line becomes the incoming " +
      "card's line), appends a dated change-log line, and logs the card pair as a quality label. Exact card names only. " +
      "Give out alone for a cut, in alone for an add.",
    inputSchema: acceptSwapShape,
  }, async (args) => withStore(store, (s) => acceptSwap(s, args)));
  server.registerTool("reject_swap", {
    title: "Reject a swap",
    description: "Record that the player rejected a swap: logs the card pair as a quality label. The deck file is never touched.",
    inputSchema: rejectSwapShape,
  }, async (args) => withStore(store, (s) => rejectSwap(s, args)));
  return server;
}

if (import.meta.main) {
  const store = ensureStore().then(() => openStore());
  store.catch((e) => console.error(`mtg-deck: ${e instanceof Error ? e.message : String(e)}`));
  await createDeckServer(store).connect(new StdioServerTransport());
}
