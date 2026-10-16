/**
 * The run ledger: usage and invocation rows rpiv-wf appends to the run's own
 * JSONL (`.rpiv/workflows/runs/<runId>.jsonl`), beside the engine's stage rows.
 *
 *   {"type":"usage", ts, invocation, stage?, sessionId, turns, durationMs,
 *    inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
 *    models, toolCalls, costUsd?}                         one per stage turn
 *   {"type":"invocation", ts, invocation, kind: "run" | "resumed" | "end"}
 *
 * Tokens are always recorded. `costUsd` is recorded only when the SDK reported
 * a cost for the turn: a turn routed through a gateway reports none, and the
 * ledger never invents a price. Rows carry no `stageNumber`, so the engine's
 * readers treat them as foreign telemetry, never as malformed stage rows.
 *
 * Because the rows live in the run file, totals survive resume: `--max-cost`,
 * `--timeout` and the per-stage caps enforce against everything the run has
 * spent across all of its invocations, not just the current process.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LifecycleListeners } from "@juicesharp/rpiv-workflow";
import type { TurnUsage } from "./claude-host.js";

export interface UsageRow {
	type: "usage";
	ts: string;
	invocation: string;
	stage?: string;
	sessionId: string;
	turns: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	models: string[];
	toolCalls: Record<string, number>;
	costUsd?: number;
}

export interface InvocationRow {
	type: "invocation";
	ts: string;
	invocation: string;
	kind: "run" | "resumed" | "end";
}

/** What a run has spent so far, folded from its ledger rows. */
export interface LedgerTotals {
	costUsd: number;
	/** True when at least one turn reported a cost (false ⇒ cost is unknown, not zero). */
	costReported: boolean;
	tokens: number;
	/** Wall-clock across invocations: each invocation's first row to its last. */
	elapsedMs: number;
	/** Per stage name: cost and tokens. */
	stages: Record<string, { costUsd: number; tokens: number }>;
}

const runFile = (cwd: string, runId: string) => join(cwd, ".rpiv", "workflows", "runs", `${runId}.jsonl`);

export function appendLedgerRow(cwd: string, runId: string, row: UsageRow | InvocationRow): void {
	try {
		mkdirSync(join(cwd, ".rpiv", "workflows", "runs"), { recursive: true });
		appendFileSync(runFile(cwd, runId), `${JSON.stringify(row)}\n`, "utf-8");
	} catch (err) {
		process.stderr.write(`[warning] could not append to the run ledger: ${String(err)}\n`);
	}
}

/** All tokens a turn moved (input, output, cache reads and writes). */
export const usageTokens = (
	r: Pick<UsageRow, "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens">,
) => r.inputTokens + r.outputTokens + r.cacheReadInputTokens + r.cacheCreationInputTokens;

/** One turn as a ledger row. */
export function usageRow(u: TurnUsage, info: { stage?: string; sessionId: string }, invocation: string): UsageRow {
	const row: UsageRow = {
		type: "usage",
		ts: new Date().toISOString(),
		invocation,
		...(info.stage !== undefined ? { stage: info.stage } : {}),
		sessionId: info.sessionId,
		turns: u.turns,
		durationMs: u.durationMs,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		models: Object.keys(u.models),
		toolCalls: { ...u.toolCalls },
	};
	for (const m of Object.values(u.models)) {
		row.inputTokens += m.inputTokens;
		row.outputTokens += m.outputTokens;
		row.cacheReadInputTokens += m.cacheReadInputTokens;
		row.cacheCreationInputTokens += m.cacheCreationInputTokens;
	}
	if (u.costUsd > 0) row.costUsd = u.costUsd;
	return row;
}

export function emptyLedgerTotals(): LedgerTotals {
	return { costUsd: 0, costReported: false, tokens: 0, elapsedMs: 0, stages: {} };
}

/** The per-stage accumulator for `stage`, created on first use. */
function stageSlot(t: LedgerTotals, stage: string): { costUsd: number; tokens: number } {
	let s = t.stages[stage];
	if (!s) {
		s = { costUsd: 0, tokens: 0 };
		t.stages[stage] = s;
	}
	return s;
}

/** Fold one usage row into totals (also used live, as each turn lands). */
export function addUsageRow(t: LedgerTotals, r: UsageRow): void {
	const tokens = usageTokens(r);
	t.tokens += tokens;
	if (r.costUsd !== undefined) {
		t.costUsd += r.costUsd;
		t.costReported = true;
	}
	if (r.stage !== undefined) {
		const s = stageSlot(t, r.stage);
		s.tokens += tokens;
		s.costUsd += r.costUsd ?? 0;
	}
}

