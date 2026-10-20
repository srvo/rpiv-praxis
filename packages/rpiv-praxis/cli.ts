/**
 * rpiv-wf — run rpiv-workflow pipelines on Claude Code, no Pi process.
 *
 *   rpiv-wf list
 *   rpiv-wf run <workflow> [input…] [--name N] [--model M] [--concurrency N]
 *                                   [--permission-mode M] [--plugin-dir D] [--cwd D]
 *   rpiv-wf resume <run-id|name>    [same flags]
 *   rpiv-wf step <skill> [args…]    one skill as a one-stage run (output checked, logged, resumable)
 *   rpiv-wf steps                   skills a step can run
 *   rpiv-wf eval <spec.json>        compare variants (model, effort, tools, memory) on one workflow
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
 * answer), 76 stopped at --max-cost, 124 stopped at --timeout, 130 interrupted.
 * A stopped run is resumable like an interrupted one.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { RunWorkflowResult, WorkflowHostContext } from "@juicesharp/rpiv-workflow";
import { type ClaudeHostDeps, ClaudeWorkflowHost } from "./claude-host.ts";
import { type CliIo, EXIT, reportInvocation } from "./cli-outcome.ts";
import { detectKata, type Kata, type KataOptions } from "./kata.ts";
import {
	formatPark,
	locateRun,
	openParksIn,
	readParks,
	resolveChoice,
	resolveRunId,
	updatePark,
} from "./park-store.ts";
import { createRunParking } from "./parking.ts";
import { discoverWorktrees, formatProgressMarkdown, type ProgressReport, reportProgress } from "./progress.ts";
import { registerRpivWorkflowSupport } from "./rpiv-support.ts";
import {
	generateRunAlias,
	hasRunAliasEntry,
	listRunAliases,
	registerRunAlias,
	reserveRunAlias,
	resolveRunAlias,
} from "./run-alias.ts";
import { mergeLifecycles, RunLedger } from "./run-ledger.ts";
import { defaultPluginDir, loadSkillCatalog, skillRegistryHost } from "./skills.ts";
import { registerStep, STEP_PREFIX, stepSkill, stepSkills, stepWorkflowName } from "./steps.ts";
import { addTurn, emptyTotals, listFlag } from "./usage.ts";

export { type CliIo, EXIT } from "./cli-outcome.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
const SETTING_SOURCES = ["user", "project", "local"] as const;
type SettingSource = (typeof SETTING_SOURCES)[number];

const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;
type PermissionMode = (typeof PERMISSION_MODES)[number];

const USAGE = `usage:
  rpiv-wf list
  rpiv-wf run <workflow> [input...] [options]
  rpiv-wf resume <run-id|name> [options]
  rpiv-wf step <skill> [args...] [options]
  rpiv-wf steps
  rpiv-wf eval <spec.json> [--dry-run] [--out <dir>]
  rpiv-wf eval --continue <eval-results dir>   finish an interrupted eval (--allow-drift: even if the code changed)
  rpiv-wf inbox
  rpiv-wf runs                         named runs shared by this repo's worktrees
  rpiv-wf progress [--json]            all authoring topics across linked worktrees + Kata
  rpiv-wf answer <run-id|name> <n> <choice...> [--no-resume] [options]

options:
  --name <name>              override the auto RPIV run alias; resume by name across worktrees
  --model <id>               Claude model for every stage (default: Claude Code's)
  --concurrency <n>          parallel fan-out units (default 4)
  --permission-mode <mode>   ${PERMISSION_MODES.join(" | ")} (default auto)
  --plugin-dir <dir>         rpiv Claude plugin (default: rpiv-pi/hosts/claude)
  --cwd <dir>                project directory (default: current)
  --effort <level>           low | medium | high | xhigh | max, for every stage
  --tools <a,b,...>          built-in tools stages may use (none = no built-ins)
  --disallowed-tools <a,b>   tools removed from every stage
  --setting-sources <a,b>    user,project,local (default all; none = no settings or CLAUDE.md memory)
  --max-cost <usd>           stop the run once it has cost this much in total, across resumes (exit 76, resumable)
  --timeout <minutes>        stop the run once it has run this long in total, across resumes (exit 124, resumable)
  --stage-max-cost <usd>     stop the run once any one stage has cost this much (exit 76)
  --stage-max-tokens <n>     stop the run once any one stage has used this many tokens (exit 76)
  --no-resume                answer: record the answer without resuming the run
  --park-confirmations       park routine confirmations too (default: take their (Recommended) option, logged)
  --auto-accept-checkpoints  let human-checkpoint stages pass without a person (logged in the run log)
  --kata <ref>               file each parked question's ticket under this phase ticket
  --kata-labels <a,b>        labels for parked-question tickets (default rpiv-parked,human)

<choice> is an option number, an option label, or free text.

exit codes: 0 completed, 1 failed, 2 usage, 75 parked (answer it), 76 stopped at
a cost/token cap, 124 stopped at --timeout, 130 interrupted. Stopped runs resume.

Usage (tokens always, cost when the SDK reports one) is written to the run's
JSONL as one row per stage turn, so caps count what earlier invocations spent.`;

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

/** The skill behind a step run, read from the run's header; undefined for any other run. */
async function stepOfRun(cwd: string, ref: string): Promise<string | undefined> {
	try {
		const { resolveRun } = await import("@juicesharp/rpiv-workflow/registration");
		const header = resolveRun(cwd, ref) as { workflow?: string } | undefined;
		return header?.workflow ? stepSkill(header.workflow) : undefined;
	} catch {
		return undefined;
	}
}

