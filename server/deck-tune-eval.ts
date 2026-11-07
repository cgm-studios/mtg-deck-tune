// MV-17: the deck-tune eval, code stage then judge stage, over the recorded sessions in docs/research/deck-tune/.
//
//   bun app/deck-tune-eval.ts [--trials N] [--json]
//
// 1. Code stage: `bun test ./deck-tune-checks.test.ts` (ISC-13, 22.1, 22.2, 23.1 and the code half of ISC-23.2). When it
//    is red the judge stage is not dispatched: a gated judge is never a pass.
// 2. Judge stage: the Assay suite evals/deck-tune.yaml through Assay's own runAgenticSuite (EvalRunner's runner: trials,
//    pass^k, adversarial fixture, persisted run.json and receipt), with an offline replay adapter. A case's prompt names
//    a recorded transcript; the adapter returns that transcript rendered, so the judge grades the session as recorded.
//
// Exit codes follow EvalRunner: 0 passed, 1 regressed (or the code stage is red), 2 verifier unavailable.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readTranscript, renderTranscript } from "./deck-tune-transcript";

const ROOT = new URL("../", import.meta.url).pathname;
const SUITE_FILE = join(ROOT, "evals", "deck-tune.yaml");
const SKILL_FILE = join(ROOT, "plugin", "skills", "deck-tune", "SKILL.md");
const ASSAY_AGENTIC = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "skills", "Assay", "Tools", "Agentic.ts");
const REQUIRED_CONTEXT = ["skill", "transcript"];
const CODE_STAGE_TIMEOUT_MS = 120_000;

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The Assay HarnessAdapter shape (skills/Assay/Tools/Agentic.ts), restated so this file type-checks without it. */
type HarnessAdapter = {
  id: string;
  offline?: boolean;
  runCase(input: { prompt: string; workspace: string }): Promise<{ output: string; model: string; context: Record<string, string>; evidence: string }>;
};
type SuiteResult = {
  suite: string; passed: boolean; summary: string; verifier_unavailable: boolean; run_id: string; judge_level?: string;
  provisional?: boolean; provisional_reason?: string; judged_residue?: number;
  adversarial?: { cases: number; caught: number; missed: string[] };
  cases: { id: string; pass_to_k: number; mean_score: number; infra_errors: number }[];
  receipt?: string;
};
type AgenticModule = {
  runAgenticSuite(name: string, adapter: HarnessAdapter, requiredContext: string[], override: Record<string, unknown>): Promise<SuiteResult>;
};

/** Replays a recorded transcript: the prompt is its path, relative to the repo root and inside it. */
export const replayAdapter: HarnessAdapter = {
  id: "mtg-deck-tune:deck-tune-replay",
  offline: true,
  async runCase({ prompt }) {
    const path = resolve(ROOT, prompt.trim());
    if (relative(ROOT, path).startsWith("..") || !existsSync(path)) throw new Error(`replay: ${prompt} is not a transcript inside the repo`);
    const t = readTranscript(path);
    return {
      output: renderTranscript(t),
      model: t.header.playedBy, // a short id: receipts key evaluators by it; the replay itself is marked by `offline` and the adapter id

      context: { skill: sha256(SKILL_FILE), transcript: sha256(path) },
      evidence: `${relative(ROOT, path)} sha256:${sha256(path)}`,
    };
  },
};

function codeStage(): boolean {
  const run = Bun.spawnSync(["bun", "test", "./deck-tune-checks.test.ts"], { cwd: join(ROOT, "app"), stdout: "inherit", stderr: "inherit", timeout: CODE_STAGE_TIMEOUT_MS });
  return run.exitCode === 0;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { trials: { type: "string" }, json: { type: "boolean" } } });
  console.log("Code stage: bun test ./app/deck-tune-checks.test.ts");
  if (!codeStage()) {
    console.log("\nCode stage RED: the judge stage is not dispatched.");
    return 1;
  }
  if (!existsSync(ASSAY_AGENTIC)) {
    console.log(`\nJudge stage unavailable: Assay not found at ${ASSAY_AGENTIC}.`);
    return 2;
  }
  const suite = Bun.YAML.parse(readFileSync(SUITE_FILE, "utf8")) as Record<string, unknown> & { name?: unknown };
  if (typeof suite.name !== "string" || !Array.isArray(suite.cases)) throw new Error(`${SUITE_FILE} is not an Assay v2 suite (name and cases)`);
  if (values.trials !== undefined) {
    const n = Number(values.trials);
    if (!Number.isInteger(n) || n < 1) throw new Error("--trials must be a positive integer");
    suite.trials = n;
  }
  console.log(`\nJudge stage: Assay runAgenticSuite on ${relative(ROOT, SUITE_FILE)} (offline replay)`);
  const { runAgenticSuite } = (await import(ASSAY_AGENTIC)) as AgenticModule;
  const r = await runAgenticSuite(suite.name, replayAdapter, REQUIRED_CONTEXT, suite);
  if (values.json) console.log(JSON.stringify(r, null, 2));
  console.log(`\n${r.verifier_unavailable ? "NO VERDICT" : r.passed ? "PASSED" : "REGRESSED"}: ${r.suite}  ${r.summary}`);
  console.log(`  judge: ${r.judge_level ?? "?"}${r.provisional ? ` · PROVISIONAL (${r.provisional_reason ?? "uncalibrated"})` : ""} · judged residue ${Math.round((r.judged_residue ?? 0) * 100)}%`);
  if (r.adversarial) console.log(`  adversarial fixtures caught: ${r.adversarial.caught}/${r.adversarial.cases}${r.adversarial.missed.length ? ` (missed: ${r.adversarial.missed.join(", ")})` : ""}`);
  for (const c of r.cases) console.log(`  - ${c.id}: pass^k ${Math.round(c.pass_to_k * 100)}%  mean ${Math.round(c.mean_score * 100)}%${c.infra_errors ? `  (${c.infra_errors} trial(s) unavailable)` : ""}`);
  console.log(`  run: ${r.run_id}${r.receipt ? `  receipt: ${r.receipt}` : ""}`);
  return r.verifier_unavailable ? 2 : r.passed ? 0 : 1;
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
}