/** Read a run's ledger rows and fold them. A missing or unreadable file reads as empty. */
export function readLedger(cwd: string, runId: string): LedgerTotals {
	const t = emptyLedgerTotals();
	const file = runFile(cwd, runId);
	if (!existsSync(file)) return t;
	const span = new Map<string, { first: number; last: number }>();
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		return t;
	}
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		const r = row as Partial<UsageRow | InvocationRow>;
		if ((r.type !== "usage" && r.type !== "invocation") || typeof r.invocation !== "string") continue;
		const at = Date.parse(String(r.ts));
		if (Number.isFinite(at)) {
			const s = span.get(r.invocation);
			if (!s) span.set(r.invocation, { first: at, last: at });
			else {
				s.first = Math.min(s.first, at);
				s.last = Math.max(s.last, at);
			}
		}
		if (r.type === "usage") addUsageRow(t, r as UsageRow);
	}
	for (const s of span.values()) t.elapsedMs += s.last - s.first;
	return t;
}

/**
 * One invocation's view of the ledger. Knows the run id up front on resume and
 * learns it from the runner's `onWorkflowStart` on a fresh run; turns that land
 * before then are buffered. `totals` is CUMULATIVE: the run's prior rows (read
 * when the run id binds) plus every turn recorded since.
 */
export class RunLedger {
	readonly invocation = randomUUID();
	readonly totals = emptyLedgerTotals();
	private runId: string | undefined;
	private readonly buffer: UsageRow[] = [];

	constructor(
		private readonly cwd: string,
		private readonly kind: "run" | "resumed",
		runId?: string,
	) {
		if (runId) this.bind(runId);
	}

	/** Attach to the run: fold its prior rows, write this invocation's row, flush buffered turns. */
	bind(runId: string): void {
		if (this.runId) return;
		this.runId = runId;
		const prior = readLedger(this.cwd, runId);
		this.totals.costUsd += prior.costUsd;
		this.totals.costReported ||= prior.costReported;
		this.totals.tokens += prior.tokens;
		this.totals.elapsedMs += prior.elapsedMs;
		for (const [stage, v] of Object.entries(prior.stages)) {
			const s = stageSlot(this.totals, stage);
			s.costUsd += v.costUsd;
			s.tokens += v.tokens;
		}
		appendLedgerRow(this.cwd, runId, this.invocationRow(this.kind));
		for (const row of this.buffer.splice(0)) appendLedgerRow(this.cwd, runId, row);
	}

	/** Record one turn; returns the row (already folded into `totals`). */
	record(u: TurnUsage, info: { stage?: string; sessionId: string }): UsageRow {
		const row = usageRow(u, info, this.invocation);
		addUsageRow(this.totals, row);
		if (this.runId) appendLedgerRow(this.cwd, this.runId, row);
		else this.buffer.push(row);
		return row;
	}

	/** Close this invocation's wall-clock span. */
	end(): void {
		if (this.runId) appendLedgerRow(this.cwd, this.runId, this.invocationRow("end"));
	}

	readonly lifecycle: LifecycleListeners = {
		onWorkflowStart: (ctx) => this.bind(ctx.runId),
	};

	private invocationRow(kind: InvocationRow["kind"]): InvocationRow {
		return { type: "invocation", ts: new Date().toISOString(), invocation: this.invocation, kind };
	}
}

/**
 * Call every listener set's handler for each event, in order (the runner takes
 * one listener object). Synchronous handlers run synchronously — a later set
 * sees an earlier set's effect immediately — and a returned promise chains the
 * rest behind it.
 */
export function mergeLifecycles(...sets: LifecycleListeners[]): LifecycleListeners {
	type Handler = (...args: unknown[]) => unknown;
	const merged: Record<string, Handler> = {};
	const keys = new Set(sets.flatMap((s) => Object.keys(s)));
	for (const key of keys) {
		const handlers = sets
			.map((s) => (s as Record<string, Handler | undefined>)[key])
			.filter((fn): fn is Handler => typeof fn === "function");
		merged[key] = (...args: unknown[]) => {
			let chain: Promise<unknown> | undefined;
			for (const fn of handlers) {
				if (chain) chain = chain.then(() => fn(...args));
				else {
					const r = fn(...args);
					if (r instanceof Promise) chain = r;
				}
			}
			return chain?.then(() => undefined);
		};
	}
	return merged as LifecycleListeners;
}
