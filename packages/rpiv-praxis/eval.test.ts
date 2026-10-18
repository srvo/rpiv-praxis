import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionUsageOf, turnUsage } from "./claude-host.js";
import {
	type EvalDeps,
	type EvalSpec,
	nodeEvalDeps,
	plan,
	runEval,
	runTrial,
	specProblems,
	summarize,
	type TrialResult,
	variantFlags,
} from "./eval.js";
import { emptyTotals, listFlag, mergeTotals } from "./usage.js";

describe("per-turn usage from cumulative SDK results", () => {
	const result = (cost: number, out: number) => ({
		total_cost_usd: cost,
		num_turns: 1,
		duration_ms: 10,
		modelUsage: {
			opus: { inputTokens: out * 10, outputTokens: out, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
		},
	});

	it("reports only what a resumed turn added (the measured cumulative case)", () => {
		const first = turnUsage(result(0.021, 3), {});
		const second = turnUsage(result(0.051, 6), { Bash: 1 }, sessionUsageOf(result(0.021, 3)));
		expect(first.costUsd).toBeCloseTo(0.021);
		expect(second.costUsd).toBeCloseTo(0.03);
		expect(second.models.opus!.outputTokens).toBe(3);
		expect(second.toolCalls).toEqual({ Bash: 1 });
	});

	it("never goes negative and treats missing fields as zero", () => {
		expect(turnUsage(result(0.01, 1), {}, sessionUsageOf(result(0.05, 5))).costUsd).toBe(0);
		expect(turnUsage({}, {})).toMatchObject({ costUsd: 0, turns: 0, durationMs: 0, models: {} });
	});
});

describe("usage totals", () => {
	it("merges invocations and parses list flags", () => {
		const a = { ...emptyTotals(), costUsd: 1, inputTokens: 5, toolCalls: { Read: 2 }, models: ["opus"] };
		const b = {
			...emptyTotals(),
			costUsd: 0.5,
			inputTokens: 1,
			toolCalls: { Read: 1, Bash: 1 },
			models: ["opus", "haiku"],
		};
		mergeTotals(a, b);
		expect(a).toMatchObject({
			costUsd: 1.5,
			inputTokens: 6,
			toolCalls: { Read: 3, Bash: 1 },
			models: ["opus", "haiku"],
		});
		expect(listFlag(undefined)).toBeUndefined();
		expect(listFlag("none")).toEqual([]);
		expect(listFlag(" Read, Bash ,")).toEqual(["Read", "Bash"]);
	});
});

const spec: EvalSpec = {
	name: "demo",
	fixture: "fx",
	step: "create-handoff",
	input: "note",
	repeats: 2,
	defaults: { permissionMode: "bypassPermissions", setup: "git init -q", env: { A: "1" } },
	variants: [
		{ name: "with-memory", settingSources: ["project"] },
		{ name: "no-memory", settingSources: "none", tools: ["Read", "Write"], model: "haiku", effort: "low" },
	],
	answers: ["1"],
	checks: [{ name: "marker", run: "grep -q OK out.md" }],
};

describe("spec and plan", () => {
	it("accepts a valid spec and names every problem in a bad one", () => {
		expect(specProblems(spec)).toEqual([]);
		expect(
			specProblems({
				name: "bad name",
				variants: [{ name: "a" }, { name: "a" }],
				workflow: "x",
				step: "y",
				repeats: 0,
			}),
		).toEqual([
			"name: letters, digits, - and _ only",
			"fixture: required (a directory copied fresh for every trial)",
			"exactly one of workflow or step",
			'variant "a" is listed twice',
			"repeats: a positive integer",
		]);
	});

	it("expands variants × repeats with defaults merged under each variant", () => {
		const trials = plan(spec, "/out");
		expect(trials.map((t) => `${t.variant.name}#${t.repeat}`)).toEqual([
			"with-memory#1",
			"no-memory#1",
			"with-memory#2",
			"no-memory#2",
		]);
		expect(trials[1]!.variant).toMatchObject({
			permissionMode: "bypassPermissions",
			setup: "git init -q",
			env: { A: "1" },
		});
		expect(trials[1]!.dir).toBe(join("/out", "trials", "no-memory__1"));
	});

	it("turns a variant into rpiv-wf flags", () => {
		expect(variantFlags(plan(spec, "/o")[1]!.variant, "/w")).toEqual([
			"--cwd",
			"/w",
			"--model",
			"haiku",
			"--effort",
			"low",
			"--permission-mode",
			"bypassPermissions",
			"--tools",
			"Read,Write",
			"--setting-sources",
			"none",
		]);
	});
});

/** A fake rpiv-wf: parks once if asked, writes metrics, and lets checks read the working copy. */
function fakeDeps(script: { parkFirst?: boolean; setupCode?: number; writeMarker?: boolean } = {}) {
	const calls: Array<{ cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
	let clock = 0;
	const deps: EvalDeps = {
		now: () => (clock += 1000),
		async run(cmd, args, o) {
			calls.push({ cmd, args, cwd: o.cwd, env: o.env });
			if (cmd === "sh") {
				if (args[1] === "git init -q") return { code: script.setupCode ?? 0 };
				const ok = (() => {
					try {
						return readFileSync(join(o.cwd, "out.md"), "utf8").includes("OK");
					} catch {
						return false;
					}
				})();
				writeFileSync(o.log, ok ? "found\n" : "missing\n");
				return { code: ok ? 0 : 1 };
			}
			const kind = args[1];
			const metrics = o.env.RPIV_WF_METRICS_FILE!;
			const usage = {
				...emptyTotals(),
				costUsd: 0.25,
				inputTokens: 100,
				outputTokens: 10,
				stageTurns: 1,
				toolCalls: { Write: 1 },
			};
			if (kind !== "answer" && script.parkFirst) {
				writeFileSync(metrics, JSON.stringify({ stagesCompleted: 0, usage, parked: [{ n: 1 }] }));
				return { code: 75 };
			}
			if (script.writeMarker) writeFileSync(join(o.cwd, "out.md"), "OK\n");
			writeFileSync(metrics, JSON.stringify({ stagesCompleted: 1, usage, parked: [] }));
			return { code: 0 };
		},
	};
	return { deps, calls };
}

function fixture(): { root: string; specFile: string } {
	const root = mkdtempSync(join(tmpdir(), "rpiv-eval-"));
	mkdirSync(join(root, "fx", "node_modules"), { recursive: true });
	writeFileSync(join(root, "fx", "CLAUDE.md"), "memory\n");
	writeFileSync(join(root, "spec.json"), JSON.stringify(spec));
	return { root, specFile: join(root, "spec.json") };
}

describe("runTrial", () => {
	it("copies the fixture, runs setup, answers a park from the script, sums usage, and grades", async () => {
		const { root } = fixture();
		const { deps, calls } = fakeDeps({ parkFirst: true, writeMarker: true });
		const t = plan(spec, join(root, "out"))[0]!;
		const r = await runTrial(spec, join(root, "fx"), t, deps);
		expect(r).toMatchObject({ state: "completed", exitCodes: [75, 0], answered: 1, stagesCompleted: 1 });
		expect(r.usage.costUsd).toBeCloseTo(0.5);
		expect(r.checks).toEqual([{ name: "marker", pass: true, output: "found" }]);
		const runs = calls.filter((c) => c.cmd !== "sh");
		expect(runs[0]!.args.slice(1, 4)).toEqual(["step", "create-handoff", "note"]);
		expect(runs[1]!.args.slice(1, 5)).toEqual(["answer", "eval-with-memory-1", "1", "1"]);
		expect(runs[0]!.env.RPIV_WF_KATA).toBe("off");
		expect(runs[0]!.env.A).toBe("1");
		expect(readFileSync(join(t.dir, "work", "CLAUDE.md"), "utf8")).toBe("memory\n");
		expect(() => readFileSync(join(t.dir, "work", "node_modules"))).toThrow();
	});

	it("copies symlink targets so trial writes cannot change the fixture", async () => {
		const { root } = fixture();
		writeFileSync(join(root, "fx", "real.txt"), "original\n");
		symlinkSync("real.txt", join(root, "fx", "link.txt"));
		const deps: EvalDeps = {
			now: () => 0,
			async run(cmd, _args, o) {
				if (cmd !== "sh") writeFileSync(join(o.cwd, "link.txt"), "changed\n");
				return { code: 0 };
			},
		};
		const t = plan(spec, join(root, "out"))[0]!;
		await runTrial(spec, join(root, "fx"), t, deps);
		expect(readFileSync(join(root, "fx", "real.txt"), "utf8")).toBe("original\n");
		expect(readFileSync(join(t.dir, "work", "real.txt"), "utf8")).toBe("changed\n");
		expect(readFileSync(join(t.dir, "work", "link.txt"), "utf8")).toBe("changed\n");
	});
	it("refuses fixture symlinks that resolve outside the fixture root", async () => {
		const { root } = fixture();
		writeFileSync(join(root, "outside.txt"), "private\n");
		symlinkSync(join(root, "outside.txt"), join(root, "fx", "escape.txt"));
		const { deps, calls } = fakeDeps();
		const t = plan(spec, join(root, "out"))[0]!;

		const result = await runTrial(spec, join(root, "fx"), t, deps);

		expect(result).toMatchObject({ state: "error" });
		expect(result.error).toMatch(/symlink.*outside the fixture/);
		expect(calls).toHaveLength(0);
		expect(readFileSync(join(root, "outside.txt"), "utf8")).toBe("private\n");
	});

	it("stops parked when the scripted answers run out", async () => {
		const { root } = fixture();
		const r = await runTrial(
			{ ...spec, answers: [] },
			join(root, "fx"),
			plan(spec, join(root, "o"))[0]!,
			fakeDeps({ parkFirst: true }).deps,
		);
		expect(r.state).toBe("parked");
		expect(r.checks[0]!.pass).toBe(false);
	});

	it("records a failed setup without running the workflow", async () => {
		const { root } = fixture();
		const { deps, calls } = fakeDeps({ setupCode: 3 });
		const r = await runTrial(spec, join(root, "fx"), plan(spec, join(root, "o"))[0]!, deps);
		expect(r).toMatchObject({ state: "error", error: "setup exited 3" });
		expect(calls).toHaveLength(1);
	});
});

describe("runEval", () => {
	it("dry-run prints the matrix and spends nothing", async () => {
		const { specFile } = fixture();
		const out: string[] = [];
		const { deps, calls } = fakeDeps();
		expect(await runEval(specFile, { dryRun: true, out: (l) => out.push(l), deps })).toBe(0);
		expect(out[0]).toBe("4 trial(s): 2 variant(s) × 2 repeat(s)");
		expect(calls).toHaveLength(0);
	});

	it("runs every trial and writes results.jsonl and summary.md", async () => {
		const { root, specFile } = fixture();
		const out: string[] = [];
		const code = await runEval(specFile, {
			outDir: join(root, "res"),
			out: (l) => out.push(l),
			deps: fakeDeps({ writeMarker: true }).deps,
		});
		expect(code).toBe(0);
		const summaryPath = out.at(-1)!.replace("summary: ", "");
		const dir = summaryPath.replace(/summary\.md$/, "");
		expect(readFileSync(join(dir, "results.jsonl"), "utf8").trim().split("\n")).toHaveLength(4);
		expect(readFileSync(summaryPath, "utf8")).toContain("| with-memory | 2 | 100% | 100% | $0.2500 |");
	});

	it("rejects an unreadable spec or a missing fixture", async () => {
		const { root } = fixture();
		const out: string[] = [];
		expect(await runEval(join(root, "nope.json"), { out: (l) => out.push(l) })).toBe(2);
		writeFileSync(join(root, "s2.json"), JSON.stringify({ ...spec, fixture: "missing" }));
		expect(await runEval(join(root, "s2.json"), { out: (l) => out.push(l) })).toBe(2);
		expect(out.join("\n")).toContain("does not exist");
	});
});

describe("summarize", () => {
	it("compares variants, tabulates checks, and lists trials that did not complete", () => {
		const r = (variant: string, state: string, cost: number, pass: boolean): TrialResult => ({
			variant,
			repeat: 1,
			state,
			exitCodes: [0],
			answered: 0,
			stagesCompleted: 1,
			wallMs: 2000,
			usage: { ...emptyTotals(), costUsd: cost, toolCalls: { Read: 2 } },
			checks: [{ name: "marker", pass, output: "" }],
			dir: `/t/${variant}`,
		});
		const md = summarize(spec, [r("with-memory", "completed", 0.1, true), r("no-memory", "failed", 0.3, false)]);
		expect(md).toContain("| with-memory | 1 | 100% | 100% | $0.1000 | 2.0s | 0 / 0 / 0 | 2.0 | 0.0 |");
		expect(md).toContain("| no-memory | 1 | 0% | 0% | $0.3000 |");
		expect(md).toContain("| marker | 100% | 0% |");
		expect(md).toContain("- no-memory #1: failed — /t/no-memory");
		expect(md).toContain("not a result");
	});
});

describe("long unattended evals", () => {
	it("passes the trial's time and cost caps to rpiv-wf", () => {
		expect(variantFlags({ maxCostUsd: 2 }, "/w")).toEqual(["--cwd", "/w", "--max-cost", "2"]);
		expect(specProblems({ ...spec, budgetUsd: 0, timeoutMinutes: -1 })).toEqual([
			"timeoutMinutes: a positive number",
			"budgetUsd: a positive number",
		]);
	});

	it("stops starting trials once the eval budget is spent (exit 3)", async () => {
		const { root, specFile } = fixture();
		writeFileSync(specFile, JSON.stringify({ ...spec, budgetUsd: 0.4 }));
		const out: string[] = [];
		const code = await runEval(specFile, {
			outDir: join(root, "res"),
			out: (l) => out.push(l),
			deps: fakeDeps().deps,
		});
		expect(code).toBe(3);
		expect(out.filter((l) => l.startsWith("  done"))).toHaveLength(2);
		expect(out.join("\n")).toContain("budget $0.4 reached ($0.5000): 2 trial(s) not started");
	});

	it("Ctrl-C stops starting trials and leaves the interrupted one for --continue (exit 130)", async () => {
		const { root, specFile } = fixture();
		const controller = new AbortController();
		const { deps } = fakeDeps();
		let wf = 0;
		const interrupting: EvalDeps = {
			...deps,
			async run(cmd, args, o) {
				if (cmd === "sh" || ++wf < 2) return deps.run(cmd, args, o);
				controller.abort();
				return { code: 130 };
			},
		};
		const out: string[] = [];
		const code = await runEval(specFile, {
			outDir: join(root, "res"),
			out: (l) => out.push(l),
			deps: interrupting,
			signal: controller.signal,
		});
		expect(code).toBe(130);
		expect(wf).toBe(2);
		const dir = out.find((l) => l.startsWith("results: "))!.replace("results: ", "");
		expect(readFileSync(join(dir, "results.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
		expect(out.at(-1)).toBe(`interrupted: 3 trial(s) not recorded; finish with: rpiv-wf eval --continue ${dir}`);
	});

	it("--continue runs only unrecorded trials, against the spec saved with the results", async () => {
		const { root, specFile } = fixture();
		const first: string[] = [];
		await runEval(specFile, { outDir: join(root, "res"), out: (l) => first.push(l), deps: fakeDeps().deps });
		const dir = first
			.at(-1)!
			.replace("summary: ", "")
			.replace(/summary\.md$/, "");
		// Simulate a crash: keep one finished trial plus a line cut short mid-write.
		const lines = readFileSync(join(dir, "results.jsonl"), "utf8").trim().split("\n");
		writeFileSync(join(dir, "results.jsonl"), `${lines[0]}\n${lines[1]!.slice(0, 20)}`);
		writeFileSync(specFile, "{ not even json"); // edits to the original no longer matter
		const { deps, calls } = fakeDeps();
		const out: string[] = [];
		expect(await runEval(undefined, { continueDir: dir, out: (l) => out.push(l), deps })).toBe(0);
		expect(out[0]).toBe("4 trial(s): 2 variant(s) × 2 repeat(s); 1 already recorded, 3 to run");
		expect(calls.filter((c) => c.cmd !== "sh")).toHaveLength(3);
		expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("4 trial(s)");
		const second = fakeDeps();
		const secondOut: string[] = [];
		expect(await runEval(undefined, { continueDir: dir, out: (l) => secondOut.push(l), deps: second.deps })).toBe(0);
		expect(second.calls.filter((c) => c.cmd !== "sh")).toHaveLength(0);
		expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("spent $1.0000");
	});
	it.skipIf(process.platform === "win32")(
		"hard-kills timed-out descendants and closes their output pipes",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "rpiv-eval-process-"));
			const marker = join(root, "survived");
			const child = `process.on("SIGINT",()=>{}); setTimeout(()=>require("node:fs").writeFileSync(${JSON.stringify(marker)},"survived"),250); setInterval(()=>{},1000);`;
			const parent = `process.on("SIGINT",()=>{}); const {spawn}=require("node:child_process"); spawn(process.execPath,["-e",${JSON.stringify(child)}],{stdio:"inherit"}); setInterval(()=>{},1000);`;
			const started = Date.now();
			await nodeEvalDeps(20).run(process.execPath, ["-e", parent], {
				cwd: root,
				env: process.env,
				log: join(root, "log"),
				timeoutMs: 20,
			});
			expect(Date.now() - started).toBeLessThan(200);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(existsSync(marker)).toBe(false);
		},
	);
});
