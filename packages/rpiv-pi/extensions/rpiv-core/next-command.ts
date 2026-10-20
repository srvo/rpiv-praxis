import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	getNextTargetCommands,
	hasNextCommandCollision,
	NEXT_AUTHORIZATION_ENTRY,
	NEXT_RECEIPT_ENTRY,
	type NextAuthorization,
	registerNextTargetCommands,
	restoreNextAttempt,
} from "./next-authorization.ts";
import { RPIV_STAGE_NAMES } from "./pipeline-pointer.ts";
import { listLanes } from "./run-lane-registry.ts";
export const NEXT_APPROVAL_MARKER = "Reply /next to run only the step above in a fresh session.";

export interface NextHandoff {
	sourceEntryId: string;
	command: string;
	stageName: (typeof RPIV_STAGE_NAMES)[number];
	workingDirectory: string;
	inputArtifact: string;
	branch: string;
	kataIssue: string;
}

export type NextHandoffSelection = { ok: true; handoff: NextHandoff } | { ok: false; reason: string };

type SessionMessageEntry = {
	type: string;
	parentId?: string | null;
	timestamp?: string;
	id: string;
	message?: {
		role?: string;
		stopReason?: string;
		content?: unknown;
	};
};

const fail = (reason: string): NextHandoffSelection => ({ ok: false, reason });
const absolutePath = (value: string): boolean => isAbsolute(value) && !/[\r\n{}]/.test(value) && !value.includes("${");
const isWithin = (directory: string, target: string): boolean => {
	const pathFromDirectory = relative(resolve(directory), resolve(target));
	return (
		pathFromDirectory === "" ||
		(!pathFromDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && pathFromDirectory !== "..")
	);
};

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return (
				!!part &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
			);
		})
		.map((part) => part.text)
		.join("\n");
}

