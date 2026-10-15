/**
 * rpiv-wf — run rpiv-workflow pipelines on Claude Code, no Pi process.
 *
 *   rpiv-wf list
 *   rpiv-wf run <workflow> [input…] [--name N] [--model M] [--concurrency N]
 *                                   [--permission-mode M] [--plugin-dir D] [--cwd D]
 *   rpiv-wf resume <run-id|name>    [same flags]
 *   rpiv-wf inbox                   questions parked runs are waiting on
 *   rpiv-wf answer <run> <n> <choice…> [--no-resume] [same flags]
 *
 * Same catalog as `/wf` in Pi: rpiv-pi's built-ins, then user and project
 * overlays (`.rpiv/workflows/`). Run state lands in `.rpiv/workflows/runs/`,
 * so a run started here can be listed or resumed from Pi and vice versa.
 *
 * A stage that asks a question (AskUserQuestion) does not guess: the run parks
 * at that stage, the question lands in the inbox (and a kata ticket when kata
 * is installed), and `answer` resumes the stage in its own session.
 *
 * Exit codes: 0 completed, 1 failed, 2 usage error, 75 parked (waiting on an
 * answer), 130 interrupted.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RunWorkflowResult, WorkflowHostContext } from "@juicesharp/rpiv-workflow";
import { type ClaudeHostDeps, ClaudeWorkflowHost } from "./claude-host.js";
import { detectKata, type Kata } from "./kata.js";
import { formatPark, openParks, readParks, resolveChoice, resolveRunId, updatePark } from "./park-store.js";
import { createRunParking } from "./parking.js";
import { registerRpivWorkflowSupport } from "./rpiv-support.js";
import { defaultPluginDir, loadSkillCatalog, skillRegistryHost } from "./skills.js";

export const EXIT = { ok: 0, failed: 1, usage: 2, parked: 75, interrupted: 130 } as const;

const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;
type PermissionMode = (typeof PERMISSION_MODES)[number];

const USAGE = `usage:
  rpiv-wf list
  rpiv-wf run <workflow> [input...] [options]
  rpiv-wf resume <run-id|name> [options]
  rpiv-wf inbox
  rpiv-wf answer <run-id|name> <n> <choice...> [--no-resume] [options]

options:
  --name <name>              name the run (resume it later by name)
  --model <id>               Claude model for every stage (default: Claude Code's)
  --concurrency <n>          parallel fan-out units (default 4)
  --permission-mode <mode>   ${PERMISSION_MODES.join(" | ")} (default auto)
  --plugin-dir <dir>         rpiv Claude plugin (default: rpiv-pi/hosts/claude)
  --cwd <dir>                project directory (default: current)
  --no-resume                answer: record the answer without resuming the run

<choice> is an option number, an option label, or free text.`;

export interface CliIo {
	out: (line: string) => void;
	err: (line: string) => void;
}

/** The workflow API, injectable so tests drive the CLI without the runner. */
export interface WorkflowApi {
	loadWorkflows(cwd: string): Promise<{
		workflows: readonly { name: string; description?: string }[];
		issues?: readonly { severity: string; message: string }[];
	}>;
	runWorkflowByName(ctx: WorkflowHostContext, name: string, input: string, opts: object): Promise<RunWorkflowResult>;
	resumeWorkflowByRunId(ctx: WorkflowHostContext, ref: string, opts: object): Promise<RunWorkflowResult>;
}

async function defaultApi(cwd: string): Promise<WorkflowApi> {
	await registerRpivWorkflowSupport(cwd);
	const { loadWorkflows } = await import("@juicesharp/rpiv-workflow/registration");
	const { runWorkflowByName, resumeWorkflowByRunId } = await import("@juicesharp/rpiv-workflow/runner");
	return { loadWorkflows, runWorkflowByName, resumeWorkflowByRunId } as WorkflowApi;
}

async function defaultDeps(): Promise<ClaudeHostDeps> {
	const sdk = await import("@anthropic-ai/claude-agent-sdk");
	return { query: sdk.query, forkSession: sdk.forkSession };
}

function report(result: RunWorkflowResult, io: CliIo): number {
	const where = result.runId ? ` (run ${result.runId})` : "";
	if (result.success) {
		io.out(`completed${where}: ${result.stagesCompleted} stage(s)`);
		if (result.lastArtifact) io.out(`artifact: ${result.lastArtifact}`);
		return EXIT.ok;
	}
	io.err(`failed${where} after ${result.stagesCompleted} stage(s): ${result.error ?? "unknown error"}`);
	return EXIT.failed;
}

