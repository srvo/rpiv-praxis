/**
 * rpiv-wf eval — run the same workflow (or step) across variants and compare.
 *
 *   rpiv-wf eval spec.json [--dry-run] [--out <dir>]
 *   rpiv-wf eval --continue <eval-results dir>      finish an interrupted eval
 *
 * A variant is a set of overrides: model, effort, tools, which settings and
 * CLAUDE.md memory load, permission mode, env, and a setup command run in the
 * trial's copy of the fixture (add or remove a CLAUDE.md, delete .rpiv/lessons).
 * Every trial runs `rpiv-wf` as its own process in a fresh copy of the fixture,
 * so trials cannot leak into each other. A trial that parks is answered from
 * `answers` (a scripted person) and resumed. After the run, `checks` (shell
 * commands, exit 0 = pass) grade the working tree.
 *
 * Built for long unattended runs: each trial is capped by `timeoutMinutes`
 * (graceful stop, then a hard kill) and optionally `maxCostUsd`; `budgetUsd`
 * caps the whole eval; results are appended as each trial finishes, and
 * `--continue` re-runs only the trials an interrupted eval did not record.
 *
 * `--continue` refuses when the code has changed since the eval started (it records
 * a fingerprint of the checkout); `--allow-drift` continues anyway and says so.
 *
 * Output: <out>/<name>-<stamp>/results.jsonl (one row per trial, written as
 * each finishes), summary.md (per-variant comparison), trials/<variant>__<n>/
 * (the working copy, rpiv-wf's log, metrics).
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ActivitySink, memorySink, trialActivity } from "./eval-activity.ts";
import { checkContinuable, codeFingerprint, recordedProvenance, writeProvenance } from "./eval-provenance.ts";
import { CLI_BIN, EXIT_STATE } from "./mcp.ts";
import { emptyTotals, mergeTotals, type UsageTotals } from "./usage.ts";

export interface Variant {
	name: string;
	model?: string;
	effort?: string;
	permissionMode?: string;
	tools?: string[] | "none";
	disallowedTools?: string[];
	settingSources?: string[] | "none";
	concurrency?: number;
	/** Shell command run in the trial's working copy before the run. */
	setup?: string;
	env?: Record<string, string>;
	/** Scripted answers for parked questions, used in order. */
	answers?: string[];
	/** Stop a trial once it has cost this much (rpiv-wf --max-cost). */
	maxCostUsd?: number;
}

export interface Check {
	name: string;
	run: string;
}

export interface EvalSpec {
	name: string;
	/** Directory copied fresh for every trial (relative to the spec file). */
	fixture: string;
	workflow?: string;
	step?: string;
	input?: string;
	repeats?: number;
	parallel?: number;
	timeoutMinutes?: number;
	defaults?: Omit<Variant, "name">;
	variants: Variant[];
	answers?: string[];
	checks?: Check[];
	/** Stop starting new trials once the eval has spent this much. */
	budgetUsd?: number;
}

export interface TrialResult {
	variant: string;
	repeat: number;
	state: string;
	exitCodes: number[];
	answered: number;
	stagesCompleted: number;
	wallMs: number;
	usage: UsageTotals;
	checks: Array<{ name: string; pass: boolean; output: string }>;
	dir: string;
	/** The rpiv-wf run alias this attempt measured under (traceable with `rpiv-wf runs`). */
	alias?: string;
	error?: string;
}

export interface ProcResult {
	code: number;
}

export interface EvalDeps {
	/** Run a command to completion, output appended to `log`. */
	run(
		cmd: string,
		args: string[],
		opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; timeoutMs: number },
	): Promise<ProcResult>;
	now(): number;
}

