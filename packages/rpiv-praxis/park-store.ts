/**
 * Parked questions: a stage that needs a person, recorded beside its run log.
 *
 * When a stage calls AskUserQuestion in an unattended run, the host stops the
 * run and saves the question here, in `.rpiv/workflows/runs/<runId>.parked.json`
 * next to the run's own `<runId>.jsonl`. The run log keeps its upstream format;
 * this sidecar is the only new file. `rpiv-wf inbox` lists what is waiting,
 * `rpiv-wf answer` records a choice, and the resumed run reopens the parked
 * stage's own session with the answer instead of starting the stage over.
 *
 *   waiting  → asked, no answer yet
 *   answered → answer recorded, run not yet resumed
 *   resumed  → the answer was delivered to the stage
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ParkedOption {
	label: string;
	description?: string;
}

export interface ParkedQuestion {
	question: string;
	header?: string;
	options: ParkedOption[];
	multiSelect?: boolean;
}

export interface Park {
	/** 1-based, stable within its run. */
	n: number;
	runId: string;
	workflow?: string;
	stage?: string;
	/** The stage prompt as the runner sent it (pre-translation): the key that finds this park on resume. */
	prompt: string;
	sessionId: string;
	sessionFile?: string;
	questions: ParkedQuestion[];
	/** What the stage wrote before it asked: the text its question refers to ("the issues above"). */
	context?: string;
	status: "waiting" | "answered" | "resumed";
	askedAt: string;
	answer?: string;
	answeredAt?: string;
	/** kata ticket ref, when one was filed. */
	kata?: string;
	/** The parked session's cumulative usage: the resumed turns' cost baseline. */
	usage?: { costUsd: number; models: Record<string, Record<string, number>> };
}

export const runsDir = (cwd: string): string => join(cwd, ".rpiv", "workflows", "runs");
const parkFile = (cwd: string, runId: string): string => join(runsDir(cwd), `${runId}.parked.json`);

export function readParks(cwd: string, runId: string): Park[] {
	const file = parkFile(cwd, runId);
	if (!existsSync(file)) return [];
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { parks?: unknown };
		return Array.isArray(parsed.parks) ? (parsed.parks as Park[]) : [];
	} catch {
		return [];
	}
}

function writeParks(cwd: string, runId: string, parks: Park[]): void {
	const file = parkFile(cwd, runId);
	mkdirSync(runsDir(cwd), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ runId, parks }, null, "\t")}\n`);
	renameSync(tmp, file);
}

export function addPark(cwd: string, park: Omit<Park, "n" | "status" | "askedAt">, now = new Date()): Park {
	const parks = readParks(cwd, park.runId);
	const added: Park = {
		...park,
		n: parks.reduce((m, p) => Math.max(m, p.n), 0) + 1,
		status: "waiting",
		askedAt: now.toISOString(),
	};
	writeParks(cwd, park.runId, [...parks, added]);
	return added;
}

export function updatePark(cwd: string, runId: string, n: number, patch: Partial<Park>): Park | undefined {
	const parks = readParks(cwd, runId);
	const i = parks.findIndex((p) => p.n === n);
	if (i === -1) return undefined;
	parks[i] = { ...parks[i]!, ...patch };
	writeParks(cwd, runId, parks);
	return parks[i];
}

/** Every park in the project not yet delivered to its stage, oldest first. */
export function openParks(cwd: string): Park[] {
	const dir = runsDir(cwd);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".parked.json"))
		.flatMap((f) => readParks(cwd, f.slice(0, -".parked.json".length)))
		.filter((p) => p.status !== "resumed")
		.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
}
/** The oldest answered park for this run and stable stage identity. Prompt text is not an identity. */
export function answeredParkFor(cwd: string, runId: string, stage: string): Park | undefined {
	const next = readParks(cwd, runId)
		.filter((park) => park.stage === stage && park.status !== "resumed")
		.sort((a, b) => a.n - b.n)[0];
	return next?.status === "answered" ? next : undefined;
}

/** A run reference (name or id) → its run id, via the runner's `names.json`. */
export function resolveRunId(cwd: string, ref: string): string | undefined {
	if (existsSync(join(runsDir(cwd), `${ref}.jsonl`))) return ref;
	try {
		const names = JSON.parse(readFileSync(join(runsDir(cwd), "names.json"), "utf8")) as Record<string, string>;
		return typeof names[ref] === "string" ? names[ref] : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Turn what a person typed into the answer text: an option number (`2`) or an
 * exact label picks that option; anything else is a free-text answer, which
 * AskUserQuestion also allows.
 */
export function resolveChoice(park: Park, choice: string): string {
	const trimmed = choice.trim();
	const options = park.questions[0]?.options ?? [];
	const byNumber = /^\d+$/.test(trimmed) ? options[Number(trimmed) - 1] : undefined;
	const byLabel = options.find((o) => o.label.toLowerCase() === trimmed.toLowerCase());
	return (byNumber ?? byLabel)?.label ?? trimmed;
}

/** The message a resumed stage receives in place of the question it parked on. */
export function answerMessage(park: Park): string {
	const asked = park.questions.map((q) => `- ${q.question}`).join("\n");
	return [
		"The person answered the question you parked on.",
		`Question:\n${asked}`,
		`Answer: ${park.answer}`,
		"Continue the task from where you stopped, using this answer.",
	].join("\n\n");
}

/** One inbox entry, as printed by `rpiv-wf inbox`. */
export function formatPark(p: Park): string {
	const where = [p.workflow, p.stage].filter(Boolean).join(" › ");
	const lines = [`${p.runId} #${p.n}  ${where}  (${p.status}, asked ${p.askedAt})${p.kata ? `  kata ${p.kata}` : ""}`];
	if (p.context) {
		lines.push("  context:");
		for (const l of p.context.split("\n")) lines.push(l ? `    ${l}` : "");
	}
	for (const q of p.questions) {
		lines.push(`  ${q.header ? `[${q.header}] ` : ""}${q.question}`);
		q.options.forEach((o, i) => {
			lines.push(`    ${i + 1}) ${o.label}${o.description ? ` — ${o.description}` : ""}`);
		});
	}
	if (p.answer) lines.push(`  answer: ${p.answer}`);
	return lines.join("\n");
}
