/**
 * The run ledger (kata v199): usage rows per stage turn in the run's JSONL, a
 * `resumed` row on resume, and caps that count what earlier invocations spent.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunWorkflowResult } from "@juicesharp/rpiv-workflow";
import { describe, expect, it, vi } from "vitest";
import type { TurnUsage } from "./claude-host.js";
import { EXIT, main, type WorkflowApi } from "./cli.js";
import { RunLedger, readLedger, usageRow } from "./run-ledger.js";

const turn = (costUsd: number, input = 100, output = 50): TurnUsage => ({
	costUsd,
	turns: 1,
	durationMs: 10,
	models: {
		"claude-x": { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
	},
	toolCalls: { Write: 1 },
});

const project = () => {
	const cwd = mkdtempSync(join(tmpdir(), "rpiv-ledger-"));
	mkdirSync(join(cwd, ".rpiv", "workflows", "runs"), { recursive: true });
	return cwd;
};
const runRows = (cwd: string, runId: string) =>
	readFileSync(join(cwd, ".rpiv", "workflows", "runs", `${runId}.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
const seedRun = (cwd: string, runId: string, rows: object[]) =>
	writeFileSync(
		join(cwd, ".rpiv", "workflows", "runs", `${runId}.jsonl`),
		[{ runId, workflow: "wf", input: "x", ts: "2026-10-16T00:00:00Z", v: 3 }, ...rows]
			.map((r) => JSON.stringify(r))
			.join("\n")
			.concat("\n"),
	);
const priorUsage = (invocation: string, ts: string, costUsd?: number, stage = "plan") => ({
	type: "usage",
	ts,
	invocation,
	stage,
	sessionId: "s0",
	turns: 1,
	durationMs: 1,
	inputTokens: 1000,
	outputTokens: 0,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	models: [],
	toolCalls: {},
	...(costUsd !== undefined ? { costUsd } : {}),
});

function plugin(): string {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-ledger-plugin-"));
	mkdirSync(join(dir, "skills", "commit"), { recursive: true });
	writeFileSync(join(dir, "skills", "commit", "SKILL.md"), "---\nname: commit\n---\n");
	return dir;
}

const apiWith = (body: (ctx: unknown, opts: unknown) => Promise<RunWorkflowResult>): WorkflowApi => ({
	loadWorkflows: vi.fn(async () => ({ workflows: [] })),
	runWorkflowByName: vi.fn(async (ctx, _n, _i, opts) => body(ctx, opts)),
	resumeWorkflowByRunId: vi.fn(async (ctx, _r, opts) => body(ctx, opts)),
});
const hostOpts = (ctx: unknown) =>
	(
		ctx as {
			opts: {
				onUsage(u: TurnUsage, i: { stage?: string; sessionId: string }): void;
				onTurnStart(stage?: string): void;
				halt: AbortSignal;
			};
		}
	).opts;
const deps = { query: vi.fn(), forkSession: vi.fn() } as never;

describe("usageRow", () => {
	it("always records tokens; records cost only when the SDK reported one", () => {
		const unpriced = usageRow(turn(0), { stage: "plan", sessionId: "s1" }, "inv");
		expect(unpriced).toMatchObject({ type: "usage", stage: "plan", inputTokens: 100, outputTokens: 50 });
		expect(unpriced).not.toHaveProperty("costUsd");
		expect(usageRow(turn(0.25), { sessionId: "s1" }, "inv").costUsd).toBe(0.25);
	});
});

describe("RunLedger", () => {
	it("buffers turns until the run id is known, then writes the invocation row and the usage rows", () => {
		const cwd = project();
		const ledger = new RunLedger(cwd, "run");
		ledger.record(turn(0), { stage: "research", sessionId: "s1" });
		seedRun(cwd, "r1", []);
		ledger.lifecycle.onWorkflowStart?.({ runId: "r1" } as never);
		ledger.end();
		const rows = runRows(cwd, "r1").slice(1);
		expect(rows.map((r) => r.type)).toEqual(["invocation", "usage", "invocation"]);
		expect(rows[0]).toMatchObject({ kind: "run" });
		expect(rows[1]).toMatchObject({ stage: "research", inputTokens: 100 });
		expect(rows[2]).toMatchObject({ kind: "end" });
	});

	it("on resume, folds the prior rows into the cumulative totals and writes a resumed row", () => {
		const cwd = project();
		seedRun(cwd, "r1", [
			{ type: "invocation", ts: "2026-10-16T00:00:00Z", invocation: "a", kind: "run" },
			priorUsage("a", "2026-10-16T00:10:00Z", 0.4),
		]);
		const ledger = new RunLedger(cwd, "resumed", "r1");
		expect(ledger.totals).toMatchObject({ costUsd: 0.4, costReported: true, tokens: 1000, elapsedMs: 600_000 });
		expect(runRows(cwd, "r1").at(-1)).toMatchObject({ type: "invocation", kind: "resumed" });
	});

	it("elapsed sums each invocation's own span, not the gap between invocations", () => {
		const cwd = project();
		seedRun(cwd, "r1", [
			priorUsage("a", "2026-10-16T00:00:00Z"),
			priorUsage("a", "2026-10-16T00:05:00Z"),
			priorUsage("b", "2026-10-16T09:00:00Z"),
			priorUsage("b", "2026-10-16T09:01:00Z"),
		]);
		expect(readLedger(cwd, "r1").elapsedMs).toBe(6 * 60_000);
	});
	it("counts a forced-exit terminal timestamp when no end row was written", () => {
		const cwd = project();
		seedRun(cwd, "r1", [
			{ type: "invocation", ts: "2026-10-16T00:00:00Z", invocation: "aborted", kind: "run" },
			{ type: "terminal", ts: "2026-10-16T00:02:00Z", invocation: "aborted", outcome: "aborted", reason: "SIGTERM" },
		]);
		expect(readLedger(cwd, "r1").elapsedMs).toBe(120_000);
	});

	it("does not extend a normally closed invocation to its later terminal row", () => {
		const cwd = project();
		seedRun(cwd, "r1", [
			{ type: "invocation", ts: "2026-10-16T00:00:00Z", invocation: "closed", kind: "run" },
			{ type: "invocation", ts: "2026-10-16T00:01:00Z", invocation: "closed", kind: "end" },
			{ type: "terminal", ts: "2026-10-16T00:02:00Z", invocation: "closed", outcome: "completed" },
		]);
		expect(readLedger(cwd, "r1").elapsedMs).toBe(60_000);
	});
});

describe("rpiv-wf caps across resumes", () => {
	it("--max-cost counts what earlier invocations spent", async () => {
		const cwd = project();
		seedRun(cwd, "r1", [priorUsage("a", "2026-10-16T00:00:00Z", 0.9)]);
		let haltedAfter: boolean | undefined;
		const api = apiWith(async (ctx) => {
			hostOpts(ctx).onUsage(turn(0.2), { stage: "plan", sessionId: "s1" });
			haltedAfter = hostOpts(ctx).halt.aborted;
			return { success: false, stagesCompleted: 0, runId: "r1" };
		});
		const err: string[] = [];
		const code = await main(
			["resume", "r1", "--max-cost", "1", "--cwd", cwd, "--plugin-dir", plugin()],
			{ out: () => {}, err: (l) => err.push(l) },
			{ api, deps, kata: null },
		);
		expect(haltedAfter).toBe(true);
		expect(code).toBe(EXIT.budget);
		expect(err.join("\n")).toContain("across the run");
		const rows = runRows(cwd, "r1");
		expect(rows.filter((r) => r.type === "usage")).toHaveLength(2);
		expect(rows.some((r) => r.type === "invocation" && r.kind === "resumed")).toBe(true);
	});

	it("halts before resuming when prior spending already exhausts the run cap", async () => {
		const cwd = project();
		seedRun(cwd, "r1", [priorUsage("a", "2026-10-16T00:00:00Z", 1.2)]);
		let haltedAtEntry: boolean | undefined;
		const api = apiWith(async (ctx) => {
			haltedAtEntry = hostOpts(ctx).halt.aborted;
			return { success: false, stagesCompleted: 0, runId: "r1", error: "halted before query" };
		});
		const code = await main(
			["resume", "r1", "--max-cost", "1", "--cwd", cwd, "--plugin-dir", plugin()],
			{ out: () => {}, err: () => {} },
			{ api, deps, kata: null },
		);
		expect(haltedAtEntry).toBe(true);
		expect(code).toBe(EXIT.budget);
		expect(runRows(cwd, "r1").filter((r) => r.type === "usage")).toHaveLength(1);
	});
	it("--max-cost warns, instead of pretending, when the SDK reports no cost", async () => {
		const cwd = project();
		const api = apiWith(async (ctx) => {
			hostOpts(ctx).onUsage(turn(0), { stage: "plan", sessionId: "s1" });
			return { success: true, stagesCompleted: 1, runId: "r1" };
		});
		const err: string[] = [];
		await main(
			["run", "x", "--max-cost", "1", "--cwd", cwd, "--plugin-dir", plugin()],
			{
				out: () => {},
				err: (l) => err.push(l),
			},
			{ api, deps, kata: null },
		);
		expect(err.join("\n")).toContain("--max-cost cannot be enforced");
	});

	it("--timeout counts the wall-clock earlier invocations used", async () => {
		const cwd = project();
		seedRun(cwd, "r1", [priorUsage("a", "2026-10-16T00:00:00Z"), priorUsage("a", "2026-10-16T02:00:00Z")]);
		const api = apiWith(async (_ctx, opts) => {
			const signal = (opts as { signal: AbortSignal }).signal;
			if (!signal.aborted) await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
			return { success: false, stagesCompleted: 0, runId: "r1" };
		});
		const code = await main(
			["resume", "r1", "--timeout", "60", "--cwd", cwd, "--plugin-dir", plugin()],
			{ out: () => {}, err: () => {} },
			{ api, deps, kata: null },
		);
		expect(code).toBe(EXIT.timeout);
	});

	it("checks accumulated stage tokens before a resumed stage starts another turn", async () => {
		const cwd = project();
		seedRun(cwd, "r1", [priorUsage("a", "2026-10-16T00:00:00Z", undefined, "plan")]);
		let haltedBeforeTurn: boolean | undefined;
		const api = apiWith(async (ctx, _opts) => {
			const options = hostOpts(ctx) as ReturnType<typeof hostOpts> & { onTurnStart(stage?: string): void };
			options.onTurnStart("plan");
			haltedBeforeTurn = options.halt.aborted;
			return { success: false, stagesCompleted: 0, runId: "r1", error: "halted before turn" };
		});
		const code = await main(
			["resume", "r1", "--stage-max-tokens", "1000", "--cwd", cwd, "--plugin-dir", plugin()],
			{ out: () => {}, err: () => {} },
			{ api, deps, kata: null },
		);
		expect(haltedBeforeTurn).toBe(true);
		expect(code).toBe(EXIT.budget);
	});
	it("--stage-max-tokens stops the run once one stage crosses it", async () => {
		const cwd = project();
		let halted: boolean | undefined;
		const api = apiWith(async (ctx) => {
			hostOpts(ctx).onUsage(turn(0, 400, 0), { stage: "impl (phase-1)", sessionId: "s1" });
			hostOpts(ctx).onUsage(turn(0, 400, 0), { stage: "impl (phase-2)", sessionId: "s2" });
			expect(hostOpts(ctx).halt.aborted).toBe(false);
			hostOpts(ctx).onUsage(turn(0, 200, 0), { stage: "impl (phase-1)", sessionId: "s1" });
			halted = hostOpts(ctx).halt.aborted;
			return { success: false, stagesCompleted: 0, runId: "r1" };
		});
		const code = await main(
			["run", "x", "--stage-max-tokens", "600", "--cwd", cwd, "--plugin-dir", plugin()],
			{ out: () => {}, err: () => {} },
			{ api, deps, kata: null },
		);
		expect(halted).toBe(true);
		expect(code).toBe(EXIT.budget);
	});
});
