import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunWorkflowResult } from "@juicesharp/rpiv-workflow";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeHostDeps } from "./claude-host.ts";
import { EXIT, main, type WorkflowApi } from "./cli.ts";
import type { Kata } from "./kata.ts";
import { addPark, readParks, runsDir, updatePark } from "./park-store.ts";
import type { ProgressReport } from "./progress.ts";

import { registerRunAlias, resolveRunAlias } from "./run-alias.ts";

function plugin(): string {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-cli-plugin-"));
	mkdirSync(join(dir, "skills", "commit"), { recursive: true });
	writeFileSync(join(dir, "skills", "commit", "SKILL.md"), "---\nname: commit\n---\n");
	return dir;
}

function repoWithWorktree(): { root: string; first: string; second: string } {
	const root = mkdtempSync(join(tmpdir(), "rpiv-cli-worktrees-"));
	const first = join(root, "first");
	const second = join(root, "second");
	mkdirSync(first);
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	git(first, "init", "-q");
	git(first, "config", "user.email", "rpiv-test@example.invalid");
	git(first, "config", "user.name", "RPIV Test");
	writeFileSync(join(first, "README.md"), "fixture\n");
	git(first, "add", "README.md");
	git(first, "commit", "-qm", "fixture");
	git(first, "worktree", "add", "-qb", "second", second);
	return { root, first, second };
}

function harness(result: RunWorkflowResult = { success: true, stagesCompleted: 2, runId: "r1" }) {
	const out: string[] = [];
	const err: string[] = [];
	const api: WorkflowApi = {
		loadWorkflows: vi.fn(async () => ({
			workflows: [{ name: "build", description: "the big one" }, { name: "mine" }],
		})),
		runWorkflowByName: vi.fn(async () => result),
		resumeWorkflowByRunId: vi.fn(async () => result),
	};
	const deps = { query: vi.fn(), forkSession: vi.fn() } as unknown as ClaudeHostDeps;
	const go = (args: string[], signal?: AbortSignal) =>
		main(args, { out: (l) => out.push(l), err: (l) => err.push(l) }, { api, deps, signal, kata: null });
	return { go, api, out, err };
}

