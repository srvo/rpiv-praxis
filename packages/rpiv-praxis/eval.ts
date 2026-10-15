/**
 * rpiv-wf eval — run the same workflow (or step) across variants and compare.
 *
 *   rpiv-wf eval spec.json [--dry-run] [--out <dir>]
 *
 * A variant is a set of overrides: model, effort, tools, which settings and
 * CLAUDE.md memory load, permission mode, env, and a setup command run in the
 * trial's copy of the fixture (add or remove a CLAUDE.md, delete .rpiv/lessons).
 * Every trial runs `rpiv-wf` as its own process in a fresh copy of the fixture,
 * so trials cannot leak into each other. A trial that parks is answered from
 * `answers` (a scripted person) and resumed. After the run, `checks` (shell
 * commands, exit 0 = pass) grade the working tree.
 *
 * Output: <out>/<name>-<stamp>/results.jsonl (one row per trial, written as
 * each finishes), summary.md (per-variant comparison), trials/<variant>__<n>/
 * (the working copy, rpiv-wf's log, metrics).
 */

import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CLI_BIN, EXIT_STATE } from "./mcp.js";
import { emptyTotals, mergeTotals, type UsageTotals } from "./usage.js";

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

export async function runTrial(spec: EvalSpec, fixture: string, t: Trial, deps: EvalDeps): Promise<TrialResult> {
	const work = join(t.dir, "work");
	const log = join(t.dir, "rpiv-wf.log");
	const timeoutMs = (spec.timeoutMinutes ?? 30) * 60_000;
	mkdirSync(t.dir, { recursive: true });
	cpSync(fixture, work, { recursive: true, filter: (src) => basename(src) !== "node_modules" });
	const env = { ...process.env, ...t.variant.env, RPIV_WF_KATA: "off" };
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
	const started = deps.now();
	if (t.variant.setup) {
		const s = await deps.run("sh", ["-c", t.variant.setup], { cwd: work, env, log, timeoutMs });
		if (s.code !== 0) {
			result.error = `setup exited ${s.code}`;
			return result;
		}
	}
	const flags = variantFlags(t.variant, work);
	const answers = [...(t.variant.answers ?? spec.answers ?? [])];
	const name = `eval-${t.variant.name}-${t.repeat}`.slice(0, 64);
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
export function summarize(spec: EvalSpec, results: TrialResult[]): string {
	const lines = [
		`# eval: ${spec.name}`,
		"",
		`${spec.workflow ? `workflow \`${spec.workflow}\`` : `step \`${spec.step}\``} · ${results.length} trial(s)`,
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

export async function runEval(
	specFile: string,
	opts: { outDir?: string; dryRun?: boolean; out: (l: string) => void; deps?: EvalDeps },
): Promise<number> {
	const spec = readJson<EvalSpec>(specFile);
	const problems = spec ? specProblems(spec) : [`cannot read ${specFile} as JSON`];
	if (!spec || problems.length > 0) {
		for (const p of problems) opts.out(`spec: ${p}`);
		return 2;
	}
	const fixture = resolve(dirname(specFile), spec.fixture);
	if (!existsSync(fixture)) {
		opts.out(`spec: fixture ${fixture} does not exist`);
		return 2;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outDir = resolve(opts.outDir ?? join(dirname(specFile), "eval-results"), `${spec.name}-${stamp}`);
	const trials = plan(spec, outDir);
	opts.out(`${trials.length} trial(s): ${spec.variants.length} variant(s) × ${spec.repeats ?? 1} repeat(s)`);
	for (const t of trials)
		opts.out(`  ${t.variant.name} #${t.repeat}: rpiv-wf ${variantFlags(t.variant, "<copy>").join(" ")}`);
	if (opts.dryRun) return 0;
	const deps = opts.deps ?? nodeEvalDeps();
	mkdirSync(outDir, { recursive: true });
	const results: TrialResult[] = [];
	let next = 0;
	const worker = async () => {
		while (next < trials.length) {
			const t = trials[next++]!;
			const r = await runTrial(spec, fixture, t, deps);
			results.push(r);
			appendFileSync(join(outDir, "results.jsonl"), `${JSON.stringify(r)}\n`);
			opts.out(
				`  done ${r.variant} #${r.repeat}: ${r.state}, $${r.usage.costUsd.toFixed(4)}, ${(r.wallMs / 1000).toFixed(1)}s`,
			);
		}
	};
	await Promise.all(Array.from({ length: Math.min(spec.parallel ?? 1, trials.length) }, worker));
	results.sort((a, b) => a.variant.localeCompare(b.variant) || a.repeat - b.repeat);
	writeFileSync(join(outDir, "summary.md"), summarize(spec, results));
	opts.out(`summary: ${join(outDir, "summary.md")}`);
	return 0;
}

export function nodeEvalDeps(): EvalDeps {
	return {
		now: () => Date.now(),
		run: (cmd, args, o) =>
			new Promise((done) => {
				const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"] });
				const write = (b: Buffer) => appendFileSync(o.log, b);
				child.stdout.on("data", write);
				child.stderr.on("data", write);
				const timer = setTimeout(() => child.kill("SIGINT"), o.timeoutMs);
				child.on("close", (code) => {
					clearTimeout(timer);
					done({ code: code ?? 1 });
				});
			}),
	};
}
