// Reading Scryfall's bulk files, in one place: the gzipped JSON-lines reader every loader uses (deck-pool, build-db,
// roles, build, pull-scryfall) and the one rule for a card's oracle text. Fetching and caching the files is
// pull-scryfall.ts.

/** One JSON record per non-blank line of a gzipped JSON-lines file. `any`: each caller narrows to its own Scryfall type. */
export async function readJSONL(path: string): Promise<any[]> {
  const text = new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await Bun.file(path).arrayBuffer())));
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/**
 * A card's rules text: its own `oracle_text` when Scryfall gives one (even an empty one), otherwise every face's text
 * joined by a line break (split, adventure and two-faced cards carry text per face; a textless face adds "").
 */
export const oracleText = (card: { oracle_text?: string; card_faces?: { oracle_text?: string }[] }): string =>
  card.oracle_text ?? (card.card_faces ?? []).map((f) => f.oracle_text ?? "").join("\n");
