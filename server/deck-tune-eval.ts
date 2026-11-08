// MV-17, DT-6.7: the deck-tune eval.
//
//   bun server/deck-tune-eval.ts                         the code stage: `bun test ./server/deck-tune-checks.test.ts`
//   bun server/deck-tune-eval.ts -t "ISC-NN"             only the tests whose name has that criterion in it
//   bun server/deck-tune-eval.ts -t "ISC-107" --session <session.jsonl> [--trials N] [--json]
//                                                        also the judge cases of that criterion, on that session
//
// The code stage is the eval: it passes or fails, and its exit code is the command's. The judge stage (ISC-84, 87, 107: what only
// a reader can settle) runs by hand on one real session, through the Assay suite evals/deck-tune.yaml and Assay's own
// runAgenticSuite (trials, pass^k, adversarial fixture, persisted run and receipt) with an offline replay adapter that returns the
// session rendered, so the judge grades the session as recorded. It only reports: a judge that fails, is provisional or is
// unavailable (Assay missing, no session given) never changes the exit code. `--session` also prints the six session checks on that
// session, which are the checks a real session is held to.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readTranscript, renderTranscript } from "./deck-tune-transcript";

const ROOT = new URL("../", import.meta.url).pathname;
const SUITE_FILE = join(ROOT, "evals", "deck-tune.yaml");
const SKILL_FILE = join(ROOT, "plugin", "skills", "deck-tune", "SKILL.md");
const ASSAY_AGENTIC = process.env.ASSAY_AGENTIC; // the judge stage's runner: the path to Assay's Agentic.ts
const REQUIRED_CONTEXT = ["skill", "transcript"];
const CODE_STAGE_TIMEOUT_MS = 600_000;

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

/** Replays a recorded transcript: the prompt is its path (absolute, or relative to the repo root). */
export const replayAdapter: HarnessAdapter = {
  id: "mtg-deck-tune:deck-tune-replay",
  offline: true,
  async runCase({ prompt }) {
    const path = resolve(ROOT, prompt.trim());
    if (!existsSync(path)) throw new Error(`replay: ${prompt} is not a transcript`);
    const t = readTranscript(path);
    return {
      output: renderTranscript(t),
      model: t.header.playedBy, // a short id: receipts key evaluators by it; the replay itself is marked by `offline` and the adapter id
      context: { skill: sha256(SKILL_FILE), transcript: sha256(path) },
      evidence: `${path} sha256:${sha256(path)}`,
    };
  },
};

function codeStage(pattern?: string): boolean {
  const args = ["bun", "test", "./server/deck-tune-checks.test.ts", ...(pattern ? ["-t", pattern] : [])];
  const run = Bun.spawnSync(args, { cwd: ROOT, stdout: "inherit", stderr: "inherit", timeout: CODE_STAGE_TIMEOUT_MS });
  return run.exitCode === 0;
}

/** Whether a suite case id belongs to a criterion pattern: "ISC-107" takes isc-107-..., and "ISC-10" does not. */
export function caseMatches(id: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/\./g, "-");
  return id === p || id.startsWith(`${p}-`);
}

/** The six session checks on one session, printed by criterion. */
async function gradeFile(file: string): Promise<void> {
  const { gradeSession, scannableNames } = await import("./deck-tune-checks");
  const { openStore } = await import("./deck-tools");
  const names = scannableNames(openStore().names.map((n) => n.name));
  console.log(`\nSession checks on ${file}`);
  for (const g of gradeSession(readTranscript(file), names)) {
    console.log(`  ${g.result.pass ? "PASS" : "FAIL"} ${g.id}  ${g.title}`);
    if (!g.result.pass) for (const d of g.result.details.slice(0, 4)) console.log(`        ${d}`);
  }
}

/** The judge stage on one session. Reports only. */
async function judgeStage(pattern: string, session: string | undefined, trials: string | undefined, json: boolean): Promise<void> {
  const suite = Bun.YAML.parse(readFileSync(SUITE_FILE, "utf8")) as Record<string, unknown> & { name?: unknown; cases?: { id: string; prompt: string }[] };
  if (typeof suite.name !== "string" || !Array.isArray(suite.cases)) throw new Error(`${SUITE_FILE} is not an Assay v2 suite (name and cases)`);
  const cases = suite.cases.filter((c) => caseMatches(c.id, pattern));
  if (cases.length === 0) return console.log(`\nNo judge case for ${pattern}: the code stage is all there is for it.`);
  if (!session) return console.log(`\nJudge stage not run: ${cases.map((c) => c.id).join(", ")} judge a real session; give one with --session <session.jsonl>.`);
  if (!ASSAY_AGENTIC || !existsSync(ASSAY_AGENTIC)) return console.log(`\nJudge stage unavailable: set ASSAY_AGENTIC to the path of Assay's Agentic.ts${ASSAY_AGENTIC ? ` (not found: ${ASSAY_AGENTIC})` : ""}.`);
  suite.cases = cases.map((c) => ({ ...c, prompt: resolve(session) }));
  if (trials !== undefined) {
    const n = Number(trials);
    if (!Number.isInteger(n) || n < 1) throw new Error("--trials must be a positive integer");
    suite.trials = n;
  }
  console.log(`\nJudge stage (advisory): Assay runAgenticSuite on ${relative(ROOT, SUITE_FILE)}, ${cases.map((c) => c.id).join(", ")}`);
  const { runAgenticSuite } = (await import(ASSAY_AGENTIC)) as AgenticModule;
  const r = await runAgenticSuite(suite.name, replayAdapter, REQUIRED_CONTEXT, suite);
  if (json) console.log(JSON.stringify(r, null, 2));
  console.log(`\n${r.verifier_unavailable ? "NO VERDICT" : r.passed ? "JUDGE PASSED" : "JUDGE FAILED"}: ${r.suite}  ${r.summary}`);
  console.log(`  judge: ${r.judge_level ?? "?"}${r.provisional ? ` · PROVISIONAL (${r.provisional_reason ?? "uncalibrated"})` : ""} · judged residue ${Math.round((r.judged_residue ?? 0) * 100)}%`);
  if (r.adversarial) console.log(`  adversarial fixtures caught: ${r.adversarial.caught}/${r.adversarial.cases}${r.adversarial.missed.length ? ` (missed: ${r.adversarial.missed.join(", ")})` : ""}`);
  for (const c of r.cases) console.log(`  - ${c.id}: pass^k ${Math.round(c.pass_to_k * 100)}%  mean ${Math.round(c.mean_score * 100)}%${c.infra_errors ? `  (${c.infra_errors} trial(s) unavailable)` : ""}`);
  console.log(`  run: ${r.run_id}${r.receipt ? `  receipt: ${r.receipt}` : ""}`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { trials: { type: "string" }, json: { type: "boolean" }, test: { type: "string", short: "t" }, session: { type: "string" } } });
  console.log(`Code stage: bun test ./server/deck-tune-checks.test.ts${values.test ? ` -t "${values.test}"` : ""}`);
  const green = codeStage(values.test);
  if (values.session) await gradeFile(resolve(values.session));
  if (values.test) {
    try {
      await judgeStage(values.test, values.session, values.trials, !!values.json);
    } catch (e) {
      console.log(`\nJudge stage unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n${green ? "CODE STAGE PASSED" : "CODE STAGE RED"}`);
  return green ? 0 : 1;
}

if (import.meta.main) {
  main().then((code) => process.exit(code), (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
