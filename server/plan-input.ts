// The plan argument the tools take (ISA ISC-41): named themes, priority cards and themes to avoid, as the player
// confirmed them. Its own module (zod only) so deck-tools.ts and swap-tools.ts can declare it in their input shapes
// without a load-order cycle through plan.ts, which resolves it.
import { z } from "zod";

export const MAX_THEMES = 3;
export const MAX_PRIORITIES = 6; // the card graph's card-plan limit (graph/profile.ts planCards)
export const MAX_AVOID = 5;

export const planShape = z.object({
  themes: z.array(z.string().min(1)).max(MAX_THEMES).optional()
    .describe(`EDHREC themes the deck is built around, by name (e.g. ["Aristocrats"]), at most ${MAX_THEMES}`),
  priorities: z.array(z.string().min(1)).max(MAX_PRIORITIES).optional()
    .describe(`Keystone cards the plan is about, exact card names inside the commander's color identity, at most ${MAX_PRIORITIES}. With no theme, the plan is read under the usable theme these cards fit best, and the result names it`),
  avoid: z.array(z.string().min(1)).max(MAX_AVOID).optional()
    .describe(`EDHREC themes the player does not want (e.g. ["Tokens"] for a deck that should not go wide), at most ${MAX_AVOID}`),
}).strict().describe("The player's confirmed plan: at least one theme or one priority card");
export type PlanInput = z.input<typeof planShape>;