/** Validate a parsed spec; returns problems, empty when it is runnable. */
export function specProblems(spec: Partial<EvalSpec>): string[] {
	const p: string[] = [];
	if (!spec.name || !/^[A-Za-z0-9_-]+$/.test(spec.name)) p.push("name: letters, digits, - and _ only");
	if (!spec.fixture) p.push("fixture: required (a directory copied fresh for every trial)");
	if (!spec.workflow === !spec.step) p.push("exactly one of workflow or step");
	if (!Array.isArray(spec.variants) || spec.variants.length === 0) p.push("variants: at least one");
	const names = new Set<string>();
	for (const v of spec.variants ?? []) {
		if (!v.name || !/^[A-Za-z0-9_-]+$/.test(v.name))
			p.push(`variant name "${v.name}": letters, digits, - and _ only`);
		if (names.has(v.name)) p.push(`variant "${v.name}" is listed twice`);
		names.add(v.name);
	}
	for (const [k, n] of [
		["repeats", spec.repeats],
		["parallel", spec.parallel],
	] as const) {
		if (n !== undefined && (!Number.isInteger(n) || n < 1)) p.push(`${k}: a positive integer`);
	}
	for (const [k, n] of [
		["timeoutMinutes", spec.timeoutMinutes],
		["budgetUsd", spec.budgetUsd],
		...(spec.variants ?? []).map((v) => [`variant "${v.name}" maxCostUsd`, v.maxCostUsd] as const),
	] as const) {
		if (n !== undefined && !(typeof n === "number" && n > 0)) p.push(`${k}: a positive number`);
	}
	return p;
}

const list = (v: string[] | "none" | undefined) => (v === undefined ? undefined : v === "none" ? "none" : v.join(","));

/** rpiv-wf flags for a variant (defaults merged under it). */
export function variantFlags(v: Omit<Variant, "name">, cwd: string): string[] {
	const out = ["--cwd", cwd];
	const add = (flag: string, value: string | number | undefined) => {
		if (value !== undefined) out.push(flag, String(value));
	};
	add("--model", v.model);
	add("--effort", v.effort);
	add("--permission-mode", v.permissionMode);
	add("--tools", list(v.tools));
	add("--disallowed-tools", list(v.disallowedTools));
	add("--setting-sources", list(v.settingSources));
	add("--concurrency", v.concurrency);
	add("--max-cost", v.maxCostUsd);
	return out;
}

export interface Trial {
	variant: Variant & Omit<Variant, "name">;
	repeat: number;
	dir: string;
}

export function plan(spec: EvalSpec, outDir: string): Trial[] {
	const trials: Trial[] = [];
	for (let r = 1; r <= (spec.repeats ?? 1); r++) {
		for (const v of spec.variants) {
			trials.push({
				variant: { ...spec.defaults, ...v, env: { ...spec.defaults?.env, ...v.env } },
				repeat: r,
				dir: join(outDir, "trials", `${v.name}__${r}`),
			});
		}
	}
	return trials;
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}
function assertFixtureSymlinksStayWithinRoot(fixture: string): void {
	const root = realpathSync(fixture);
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				let target: string;
				try {
					target = realpathSync(path);
				} catch {
					throw new Error(`fixture symlink ${path} cannot be resolved`);
				}
				const fromRoot = relative(root, target);
				if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
					throw new Error(`fixture symlink ${path} resolves outside the fixture root`);
				}
			} else if (entry.isDirectory()) {
				visit(path);
			}
		}
	};
	visit(root);
}

/**
 * A fresh identity for one attempt at a trial.
 *
 * An eval is a measurement of the code as it was that day, and the workflows and
 * skills it runs change minute to minute. So an attempt never inherits an identity:
 * a stable name would let a later attempt (a `--continue`, or the same trial planned
 * from another eval directory) reuse an earlier attempt's shared alias and be refused.
 */
export function newTrialAttempt(now: number): string {
	return `${now.toString(36)}${randomBytes(3).toString("hex")}`;
}

