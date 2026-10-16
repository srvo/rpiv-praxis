/**
 * The terminal row (kata grt7): runs 4f47 and f9bc ended after their goal stage
 * and logged nothing else, so a reader could not tell a finished run from one
 * that died silently. Every invocation of a run now ends with exactly one
 * `terminal` row — `completed`, `failed`, `parked` or `aborted`, with the
 * reason — written by the CLI when the run returns and from a process `exit`
 * handler when it does not.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunWorkflowResult } from "@juicesharp/rpiv-workflow";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeHostDeps, TurnUsage } from "./claude-host.js";
import { EXIT, handleStopSignals, main, type WorkflowApi } from "./cli.js";
import { RunLedger, readLedger } from "./run-ledger.js";

const turn = (costUsd: number, input = 100, output = 0): TurnUsage => ({
	costUsd,
	turns: 1,
	durationMs: 10,
	models: {
		"claude-x": { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
	},
	toolCalls: {},
});

const project = () => {
	const cwd = mkdtempSync(join(tmpdir(), "rpiv-terminal-"));
	mkdirSync(join(cwd, ".rpiv", "workflows", "runs"), { recursive: true });
	return cwd;
};
const runRows = (cwd: string, runId: string) =>
	readFileSync(join(cwd, ".rpiv", "workflows", "runs", `${runId}.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
const terminalRows = (cwd: string, runId: string) => runRows(cwd, runId).filter((r) => r.type === "terminal");

function plugin(): string {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-terminal-plugin-"));
	mkdirSync(join(dir, "skills", "commit"), { recursive: true });
	writeFileSync(join(dir, "skills", "commit", "SKILL.md"), "---\nname: commit\n---\n");
	return dir;
}

const io = () => {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};
const deps = { query: vi.fn(), forkSession: vi.fn() } as unknown as ClaudeHostDeps;
const apiWith = (body: (ctx: unknown, opts: unknown) => Promise<RunWorkflowResult>): WorkflowApi => ({
	loadWorkflows: vi.fn(async () => ({ workflows: [] })),
	runWorkflowByName: vi.fn(async (ctx, _n, _i, opts) => body(ctx, opts)),
	resumeWorkflowByRunId: vi.fn(async (ctx, _r, opts) => body(ctx, opts)),
});
const hostOpts = (ctx: unknown) =>
	(ctx as { opts: { onUsage(u: TurnUsage, i: { stage?: string; sessionId: string }): void; parking: object } }).opts;
/** Bind the run id the way the runner's lifecycle does. */
const bind = (opts: unknown, runId: string) =>
	(opts as { lifecycle: { onWorkflowStart(c: unknown): void } }).lifecycle.onWorkflowStart({ runId, workflow: "wf" });

describe("RunLedger.terminal", () => {
	it("writes exactly one terminal row, first call wins", () => {
		const cwd = project();
		const ledger = new RunLedger(cwd, "run");
		ledger.lifecycle.onWorkflowStart?.({ runId: "r1" } as never);
		ledger.terminal("completed", "3 stage(s)", 0);
		ledger.terminal("failed", "a later exit handler", 1);
		const rows = terminalRows(cwd, "r1");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			type: "terminal",
			invocation: ledger.invocation,
			outcome: "completed",
			reason: "3 stage(s)",
			exitCode: 0,
		});
	});

	it("writes nothing before the run id is known (there is no run file yet)", () => {
		const cwd = project();
		const ledger = new RunLedger(cwd, "run");
		ledger.terminal("failed", "no run yet", 1);
		expect(readdirSync(join(cwd, ".rpiv", "workflows", "runs"))).toEqual([]);
	});

	it("terminal rows are not folded into the ledger totals", () => {
		const cwd = project();
		const ledger = new RunLedger(cwd, "run");
		ledger.lifecycle.onWorkflowStart?.({ runId: "r1" } as never);
		ledger.record(turn(0.5, 100), { stage: "plan", sessionId: "s1" });
		ledger.terminal("completed", "1 stage(s)", 0);
		expect(readLedger(cwd, "r1")).toMatchObject({ costUsd: 0.5, tokens: 100 });
	});
});