function topLevelLines(text: string): { lines: string[]; topLevel: boolean[] } {
	const lines = text.split(/\r?\n/);
	const topLevel: boolean[] = [];
	let fence: { char: string; length: number } | undefined;

	for (const line of lines) {
		const trimmed = line.trimStart();
		const marker = trimmed.match(/^(`{3,}|~{3,})/);
		if (fence) {
			topLevel.push(false);
			if (
				marker &&
				marker[1]![0] === fence.char &&
				marker[1]!.length >= fence.length &&
				trimmed.trim().length === marker[1]!.length
			) {
				fence = undefined;
			}
			continue;
		}
		if (marker) {
			fence = { char: marker[1]![0]!, length: marker[1]!.length };
			topLevel.push(false);
			continue;
		}
		topLevel.push(!/^\s*>/.test(line) && !/^(?: {4}|\t)/.test(line));
	}
	return { lines, topLevel };
}

function fieldValue(line: string, label: string): string | undefined {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = line.match(new RegExp(`^\\*\\*${escaped}:\\*\\* \`([^\`\\r\\n]+)\`$`));
	return match?.[1];
}

function parseClosingFooter(
	text: string,
):
	| Pick<NextHandoff, "command" | "stageName" | "workingDirectory" | "inputArtifact" | "branch" | "kataIssue">
	| { error: string } {
	const { lines, topLevel } = topLevelLines(text);
	let finalLine = lines.length - 1;
	while (finalLine >= 0 && !lines[finalLine]!.trim()) finalLine--;
	if (finalLine < 0 || !topLevel[finalLine] || lines[finalLine] !== NEXT_APPROVAL_MARKER) {
		return { error: "No top-level /next approval marker at the end of the latest assistant message." };
	}

	const defaultIndexes = lines.flatMap((line, index) => {
		return topLevel[index] && /^\*\*Next step(?: \(default\))?:\*\*/.test(line) ? [index] : [];
	});
	if (defaultIndexes.length !== 1)
		return { error: "The latest assistant message must contain exactly one default next-step field." };
	const start = defaultIndexes[0]!;
	if (start >= finalLine) return { error: "The default next-step field must precede the final approval marker." };

	const commandMatch = lines[start]!.match(/^\*\*Next step(?: \(default\))?:\*\* `([^`\r\n]+)`(?:\s+[—–-].*)?$/u);
	const readUniqueField = (label: string): string | undefined => {
		const indexes = lines.flatMap((line, index) =>
			topLevel[index] && line.startsWith(`**${label}:**`) ? [index] : [],
		);
		if (indexes.length !== 1 || indexes[0]! <= start || indexes[0]! >= finalLine) return undefined;
		return fieldValue(lines[indexes[0]]!, label);
	};
	const workingDirectory = readUniqueField("Working directory");
	const inputArtifact = readUniqueField("Input artifact");
	const branch = readUniqueField("Branch");
	const kataIssue = readUniqueField("Kata issue");
	if (
		!topLevel.slice(start, finalLine + 1).every(Boolean) ||
		!commandMatch ||
		!workingDirectory ||
		!inputArtifact ||
		!branch ||
		!kataIssue
	) {
		return { error: "The closing handoff is missing or malformed; /next requires all five fields." };
	}

	const command = commandMatch[1]!;
	if (command.trim() !== command || /[\r\n{}]|\$\{/.test(command))
		return { error: "The next-step command contains whitespace or unresolved template fields." };
	const stageMatch = command.match(/^\/skill:([a-z][a-z0-9-]*)(?:\s|$)/);
	if (!stageMatch || !RPIV_STAGE_NAMES.includes(stageMatch[1] as (typeof RPIV_STAGE_NAMES)[number])) {
		return { error: "Only public, document-consuming RPIV stage skills may be approved by /next." };
	}
	if (!absolutePath(workingDirectory) || !absolutePath(inputArtifact))
		return { error: "Working directory and input artifact must be absolute, resolved paths." };
	if (!branch || branch === "HEAD" || /[\s{}]/.test(branch))
		return { error: "The captured branch must be a symbolic, non-detached branch name." };
	if (!/^[a-z][a-z0-9-]*#(?:[a-z0-9]{4}|[0-9A-HJKMNP-TV-Z]{26})$/i.test(kataIssue)) {
		return { error: "Kata issue must be qualified as project#short-id or project#ULID." };
	}

	return {
		command,
		stageName: stageMatch[1] as (typeof RPIV_STAGE_NAMES)[number],
		workingDirectory,
		inputArtifact,
		branch,
		kataIssue,
	};
}

/** Selects only the latest completed assistant message on the active session branch. */
export function selectNextHandoff(branch: readonly SessionMessageEntry[]): NextHandoffSelection {
	const latestAssistant = [...branch]
		.reverse()
		.find((entry) => entry.type === "message" && entry.message?.role === "assistant");
	if (!latestAssistant) return fail("The active session branch has no assistant handoff.");
	if (latestAssistant.message?.stopReason !== "stop")
		return fail("The latest assistant message did not complete normally.");
	const parsed = parseClosingFooter(textContent(latestAssistant.message.content));
	if ("error" in parsed) return fail(parsed.error);
	return { ok: true, handoff: { ...parsed, sourceEntryId: latestAssistant.id } };
}

function hasBalancedCommandQuotes(command: string): boolean {
	let quote: "'" | '"' | undefined;
	for (const character of command) {
		if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === "'" || character === '"') {
			quote = character;
		}
	}
	return quote === undefined;
}

export interface NextHandoffArgumentDependencies {
	cwd: string;
	parseCommandArgs: (command: string) => string[];
	commands: ReadonlyArray<{ name: string; source?: string; sourceInfo?: { path?: string } }>;
	isReadableFile: (path: string) => boolean;
	readFile: (path: string) => string | Uint8Array;
}

export type NextHandoffArgumentValidation =
	| {
			ok: true;
			command: string;
			stageName: NextHandoff["stageName"];
			skillPath: string;
			inputArtifactSha256: string;
			args: string[];
	  }
	| { ok: false; reason: string };

/** Validates the installed public skill and binds the command's path argument to its advertised file. */
export function validateNextHandoffArguments(
	handoff: NextHandoff,
	dependencies: NextHandoffArgumentDependencies,
): NextHandoffArgumentValidation {
	if (!handoff.command.startsWith(`/skill:${handoff.stageName} `))
		return { ok: false, reason: "The skill name must be followed by a literal space for normal skill loading." };
	if (hasNextCommandCollision(dependencies.commands, handoff.stageName))
		return { ok: false, reason: "An extension or prompt command shadows the approved skill invocation." };
	if (!hasBalancedCommandQuotes(handoff.command))
		return { ok: false, reason: "The saved skill command contains an unbalanced quote." };
	let args: string[];
	try {
		args = dependencies.parseCommandArgs(handoff.command);
	} catch {
		return { ok: false, reason: "The saved skill command could not be parsed." };
	}
	if (args[0] !== `/skill:${handoff.stageName}`)
		return { ok: false, reason: "The parsed command does not match its declared RPIV stage." };
	if (args.some((arg, index) => index > 0 && /^\/(?:skill|wf|next)(?::|\b)/.test(arg))) {
		return { ok: false, reason: "Chained commands are not supported by /next." };
	}

	const matchingSkills = dependencies.commands.filter((command) => {
		const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
		return command.source === "skill" && name === handoff.stageName && typeof command.sourceInfo?.path === "string";
	});
	if (matchingSkills.length !== 1)
		return { ok: false, reason: "The target must resolve to exactly one installed skill command." };
	const skillPath = matchingSkills[0]!.sourceInfo!.path!;
	if (!dependencies.isReadableFile(skillPath))
		return { ok: false, reason: "The installed target skill file is missing or unreadable." };

	const artifactArgCount = args
		.slice(1)
		.filter((arg) => resolve(dependencies.cwd, arg) === resolve(handoff.inputArtifact)).length;
	if (artifactArgCount !== 1)
		return {
			ok: false,
			reason: "The command must contain exactly one argument resolving to the advertised input artifact.",
		};
	if (!dependencies.isReadableFile(handoff.inputArtifact))
		return { ok: false, reason: "The advertised input artifact is missing or unreadable." };
	try {
		const inputArtifactSha256 = createHash("sha256")
			.update(dependencies.readFile(handoff.inputArtifact))
			.digest("hex");
		return { ok: true, command: handoff.command, stageName: handoff.stageName, skillPath, inputArtifactSha256, args };
	} catch {
		return { ok: false, reason: "The advertised input artifact could not be read." };
	}
}

export interface NextPreflightFacts {
	cwd: string;
	processCwd: string;
	worktreeRoot: string;
	branch: string;
	detached: boolean;
	sessionPersisted: boolean;
	trustedProject: boolean;
	foregroundBusy: boolean;
	queuedInput: boolean;
	laneStatuses: readonly string[];
	preflightRequired: boolean;
	preflightAvailable: boolean;
	preflightPassed: boolean;
	preflightArgs: readonly string[];
	projectRegistered: boolean;
	issueRef: string;
	issueStatus: string;
	issueReady: boolean;
	protectedBranch: boolean;
}

/** Pure guard for all state that must be established before any reset or dispatch. */
export function validateNextPreflight(
	handoff: NextHandoff,
	facts: NextPreflightFacts,
	options: { requirePersistedSession?: boolean } = {},
): { ok: true } | { ok: false; reason: string } {
	const samePath = (left: string, right: string) => resolve(left) === resolve(right);
	if (!samePath(facts.cwd, handoff.workingDirectory) || !samePath(facts.processCwd, facts.cwd)) {
		return { ok: false, reason: "Pi cwd, process cwd, and the handoff working directory must agree exactly." };
	}
	if (!isWithin(facts.worktreeRoot, facts.cwd))
		return { ok: false, reason: "The active working directory is outside its Git worktree." };
	if (facts.detached || facts.branch === "HEAD" || facts.branch !== handoff.branch)
		return { ok: false, reason: "The current symbolic branch does not match the captured branch." };
	if (facts.protectedBranch || /^(main|master|dev|local-dev)$/i.test(facts.branch))
		return { ok: false, reason: "Continuation is not allowed on a protected editing branch." };
	if ((options.requirePersistedSession ?? true) && !facts.sessionPersisted)
		return { ok: false, reason: "The source session must be persisted before replacement." };
	if (!facts.trustedProject) return { ok: false, reason: "The project is not trusted." };
	if (facts.foregroundBusy) return { ok: false, reason: "The foreground session is busy." };
	if (facts.queuedInput) return { ok: false, reason: "Queued input must be handled before replacement." };
	if (facts.laneStatuses.includes("running")) return { ok: false, reason: "A detached workflow lane is running." };
	if (facts.preflightRequired) {
		if (!facts.preflightAvailable || !facts.preflightPassed)
			return { ok: false, reason: "The required read-only repository preflight is unavailable or failed." };
		if (
			!facts.preflightArgs.includes("--allow-dirty") ||
			facts.preflightArgs.some((arg) =>
				/^(--ensure-issue|--bootstrap|--branch-bootstrap|--new|--ensure|--cleanup|--create-issue|--create-worktree|--switch-branch)$/.test(
					arg,
				),
			)
		) {
			return {
				ok: false,
				reason: "Repository preflight must allow dirty continuation without lifecycle or issue-creation flags.",
			};
		}
	}
	if (!facts.projectRegistered || facts.issueRef !== handoff.kataIssue)
		return { ok: false, reason: "The captured Kata project or exact issue is not registered in this workspace." };
	if (facts.issueStatus !== "open" || !facts.issueReady)
		return { ok: false, reason: "The captured Kata issue must be open and ready." };
	return { ok: true };
}

export const NEXT_ATTEMPT_ENTRY = "rpiv_next_attempt";
export const NEXT_CANCELLED_ENTRY = "rpiv_next_cancelled";
export const NEXT_HANDOFF_MESSAGE = "rpiv_next_handoff";

export interface NextRuntimeDependencies {
	parseCommandArgs?: (command: string) => string[];
	isReadableFile?: (path: string) => boolean;
	readFile?: (path: string) => string | Uint8Array;
	collectPreflightFacts?: (
		ctx: ExtensionCommandContext,
		handoff: NextHandoff,
		options?: { requirePersistedSession?: boolean },
	) => Promise<NextPreflightFacts>;
	argsExtensionLoaded?: () => boolean;
	getTargetCommands?: (ctx: ExtensionCommandContext) => NextHandoffArgumentDependencies["commands"] | undefined;
}

interface CustomEntryRecord {
	type?: string;
	customType?: string;
	data?: Record<string, unknown>;
}

function notify(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" = "warning"): void {
	ctx.ui.notify(text, level);
}

function fileText(value: string | Uint8Array): string {
	return typeof value === "string" ? value : new TextDecoder().decode(value);
}
function entryData(entry: unknown, customType: string): Record<string, unknown> | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const candidate = entry as CustomEntryRecord;
	return candidate.type === "custom" && candidate.customType === customType ? candidate.data : undefined;
}

function findUncancelledAttempt(
	entries: readonly unknown[],
	sessionId: string,
	entryId: string,
): Record<string, unknown> | undefined {
	const attempts = entries
		.map((entry) => entryData(entry, NEXT_ATTEMPT_ENTRY))
		.filter((data) => data?.sourceSessionId === sessionId && data.sourceEntryId === entryId);
	const cancelled = new Set(
		entries
			.map((entry) => entryData(entry, NEXT_CANCELLED_ENTRY)?.attemptId)
			.filter((value): value is string => typeof value === "string"),
	);
	return attempts.find((attempt) => typeof attempt?.attemptId !== "string" || !cancelled.has(attempt.attemptId));
}

function commandOutput(command: string, args: string[], cwd: string): string {
	return execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		timeout: 8_000,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function parseJson<T>(output: string): T {
	return JSON.parse(output) as T;
}

async function collectLivePreflightFacts(
	ctx: ExtensionCommandContext,
	handoff: NextHandoff,
	options: { requirePersistedSession?: boolean } = {},
): Promise<NextPreflightFacts> {
	let worktreeRoot = "";
	let branch = "";
	try {
		worktreeRoot = commandOutput("git", ["rev-parse", "--show-toplevel"], ctx.cwd);
		branch = commandOutput("git", ["branch", "--show-current"], ctx.cwd);
	} catch {
		// Empty identity fails closed in validateNextPreflight.
	}

	const preflightPath = worktreeRoot ? join(worktreeRoot, "scripts/preflight/worktree-session-check.sh") : "";
	const preflightRequired = !!preflightPath && existsSync(preflightPath);
	let preflightPassed = !preflightRequired;
	if (preflightRequired) {
		try {
			commandOutput(preflightPath, ["--allow-dirty"], worktreeRoot);
			preflightPassed = true;
		} catch {
			preflightPassed = false;
		}
	}

	const [issueResult, readyResult] = await Promise.all([
		Promise.resolve()
			.then(() => {
				const [project, issueRef] = handoff.kataIssue.split("#");
				return parseJson<{ issue?: { uid?: string; short_id?: string; status?: string } }>(
					commandOutput(
						"kata",
						["show", issueRef!, "--project", project!, "--workspace", ctx.cwd, "--json"],
						ctx.cwd,
					),
				);
			})
			.catch(() => undefined),
		Promise.resolve()
			.then(() => {
				const [project] = handoff.kataIssue.split("#");
				return parseJson<{ issues?: Array<{ uid?: string; short_id?: string }> }>(
					commandOutput("kata", ["ready", "--project", project!, "--workspace", ctx.cwd, "--json"], ctx.cwd),
				);
			})
			.catch(() => undefined),
	]);
	const issue = issueResult?.issue;
	const expectedIssue = handoff.kataIssue.split("#")[1]!.toLowerCase();
	const exactIssue = !!issue && [issue.uid, issue.short_id].some((value) => value?.toLowerCase() === expectedIssue);
	const issueReady = !!readyResult?.issues?.some((candidate) =>
		[candidate.uid, candidate.short_id].some((value) => value?.toLowerCase() === expectedIssue),
	);
	const sessionFile = ctx.sessionManager.getSessionFile();

	return {
		cwd: ctx.cwd,
		processCwd: process.cwd(),
		worktreeRoot,
		branch,
		detached: !branch,
		sessionPersisted: options.requirePersistedSession === false || (!!sessionFile && existsSync(sessionFile)),
		trustedProject: ctx.isProjectTrusted(),
		foregroundBusy: !ctx.isIdle(),
		queuedInput: ctx.hasPendingMessages(),
		laneStatuses: listLanes().map((lane) => lane.status),
		preflightRequired,
		preflightAvailable: !preflightRequired || existsSync(preflightPath),
		preflightPassed,
		preflightArgs: ["--allow-dirty"],
		projectRegistered: exactIssue,
		issueRef: exactIssue ? handoff.kataIssue : "",
		issueStatus: issue?.status ?? "unknown",
		issueReady,
		protectedBranch: /^(main|master|dev|local-dev)$/i.test(branch),
	};
}

async function loadArgumentParser(): Promise<((command: string) => string[]) | undefined> {
	try {
		const argsExtension = await import("@juicesharp/rpiv-args/args.js");
		return argsExtension.parseCommandArgs;
	} catch {
		return undefined;
	}
}

const argsExtensionIsLoaded = (): boolean =>
	(globalThis as Record<symbol, unknown>)[Symbol.for("@juicesharp/rpiv-args:loaded")] === true;

function buildHandoffCapsule(authorization: NextAuthorization): string {
	return [
		"This is a fresh session authorized for exactly one RPIV stage invocation.",
		`Working directory: ${authorization.workingDirectory}`,
		`Branch: ${authorization.branch}`,
		`Kata issue: ${authorization.kataIssue}`,
		`Input artifact: ${authorization.inputArtifact}`,
		`Source session: ${authorization.sourceSessionId}; assistant entry: ${authorization.sourceEntryId}`,
		"Do not infer or run any subsequent stage; later progression requires new user approval.",
	].join("\n");
}
function recoveryDetails(authorization: NextAuthorization, targetSessionId?: string): string {
	return [
		`Source session file: ${authorization.sourceSessionFile}`,
		`Target session: ${targetSessionId || "unknown; inspect session history"}`,
		`Manual fallback: ${authorization.command}`,
		`Working directory: ${authorization.workingDirectory}`,
	].join("\n");
}

export function registerNextCommand(pi: ExtensionAPI, dependencies: NextRuntimeDependencies = {}): void {
	const inFlight = new Set<string>();
	pi.on("session_start", (_event, ctx) => {
		registerNextTargetCommands(ctx.sessionManager, () => pi.getCommands());
	});
	const isReadableFile =
		dependencies.isReadableFile ??
		((path: string) => {
			try {
				readFileSync(path);
				return true;
			} catch {
				return false;
			}
		});
	const readFile = dependencies.readFile ?? ((path: string) => readFileSync(path));
	const collectFacts = dependencies.collectPreflightFacts ?? collectLivePreflightFacts;

	pi.registerCommand("next", {
		description: "Run only the latest approved RPIV step in a fresh session",
		handler: async (rawArgs, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!sessionId) {
				notify(ctx, "/next requires a persisted source session.");
				return;
			}
			if (inFlight.has(sessionId)) {
				notify(ctx, "/next is already validating or replacing this session.");
				return;
			}
			inFlight.add(sessionId);
			let resetStarted = false;
			let attemptId: string | undefined;
			let recovery: NextAuthorization | undefined;
			let targetSessionId: string | undefined;
			let invalidateTarget: (() => void) | undefined;
			let submitted = false;
			try {
				if (rawArgs.trim()) {
					notify(ctx, "/next takes no arguments; use the exact latest approved footer.");
					return;
				}
				if (!ctx.isIdle() || ctx.hasPendingMessages()) {
					notify(ctx, "/next requires an idle foreground session with no queued input.");
					return;
				}
				const selected = selectNextHandoff(ctx.sessionManager.getBranch() as SessionMessageEntry[]);
				if (!selected.ok) {
					notify(ctx, selected.reason);
					return;
				}
				const handoff = selected.handoff;
				const entries = ctx.sessionManager.getEntries() as unknown[];
				const unresolvedAttempt = findUncancelledAttempt(entries, sessionId, handoff.sourceEntryId);
				if (unresolvedAttempt) {
					const savedCommand =
						typeof unresolvedAttempt.command === "string" ? unresolvedAttempt.command : handoff.command;
					const savedDirectory =
						typeof unresolvedAttempt.workingDirectory === "string"
							? unresolvedAttempt.workingDirectory
							: handoff.workingDirectory;
					notify(
						ctx,
						`A replacement attempt has unknown delivery; refusing automatic replay.\nSource session file: ${ctx.sessionManager.getSessionFile() ?? "unknown"}\nTarget session: unknown unless found in session history.\nManual fallback: ${savedCommand}\nWorking directory: ${savedDirectory}`,
					);
					return;
				}
				const sessionFile = ctx.sessionManager.getSessionFile();
				if (!sessionFile || !existsSync(sessionFile)) {
					notify(ctx, "/next requires a persisted source session file.");
					return;
				}
				if (resolve(ctx.cwd) !== resolve(handoff.workingDirectory) || resolve(process.cwd()) !== resolve(ctx.cwd)) {
					notify(
						ctx,
						"Pi cwd, process cwd, and footer working directory must agree; launch Pi in the intended worktree.",
					);
					return;
				}

				const parser = dependencies.parseCommandArgs ?? (await loadArgumentParser());
				if (!parser) {
					notify(
						ctx,
						"The rpiv-args parser is unavailable; run the approved command manually from this worktree.",
					);
					return;
				}
				const installedCommands = pi.getCommands();
				const validation = validateNextHandoffArguments(handoff, {
					cwd: ctx.cwd,
					parseCommandArgs: parser,
					commands: installedCommands,
					isReadableFile,
					readFile,
				});
				if (!validation.ok) {
					notify(
						ctx,
						`${validation.reason}\nManual fallback: ${handoff.command}\nWorking directory: ${handoff.workingDirectory}`,
					);
					return;
				}
				const skillText = fileText(readFile(validation.skillPath));
				const requiresArgsExtension = /\$(?:\d+|ARGUMENTS|@|\{@:)|\$\{(?:SKILL_DIR|SESSION_ID)\}|```!/.test(
					skillText,
				);
				if (requiresArgsExtension && !(dependencies.argsExtensionLoaded ?? argsExtensionIsLoaded)()) {
					notify(
						ctx,
						"The target skill requires rpiv-args, which is not loaded; run the approved command manually after loading it.",
					);
					return;
				}
				const facts = await collectFacts(ctx, handoff);
				const checked = validateNextPreflight(handoff, facts);
				if (!checked.ok) {
					notify(
						ctx,
						`${checked.reason}\nManual fallback: ${handoff.command}\nWorking directory: ${handoff.workingDirectory}`,
					);
					return;
				}
				const immediatelyCurrent = selectNextHandoff(ctx.sessionManager.getBranch() as SessionMessageEntry[]);
				if (
					!immediatelyCurrent.ok ||
					immediatelyCurrent.handoff.sourceEntryId !== handoff.sourceEntryId ||
					immediatelyCurrent.handoff.command !== handoff.command ||
					ctx.sessionManager.getSessionId() !== sessionId
				) {
					notify(ctx, "The active handoff changed during preflight; no session was reset.");
					return;
				}
				const finalValidation = validateNextHandoffArguments(handoff, {
					cwd: ctx.cwd,
					parseCommandArgs: parser,
					commands: installedCommands,
					isReadableFile,
					readFile,
				});
				if (!finalValidation.ok || finalValidation.inputArtifactSha256 !== validation.inputArtifactSha256) {
					notify(ctx, "The input artifact or installed skill changed during preflight; no session was reset.");
					return;
				}
				const finalFacts = await collectFacts(ctx, handoff);
				const finalCheck = validateNextPreflight(handoff, finalFacts);
				if (!finalCheck.ok) {
					notify(
						ctx,
						`${finalCheck.reason}\nManual fallback: ${handoff.command}\nWorking directory: ${handoff.workingDirectory}`,
					);
					return;
				}
				const finalHandoff = selectNextHandoff(ctx.sessionManager.getBranch() as SessionMessageEntry[]);
				const lastValidation = validateNextHandoffArguments(handoff, {
					cwd: ctx.cwd,
					parseCommandArgs: parser,
					commands: pi.getCommands(),
					isReadableFile,
					readFile,
				});
				if (
					!finalHandoff.ok ||
					finalHandoff.handoff.sourceEntryId !== handoff.sourceEntryId ||
					finalHandoff.handoff.command !== handoff.command ||
					ctx.sessionManager.getSessionId() !== sessionId ||
					!lastValidation.ok ||
					lastValidation.inputArtifactSha256 !== validation.inputArtifactSha256 ||
					!ctx.isIdle() ||
					ctx.hasPendingMessages()
				) {
					notify(
						ctx,
						"The source session, handoff, or artifact changed during final preflight; no session was reset.",
					);
					return;
				}

				attemptId = randomUUID();
				const authorization: NextAuthorization = {
					attemptId,
					sourceSessionId: sessionId,
					sourceSessionFile: sessionFile,
					sourceEntryId: handoff.sourceEntryId,
					command: validation.command,
					stageName: validation.stageName,
					skillPath: validation.skillPath,
					inputArtifact: handoff.inputArtifact,
					inputArtifactSha256: validation.inputArtifactSha256,
					workingDirectory: handoff.workingDirectory,
					branch: handoff.branch,
					kataIssue: handoff.kataIssue,
					requiresTokenSubstitution: /\$(?:\d+|ARGUMENTS|@|\{@:)/.test(skillText),
				};
				recovery = authorization;
				pi.appendEntry(NEXT_ATTEMPT_ENTRY, authorization);
				resetStarted = true;
				const result = await ctx.newSession({
					parentSession: sessionFile,
					setup: async (manager) => {
						targetSessionId = manager.getSessionId() ?? undefined;
						invalidateTarget = () => {
							const receipted = manager
								.getEntries()
								.some(
									(entry) =>
										entry.type === "custom" &&
										entry.customType === NEXT_RECEIPT_ENTRY &&
										(entry.data as { attemptId?: string } | undefined)?.attemptId === authorization.attemptId,
								);
							if (!receipted)
								manager.appendCustomEntry(NEXT_RECEIPT_ENTRY, {
									attemptId: authorization.attemptId,
									status: "rejected",
								});
						};
						manager.appendCustomEntry(NEXT_AUTHORIZATION_ENTRY, {
							...authorization,
							targetSessionId: targetSessionId ?? "",
						});
					},
					withSession: async (freshContext) => {
						const targetFacts = await collectFacts(freshContext, handoff, { requirePersistedSession: false });
						const targetCheck = validateNextPreflight(handoff, targetFacts, { requirePersistedSession: false });
						const targetCommands = dependencies.getTargetCommands
							? dependencies.getTargetCommands(freshContext)
							: getNextTargetCommands(freshContext.sessionManager);
						if (!targetCommands) throw new Error("The replacement command registry is unavailable.");
						const targetValidation = validateNextHandoffArguments(handoff, {
							cwd: freshContext.cwd,
							parseCommandArgs: parser,
							commands: targetCommands,
							isReadableFile,
							readFile,
						});
						if (requiresArgsExtension && !(dependencies.argsExtensionLoaded ?? argsExtensionIsLoaded)()) {
							freshContext.ui.notify(
								`The target requires rpiv-args, which is not loaded.\nManual fallback: ${authorization.command}\nWorking directory: ${authorization.workingDirectory}`,
								"warning",
							);
							return;
						}
						if (
							!targetCheck.ok ||
							!targetValidation.ok ||
							targetValidation.skillPath !== authorization.skillPath ||
							targetValidation.inputArtifactSha256 !== authorization.inputArtifactSha256
						) {
							freshContext.ui.notify(
								`${!targetCheck.ok ? targetCheck.reason : !targetValidation.ok ? targetValidation.reason : "The target skill or artifact changed after replacement."}\nManual fallback: ${authorization.command}\nWorking directory: ${authorization.workingDirectory}`,
								"warning",
							);
							return;
						}
						try {
							await freshContext.sendMessage(
								{
									customType: NEXT_HANDOFF_MESSAGE,
									content: buildHandoffCapsule(authorization),
									display: true,
								},
								{ triggerTurn: false },
							);
							await freshContext.sendUserMessage(authorization.command, { expandPromptTemplates: true });
							submitted = true;
						} catch (error) {
							console.error("[rpiv-next] replacement dispatch ended with unknown delivery", error);
							freshContext.ui.notify(
								`Replacement dispatch ended with unknown delivery; do not replay automatically.\n${recoveryDetails(authorization, targetSessionId)}`,
								"warning",
							);
						} finally {
							try {
								await restoreNextAttempt(freshContext.sessionManager, attemptId!);
							} catch (restoreError) {
								console.error(
									"[rpiv-next] replacement dispatch failed to restore the skill model",
									restoreError,
								);
								freshContext.ui.notify(
									"The stage model may still be active; restore the prior model before continuing.",
									"warning",
								);
							}
						}
					},
				});
				if (result.cancelled) {
					resetStarted = false;
					pi.appendEntry(NEXT_CANCELLED_ENTRY, {
						attemptId,
						sourceSessionId: sessionId,
						sourceEntryId: handoff.sourceEntryId,
					});
				}
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				if (resetStarted) {
					console.error(
						`[rpiv-next] replacement attempt has unknown delivery; do not replay automatically. attempt=${attemptId ?? "not-recorded"}: ${text}\n${recovery ? recoveryDetails(recovery, targetSessionId) : "Recovery snapshot unavailable."}`,
					);
					return;
				}
				notify(ctx, `/next preflight failed. Details: ${text}`);
			} finally {
				if (!submitted) {
					try {
						invalidateTarget?.();
					} catch (error) {
						console.error("[rpiv-next] could not invalidate target authorization", error);
					}
				}
				inFlight.delete(sessionId);
			}
		},
	});
}