describe("rpiv-wf", () => {
	it("prints usage to stdout and exits 0 for --help, -h and help", async () => {
		for (const args of [["--help"], ["-h"], ["help"], ["run", "--help"]]) {
			const h = harness();
			expect(await h.go(args)).toBe(EXIT.ok);
			expect(h.out.join("\n")).toMatch(/--max-cost/);
			expect(h.err).toEqual([]);
		}
	});

	it("lists workflows", async () => {
		const h = harness();
		expect(await h.go(["list"])).toBe(EXIT.ok);
		expect(h.out).toEqual(["build\tthe big one", "mine"]);
	});

	it("reports load issues on list and fails when any is an error", async () => {
		const h = harness();
		vi.mocked(h.api.loadWorkflows).mockResolvedValueOnce({
			workflows: [{ name: "build" }],
			issues: [
				{ severity: "warning", message: "w" },
				{ severity: "error", message: "pack broken" },
			],
		});
		expect(await h.go(["list"])).toBe(EXIT.failed);
		expect(h.err).toEqual(["[warning] w", "[error] pack broken"]);
	});

	it("prints project-wide authoring progress in Markdown and JSON without loading workflows", async () => {
		const h = harness();
		const report: ProgressReport = {
			root: "/repo",
			worktrees: ["/repo", "/repo-wt"],
			topics: [],
			kata: { available: true, issueCount: 3 },
			overlapCandidates: [],
			unlinkedIssues: [],
			warnings: [],
		};
		const progressReport = vi.fn(() => report);
		expect(
			await main(
				["progress"],
				{ out: (line) => h.out.push(line), err: (line) => h.err.push(line) },
				{ progressReport },
			),
		).toBe(EXIT.ok);
		expect(h.out[0]).toContain("## RPIV authoring progress");
		expect(progressReport).toHaveBeenCalledOnce();
		expect(h.api.loadWorkflows).not.toHaveBeenCalled();
		h.out.length = 0;
		expect(
			await main(
				["progress", "--json"],
				{ out: (line) => h.out.push(line), err: (line) => h.err.push(line) },
				{ progressReport },
			),
		).toBe(EXIT.ok);
		expect(JSON.parse(h.out[0]!)).toEqual(report);
	});

	it("returns failure for an incomplete Kata snapshot while still printing the partial report", async () => {
		const h = harness();
		const progressReport = () => ({
			root: "/repo",
			worktrees: ["/repo"],
			topics: [],
			kata: { available: false, issueCount: 0, unavailableReason: "daemon unavailable" },
			overlapCandidates: [],
			unlinkedIssues: [],
			warnings: ["Kata unavailable: daemon unavailable"],
		});
		expect(
			await main(
				["progress"],
				{ out: (line) => h.out.push(line), err: (line) => h.err.push(line) },
				{ progressReport },
			),
		).toBe(EXIT.failed);
		expect(h.out.join("\n")).toContain("Kata unavailable");
	});
	it("runs a workflow with the joined input, a registry host and the requested name", async () => {
		const h = harness({ success: true, stagesCompleted: 3, runId: "r9", lastArtifact: "plan.md" });
		const code = await h.go(["run", "build", "add", "dark", "mode", "--name", "dm", "--plugin-dir", plugin()]);
		expect(code).toBe(EXIT.ok);
		const [ctx, name, input, opts] = vi.mocked(h.api.runWorkflowByName).mock.calls[0]!;
		expect([name, input]).toEqual(["build", "add dark mode"]);
		expect(ctx.maxConcurrency).toBe(4);
		expect(opts).toMatchObject({ name: "dm", trigger: { kind: "programmatic", source: "rpiv-praxis" } });
		expect((opts as { host: { getCommands(): unknown[] } }).host.getCommands()).toEqual([
			{ name: "skill:commit", source: "skill" },
		]);
		expect(h.out).toEqual(["completed (run r9): 3 stage(s)", "artifact: plan.md"]);
	});
	it("auto-names RPIV runs from the workflow and brief", async () => {
		const h = harness({ success: true, stagesCompleted: 1, runId: "r10" });
		const { root, first, second } = repoWithWorktree();
		mkdirSync(join(first, ".rpiv", "workflows", "runs"), { recursive: true });
		writeFileSync(join(first, ".rpiv", "workflows", "runs", "r10.jsonl"), "{}\n");
		vi.mocked(h.api.runWorkflowByName).mockImplementation(async (_ctx, _name, _input, opts) => {
			const onWorkflowStart = (opts as { lifecycle: { onWorkflowStart: (ctx: never) => unknown } }).lifecycle
				.onWorkflowStart;
			await onWorkflowStart({
				cwd: first,
				runId: "r10",
				workflow: "build",
				totalStages: 1,
				trigger: { kind: "programmatic", source: "rpiv-praxis" },
				state: {},
			} as never);
			return { success: true, stagesCompleted: 1, runId: "r10" };
		});
		const code = await h.go(["run", "build", "Add dark mode", "--cwd", first, "--plugin-dir", plugin()]);
		expect(code).toBe(EXIT.ok);
		const opts = vi.mocked(h.api.runWorkflowByName).mock.calls[0]![3] as { name: string };
		expect(opts.name).toMatch(/^rpiv-build-add-dark-mode-[0-9]{8}-[0-9]{6}-[a-f0-9]{4}$/);
		expect(h.out).toContain(`run alias: ${opts.name}`);
		const runs = harness();
		expect(await runs.go(["runs", "--cwd", second])).toBe(EXIT.ok);
		expect(runs.out[0]).toContain(`${opts.name}\tbuild\tr10`);
		rmSync(root, { recursive: true, force: true });
	});
	it("publishes the alias at durable workflow start before an interrupted run returns", async () => {
		const { root, first, second } = repoWithWorktree();
		mkdirSync(join(first, ".rpiv", "workflows", "runs"), { recursive: true });
		writeFileSync(join(first, ".rpiv", "workflows", "runs", "r11.jsonl"), "{}\n");
		const h = harness();
		let alias = "";
		vi.mocked(h.api.runWorkflowByName).mockImplementation(async (_ctx, _name, _input, opts) => {
			alias = (opts as { name: string }).name;
			const onWorkflowStart = (opts as { lifecycle: { onWorkflowStart: (ctx: never) => unknown } }).lifecycle
				.onWorkflowStart;
			await onWorkflowStart({
				cwd: first,
				runId: "r11",
				workflow: "build",
				totalStages: 1,
				trigger: { kind: "programmatic", source: "rpiv-praxis" },
				state: {},
			} as never);
			throw new Error("simulated abrupt failure after durable start");
		});
		await expect(h.go(["run", "build", "finish the run", "--cwd", first, "--plugin-dir", plugin()])).rejects.toThrow(
			"simulated abrupt failure",
		);
		expect(resolveRunAlias(second, alias)).toMatchObject({ runId: "r11", cwd: realpathSync(first) });
		rmSync(root, { recursive: true, force: true });
	});

	it("--model reaches the engine as every stage's default model (kata rb2w)", async () => {
		const h = harness();
		expect(await h.go(["run", "build", "x", "--model", "sonnet", "--plugin-dir", plugin()])).toBe(EXIT.ok);
		const opts = vi.mocked(h.api.runWorkflowByName).mock.calls[0]![3] as {
			resolveModel?: (id: { workflow: string; stage: string; skill: string }) => unknown;
		};
		expect(opts.resolveModel?.({ workflow: "build", stage: "plan", skill: "plan" })).toEqual({ model: "sonnet" });
		const bare = harness();
		await bare.go(["run", "build", "x", "--plugin-dir", plugin()]);
		expect(vi.mocked(bare.api.runWorkflowByName).mock.calls[0]![3]).not.toHaveProperty("resolveModel");
	});

	it("resumes by reference", async () => {
		const h = harness();
		expect(await h.go(["resume", "dm", "--plugin-dir", plugin(), "--concurrency", "2"])).toBe(EXIT.ok);
		const [ctx, ref] = vi.mocked(h.api.resumeWorkflowByRunId).mock.calls[0]!;
		expect(ref).toBe("dm");
		expect(ctx.maxConcurrency).toBe(2);
	});
	it("resolves a named run from another worktree and resumes in its origin", async () => {
		const { root, first, second } = repoWithWorktree();
		mkdirSync(join(first, ".rpiv", "workflows", "runs"), { recursive: true });
		writeFileSync(
			join(first, ".rpiv", "workflows", "runs", "run-1.jsonl"),
			`${JSON.stringify({ runId: "run-1", workflow: "build", input: "topic", ts: "2026-10-18" })}\n`,
		);
		expect(registerRunAlias(first, "rpiv-build-topic-20261018-123456", "run-1", "build")).toBe(true);
		const h = harness();
		expect(
			await h.go(["resume", "rpiv-build-topic-20261018-123456", "--cwd", second, "--plugin-dir", plugin()]),
		).toBe(EXIT.ok);
		const [ctx, ref] = vi.mocked(h.api.resumeWorkflowByRunId).mock.calls[0]!;
		expect(ctx.cwd).toBe(realpathSync(first));
		expect(ref).toBe("run-1");
		const runs = harness();
		expect(await runs.go(["runs", "--cwd", second])).toBe(EXIT.ok);
		expect(runs.out[0]).toContain("rpiv-build-topic-20261018-123456\tbuild\trun-1");
		rmSync(root, { recursive: true, force: true });
	});
	it("reports a stale cross-worktree alias instead of silently starting a new run", async () => {
		const { root, first, second } = repoWithWorktree();
		const runFile = join(first, ".rpiv", "workflows", "runs", "run-1.jsonl");
		mkdirSync(join(first, ".rpiv", "workflows", "runs"), { recursive: true });
		writeFileSync(runFile, "{}\n");
		expect(registerRunAlias(first, "stale", "run-1", "build")).toBe(true);
		rmSync(runFile);
		const h = harness();
		expect(await h.go(["resume", "stale", "--cwd", second])).toBe(EXIT.usage);
		expect(h.api.resumeWorkflowByRunId).not.toHaveBeenCalled();
		expect(h.err.join(" ")).toContain("stale or unreadable");
		rmSync(root, { recursive: true, force: true });
	});

	it("exits 1 with the runner's error on failure", async () => {
		const h = harness({ success: false, stagesCompleted: 1, runId: "r2", error: "gate failed" });
		expect(await h.go(["run", "build", "--plugin-dir", plugin()])).toBe(EXIT.failed);
		expect(h.err.at(-1)).toBe("failed (run r2) after 1 stage(s): gate failed");
	});

	it("exits 130 when interrupted", async () => {
		const ac = new AbortController();
		ac.abort();
		const h = harness({ success: false, stagesCompleted: 0 });
		expect(await h.go(["run", "build", "--plugin-dir", plugin()], ac.signal)).toBe(EXIT.interrupted);
	});

	it.each([
		[[]],
		[["run"]],
		[["resume"]],
		[["deploy", "x"]],
		[["run", "x", "--concurrency", "0"]],
		[["run", "x", "--permission-mode", "yolo"]],
		[["run", "x", "--bogus"]],
	])("rejects %j with a usage error", async (args) => {
		const h = harness();
		expect(await h.go(args)).toBe(EXIT.usage);
		expect(h.api.runWorkflowByName).not.toHaveBeenCalled();
	});

	it("refuses a plugin directory with no skills", async () => {
		const h = harness();
		const empty = mkdtempSync(join(tmpdir(), "rpiv-cli-empty-"));
		expect(await h.go(["run", "build", "--plugin-dir", empty])).toBe(EXIT.usage);
		expect(h.err.join()).toContain("export:hosts");
	});

	it("lists rpiv's built-ins through the real registration, without injection", async () => {
		const out: string[] = [];
		const cwd = mkdtempSync(join(tmpdir(), "rpiv-cli-real-"));
		expect(await main(["list", "--cwd", cwd], { out: (l) => out.push(l), err: () => {} })).toBe(EXIT.ok);
		expect(out.map((l) => l.split("\t")[0])).toEqual(expect.arrayContaining(["build", "ship", "vet", "polish"]));
	});

	it("builds the host on the real Claude Agent SDK when none is injected", async () => {
		const result = { success: true, stagesCompleted: 0 };
		const api = { ...harness().api, runWorkflowByName: vi.fn(async () => result) };
		const code = await main(["run", "x", "--plugin-dir", plugin()], { out: () => {}, err: () => {} }, { api });
		expect(code).toBe(EXIT.ok);
		expect(api.runWorkflowByName).toHaveBeenCalledOnce();
	});
});