export async function main(
	argv: readonly string[],
	io: CliIo = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) },
	inject: { api?: WorkflowApi; deps?: ClaudeHostDeps; signal?: AbortSignal; kata?: Kata | null } = {},
): Promise<number> {
	let parsed: ReturnType<
		typeof parseArgs<{ allowPositionals: true; options: Record<string, { type: "string" | "boolean" }> }>
	>;
	try {
		parsed = parseArgs({
			args: [...argv],
			allowPositionals: true,
			options: {
				name: { type: "string" },
				model: { type: "string" },
				concurrency: { type: "string" },
				"permission-mode": { type: "string" },
				"plugin-dir": { type: "string" },
				cwd: { type: "string" },
				"no-resume": { type: "boolean" },
			},
		});
	} catch (err) {
		io.err(`${(err as Error).message}\n${USAGE}`);
		return EXIT.usage;
	}
	const values = parsed.values as Record<string, string | boolean | undefined> & {
		name?: string;
		model?: string;
		concurrency?: string;
		"permission-mode"?: string;
		"plugin-dir"?: string;
		cwd?: string;
		"no-resume"?: boolean;
	};
	const [command, target, ...rest] = parsed.positionals;
	const cwd = resolve(values.cwd ?? process.cwd());
	const concurrency = Number(values.concurrency ?? 4);
	const mode = (values["permission-mode"] ?? "auto") as PermissionMode;
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		io.err(`--concurrency must be a positive integer\n${USAGE}`);
		return EXIT.usage;
	}
	if (!PERMISSION_MODES.includes(mode)) {
		io.err(`unknown --permission-mode "${mode}"\n${USAGE}`);
		return EXIT.usage;
	}
	const needsTarget = command === "run" || command === "resume";
	const known = needsTarget || command === "list" || command === "inbox" || command === "answer";
	if (!known || (needsTarget && !target) || (command === "answer" && rest.length < 2)) {
		io.err(USAGE);
		return EXIT.usage;
	}

	if (command === "inbox") {
		const open = openParks(cwd);
		if (open.length === 0) io.out("nothing waiting");
		for (const p of open) io.out(formatPark(p));
		return EXIT.ok;
	}

	const warn = (m: string) => io.err(`[warning] ${m}`);
	const kata = inject.kata === undefined ? detectKata(warn) : (inject.kata ?? undefined);
	let resumeRef = target;
	if (command === "answer") {
		const runId = resolveRunId(cwd, target!);
		const n = Number(rest[0]);
		const park = runId ? readParks(cwd, runId).find((p) => p.n === n) : undefined;
		if (!runId || !park) {
			io.err(`no parked question #${rest[0]} for run "${target}" — see \`rpiv-wf inbox\``);
			return EXIT.usage;
		}
		if (park.status === "resumed") {
			io.err(`question #${n} of ${runId} was already answered and delivered`);
			return EXIT.usage;
		}
		const answer = resolveChoice(park, rest.slice(1).join(" "));
		const updated = updatePark(cwd, runId, n, { status: "answered", answer, answeredAt: new Date().toISOString() });
		if (updated) kata?.close(updated);
		io.out(`answered ${runId} #${n}: ${answer}`);
		if (values["no-resume"]) return EXIT.ok;
		resumeRef = runId;
	}

	const api = inject.api ?? (await defaultApi(cwd));
	if (command === "list") {
		const { workflows, issues = [] } = await api.loadWorkflows(cwd);
		for (const w of workflows) io.out(w.description ? `${w.name}\t${w.description}` : w.name);
		// `run` refuses on any error-severity issue; say so here rather than list a set it will not run.
		for (const i of issues) io.err(`[${i.severity}] ${i.message}`);
		return issues.some((i) => i.severity === "error") ? EXIT.failed : EXIT.ok;
	}

	const pluginDir = resolve(values["plugin-dir"] ?? defaultPluginDir());
	const catalog = loadSkillCatalog(pluginDir, cwd);
	if (catalog.plugin.size === 0) {
		io.err(`no skills found under ${pluginDir}/skills — run \`npm run export:hosts\` or pass --plugin-dir`);
		return EXIT.usage;
	}
	const stop = new AbortController();
	inject.signal?.addEventListener("abort", () => stop.abort(), { once: true });
	if (inject.signal?.aborted) stop.abort();
	const runParking = createRunParking({
		cwd,
		runId: command === "run" ? undefined : resolveRunId(cwd, resumeRef!),
		kata,
		stop: () => stop.abort(),
		notify: (m) => io.err(`[info] ${m}`),
	});
	const host = new ClaudeWorkflowHost(
		{
			cwd,
			pluginDir,
			catalog,
			permissionMode: mode,
			maxConcurrency: concurrency,
			model: values.model,
			signal: stop.signal,
			notify: (m, l = "info") => io.err(`[${l}] ${m}`),
			parking: runParking.parking,
		},
		inject.deps ?? (await defaultDeps()),
	);
	const opts = {
		host: skillRegistryHost(catalog),
		signal: stop.signal,
		lifecycle: runParking.lifecycle,
		trigger: { kind: "programmatic", source: "rpiv-claude" },
		...(values.name ? { name: values.name } : {}),
	};
	const result =
		command === "run"
			? await api.runWorkflowByName(host, target!, rest.join(" "), opts)
			: await api.resumeWorkflowByRunId(host, resumeRef!, opts);
	const parked = runParking.parked();
	if (parked.length > 0) {
		for (const p of parked) io.out(formatPark(p));
		io.out(`parked: answer with \`rpiv-wf answer ${parked[0]!.runId} ${parked[0]!.n} <choice>\``);
		return EXIT.parked;
	}
	if (inject.signal?.aborted) {
		io.err("interrupted");
		return EXIT.interrupted;
	}
	return report(result, io);
}
