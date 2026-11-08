// The card graph's fixed grammar, ported from mtg-graph-api src/grammar.ts (branch rework/ts-card-graph). The relations
// are fixed; hook names are open. The card store keeps each card's abilities in this shape (card_graph.abilities), less
// the Forge source line, which nothing at query time reads.

export const RELATIONS = ["produces", "consumes", "triggers_on", "modifies", "replaces"] as const;
export type RelationKind = (typeof RELATIONS)[number];

/** Who or what a relation applies to. Built from Forge's Valid*, Defined$ and Affected$ expressions. */
export interface Selector {
  /** Alternatives joined by OR. An empty list means "unspecified". */
  any: SelectorAlt[];
  /** The Forge expression this came from: kept as a memo key and for audit. */
  raw: string;
}

export interface SelectorAlt {
  /** Card types: Creature, Artifact, Land, Planeswalker, Instant, Sorcery, Enchantment, Battle, Permanent, Card, Spell. */
  types: string[];
  /** Subtypes: Elf, Tentacle, Equipment, Aura… */
  subtypes: string[];
  controller: "you" | "opponent" | "any";
  /** true = token only, false = nontoken only, null = either. */
  token: boolean | null;
  self: boolean;
  other: boolean;
  /** Player selectors (You, Opponent, Player, TriggeredPlayer…). */
  player?: string;
  /** Remaining Forge properties kept but not interpreted yet (cmcLE2, nonLand…). */
  props: string[];
}

export interface Relation {
  relation: RelationKind;
  hook: string;
  /** The subject: what the hook happens to or is done by. */
  selector: Selector;
  /** The second party when there is one, e.g. who is dealt the damage in "deals combat damage to a player". */
  object?: Selector;
}

export type AbilityKind = "triggered" | "activated" | "spell" | "mana" | "static" | "replacement" | "keyword" | "chapter";

export interface Ability {
  kind: AbilityKind;
  /** Card face index: 0 = front. */
  face: number;
  /** True for abilities granted to something else (auras, emblems, class levels, modal grants). */
  granted: boolean;
  relations: Relation[];
}

/** One card's graph as the store holds it. */
export interface CardGraph {
  name: string;
  oracleId: string;
  abilities: Ability[];
}
