/**
 * Wires the host's Parking hooks to the park store and (optionally) kata, for
 * one rpiv-wf run or resume. The runner announces the run id through lifecycle
 * events; the host names the stage that asked (falling back to the stage that
 * started last). A park calls `stop`, which rpiv-wf wires to a soft stop:
 * siblings already running finish and are kept, and no new turn starts.
 */

import type { LifecycleListeners } from "@juicesharp/rpiv-workflow";
import type { Parking } from "./claude-host.ts";
import type { Kata } from "./kata.ts";
import { addPark, answeredParkFor, answerMessage, type Park, type ParkedQuestion, updatePark } from "./park-store.ts";
import { appendLedgerRow } from "./run-ledger.ts";

export interface RunParking {
	parking: Parking;
	lifecycle: LifecycleListeners;
	/** Parks recorded during this invocation. */
	parked(): readonly Park[];
}

/** Keep only the fields a person needs from AskUserQuestion's input. */
export function toQuestions(raw: unknown): ParkedQuestion[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((q) => {
		if (!q || typeof q !== "object" || typeof (q as { question?: unknown }).question !== "string") return [];
		const r = q as { question: string; header?: unknown; options?: unknown; multiSelect?: unknown };
		const options = Array.isArray(r.options)
			? r.options
					.filter((o): o is { label: string; description?: unknown } => typeof o?.label === "string")
					.map((o) => ({
						label: o.label,
						...(typeof o.description === "string" ? { description: o.description } : {}),
					}))
			: [];
		return [
			{
				question: r.question,
				...(typeof r.header === "string" ? { header: r.header } : {}),
				options,
				...(r.multiSelect === true ? { multiSelect: true } : {}),
			},
		];
	});
}

export function createRunParking(opts: {
	cwd: string;
	/** Known up front on resume; announced by the runner on a fresh run. */
	runId?: string;
	kata?: Kata;
	stop: () => void;
	notify: (m: string) => void;
}): RunParking {
	let runId = opts.runId;
	let workflow: string | undefined;
	let stage: string | undefined;
	const recorded: Park[] = [];

	const parking: Parking = {
		park(info) {
			if (!runId) {
				opts.notify("a stage asked a question before the run id was known; stopping without parking it");
				opts.stop();
				return;
			}
			const asked = info.stage ?? stage;
			let park = addPark(opts.cwd, {
				runId,
				workflow,
				stage: asked,
				prompt: info.prompt,
				sessionId: info.sessionId,
				sessionFile: info.sessionFile,
				questions: toQuestions(info.questions),
				...(info.context ? { context: info.context } : {}),
			});
			const ref = opts.kata?.file(park, `rpiv-wf answer ${runId} ${park.n} <choice>`);
			if (ref) park = updatePark(opts.cwd, runId, park.n, { kata: ref }) ?? park;
			recorded.push(park);
			opts.notify(`parked ${asked ?? "stage"}: ${park.questions[0]?.question ?? "a question"}`);
			opts.stop();
		},
		answerFor(stageKey) {
			const park = runId && stageKey ? answeredParkFor(opts.cwd, runId, stageKey) : undefined;
			if (!park || !runId) return undefined;
			const id = runId;
			return {
				sessionId: park.sessionId,
				sessionFile: park.sessionFile,
				message: answerMessage(park),
				...(park.usage ? { usage: park.usage as never } : {}),
				delivered: () => {
					updatePark(opts.cwd, id, park.n, { status: "resumed" });
				},
			};
		},
	};

	parking.record = (row) => {
		if (runId) appendLedgerRow(opts.cwd, runId, { ts: new Date().toISOString(), ...row });
		opts.notify(`${row.type}${row.stage ? ` (${row.stage})` : ""}`);
	};

	parking.noteUsage = (sessionId, usage) => {
		const park = recorded.find((p) => p.sessionId === sessionId);
		if (park && runId) updatePark(opts.cwd, runId, park.n, { usage: usage as never });
	};

	parking.noteContext = (sessionId, context) => {
		const park = recorded.find((p) => p.sessionId === sessionId);
		if (!park || !runId || !context || context === park.context) return;
		const updated = updatePark(opts.cwd, runId, park.n, { context });
		if (updated) recorded[recorded.indexOf(park)] = updated;
	};

	const lifecycle: LifecycleListeners = {
		onWorkflowStart(ctx) {
			runId = ctx.runId;
			workflow = ctx.workflow;
		},
		onStageStart(ref) {
			stage = ref.name;
		},
	};

	return { parking, lifecycle, parked: () => recorded };
}
