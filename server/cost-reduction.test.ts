// What a cost reducer discounts, read from its rules text (DT-6.13, ISA ISC-86). The texts below are Oracle wordings
// written out here, so the expected readings are worked by hand, not by the code under test.
import { describe, expect, test } from "bun:test";
import { discountUsable, spellDiscounts, type CastFacts } from "./cost-reduction";

const SUBTYPES = new Set(["kithkin", "soldier", "dinosaur", "elf", "equipment", "aura", "beast", "dragon"]);
const card = (types: string, colors: string, subtypes = "", supertypes = ""): CastFacts => ({
  types: new Set(types.toLowerCase().split(" ").filter(Boolean)),
  colors: new Set([...colors.toLowerCase()].map((c) => ({ w: "white", u: "blue", b: "black", r: "red", g: "green" })[c]!)),
  subtypes: new Set(subtypes.toLowerCase().split(" ").filter(Boolean)),
  supertypes: new Set(supertypes.toLowerCase().split(" ").filter(Boolean)),
});
const monoGreen = [card("Creature", "G", "Elf Druid"), card("Creature", "G", "Elder Dinosaur", "Legendary"), card("Sorcery", "G"), card("Artifact", "")];

describe("reading a cost reducer's discount (ISC-86)", () => {
  test("a color or a type before \"spells\" is what it discounts; several groups are alternatives, words in one group all hold", () => {
    expect(spellDiscounts("Black spells you cast cost {1} less to cast.", SUBTYPES)).toEqual([[["black"]]]);
    expect(spellDiscounts("Instant and sorcery spells you cast cost {1} less to cast.", SUBTYPES)).toEqual([[["instant"], ["sorcery"]]]);
    expect(spellDiscounts("Kithkin spells and Soldier spells you cast cost {1} less to cast.", SUBTYPES)).toEqual([[["kithkin"], ["soldier"]]]);
    expect(spellDiscounts("White creature spells you cast cost {1} less to cast.\nWhenever you cast a creature spell, create a token.", SUBTYPES)).toEqual([[["white", "creature"]]]);
    expect(spellDiscounts("Trample\nThe first creature spell you cast each turn costs {2} less to cast.", SUBTYPES)).toEqual([[["creature"]]]);
  });

  test("a discount on any spell, a self-discount, an opponent's spells and a chosen type are not judged", () => {
    expect(spellDiscounts("Spells you cast cost {1} less to cast.", SUBTYPES)).toEqual([null]);
    expect(spellDiscounts("Spells you cast of the chosen type cost {1} less to cast.", SUBTYPES)).toEqual([null]);
    expect(spellDiscounts("This spell costs {1} less to cast for each artifact you control.", SUBTYPES)).toEqual([]);
    expect(spellDiscounts("Spells your opponents cast that target this creature cost {2} more to cast.", SUBTYPES)).toEqual([]);
    expect(spellDiscounts("As an additional cost, you may pay 2 life. Those spells cost {G} less to cast if you paid life this way.", SUBTYPES)).toEqual([]);
    expect(spellDiscounts("Flying\nDraw a card.", SUBTYPES)).toEqual([]);
    // an unknown word in a group leaves that group unjudged
    expect(spellDiscounts("Face-down creature spells you cast cost {1} less to cast.", SUBTYPES)).toEqual([null]);
  });

  test("a mono-green deck with a colorless artifact can use green, creature, artifact, Dinosaur and legendary discounts, and no other color's", () => {
    const usable = (text: string) => discountUsable(spellDiscounts(text, SUBTYPES), monoGreen);
    for (const t of ["Green spells you cast cost {1} less to cast.", "Creature spells you cast cost {1} less to cast.", "Artifact spells you cast cost {1} less to cast.",
      "Dinosaur spells you cast cost {2} less to cast.", "Legendary spells you cast cost {1} less to cast.", "Noncreature spells you cast cost {1} less to cast.",
      "Spells you cast cost {1} less to cast.", "Herald's text: Creature spells you cast of the chosen type cost {1} less to cast.", "Flying"]) expect([t, usable(t)]).toEqual([t, true]);
    for (const t of ["White spells you cast cost {1} less to cast.", "Blue spells you cast cost {1} less to cast.", "Black spells you cast cost {1} less to cast.",
      "Red spells you cast cost {1} less to cast.", "Enchantment spells you cast cost {1} less to cast.", "White creature spells you cast cost {1} less to cast.",
      "Instant and sorcery spells you cast cost {1} less to cast.".replace("sorcery", "planeswalker"), "Beast spells you cast cost {1} less to cast."]) expect([t, usable(t)]).toEqual([t, false]);
    // two clauses: usable when either one is
    expect(discountUsable(spellDiscounts("White spells you cast cost {1} less to cast.\nGreen spells you cast cost {1} less to cast.", SUBTYPES), monoGreen)).toBe(true);
    // a colorless card is colorless; a card with no colors is never white
    expect(discountUsable(spellDiscounts("Colorless spells you cast cost {2} less to cast.", SUBTYPES), monoGreen)).toBe(true);
    expect(discountUsable(spellDiscounts("Colorless spells you cast cost {2} less to cast.", SUBTYPES), monoGreen.slice(0, 3))).toBe(false);
  });
});