/** Run alias for one attempt: `eval-<variant>-<repeat>-<attempt>`, capped at 64 characters. */
export function trialRunAlias(t: Trial, attempt: string): string {
	const base = `eval-${t.variant.name}-${t.repeat}`;
	const suffix = `-${attempt}`;
	return `${base.slice(0, 64 - suffix.length)}${suffix}`;
}

export async function runTrial(spec: EvalSpec, fixture: string, t: Trial, deps: EvalDeps): Promise<TrialResult> {
	const work = join(t.dir, "work");
	const log = join(t.dir, "rpiv-wf.log");
	const minutes = spec.timeoutMinutes ?? 30;
	// rpiv-wf stops itself at `minutes` (resumable, exit 124); the kill is the backstop.
	const timeoutMs = (minutes + 2) * 60_000;
	const result: TrialResult = {
		variant: t.variant.name,
		repeat: t.repeat,
		state: "error",
		exitCodes: [],
		answered: 0,
		stagesCompleted: 0,
		wallMs: 0,
		usage: emptyTotals(),
		checks: [],
		dir: t.dir,
	};
	const attempt = newTrialAttempt(deps.now());
	rmSync(t.dir, { recursive: true, force: true }); // a half-finished trial from an interrupted eval
	mkdirSync(t.dir, { recursive: true });
	cpSync(fixture, work, {
		recursive: true,
		dereference: false,
		verbatimSymlinks: true,
		filter: (src) => basename(src) !== "node_modules",
	});
	try {
		assertFixtureSymlinksStayWithinRoot(work);
	} catch (error) {
		rmSync(t.dir, { recursive: true, force: true });
		result.error = error instanceof Error ? error.message : String(error);
		return result;
	}
	// A trial names every run; keep those names local so the shared alias registry does not
	// grow one entry per attempt (the attempt alias is still recorded on the result).
	const env = { ...process.env, ...t.variant.env, RPIV_WF_KATA: "off", RPIV_NO_SHARED_ALIAS: "1" };
	const started = deps.now();
	if (t.variant.setup) {
		const s = await deps.run("sh", ["-c", t.variant.setup], { cwd: work, env, log, timeoutMs });
		if (s.code !== 0) {
			result.error = `setup exited ${s.code}`;
			return result;
		}
	}
	const flags = [...variantFlags(t.variant, work), "--timeout", String(minutes)];
	const answers = [...(t.variant.answers ?? spec.answers ?? [])];
	const name = trialRunAlias(t, attempt);
	result.alias = name;
	let args = spec.step
		? ["step", spec.step, ...(spec.input ? [spec.input] : []), "--name", name, ...flags]
		: ["run", spec.workflow!, ...(spec.input ? [spec.input] : []), "--name", name, ...flags];
	for (let invocation = 1; ; invocation++) {
		const metricsFile = join(t.dir, `metrics-${invocation}.json`);
		const r = await deps.run(process.execPath, [CLI_BIN, ...args], {
			cwd: work,
			env: { ...env, RPIV_WF_METRICS_FILE: metricsFile },
			log,
			timeoutMs,
		});
		result.exitCodes.push(r.code);
		const m = readJson<{ stagesCompleted?: number; usage?: UsageTotals; parked?: Array<{ n: number }> }>(metricsFile);
		if (m?.usage) mergeTotals(result.usage, m.usage);
		if (typeof m?.stagesCompleted === "number") result.stagesCompleted += m.stagesCompleted;
		const parkedN = m?.parked?.[0]?.n;
		if (r.code === 75 && parkedN !== undefined && answers.length > 0) {
			args = ["answer", name, String(parkedN), answers.shift()!, ...flags];
			result.answered++;
			continue;
		}
		result.state = EXIT_STATE[r.code] ?? `exited-${r.code}`;
		break;
	}
	result.wallMs = deps.now() - started;
	for (const c of spec.checks ?? []) {
		const checkLog = join(t.dir, `check-${c.name.replace(/[^A-Za-z0-9_-]/g, "-")}.log`);
		const r = await deps.run("sh", ["-c", c.run], { cwd: work, env, log: checkLog, timeoutMs: 10 * 60_000 });
		const output = existsSync(checkLog) ? readFileSync(checkLog, "utf8").trim().split("\n").slice(-5).join("\n") : "";
		result.checks.push({ name: c.name, pass: r.code === 0, output });
	}
	return result;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (part: number, n: number) => (n ? `${Math.round((100 * part) / n)}%` : "–");
/** Token counts at a glance: 1510 → 1.5k. */
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

/** Per-variant comparison table plus per-check pass rates. */
export function summarize(spec: EvalSpec, results: TrialResult[], totals?: { spent: number; skipped: number }): string {
	const lines = [
		`# eval: ${spec.name}`,
		"",
		`${spec.workflow ? `workflow \`${spec.workflow}\`` : `step \`${spec.step}\``} · ${results.length} trial(s)${totals ? ` · spent $${totals.spent.toFixed(4)}` : ""}${totals?.skipped ? ` · ${totals.skipped} not started (budget)` : ""}`,
		"",
		"| variant | trials | completed | checks passed | mean cost | mean wall | mean tokens in / cached / out | mean tool calls | answers used |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	];
	for (const v of spec.variants) {
		const rs = results.filter((r) => r.variant === v.name);
		const checksRun = rs.reduce((n, r) => n + r.checks.length, 0);
		const checksOk = rs.reduce((n, r) => n + r.checks.filter((c) => c.pass).length, 0);
		const tools = rs.map((r) => Object.values(r.usage.toolCalls).reduce((a, b) => a + b, 0));
		lines.push(
			`| ${v.name} | ${rs.length} | ${pct(rs.filter((r) => r.state === "completed").length, rs.length)} | ${pct(checksOk, checksRun)} | $${mean(rs.map((r) => r.usage.costUsd)).toFixed(4)} | ${(mean(rs.map((r) => r.wallMs)) / 1000).toFixed(1)}s | ${k(mean(rs.map((r) => r.usage.inputTokens)))} / ${k(mean(rs.map((r) => r.usage.cacheReadInputTokens + r.usage.cacheCreationInputTokens)))} / ${k(mean(rs.map((r) => r.usage.outputTokens)))} | ${mean(tools).toFixed(1)} | ${mean(rs.map((r) => r.answered)).toFixed(1)} |`,
		);
	}
	if ((spec.checks ?? []).length > 0) {
		lines.push("", "## Checks", "", `| check | ${spec.variants.map((v) => v.name).join(" | ")} |`);
		lines.push(`| --- | ${spec.variants.map(() => "---").join(" | ")} |`);
		for (const c of spec.checks!) {
			const cells = spec.variants.map((v) => {
				const rs = results.filter((r) => r.variant === v.name);
				return pct(rs.filter((r) => r.checks.find((x) => x.name === c.name)?.pass).length, rs.length);
			});
			lines.push(`| ${c.name} | ${cells.join(" | ")} |`);
		}
	}
	const failed = results.filter((r) => r.state !== "completed");
	if (failed.length) {
		lines.push("", "## Trials that did not complete", "");
		for (const r of failed)
			lines.push(`- ${r.variant} #${r.repeat}: ${r.state}${r.error ? ` (${r.error})` : ""} — ${r.dir}`);
	}
	lines.push("", "Small samples: a difference between variants is a lead to re-test with more repeats, not a result.");
	return `${lines.join("\n")}\n`;
}

