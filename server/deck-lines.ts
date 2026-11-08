// DT-6.18, ISC-113: the one reading of a deck list. Takes the list as Moxfield, Archidekt, Arena, MTGO or TopDecked export
// it and says what each line is, so every reader agrees on which lines are the deck. A section header (with or without a
// count or colon, plain or as a `//` comment) starts a part of the list; sideboard, maybeboard and considering parts are
// not the deck, and neither is a line tagged for one of them (Archidekt's `[Maybeboard{noDeck}]`) or marked `SB:`.

export type DeckLine = {
  line: number; // 1-based, in the text split on line ends
  text: string; // trimmed
  /** entry: "1 Card" or "1x Card". bare: words with no count. aside: a header, URL, comment, SB: line or title. */
  kind: "entry" | "bare" | "aside";
  section: string; // the part of the list it sits in, lower case; "deck" before any header
  /** Part of the deck, not a sideboard, maybeboard or considering line. */
  inDeck: boolean;
  qty?: number; // entry only
  name?: string; // entry and bare: the card name with set codes, foil marks and tags taken off
};

const SECTION = /^(commander|commanders|companion|deck|main|mainboard|sideboard|maybeboard|maybe|considering)\b\s*(\(\d+\))?:?$/i;
const NOT_DECK = /^(sideboard|maybe|considering)/i;

/** A list line's card name without its markers, and whether a trailing `[...]` tag says the line is not the deck. */
function cleanName(raw: string): { name: string; tagNotDeck: boolean } {
  let name = raw.replace(/\s+#.*$/, ""); // Moxfield #tags
  let tagNotDeck = false;
  for (let before = ""; before !== name;) {
    before = name;
    name = name
      .replace(/\s+\*[A-Z]+\*$/i, "") // *F*, *E* foil and etched markers
      .replace(/\s+\^[^^]*\^$/, "") // Archidekt ^tag^ markers
      .replace(/\s+\[([^\]]*)\]$/, (_, tag: string) => { // Archidekt [Category{flags}], or a [c21] set code
        if (NOT_DECK.test(tag) || /\{noDeck\}/i.test(tag)) tagNotDeck = true;
        return "";
      });
  }
  name = name.replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+\S+)?$/, "").trim(); // (C21) 263, (PLST) KTK-34
  if (/^[^/]+\/[^/]+$/.test(name)) name = name.replace("/", " // "); // Fire/Ice
  return { name, tagNotDeck };
}

/** Every non-blank line of a deck list, in order, saying what it is. */
export function deckLines(text: string): DeckLine[] {
  const out: DeckLine[] = [];
  let section = "deck";
  let first = true; // no card or header seen yet: a "title: title" line (TopDecked) names the deck
  text.split(/\r?\n/).forEach((raw, k) => {
    const line = raw.trim();
    if (!line) return;
    const base = { line: k + 1, text: line };
    const aside = (): void => { out.push({ ...base, kind: "aside", section, inDeck: false }); };
    if (/^https?:\/\//.test(line)) return aside();
    const header = SECTION.exec(line.replace(/^(\/\/|#)\s*/, ""));
    if (header) { section = header[1].toLowerCase(); first = false; return aside(); }
    if (line.startsWith("//") || line.startsWith("#") || /^SB:\s*/i.test(line)) return aside();
    const m = /^(\d+)\s*x?\s+(.+)$/i.exec(line);
    if (!m && first && /^[^:]+:\s/.test(line) && !/\s\/\/\s/.test(line)) { first = false; return aside(); }
    first = false;
    const { name, tagNotDeck } = cleanName(m ? m[2] : line);
    const inDeck = !NOT_DECK.test(section) && !tagNotDeck;
    out.push(m ? { ...base, kind: "entry", section, inDeck, qty: Number(m[1]), name } : { ...base, kind: "bare", section, inDeck, name });
  });
  return out;
}
