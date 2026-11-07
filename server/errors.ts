// A caller's mistake (unknown name, bad value): the server returns it as a tool error the model can act on. Its own
// module so the graph and plan modules can extend it without importing deck-tools.ts (which imports them).
export class ToolInputError extends Error {}