/** Results already recorded in an eval directory, keyed `variant#repeat`. */
function recorded(outDir: string): Map<string, TrialResult> {
	const file = join(outDir, "results.jsonl");
	const done = new Map<string, TrialResult>();
	if (!existsSync(file)) return done;
	for (const line of readFileSync(file, "utf8").split("\n")) {
		try {
			const r = JSON.parse(line) as TrialResult;
			done.set(`${r.variant}#${r.repeat}`, r);
		} catch {
			// a line cut short by a crash: that trial runs again
		}
	}
	return done;
}

/** Drop a crash-truncated final JSONL record before any later append. */
function repairResultsTail(outDir: string): void {
	const file = join(outDir, "results.jsonl");
	if (!existsSync(file)) return;
	const contents = readFileSync(file, "utf8");
	if (!contents || contents.endsWith("\n")) return;
	const lastNewline = contents.lastIndexOf("\n");
	const tail = contents.slice(lastNewline + 1);
	try {
		JSON.parse(tail);
		writeFileSync(file, `${contents}\n`);
	} catch {
		writeFileSync(file, lastNewline < 0 ? "" : contents.slice(0, lastNewline + 1));
	}
}

export async function runEval(
	specFile: string | undefined,
	opts: {
		outDir?: string;
		dryRun?: boolean;
		continueDir?: string;
		/** Continue even though the code changed since the eval started (--allow-drift). */
		allowDrift?: boolean;
		/** The code under test's fingerprint; defaults to this checkout (injected by tests). */
		codeFingerprint?: () => string;
		/** Where functional-status items go; defaults to an in-memory sink printed at the end. */
		activity?: ActivitySink;
		out: (l: string) => void;
		deps?: EvalDeps;
		signal?: AbortSignal;
	},
): Promise<number> {
	// --continue reads the spec saved with the results, so a later edit to the
	// original spec cannot change what the finished half was measured against.
	const saved = opts.continueDir ? join(opts.continueDir, "spec.json") : undefined;
	const source = saved ?? specFile;
	const spec = source ? readJson<EvalSpec & { fixtureDir?: string }>(source) : undefined;
	const problems = spec ? specProblems(spec) : [`cannot read ${source ?? "a spec"} as JSON`];
	if (!spec || problems.length > 0) {
		for (const p of problems) opts.out(`spec: ${p}`);
		return 2;
	}
	const fixture = spec.fixtureDir ?? resolve(dirname(specFile!), spec.fixture);
	if (!existsSync(fixture)) {
		opts.out(`spec: fixture ${fixture} does not exist`);
		return 2;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir =
		opts.continueDir ?? resolve(opts.outDir ?? join(dirname(specFile!), "eval-results"), `${spec.name}-${stamp}`);
	const current = (opts.codeFingerprint ?? (() => codeFingerprint(dirname(CLI_BIN))))();
	if (opts.continueDir) {
		const gate = checkContinuable(outDir, current, opts.allowDrift === true);
		if (!gate.ok) {
			opts.out(`refusing to continue: ${gate.message}`);
			return 2;
		}
		if (gate.drift)
			opts.out(`warning: continuing on code that differs from the recorded run; results mix code versions`);
	}
	if (!opts.dryRun) repairResultsTail(outDir);
	const done = recorded(outDir);
	const trials = plan(spec, outDir);
	const todo = trials.filter((t) => !done.has(`${t.variant.name}#${t.repeat}`));
	opts.out(
		`${trials.length} trial(s): ${spec.variants.length} variant(s) × ${spec.repeats ?? 1} repeat(s)${done.size ? `; ${done.size} already recorded, ${todo.length} to run` : ""}`,
	);
	for (const t of todo)
		opts.out(`  ${t.variant.name} #${t.repeat}: rpiv-wf ${variantFlags(t.variant, "<copy>").join(" ")}`);
	if (opts.dryRun) return 0;
	const deps = opts.deps ?? nodeEvalDeps();
	mkdirSync(outDir, { recursive: true });
	opts.out(`results: ${outDir}`);
	if (!saved) {
		writeFileSync(join(outDir, "spec.json"), `${JSON.stringify({ ...spec, fixtureDir: fixture }, null, "\t")}\n`);
		writeProvenance(outDir, current);
	}
	const sink = opts.activity ?? memorySink();
	const results: TrialResult[] = [...done.values()];
	let spent = results.reduce((n, r) => n + r.usage.costUsd, 0);
	let next = 0;
	let skipped = 0;
	let interrupted = 0;
	const worker = async () => {
		while (next < todo.length && !opts.signal?.aborted) {
			if (spec.budgetUsd !== undefined && spent >= spec.budgetUsd) {
				skipped = todo.length - next;
				next = todo.length;
				break;
			}
			const t = todo[next++]!;
			const r = await runTrial(spec, fixture, t, deps);
			spent += r.usage.costUsd;
			// Ctrl-C stops the trial too; leave it unrecorded so --continue runs it again.
			if (opts.signal?.aborted && r.state === "interrupted") {
				interrupted++;
				continue;
			}
			results.push(r);
			appendFileSync(join(outDir, "results.jsonl"), `${JSON.stringify(r)}\n`);
			sink.emit(trialActivity(spec.name, current, r));
			opts.out(
				`  done ${r.variant} #${r.repeat}: ${r.state}, $${r.usage.costUsd.toFixed(4)}, ${(r.wallMs / 1000).toFixed(1)}s`,
			);
		}
	};
	// Trials this run did not execute still belong in the record: attribute each to the code
	// their eval recorded, so a --allow-drift run never claims old results ran on new code.
	const recordedCode = recordedProvenance(outDir);
	for (const r of done.values()) sink.emit(trialActivity(spec.name, recordedCode ?? current, r));
	await Promise.all(Array.from({ length: Math.min(spec.parallel ?? 1, Math.max(todo.length, 1)) }, worker));
	const left = todo.length - next + interrupted;
	if (opts.signal?.aborted && left > 0) {
		opts.out(`interrupted: ${left} trial(s) not recorded; finish with: rpiv-wf eval --continue ${outDir}`);
		return 130;
	}
	if (skipped > 0)
		opts.out(`budget $${spec.budgetUsd} reached ($${spent.toFixed(4)}): ${skipped} trial(s) not started`);
	results.sort((a, b) => a.variant.localeCompare(b.variant) || a.repeat - b.repeat);
	writeFileSync(join(outDir, "summary.md"), summarize(spec, results, { spent, skipped }));
	opts.out(`summary: ${join(outDir, "summary.md")}`);
	if (!opts.activity && "items" in sink) {
		const items = (sink as ReturnType<typeof memorySink>).items();
		const functional = items.filter((i) => i.payload.functional).length;
		opts.out(`functional: ${functional}/${items.length} trial(s) on code ${current.slice(0, 12)}`);
		for (const i of items) opts.out(`  ${i.title}`);
	}
	return skipped > 0 ? 3 : 0;
}

export function nodeEvalDeps(hardKillMs = 30_000): EvalDeps {
	return {
		now: () => Date.now(),
		run: (cmd, args, o) =>
			new Promise((done) => {
				const detached = process.platform !== "win32";
				const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached });
				const write = (b: Buffer) => appendFileSync(o.log, b);
				const signal = (name: NodeJS.Signals) => {
					if (!detached || child.pid === undefined) {
						child.kill(name);
						return;
					}
					try {
						process.kill(-child.pid, name);
					} catch {
						// The group may already have exited.
					}
				};
				child.stdout.on("data", write);
				child.stderr.on("data", write);
				// SIGINT lets rpiv-wf stop resumably; then hard-kill its Unix process group. Windows can only signal the direct child.
				let kill: NodeJS.Timeout | undefined;
				const timer = setTimeout(() => {
					signal("SIGINT");
					kill = setTimeout(() => signal("SIGKILL"), hardKillMs);
				}, o.timeoutMs);
				child.on("close", (code) => {
					clearTimeout(timer);
					clearTimeout(kill);
					done({ code: code ?? 1 });
				});
			}),
	};
}
