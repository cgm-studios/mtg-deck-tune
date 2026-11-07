// Where the server reads and writes. Two homes run the same code:
//   - a checkout of this repo (development): the card store is data/cards.db, labels go to labels/, and a relative
//     deck path resolves against the repo root (fixtures/namor.txt).
//   - an installed Claude Code plugin: Claude Code sets CLAUDE_PLUGIN_DATA, a folder that survives plugin updates
//     (CLAUDE_PLUGIN_ROOT does not, so nothing is written there). The store is downloaded into it on first start
//     (store.ts), labels live beside it, and a relative deck path resolves against the player's project.
// MTG_DECK_DB and MTG_DECK_ROOT override the store file and the deck root in either home.

import { join } from "node:path";

const REPO = new URL("../", import.meta.url).pathname;
const pluginData = process.env.CLAUDE_PLUGIN_DATA || undefined;

export const IN_PLUGIN = pluginData !== undefined;
export const DB_PATH = process.env.MTG_DECK_DB ?? (pluginData ? join(pluginData, "cards.db") : join(REPO, "data", "cards.db"));
export const LABELS_PATH = join(pluginData ?? REPO, "labels", "swap-verdicts.jsonl");
export const DECK_ROOT = process.env.MTG_DECK_ROOT ?? (pluginData ? process.env.CLAUDE_PROJECT_DIR ?? process.cwd() : REPO);