async function defaultDeps(): Promise<ClaudeHostDeps> {
	const sdk = await import("@anthropic-ai/claude-agent-sdk");
	return { query: sdk.query, forkSession: sdk.forkSession };
}

/** Exit codes a stop signal ends the process with (128 + signal number). */
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

/**
 * The first SIGINT, SIGTERM or SIGHUP asks the run to stop resumably (it then
 * ends through the normal path and writes its terminal row). A second one
 * exits now with 128 + the signal number; `process.exit` still fires `exit`,
 * so the ledger's exit handler writes the terminal row. Without a listener,
 * Node dies on these signals without emitting `exit` at all (kata grt7).
 */
export function handleStopSignals(
	controller: AbortController,
	proc: { on(event: string, fn: () => void): unknown; exit(code: number): void } = process,
): void {
	for (const [sig, code] of Object.entries(SIGNAL_EXIT)) {
		proc.on(sig, () => {
			if (controller.signal.aborted) proc.exit(code);
			else controller.abort();
		});
	}
}

/** True when `code` is the exit a stop signal produces. */
const isSignalExit = (code: number): boolean => Object.values(SIGNAL_EXIT).some((c) => c === code);

/** Why a process exit code ended a run that never returned. */
function exitReason(code: number): string {
	const sig = Object.entries(SIGNAL_EXIT).find(([, c]) => c === code)?.[0];
	return `process exited (code ${code}${sig ? `, ${sig}` : ""}) before the run returned`;
}

/** Register a process `exit` listener; returns its removal. */
const onProcessExit = (fn: (code: number) => void): (() => void) => {
	process.on("exit", fn);
	return () => process.off("exit", fn);
};

