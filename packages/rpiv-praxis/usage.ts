/**
 * Usage totals for one rpiv-wf invocation: the sum of every stage turn's cost,
 * tokens and tool calls. Written to $RPIV_WF_METRICS_FILE at exit so an eval
 * (or anything else) can compare runs without parsing logs.
 */

import type { TurnUsage } from "./claude-host.ts";

export interface UsageTotals {
	costUsd: number;
	turns: number;
	stageTurns: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	toolCalls: Record<string, number>;
	models: string[];
}

export function emptyTotals(): UsageTotals {
	return {
		costUsd: 0,
		turns: 0,
		stageTurns: 0,
		durationMs: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		toolCalls: {},
		models: [],
	};
}

export function addTurn(t: UsageTotals, u: TurnUsage): void {
	t.costUsd += u.costUsd;
	t.turns += u.turns;
	t.stageTurns += 1;
	t.durationMs += u.durationMs;
	for (const [model, m] of Object.entries(u.models)) {
		t.inputTokens += m.inputTokens;
		t.outputTokens += m.outputTokens;
		t.cacheReadInputTokens += m.cacheReadInputTokens;
		t.cacheCreationInputTokens += m.cacheCreationInputTokens;
		if (!t.models.includes(model)) t.models.push(model);
	}
	for (const [tool, n] of Object.entries(u.toolCalls)) t.toolCalls[tool] = (t.toolCalls[tool] ?? 0) + n;
}

/** Add one invocation's totals into another (a trial that parks and resumes spans several). */
export function mergeTotals(into: UsageTotals, add: UsageTotals): void {
	into.costUsd += add.costUsd;
	into.turns += add.turns;
	into.stageTurns += add.stageTurns;
	into.durationMs += add.durationMs;
	into.inputTokens += add.inputTokens;
	into.outputTokens += add.outputTokens;
	into.cacheReadInputTokens += add.cacheReadInputTokens;
	into.cacheCreationInputTokens += add.cacheCreationInputTokens;
	for (const [tool, n] of Object.entries(add.toolCalls)) into.toolCalls[tool] = (into.toolCalls[tool] ?? 0) + n;
	for (const m of add.models) if (!into.models.includes(m)) into.models.push(m);
}

/** Parse a comma list flag; `none` (or empty) means an explicit empty list. */
export function listFlag(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed === "none") return [];
	return trimmed
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}
