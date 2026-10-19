/**
 * Eval trial outcomes as activity-timeline records.
 *
 * An eval answers one question about the workflow under test: is it functional on
 * the code we have today? Each recorded trial therefore emits one item — the trial,
 * the attempt alias, the code it ran on, and whether it completed and passed its
 * checks — shaped for `activity.timeline` (`observed`: a fact, not a request for
 * someone's attention).
 *
 * This module owns the data. It does not decide where a row lands: a sink receives
 * the items. The default sink keeps them in memory so a run can print and hold the
 * summary; nothing is appended to a local file, and no database is required.
 * Wiring a persisted sink (monocloud's `surface_for_cio`) is a later, deliberate step.
 */
import type { TrialResult } from "./eval.js";
import { EXIT_STATE } from "./mcp.js";

/** One functional-status observation, shaped to survive the trip into activity.timeline. */
export interface ActivityItem {
	/** Stable per trial attempt: `<eval-name>:<variant>#<repeat>@<attempt>-ish`. */
	sourceId: string;
	title: string;
	summary: string;
	/** A fact about the world, not a queued decision. */
	status: "observed";
	sourceType: "eval_trial";
	payload: {
		eval: string;
		variant: string;
		repeat: number;
		attempt: string;
		state: string;
		/** Did the trial complete the workflow AND pass every check it declares? */
		functional: boolean;
		stagesCompleted: number;
		exitCodes: number[];
		checksFailed: string[];
		codeFingerprint: string;
		costUsd: number;
		wallMs: number;
		error?: string;
	};
}

export interface ActivitySink {
	emit(item: ActivityItem): void;
}

/** Collects items in memory; read them back with `items()`. */
export function memorySink(): ActivitySink & { items(): ActivityItem[] } {
	const collected: ActivityItem[] = [];
	return {
		emit(item) {
			collected.push(item);
		},
		items: () => [...collected],
	};
}

/**
 * Functional means: the trial ran the workflow to completion (`state` is the
 * "completed" exit state, not a park, stop or error) and every check the spec
 * declares passed. A trial that parks, is cut off, or errors is not functional
 * evidence — it is an unanswered question, and it says so in `state`/`error`.
 */
export function trialActivity(specName: string, codeFingerprint: string, r: TrialResult): ActivityItem {
	const checksFailed = r.checks.filter((c) => !c.pass).map((c) => c.name);
	const functional = r.state === EXIT_STATE[0] && checksFailed.length === 0;
	const attempt = r.alias?.slice(r.alias.lastIndexOf("-") + 1) ?? "unknown";
	const what = functional ? "functional" : `not functional (${r.state})`;
	return {
		sourceId: `${specName}:${r.variant}#${r.repeat}@${attempt}`,
		title: `${specName} · ${r.variant} #${r.repeat}: ${what}`,
		summary: [
			`${what} on code ${codeFingerprint.slice(0, 12)}`,
			r.alias ? `run ${r.alias}` : undefined,
			`${r.stagesCompleted} stage(s)`,
			checksFailed.length ? `failed checks: ${checksFailed.join(", ")}` : undefined,
			r.error ? `error: ${r.error}` : undefined,
		]
			.filter(Boolean)
			.join("; "),
		status: "observed",
		sourceType: "eval_trial",
		payload: {
			eval: specName,
			variant: r.variant,
			repeat: r.repeat,
			attempt,
			state: r.state,
			functional,
			stagesCompleted: r.stagesCompleted,
			exitCodes: r.exitCodes,
			checksFailed,
			codeFingerprint,
			costUsd: r.usage.costUsd,
			wallMs: r.wallMs,
			...(r.error ? { error: r.error } : {}),
		},
	};
}