export async function main(
	argv: readonly string[],
	io: CliIo = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) },
	inject: {
		api?: WorkflowApi;
		deps?: ClaudeHostDeps;
		signal?: AbortSignal;
		kata?: Kata | null;
		/** Builds the kata client when `kata` is not injected (tests). */
		detectKata?: typeof detectKata;
		metricsFile?: string;
		progressReport?: (cwd: string) => ProgressReport;
		/** Registers the process `exit` listener that writes a terminal row for a run that never returns (tests). */
		onExit?: (fn: (code: number) => void) => () => void;
	} = {},
): Promise<number> {
	let parsed: ReturnType<
		typeof parseArgs<{
			allowPositionals: true;
			options: Record<string, { type: "string" | "boolean"; short?: string }>;
		}>
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
				effort: { type: "string" },
				tools: { type: "string" },
				"disallowed-tools": { type: "string" },
				"setting-sources": { type: "string" },
				out: { type: "string" },
				"max-cost": { type: "string" },
				timeout: { type: "string" },
				"stage-max-cost": { type: "string" },
				"stage-max-tokens": { type: "string" },
				continue: { type: "string" },
				"allow-drift": { type: "boolean" },
				"dry-run": { type: "boolean" },
				json: { type: "boolean" },
				kata: { type: "string" },
				"auto-accept-checkpoints": { type: "boolean" },
				"park-confirmations": { type: "boolean" },
				"kata-labels": { type: "string" },
				help: { type: "boolean", short: "h" },
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
		effort?: string;
		tools?: string;
		"disallowed-tools"?: string;
		"setting-sources"?: string;
		out?: string;
		"max-cost"?: string;
		timeout?: string;
		"stage-max-cost"?: string;
		"stage-max-tokens"?: string;
		continue?: string;
		"allow-drift"?: boolean;
		"dry-run"?: boolean;
		json?: boolean;
		help?: boolean;
	};
	const [command, target, ...rest] = parsed.positionals;
	if (values.help || command === "help") {
		io.out(USAGE);
		return EXIT.ok;
	}
	let cwd = resolve(values.cwd ?? process.cwd());
	const concurrency = Number(values.concurrency ?? 4);
	const mode = (values["permission-mode"] ?? "auto") as PermissionMode;
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		io.err(`--concurrency must be a positive integer\n${USAGE}`);
		return EXIT.usage;
	}
	const maxCost = values["max-cost"] === undefined ? undefined : Number(values["max-cost"]);
	const timeoutMin = values.timeout === undefined ? undefined : Number(values.timeout);
	const stageMaxCost = values["stage-max-cost"] === undefined ? undefined : Number(values["stage-max-cost"]);
	const stageMaxTokens = values["stage-max-tokens"] === undefined ? undefined : Number(values["stage-max-tokens"]);
	for (const [flag, v] of [
		["--max-cost", maxCost],
		["--timeout", timeoutMin],
		["--stage-max-cost", stageMaxCost],
		["--stage-max-tokens", stageMaxTokens],
	] as const) {
		if (v !== undefined && !(Number.isFinite(v) && v > 0)) {
			io.err(`${flag} must be a positive number\n${USAGE}`);
			return EXIT.usage;
		}
	}
	if (values.effort !== undefined && !EFFORTS.includes(values.effort as Effort)) {
		io.err(`unknown --effort "${values.effort}"\n${USAGE}`);
		return EXIT.usage;
	}
	const settingSources = listFlag(values["setting-sources"]);
	if (settingSources?.some((x) => !SETTING_SOURCES.includes(x as SettingSource))) {
		io.err(`--setting-sources takes user, project, local or none\n${USAGE}`);
		return EXIT.usage;
	}
	if (!PERMISSION_MODES.includes(mode)) {
		io.err(`unknown --permission-mode "${mode}"\n${USAGE}`);
		return EXIT.usage;
	}
	if (command === "eval") {
		if (!target && !values.continue) {
			io.err(USAGE);
			return EXIT.usage;
		}
		const { runEval } = await import("./eval.ts");
		return runEval(target ? resolve(target) : undefined, {
			outDir: values.out,
			dryRun: values["dry-run"],
			continueDir: values.continue ? resolve(values.continue) : undefined,
			allowDrift: values["allow-drift"],
			out: io.out,
			signal: inject.signal,
		});
	}

	const needsTarget = command === "run" || command === "resume" || command === "step";
	const known = needsTarget || ["list", "runs", "progress", "inbox", "answer", "steps"].includes(command ?? "");
	if (!known || (needsTarget && !target) || (command === "answer" && rest.length < 2)) {
		io.err(USAGE);
		return EXIT.usage;
	}

	if (command === "steps") {
		for (const s of stepSkills(cwd)) io.out(`${s.name}\t${s.source}\t${s.kind}`);
		return EXIT.ok;
	}

	if (command === "runs") {
		const aliases = listRunAliases(cwd);
		if (aliases.length === 0) io.out("no shared RPIV runs");
		for (const alias of aliases) io.out(`${alias.name}\t${alias.workflow}\t${alias.runId}\t${alias.cwd}`);
		return EXIT.ok;
	}
	if (command === "progress") {
		const report = (inject.progressReport ?? reportProgress)(cwd);
		io.out(values.json ? JSON.stringify(report, null, 2) : formatProgressMarkdown(report));
		return report.kata.available ? EXIT.ok : EXIT.failed;
	}
	if (command === "inbox") {
		const here = realpathOr(cwd);
		const open = openParksIn(discoverWorktrees(cwd));
		if (open.length === 0) io.out("nothing waiting");
		for (const p of open) {
			io.out(formatPark(p));
			if (p.cwd !== here) io.out(`  worktree: ${p.cwd}`);
		}
		return EXIT.ok;
	}

	const warn = (m: string) => io.err(`[warning] ${m}`);
	const kataOpts: KataOptions = {
		...(typeof values["kata-labels"] === "string" ? { labels: listFlag(values["kata-labels"]) ?? [] } : {}),
		...(typeof values.kata === "string" ? { parent: values.kata } : {}),
	};
	const kata =
		inject.kata === undefined
			? (inject.detectKata ?? detectKata)(warn, undefined, undefined, kataOpts)
			: (inject.kata ?? undefined);
	let resumeRef = target;
	let locatedRunId = command === "resume" || command === "answer" ? resolveRunId(cwd, target!) : undefined;
	if (!locatedRunId && (command === "resume" || command === "answer")) {
		const alias = resolveRunAlias(cwd, target!);
		const siblings = alias ? [] : locateRun(discoverWorktrees(cwd), target!);
		if (alias) {
			cwd = alias.cwd;
			locatedRunId = alias.runId;
			resumeRef = alias.runId;
			io.err(`[info] found RPIV run ${alias.name} in originating worktree ${alias.cwd}`);
		} else if (siblings.length === 1) {
			const [found] = siblings as [{ cwd: string; runId: string }];
			cwd = found.cwd;
			locatedRunId = found.runId;
			resumeRef = found.runId;
			io.err(`[info] found RPIV run ${found.runId} in worktree ${found.cwd}`);
		} else if (siblings.length > 1) {
			io.err(
				`RPIV run "${target}" exists in more than one worktree (${siblings.map((s) => s.cwd).join(", ")}); pass --cwd for the one you mean.`,
			);
			return EXIT.usage;
		}
		if (!alias && siblings.length === 0 && hasRunAliasEntry(cwd, target!)) {
			io.err(
				`RPIV run alias "${target}" is stale or unreadable; its original worktree/run may have been removed. Run \`rpiv-wf runs\` for available runs.`,
			);
			return EXIT.usage;
		}
	}
	if (command === "answer") {
		const runId = locatedRunId ?? resolveRunId(cwd, target!);
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
		for (const w of workflows.filter((x) => !x.name.startsWith(STEP_PREFIX))) {
			io.out(w.description ? `${w.name}\t${w.description}` : w.name);
		}
		// `run` refuses on any error-severity issue; say so here rather than list a set it will not run.
		for (const i of issues) io.err(`[${i.severity}] ${i.message}`);
		return issues.some((i) => i.severity === "error") ? EXIT.failed : EXIT.ok;
	}

	// A step run (or the resume of one) registers its one-stage workflow, and only that one.
	const step = command === "step" ? target : command !== "run" ? await stepOfRun(cwd, resumeRef!) : undefined;
	if (step && !(await registerStep(step, cwd))) {
		io.err(`no skill "${step}" — see \`rpiv-wf steps\``);
		return EXIT.usage;
	}
	const workflowName = command === "step" ? stepWorkflowName(target!) : target!;
	// RPIV_NO_SHARED_ALIAS keeps a run's name local: evals name every trial, and publishing
	// each attempt to the shared registry would grow it one entry per trial.
	const shareName = process.env.RPIV_NO_SHARED_ALIAS !== "1";
	const runAlias =
		command === "run" || command === "step"
			? (values.name ?? generateRunAlias(workflowName, rest.join(" ")))
			: undefined;
	if (runAlias && hasRunAliasEntry(cwd, runAlias)) {
		const existing = resolveRunAlias(cwd, runAlias);
		io.err(
			existing
				? `RPIV run alias "${runAlias}" already belongs to ${existing.runId} in ${existing.cwd}; resume that run or choose another --name`
				: `RPIV run alias "${runAlias}" is stale or unreadable; choose a new --name or explicitly repair it after checking its originating worktree/run.`,
		);
		return EXIT.usage;
	}

	const pluginDir = resolve(values["plugin-dir"] ?? defaultPluginDir());
	const catalog = loadSkillCatalog(pluginDir, cwd);
	if (catalog.plugin.size === 0) {
		io.err(`no skills found under ${pluginDir}/skills — run \`npm run export:hosts\` or pass --plugin-dir`);
		return EXIT.usage;
	}
	const totals = emptyTotals();
	const stop = new AbortController();
	const halt = new AbortController();
	let limit: "budget" | "timeout" | undefined;
	const stopFor = (why: "budget" | "timeout", message: string) => {
		if (limit) return;
		limit = why;
		io.err(
			why === "budget"
				? `[warning] ${message}; finishing turns in flight, starting no new ones`
				: `[warning] ${message}; stopping (resume with \`rpiv-wf resume\`)`,
		);
		// A budget stop lets running turns finish (their work is kept); a timeout cuts them off.
		(why === "budget" ? halt : stop).abort();
	};
	const priorRunId = command === "run" || command === "step" ? undefined : resolveRunId(cwd, resumeRef!);
	const ledger = new RunLedger(cwd, priorRunId ? "resumed" : "run", priorRunId);
	// Every invocation ends with a terminal row, even one that never returns (kata grt7).
	const offExit = (inject.onExit ?? onProcessExit)((code) =>
		ledger.terminal(isSignalExit(code) ? "aborted" : "failed", exitReason(code), code),
	);
	// --timeout counts the wall-clock earlier invocations of this run already used.
	const timer =
		timeoutMin === undefined
			? undefined
			: setTimeout(
					() => stopFor("timeout", `--timeout ${timeoutMin} min reached`),
					Math.max(0, timeoutMin * 60_000 - ledger.totals.elapsedMs),
				);
	timer?.unref();
	let costUnreportedWarned = false;
	const checkCaps = (stage: string | undefined) => {
		const t = ledger.totals;
		if (maxCost !== undefined && t.costReported && t.costUsd >= maxCost) {
			stopFor("budget", `--max-cost $${maxCost} reached ($${t.costUsd.toFixed(4)} across the run)`);
		}
		if (maxCost !== undefined && !t.costReported && t.tokens > 0 && !costUnreportedWarned) {
			costUnreportedWarned = true;
			warn("--max-cost cannot be enforced: the SDK reports no cost for these turns (tokens are still recorded)");
		}
		const s = stage === undefined ? undefined : t.stages[stage];
		if (s && stageMaxCost !== undefined && s.costUsd >= stageMaxCost) {
			stopFor("budget", `stage "${stage}" reached --stage-max-cost $${stageMaxCost} ($${s.costUsd.toFixed(4)})`);
		}
		if (s && stageMaxTokens !== undefined && s.tokens >= stageMaxTokens) {
			stopFor("budget", `stage "${stage}" reached --stage-max-tokens ${stageMaxTokens} (${s.tokens})`);
		}
	};
	checkCaps(undefined);
	inject.signal?.addEventListener("abort", () => stop.abort(), { once: true });
	if (inject.signal?.aborted) stop.abort();
	const runParking = createRunParking({
		cwd,
		runId: priorRunId,
		kata,
		// Soft stop: siblings already running finish and are kept; no new turn starts.
		stop: () => halt.abort(),
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
			halt: halt.signal,
			notify: (m, l = "info") => io.err(`[${l}] ${m}`),
			parking: runParking.parking,
			...(values["auto-accept-checkpoints"] === true ? { autoAcceptCheckpoints: true } : {}),
			autoAcceptConfirmations: values["park-confirmations"] !== true,
			...(values.effort ? { effort: values.effort as Effort } : {}),
			...(values.tools !== undefined ? { tools: listFlag(values.tools) } : {}),
			...(values["disallowed-tools"] !== undefined ? { disallowedTools: listFlag(values["disallowed-tools"]) } : {}),
			...(settingSources ? { settingSources: settingSources as SettingSource[] } : {}),
			onUsage: (u, info = { sessionId: "" }) => {
				addTurn(totals, u);
				ledger.record(u, info);
				checkCaps(info.stage);
			},
			onTurnStart: checkCaps,
		},
		inject.deps ?? (await defaultDeps()),
	);
	let sharedAliasRunId: string | undefined;
	const opts = {
		host: skillRegistryHost(catalog),
		signal: stop.signal,
		lifecycle: mergeLifecycles(ledger.lifecycle, runParking.lifecycle, {
			onWorkflowStart: (ctx) => {
				if (runAlias && shareName) {
					if (registerRunAlias(cwd, runAlias, ctx.runId, workflowName)) sharedAliasRunId = ctx.runId;
					else warn(`could not share run alias "${runAlias}"; its run files remain available only under ${cwd}`);
				}
			},
		}),
		trigger: { kind: "programmatic", source: "rpiv-praxis" },
		...(runAlias ? { name: runAlias } : {}),
		// --model is every stage's default; a pack's per-stage pin overrides it, and
		// its escalation ladder climbs from it (the engine must see it to do either).
		...(values.model ? { resolveModel: () => ({ model: values.model as string }) } : {}),
	};
	let releaseAlias: (() => void) | undefined;
	try {
		try {
			if (runAlias && shareName) releaseAlias = reserveRunAlias(cwd, runAlias);
		} catch (error) {
			io.err(error instanceof Error ? error.message : String(error));
			return EXIT.usage;
		}
		const result =
			command === "run" || command === "step"
				? await api.runWorkflowByName(host, workflowName, rest.join(" "), opts)
				: await api.resumeWorkflowByRunId(host, resumeRef!, opts);
		if (runAlias && result.runId && sharedAliasRunId === result.runId) io.out(`run alias: ${runAlias}`);
		return reportInvocation({
			result,
			parked: runParking.parked(),
			limit,
			interrupted: inject.signal?.aborted ?? false,
			ledger,
			io,
			totals,
			metricsFile: inject.metricsFile ?? process.env.RPIV_WF_METRICS_FILE,
		});
	} catch (err) {
		ledger.terminal("failed", `rpiv-wf threw: ${err instanceof Error ? err.message : String(err)}`, EXIT.failed);
		throw err;
	} finally {
		releaseAlias?.();
		offExit();
		if (timer) clearTimeout(timer);
	}
}

function realpathOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}
