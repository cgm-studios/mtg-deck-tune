// Hook implications, ported from mtg-graph-api src/closure.ts: the closure rules, the zone table, the extra rules, and
// "A:B implies A". The rule files are ported as source beside this file (mapping/closure_rules.yaml and the card
// graph's mapping/forge-map.json, both verbatim) and imported statically, so the bundled server carries them and reads
// no file at run time. The store's corpus was extracted under one mapping version; store-graph.ts refuses a store built
// under another, because the hooks and zones below would no longer mean what its relations mean.
import rulesFile from "./mapping/closure_rules.yaml";
import map from "./mapping/forge-map.json";

interface Rule { from: string; implies: string; condition?: { target_type?: string[] } | null }
type RulesFile = {
  event_implications: Rule[];
  effect_closures: { effect: string; triggers_event: string; condition?: Rule["condition"] }[];
};

/** The mapping version the ported closure and zone tables come from. */
export const MAPPING_VERSION: string = map.version;

const EFFECT_TO_HOOK: Record<string, string> = { CreateToken: "TokenCreated", Bounce: "Bounce", LandToBattlefield: "PutOntoBattlefield" };

export class Closure {
  private rules: Rule[] = [];

  constructor() {
    const y = rulesFile as RulesFile;
    if (!Array.isArray(y?.event_implications) || !Array.isArray(y?.effect_closures)) throw new Error("closure_rules.yaml: missing event_implications or effect_closures");
    this.rules.push(...y.event_implications);
    for (const e of y.effect_closures) this.rules.push({ from: EFFECT_TO_HOOK[e.effect] ?? e.effect, implies: e.triggers_event, condition: e.condition });
    for (const z of map.zones) for (const h of z.hooks.slice(1)) this.rules.push({ from: z.hooks[0], implies: h });
    for (const z of map.zones as { hooks: string[]; creatureHooks?: string[] }[]) for (const h of z.creatureHooks ?? []) for (const i of z.hooks) this.rules.push({ from: h, implies: i });
    for (const x of map.extraImplications) this.rules.push({ from: x.from, implies: x.implies });
  }

  get ruleCount() { return this.rules.length; }

  /** Every hook implied by `hook`, itself included. `types` gates conditional rules (Destroy implies Dies only for creatures). */
  expand(hook: string, types: string[] = []): string[] {
    const lower = types.map((x) => x.toLowerCase());
    const out = new Set<string>([hook]);
    const queue = [hook];
    while (queue.length) {
      const h = queue.shift()!;
      const parent = h.includes(":") ? h.slice(0, h.indexOf(":")) : null;
      const next = this.rules.filter((r) => r.from === h && (!r.condition?.target_type || r.condition.target_type.some((t) => lower.includes(t)))).map((r) => r.implies);
      if (parent) next.push(parent);
      for (const n of next) if (!out.has(n)) { out.add(n); queue.push(n); }
    }
    return [...out].sort();
  }
}
