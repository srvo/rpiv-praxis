/**
 * kata tickets for parked questions — optional, and never in the way.
 *
 * Active only when a `kata` executable is on PATH (set RPIV_WF_KATA=off to
 * opt out). A park files one ticket labelled `rpiv-parked`; answering closes
 * it. Deliberately NOT `human` or `decision`: monocloud's hourly producer
 * surfaces those two labels to activity.timeline, and parked questions stay
 * out of the database for now.
 *
 * Every failure is reported and swallowed: a missing or broken kata must
 * never stop a question from parking or an answer from resuming.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { Park } from "./park-store.js";

export const KATA_LABEL = "rpiv-parked";

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
		qs,
		`Answer with:\n\n    ${answerHint}`,
	].join("\n\n");
}

/** A kata client, or undefined when kata is unavailable or switched off. */
export function detectKata(
	warn: (m: string) => void,
	exec: Exec = realExec,
	env: NodeJS.ProcessEnv = process.env,
): Kata | undefined {
	if (env.RPIV_WF_KATA === "off" || !onPath("kata", env)) return undefined;
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
						["create", title, "--priority", "2", "--body-stdin", "--json"],
						ticketBody(park, answerHint),
					),
				);
				if (!ref) {
					warn("kata create returned no ticket ref; the question is still in `rpiv-wf inbox`");
					return undefined;
				}
				try {
					exec("kata", ["label", "add", ref, KATA_LABEL]);
				} catch (err) {
					warn(`kata label add ${ref} failed: ${String(err)}`);
				}
				return ref;
			} catch (err) {
				warn(`kata create failed: ${String(err)}; the question is still in \`rpiv-wf inbox\``);
				return undefined;
			}
		},
		close(park) {
			if (!park.kata) return;
			try {
				exec("kata", ["close", park.kata, "--done", "--message", `Answered via rpiv-wf: ${park.answer ?? ""}`]);
			} catch (err) {
				warn(`kata close ${park.kata} failed: ${String(err)}`);
			}
		},
	};
}