describe("rpiv-wf parked questions", () => {
	const ask = { question: "Red or blue?", options: [{ label: "Red" }, { label: "Blue" }] };
	const project = () => {
		const cwd = mkdtempSync(join(tmpdir(), "rpiv-cli-park-"));
		mkdirSync(runsDir(cwd), { recursive: true });
		writeFileSync(join(runsDir(cwd), "r1.jsonl"), "{}\n");
		writeFileSync(join(runsDir(cwd), "names.json"), JSON.stringify({ shed: "r1" }));
		return cwd;
	};
	const park = (cwd: string) =>
		addPark(cwd, {
			runId: "r1",
			workflow: "wf",
			stage: "pick",
			prompt: "/skill:pick",
			sessionId: "s1",
			questions: [ask],
		});
	const io = () => {
		const out: string[] = [];
		const err: string[] = [];
		return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
	};

	it("inbox lists what is waiting, or says nothing is", async () => {
		const cwd = project();
		const a = io();
		expect(await main(["inbox", "--cwd", cwd], a.io)).toBe(EXIT.ok);
		expect(a.out).toEqual(["nothing waiting"]);
		park(cwd);
		const b = io();
		await main(["inbox", "--cwd", cwd], b.io);
		expect(b.out.join("\n")).toContain("Red or blue?");
	});

	it("inbox and answer reach a run parked in a sibling worktree", async () => {
		const { root, first, second } = repoWithWorktree();
		mkdirSync(runsDir(second), { recursive: true });
		writeFileSync(join(runsDir(second), "r1.jsonl"), "{}\n");
		park(second);
		const a = io();
		expect(await main(["inbox", "--cwd", first], a.io)).toBe(EXIT.ok);
		expect(a.out.join("\n")).toContain("Red or blue?");
		expect(a.out.join("\n")).toContain(`worktree: ${realpathSync(second)}`);
		const h = harness();
		const b = io();
		const code = await main(["answer", "r1", "1", "Red", "--cwd", first, "--plugin-dir", plugin()], b.io, {
			api: h.api,
			deps: { query: vi.fn(), forkSession: vi.fn() } as never,
			kata: null,
		});
		expect(code).toBe(EXIT.ok);
		expect(b.err.join("\n")).toContain(`found RPIV run r1 in worktree ${realpathSync(second)}`);
		expect(readParks(second, "r1")[0]).toMatchObject({ status: "answered", answer: "Red" });
		const [ctx, ref] = vi.mocked(h.api.resumeWorkflowByRunId).mock.calls[0]!;
		expect(ref).toBe("r1");
		expect(ctx.cwd).toBe(realpathSync(second));
		rmSync(root, { recursive: true, force: true });
	});

	it("answer refuses a run id found in more than one worktree", async () => {
		const { root, first, second } = repoWithWorktree();
		const third = join(root, "third");
		execFileSync("git", ["worktree", "add", "-qb", "third", third], { cwd: first, stdio: "ignore" });
		for (const wt of [second, third]) {
			mkdirSync(runsDir(wt), { recursive: true });
			writeFileSync(join(runsDir(wt), "r1.jsonl"), "{}\n");
		}
		const h = harness();
		const a = io();
		expect(await main(["answer", "r1", "1", "Red", "--cwd", first], a.io, { api: h.api, kata: null })).toBe(
			EXIT.usage,
		);
		expect(a.err.join(" ")).toContain("more than one worktree");
		expect(a.err.join(" ")).toContain("pass --cwd");
		expect(h.api.resumeWorkflowByRunId).not.toHaveBeenCalled();
		rmSync(root, { recursive: true, force: true });
	});

	it("answer --no-resume records the choice by number and closes the ticket", async () => {
		const cwd = project();
		addPark(cwd, { runId: "r1", prompt: "p", sessionId: "s", questions: [ask], kata: "ab12" } as never);
		const kata: Kata = { file: vi.fn(), close: vi.fn() };
		const h = harness();
		const a = io();
		const code = await main(["answer", "shed", "1", "2", "--no-resume", "--cwd", cwd], a.io, { api: h.api, kata });
		expect(code).toBe(EXIT.ok);
		expect(readParks(cwd, "r1")[0]).toMatchObject({ status: "answered", answer: "Blue" });
		expect(vi.mocked(kata.close).mock.calls[0]![0]).toMatchObject({ kata: "ab12", answer: "Blue" });
		expect(h.api.resumeWorkflowByRunId).not.toHaveBeenCalled();
	});

	it("answer resumes the run by id", async () => {
		const cwd = project();
		park(cwd);
		const h = harness();
		const code = await main(["answer", "shed", "1", "Red", "--cwd", cwd, "--plugin-dir", plugin()], io().io, {
			api: h.api,
			deps: { query: vi.fn(), forkSession: vi.fn() } as never,
			kata: null,
		});
		expect(code).toBe(EXIT.ok);
		expect(vi.mocked(h.api.resumeWorkflowByRunId).mock.calls[0]![1]).toBe("r1");
	});

	it("answer refuses an unknown or already delivered question", async () => {
		const cwd = project();
		park(cwd);
		const a = io();
		expect(await main(["answer", "shed", "7", "Red", "--cwd", cwd], a.io, { api: harness().api, kata: null })).toBe(
			EXIT.usage,
		);
		expect(await main(["answer", "nope", "1", "Red", "--cwd", cwd], a.io, { api: harness().api, kata: null })).toBe(
			EXIT.usage,
		);
		updatePark(cwd, "r1", 1, { status: "resumed" });
		expect(await main(["answer", "shed", "1", "Red", "--cwd", cwd], a.io, { api: harness().api, kata: null })).toBe(
			EXIT.usage,
		);
		expect(await main(["answer", "shed", "1", "--cwd", cwd], a.io, { api: harness().api, kata: null })).toBe(
			EXIT.usage,
		);
	});

	it("a run that parks exits 75 and prints the answer command", async () => {
		const cwd = project();
		const h = harness({ success: false, stagesCompleted: 0, runId: "r9" });
		vi.mocked(h.api.runWorkflowByName).mockImplementationOnce(async (ctx, _n, _i, opts) => {
			const o = opts as { lifecycle: { onWorkflowStart(c: unknown): void } };
			o.lifecycle.onWorkflowStart({ runId: "r9", workflow: "wf" });
			(ctx as unknown as { opts: { parking: { park(i: unknown): void } } }).opts.parking.park({
				prompt: "/skill:pick",
				sessionId: "s1",
				questions: [ask],
			});
			return { success: false, stagesCompleted: 0, runId: "r9" };
		});
		const a = io();
		const code = await main(["run", "wf", "--cwd", cwd, "--plugin-dir", plugin()], a.io, {
			api: h.api,
			deps: { query: vi.fn(), forkSession: vi.fn() } as never,
			kata: null,
		});
		expect(code).toBe(EXIT.parked);
		expect(a.out.at(-1)).toBe("parked: answer with `rpiv-wf answer r9 1 <choice>`");
		expect(readParks(cwd, "r9")).toHaveLength(1);
	});

	it("a park soft-stops the run: siblings finish, nothing new starts, the run is not aborted (kata 79yy)", async () => {
		const cwd = project();
		const h = harness({ success: false, stagesCompleted: 0, runId: "r9" });
		let signals: { run?: AbortSignal; halt?: AbortSignal } = {};
		vi.mocked(h.api.runWorkflowByName).mockImplementationOnce(async (ctx, _n, _i, opts) => {
			const o = opts as { signal: AbortSignal; lifecycle: { onWorkflowStart(c: unknown): void } };
			o.lifecycle.onWorkflowStart({ runId: "r9", workflow: "wf" });
			const host = ctx as unknown as { opts: { halt: AbortSignal; parking: { park(i: unknown): void } } };
			host.opts.parking.park({ prompt: "/skill:pick", sessionId: "s1", questions: [ask] });
			signals = { run: o.signal, halt: host.opts.halt };
			return { success: false, stagesCompleted: 0, runId: "r9" };
		});
		const code = await main(["run", "wf", "--cwd", cwd, "--plugin-dir", plugin()], io().io, {
			api: h.api,
			deps: { query: vi.fn(), forkSession: vi.fn() } as never,
			kata: null,
		});
		expect(code).toBe(EXIT.parked);
		expect(signals.halt?.aborted).toBe(true);
		expect(signals.run?.aborted).toBe(false);
	});

	it("--auto-accept-checkpoints reaches the host; without it checkpoints need a person (kata ac4x)", async () => {
		for (const [flag, want] of [
			[["--auto-accept-checkpoints"], true],
			[[], undefined],
		] as const) {
			const h = harness();
			await main(["run", "wf", ...flag, "--cwd", project(), "--plugin-dir", plugin()], io().io, {
				api: h.api,
				deps: { query: vi.fn(), forkSession: vi.fn() } as never,
				kata: null,
			});
			const ctx = vi.mocked(h.api.runWorkflowByName).mock.calls[0]![0] as unknown as {
				opts: { autoAcceptCheckpoints?: boolean };
			};
			expect(ctx.opts.autoAcceptCheckpoints).toBe(want);
		}
	});

	it("routine confirmations are auto-accepted unless --park-confirmations (kata 439b)", async () => {
		for (const [flag, want] of [
			[[], true],
			[["--park-confirmations"], false],
		] as const) {
			const h = harness();
			await main(["run", "wf", ...flag, "--cwd", project(), "--plugin-dir", plugin()], io().io, {
				api: h.api,
				deps: { query: vi.fn(), forkSession: vi.fn() } as never,
				kata: null,
			});
			const ctx = vi.mocked(h.api.runWorkflowByName).mock.calls[0]![0] as unknown as {
				opts: { autoAcceptConfirmations?: boolean };
			};
			expect(ctx.opts.autoAcceptConfirmations).toBe(want);
		}
	});

	it("--kata and --kata-labels configure the park tickets", async () => {
		const detect = vi.fn(() => undefined);
		const h = harness();
		await main(
			[
				"run",
				"wf",
				"--kata",
				"ph42",
				"--kata-labels",
				"rpiv-parked,human,phase",
				"--cwd",
				project(),
				"--plugin-dir",
				plugin(),
			],
			io().io,
			{ api: h.api, deps: { query: vi.fn(), forkSession: vi.fn() } as never, detectKata: detect },
		);
		expect(detect).toHaveBeenCalledWith(expect.any(Function), undefined, undefined, {
			labels: ["rpiv-parked", "human", "phase"],
			parent: "ph42",
		});
	});
});