describe("handleStopSignals", () => {
	const fakeProc = () => {
		const handlers: Record<string, () => void> = {};
		const exit = vi.fn();
		return {
			proc: {
				on: (event: string, fn: () => void) => {
					handlers[event] = fn;
				},
				exit,
			},
			handlers,
			exit,
		};
	};

	it("a first signal asks the run to stop resumably; only a second exits", () => {
		const { proc, handlers, exit } = fakeProc();
		const controller = new AbortController();
		handleStopSignals(controller, proc);
		expect(Object.keys(handlers).sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
		handlers.SIGINT!();
		expect(controller.signal.aborted).toBe(true);
		expect(exit).not.toHaveBeenCalled();
		handlers.SIGINT!();
		expect(exit).toHaveBeenCalledWith(130);
	});

	it.each([
		["SIGINT", 130],
		["SIGTERM", 143],
		["SIGHUP", 129],
	])("a second %s exits with 128 + its number", (sig, code) => {
		const { proc, handlers, exit } = fakeProc();
		const controller = new AbortController();
		handleStopSignals(controller, proc);
		handlers[sig]!();
		handlers[sig]!();
		expect(exit).toHaveBeenCalledWith(code);
	});
});

describe("rpiv-wf writes a terminal row for every outcome", () => {
	it("completed", async () => {
		const cwd = project();
		const api = apiWith(async (_ctx, opts) => {
			bind(opts, "r1");
			return { success: true, stagesCompleted: 3, runId: "r1" };
		});
		await main(["run", "wf", "--cwd", cwd, "--plugin-dir", plugin()], io().io, { api, deps, kata: null });
		expect(terminalRows(cwd, "r1")).toMatchObject([
			{ type: "terminal", outcome: "completed", reason: "3 stage(s)", exitCode: EXIT.ok },
		]);
	});

	it("failed, with the runner's error", async () => {
		const cwd = project();
		const api = apiWith(async (_ctx, opts) => {
			bind(opts, "r1");
			return { success: false, stagesCompleted: 1, runId: "r1", error: "gate failed" };
		});
		await main(["run", "wf", "--cwd", cwd, "--plugin-dir", plugin()], io().io, { api, deps, kata: null });
		expect(terminalRows(cwd, "r1")).toMatchObject([
			{ type: "terminal", outcome: "failed", reason: "gate failed", exitCode: EXIT.failed },
		]);
	});

	it("parked, naming the question", async () => {
		const cwd = project();
		const api = apiWith(async (ctx, opts) => {
			bind(opts, "r9");
			const parking = (hostOpts(ctx) as unknown as { parking: { park(i: unknown): void } }).parking;
			parking.park({ prompt: "/skill:pick", sessionId: "s1", questions: [{ question: "Red or blue?" }] });
			return { success: false, stagesCompleted: 0, runId: "r9" };
		});
		const code = await main(["run", "wf", "--cwd", cwd, "--plugin-dir", plugin()], io().io, {
			api,
			deps,
			kata: null,
		});
		expect(code).toBe(EXIT.parked);
		const [row] = terminalRows(cwd, "r9");
		expect(row).toMatchObject({ type: "terminal", outcome: "parked", exitCode: EXIT.parked });
		expect(row.reason).toContain("Red or blue?");
	});

	it("aborted, at a cost limit", async () => {
		const cwd = project();
		const api = apiWith(async (ctx, opts) => {
			bind(opts, "r1");
			hostOpts(ctx).onUsage(turn(0.6), { stage: "plan", sessionId: "s1" });
			return { success: false, stagesCompleted: 0, runId: "r1" };
		});
		const code = await main(["run", "wf", "--max-cost", "0.5", "--cwd", cwd, "--plugin-dir", plugin()], io().io, {
			api,
			deps,
			kata: null,
		});
		expect(code).toBe(EXIT.budget);
		expect(terminalRows(cwd, "r1")).toMatchObject([
			{ type: "terminal", outcome: "aborted", reason: "stopped at the budget limit", exitCode: EXIT.budget },
		]);
	});

	it("aborted, when interrupted by a stop signal", async () => {
		const cwd = project();
		const ac = new AbortController();
		ac.abort();
		const api = apiWith(async (_ctx, opts) => {
			bind(opts, "r1");
			return { success: false, stagesCompleted: 0, runId: "r1" };
		});
		const code = await main(["run", "wf", "--cwd", cwd, "--plugin-dir", plugin()], io().io, {
			api,
			deps,
			kata: null,
			signal: ac.signal,
		});
		expect(code).toBe(EXIT.interrupted);
		expect(terminalRows(cwd, "r1")).toMatchObject([
			{ type: "terminal", outcome: "aborted", reason: "interrupted by a stop signal", exitCode: EXIT.interrupted },
		]);
	});

	it("failed, when the run throws", async () => {
		const cwd = project();
		const api = apiWith(async (_ctx, opts) => {
			bind(opts, "r1");
			throw new Error("boom");
		});
		await expect(
			main(["run", "wf", "--cwd", cwd, "--plugin-dir", plugin()], io().io, { api, deps, kata: null }),
		).rejects.toThrow("boom");
		const [row] = terminalRows(cwd, "r1");
		expect(row).toMatchObject({ type: "terminal", outcome: "failed", exitCode: EXIT.failed });
		expect(row.reason).toContain("boom");
	});
});

describe("a run that never returns still writes its terminal row", () => {
	const neverReturns = (cwd: string) => {
		let fire!: (code: number) => void;
		let removed = false;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const api = apiWith(async (_ctx, opts) => {
			bind(opts, "r1");
			await gate;
			return { success: true, stagesCompleted: 1, runId: "r1" };
		});
		const done = main(["run", "wf", "--cwd", cwd, "--plugin-dir", plugin()], io().io, {
			api,
			deps,
			kata: null,
			onExit: (fn) => {
				fire = fn;
				return () => {
					removed = true;
				};
			},
		});
		return {
			done,
			exit: (code: number) => fire(code),
			release,
			load: () => fire,
			wasRemoved: () => removed,
		};
	};

	it("a stop signal before the run returns is an aborted row naming the signal", async () => {
		const cwd = project();
		const r = neverReturns(cwd);
		await vi.waitFor(() => expect(r.load()).toBeTypeOf("function"));
		r.exit(143);
		const rows = terminalRows(cwd, "r1");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ outcome: "aborted", exitCode: 143 });
		expect(rows[0].reason).toContain("SIGTERM");
		r.release();
		await r.done;
		// The run returning afterwards does not append a second terminal row.
		expect(terminalRows(cwd, "r1")).toHaveLength(1);
		expect(r.wasRemoved()).toBe(true);
	});

	it("any other exit code before the run returns is a failed row", async () => {
		const cwd = project();
		const r = neverReturns(cwd);
		await vi.waitFor(() => expect(r.load()).toBeTypeOf("function"));
		r.exit(2);
		const [row] = terminalRows(cwd, "r1");
		expect(row).toMatchObject({ outcome: "failed", exitCode: 2 });
		expect(row.reason).toContain("code 2");
		expect(row.reason).not.toContain("SIG");
		r.release();
		await r.done;
	});
});
