/**
 * kata tickets for parked questions — optional, and never in the way.
 *
 * Active only when a `kata` executable is on PATH (set RPIV_WF_KATA=off to
 * opt out). A park files one ticket; answering closes it. Labels default to
 * `rpiv-parked` plus `human`: the CIO decided on 2026-10-15 that parked
 * questions surface on activity.timeline, and monocloud's hourly producer
 * picks up `human`. Override with --kata-labels (or RPIV_WF_KATA_LABELS).
 * `--kata <ref>` files each park under that phase ticket (`--parent`).
 *
 * Every failure is reported and swallowed: a missing or broken kata must
 * never stop a question from parking or an answer from resuming.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Park } from "./park-store.ts";

export const KATA_LABEL = "rpiv-parked";
/** Labels a park's ticket carries unless configured otherwise. */
export const DEFAULT_KATA_LABELS: readonly string[] = [KATA_LABEL, "human"];

export interface KataOptions {
	/** Labels for each park ticket (default `DEFAULT_KATA_LABELS`). */
	labels?: readonly string[];
	/** Phase ticket each park is filed under. */
	parent?: string;
}

export type Exec = (cmd: string, args: string[], input?: string) => string;

const realExec: Exec = (cmd, args, input) =>
	execFileSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });

export interface Kata {
	file(park: Park, answerHint: string): string | undefined;
	close(park: Park): void;
}

/** True when an executable named `cmd` is on `env.PATH`. */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		try {
			accessSync(join(dir, cmd), constants.X_OK);
			return true;
		} catch {
			// not here
		}
	}
	return false;
}

/**
 * The kata idempotency key for a park: ONE ticket per (run, question). A crash
 * between `create` and the ref write-back used to file a DUPLICATE ticket on
 * the retry (kata ryvn) — the park's own retry is indistinguishable from a
 * fresh park, so the tie-break has to live server-side. kata dedupes on this
 * key and returns the original issue (`reused: true`), so a retried create
 * recovers the SAME ref instead of adding a second ticket. Stable for the
 * park's whole lifetime and distinct per question.
 */
export function parkKey(park: Park): string {
	return `rpiv-park:${park.runId}:${park.n}`;
}

/** A ticket's ref from `kata create --json`, whichever key the build uses. */
export function refFrom(json: string): string | undefined {
	try {
		const o = JSON.parse(json) as Record<string, unknown>;
		const issue = (o.issue && typeof o.issue === "object" ? o.issue : o) as Record<string, unknown>;
		for (const k of ["ref", "short_id", "shortId", "id"]) {
			if (typeof issue[k] === "string" && issue[k]) return issue[k] as string;
		}
	} catch {
		// not JSON — fall through
	}
	return undefined;
}

export function ticketBody(park: Park, answerHint: string): string {
	const qs = park.questions
		.map((q) =>
			[
				q.question,
				...q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`),
			].join("\n"),
		)
		.join("\n\n");
	return [
		`rpiv workflow \`${park.workflow ?? "?"}\` parked at stage \`${park.stage ?? "?"}\` (run ${park.runId}, question #${park.n}).`,
		...(park.context ? [`Context (what the stage wrote before asking):\n\n${park.context}`] : []),
		qs,
		`Answer with:\n\n    ${answerHint}`,
	].join("\n\n");
}

/** A kata client, or undefined when kata is unavailable or switched off. */
export function detectKata(
	warn: (m: string) => void,
	exec: Exec = realExec,
	env: NodeJS.ProcessEnv = process.env,
	opts: KataOptions = {},
): Kata | undefined {
	if (env.RPIV_WF_KATA === "off" || !onPath("kata", env)) return undefined;
	const envLabels = env.RPIV_WF_KATA_LABELS?.split(",").map((l) => l.trim());
	const labels = (opts.labels ?? envLabels ?? DEFAULT_KATA_LABELS).filter((l) => l.length > 0);
	const extra = [...labels.flatMap((l) => ["--label", l]), ...(opts.parent ? ["--parent", opts.parent] : [])];
	return {
		file(park, answerHint) {
			try {
				const title =
					`rpiv: ${park.workflow ?? "workflow"} needs an answer — ${park.questions[0]?.question ?? "question"}`.slice(
						0,
						120,
					);
				const ref = refFrom(
					exec(
						"kata",
						[
							"create",
							title,
							"--priority",
							"2",
							...extra,
							// Safe retry (kata ryvn): a second create for the same park returns
							// the ticket the first one filed rather than a duplicate.
							"--idempotency-key",
							parkKey(park),
							"--body-stdin",
							"--json",
						],
						ticketBody(park, answerHint),
					),
				);
				if (!ref) warn("kata create returned no ticket ref; the question is still in `rpiv-wf inbox`");
				return ref;
			} catch (err) {
				warn(`kata create failed: ${String(err)}; the question is still in \`rpiv-wf inbox\``);
				return undefined;
			}
		},
		close(park) {
			if (!park.kata) return;
			try {
				// kata 0.18 refuses `--done` without typed evidence and with a message
				// under 40 characters; the run/question pair is the evidence.
				exec("kata", [
					"close",
					park.kata,
					"--done",
					"--message",
					`Answered via rpiv-wf (run ${park.runId}, question #${park.n}): ${park.answer ?? "(no answer text)"}`,
					"--evidence",
					`external:rpiv-wf:${park.runId}#${park.n}`,
				]);
			} catch (err) {
				warn(`kata close ${park.kata} failed: ${String(err)}`);
			}
		},
	};
}