describe("rpiv-wf steps", () => {
	const quiet = { out: () => {}, err: () => {} };

	it("step runs the skill's one-stage workflow with the joined input", async () => {
		const h = harness();
		const cwd = mkdtempSync(join(tmpdir(), "rpiv-cli-step-"));
		const code = await main(["step", "research", "how", "does", "x", "--cwd", cwd, "--plugin-dir", plugin()], quiet, {
			api: h.api,
			deps: { query: vi.fn(), forkSession: vi.fn() } as never,
			kata: null,
		});
		expect(code).toBe(EXIT.ok);
		const [, name, input] = vi.mocked(h.api.runWorkflowByName).mock.calls[0]!;
		expect([name, input]).toEqual(["step-research", "how does x"]);
	});

	it("step refuses an unknown skill", async () => {
		const h = harness();
		const err: string[] = [];
		const code = await main(
			["step", "no-such-skill", "--plugin-dir", plugin()],
			{ out: () => {}, err: (l) => err.push(l) },
			{
				api: h.api,
				kata: null,
			},
		);
		expect(code).toBe(EXIT.usage);
		expect(err.join()).toContain("rpiv-wf steps");
	});

	it("steps lists skills with their source and kind; list hides step workflows", async () => {
		const out: string[] = [];
		expect(await main(["steps"], { out: (l) => out.push(l), err: () => {} })).toBe(EXIT.ok);
		expect(out).toContain("research\trpiv\tproduces");
		const h = harness();
		vi.mocked(h.api.loadWorkflows).mockResolvedValueOnce({
			workflows: [{ name: "build" }, { name: "step-research" }],
		});
		await h.go(["list"]);
		expect(h.out).toEqual(["build"]);
	});
});

describe("rpiv-wf limits for unattended runs", () => {
	const deps = { query: vi.fn(), forkSession: vi.fn() } as never;
	const metricsOf = (file: string) => JSON.parse(readFileSync(file, "utf8"));

	it("--max-cost stops the run once spend reaches it (exit 76) and says why in the metrics", async () => {
		const h = harness({ success: false, stagesCompleted: 1, runId: "r1" });
		vi.mocked(h.api.runWorkflowByName).mockImplementationOnce(async (ctx, _n, _i, opts) => {
			const onUsage = (ctx as unknown as { opts: { onUsage(u: unknown): void } }).opts.onUsage;
			const u = { costUsd: 0.3, turns: 1, durationMs: 1, models: {}, toolCalls: {} };
			const halt = (ctx as unknown as { opts: { halt: AbortSignal } }).opts.halt;
			onUsage(u);
			expect(halt.aborted).toBe(false);
			onUsage(u);
			expect(halt.aborted).toBe(true);
			// The runner's signal stays cold, so the stage that just finished is kept.
			expect((opts as { signal: AbortSignal }).signal.aborted).toBe(false);
			return { success: false, stagesCompleted: 1, runId: "r1" };
		});
		const metricsFile = join(mkdtempSync(join(tmpdir(), "rpiv-m-")), "m.json");
		const err: string[] = [];
		const code = await main(
			["run", "x", "--max-cost", "0.5", "--plugin-dir", plugin()],
			{ out: () => {}, err: (l) => err.push(l) },
			{ api: h.api, deps, kata: null, metricsFile },
		);
		expect(code).toBe(EXIT.budget);
		expect(metricsOf(metricsFile)).toMatchObject({ exitCode: 76, stopped: "budget", usage: { costUsd: 0.6 } });
		expect(err.join("\n")).toContain("--max-cost $0.5 reached");
	});

	it("--timeout stops the run after that many minutes (exit 124)", async () => {
		const h = harness();
		vi.mocked(h.api.runWorkflowByName).mockImplementationOnce(async (_c, _n, _i, opts) => {
			const signal = (opts as { signal: AbortSignal }).signal;
			await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
			return { success: false, stagesCompleted: 0, runId: "r2" };
		});
		const code = await main(
			["run", "x", "--timeout", "0.0005", "--plugin-dir", plugin()],
			{ out: () => {}, err: () => {} },
			{
				api: h.api,
				deps,
				kata: null,
			},
		);
		expect(code).toBe(EXIT.timeout);
	});

	it.each([
		["--max-cost", "0"],
		["--max-cost", "abc"],
		["--timeout", "-1"],
	])("rejects %s %s", async (flag, value) => {
		const h = harness();
		expect(await h.go(["run", "x", flag, value])).toBe(EXIT.usage);
	});
});
