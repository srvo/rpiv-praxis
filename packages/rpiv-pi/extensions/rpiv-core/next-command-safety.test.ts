import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { parseCommandArgs } from "../../../rpiv-args/args.js";
import { authorizeNextInput, NEXT_AUTHORIZATION_ENTRY, NEXT_RECEIPT_ENTRY } from "./next-authorization.js";
import {
	NEXT_APPROVAL_MARKER,
	NEXT_ATTEMPT_ENTRY,
	type NextHandoff,
	type NextPreflightFacts,
	registerNextCommand,
	validateNextHandoffArguments,
} from "./next-command.js";

// rpiv-praxis#6g6w (parent #y9nt): regressions for target dispatch and authorization boundaries.
type Failure = "artifact" | "issue" | "dependency" | "validation-throw" | "preflight-throw";
type Entry = {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
};
type Options = { sourceCollision?: boolean; targetCollision?: boolean; tab?: boolean; failure?: Failure };

const skillPath = "/skills/implement/SKILL.md";
const commandInfo = (source: "skill" | "extension"): SlashCommandInfo => ({
	name: "skill:implement",
	source,
	sourceInfo: {
		path: source === "skill" ? skillPath : "/extensions/shadow.ts",
		source: "local",
		scope: "project",
		origin: "top-level",
	},
});
const registry = (collision = false): SlashCommandInfo[] => [
	...(collision ? [commandInfo("extension")] : []),
	commandInfo("skill"),
];

function append(entries: Entry[], customType: string, data: unknown): string {
	const id = `entry-${entries.length}`;
	entries.push({
		type: "custom",
		id,
		parentId: entries.at(-1)?.id ?? null,
		timestamp: new Date().toISOString(),
		customType,
		data,
	});
	return id;
}
const records = (entries: Entry[], customType: string) => entries.filter((entry) => entry.customType === customType);

function harness(options: Options = {}) {
	const cwd = process.cwd();
	// An existing file satisfies the registrar's native persisted-source existence check.
	// Everything read by the argument/artifact validation below is supplied in memory.
	const sourceFile = join(cwd, "package.json");
	const artifact = join(cwd, "docs/approved plan.md");
	const command = `/skill:implement${options.tab ? "\t" : " "}"docs/approved plan.md" Phase 1`;
	const handoff: NextHandoff = {
		sourceEntryId: "assistant-entry",
		command,
		stageName: "implement",
		workingDirectory: cwd,
		inputArtifact: artifact,
		branch: "y9nt-next-phase1",
		kataIssue: "rpiv-praxis#y9nt",
	};
	const sourceEntries: Entry[] = [
		{
			type: "message",
			id: handoff.sourceEntryId,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: [
							`**Next step:** \`${command}\``,
							`**Working directory:** \`${cwd}\``,
							`**Input artifact:** \`${artifact}\``,
							`**Branch:** \`${handoff.branch}\``,
							`**Kata issue:** \`${handoff.kataIssue}\``,
							NEXT_APPROVAL_MARKER,
						].join("\n"),
					},
				],
			},
		},
	];
	const targetEntries: Entry[] = [];
	const staleCalls: string[] = [];
	let disposed = false;
	let handler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
	const live = <T>(name: string, action: () => T): T => {
		if (disposed) {
			staleCalls.push(name);
			throw new Error(`stale source API: ${name}`);
		}
		return action();
	};
	const sourceCall = <T>(name: string, action: () => T) => vi.fn(() => live(name, action));
	const manager = (id: string, entries: Entry[]) => ({
		getSessionId: () => id,
		getSessionFile: () => (id === "source" ? sourceFile : undefined),
		getBranch: () => entries,
		getEntries: () => entries,
		getLeafId: () => entries.at(-1)?.id ?? null,
		appendCustomEntry: (type: string, data: unknown) => append(entries, type, data),
	});
	const targetManager = manager("target", targetEntries);
	let targetCommands = registry();
	const targetPi = {
		on: vi.fn(),
		getCommands: vi.fn(() => targetCommands),
		appendEntry: vi.fn((type: string, data: unknown) => {
			append(targetEntries, type, data);
		}),
		registerCommand: vi.fn(),
	};
	const target = {
		cwd,
		sessionManager: targetManager,
		isIdle: () => true,
		hasPendingMessages: () => false,
		isProjectTrusted: () => true,
		ui: { notify: vi.fn() },
		sendMessage: vi.fn(async () => {}),
		sendUserMessage: vi.fn(async () => {}),
	};
	const sourceManager = manager("source", sourceEntries);
	const source = {
		get cwd() {
			return live("cwd", () => cwd);
		},
		sessionManager: {
			getSessionId: sourceCall("getSessionId", sourceManager.getSessionId),
			getSessionFile: sourceCall("getSessionFile", sourceManager.getSessionFile),
			getBranch: sourceCall("getBranch", sourceManager.getBranch),
			getEntries: sourceCall("getEntries", sourceManager.getEntries),
		},
		isIdle: sourceCall("isIdle", () => true),
		hasPendingMessages: sourceCall("hasPendingMessages", () => false),
		isProjectTrusted: sourceCall("isProjectTrusted", () => true),
		ui: { notify: sourceCall("notify", () => {}) },
		sendMessage: sourceCall("sendMessage", async () => {}),
		sendUserMessage: sourceCall("sendUserMessage", async () => {}),
		newSession: vi.fn(async (settings: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
			live("newSession", () => {});
			disposed = true;
			targetCommands = registry(options.targetCollision);
			// Native replacement loads a distinct registrar/API, never rebinds the source API.
			registerNextCommand(targetPi as unknown as ExtensionAPI, dependencies);
			await settings?.setup?.(targetManager as never);
			await settings?.withSession?.(target as never);
			return { cancelled: false };
		}),
	};
	const dependencies = {
		parseCommandArgs,
		getTargetCommands: () => targetCommands,
		isReadableFile: (path: string) => {
			if (disposed && options.failure === "validation-throw" && path === skillPath) {
				throw new Error("injected target argument-validation failure");
			}
			return path === artifact || path === skillPath;
		},
		readFile: (path: string) =>
			path === skillPath
				? "$ARGUMENTS"
				: disposed && options.failure === "artifact"
					? "changed plan"
					: "approved plan",
		argsExtensionLoaded: () => !(disposed && options.failure === "dependency"),
		collectPreflightFacts: async (ctx: ExtensionCommandContext): Promise<NextPreflightFacts> => {
			const isTarget = ctx.sessionManager.getSessionId() === "target";
			if (isTarget && options.failure === "preflight-throw") throw new Error("injected target preflight failure");
			return {
				cwd: ctx.cwd,
				processCwd: cwd,
				worktreeRoot: cwd,
				branch: handoff.branch,
				detached: false,
				sessionPersisted: !isTarget,
				trustedProject: ctx.isProjectTrusted(),
				foregroundBusy: !ctx.isIdle(),
				queuedInput: ctx.hasPendingMessages(),
				laneStatuses: [],
				preflightRequired: false,
				preflightAvailable: true,
				preflightPassed: true,
				preflightArgs: ["--allow-dirty"],
				projectRegistered: true,
				issueRef: handoff.kataIssue,
				issueStatus: "open",
				issueReady: !(isTarget && options.failure === "issue"),
				protectedBranch: false,
			};
		},
	};
	const sourcePi = {
		on: vi.fn(),
		registerCommand: (_name: string, settings: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			handler = settings.handler;
		},
		getCommands: sourceCall("pi.getCommands", () => registry(options.sourceCollision)),
		appendEntry: (type: string, data: unknown) =>
			live("pi.appendEntry", () => {
				append(sourceEntries, type, data);
			}),
	};
	registerNextCommand(sourcePi as unknown as ExtensionAPI, dependencies);
	return {
		command,
		handoff,
		dependencies,
		source,
		sourceEntries,
		target,
		targetPi,
		targetEntries,
		pureValidation: () =>
			validateNextHandoffArguments(handoff, {
				...dependencies,
				cwd,
				commands: registry(options.sourceCollision),
			}),
		run: async () => {
			expect(handler).toBeDefined();
			await handler!("", source as unknown as ExtensionCommandContext);
			expect(staleCalls, "no source API access after replacement, including swallowed errors").toEqual([]);
			expect(source.sendMessage).not.toHaveBeenCalled();
			expect(source.sendUserMessage).not.toHaveBeenCalled();
		},
		laterInput: () =>
			authorizeNextInput(
				targetPi,
				{
					type: "input",
					source: "extension",
					text: command,
					images: undefined,
				},
				target as unknown as ExtensionContext,
			),
	};
}

describe("/next safety regressions (rpiv-praxis#y9nt)", () => {
	it("control: a valid handoff reaches only the fresh target and its authorization works once", async () => {
		const h = harness();
		await h.run();
		expect(h.source.newSession).toHaveBeenCalledOnce();
		expect(h.target.sendUserMessage).toHaveBeenCalledExactlyOnceWith(h.command, { expandPromptTemplates: true });
		expect(records(h.targetEntries, NEXT_AUTHORIZATION_ENTRY)).toHaveLength(1);
		expect(h.laterInput().kind).toBe("authorized");
		expect(h.laterInput().kind).not.toBe("authorized");
	});

	it("rejects an extension skill:implement collision in pure argument validation", () => {
		const h = harness({ sourceCollision: true });
		expect(h.pureValidation()).toMatchObject({ ok: false });
	});

	it("rejects an extension skill:implement collision before resetting the source", async () => {
		const h = harness({ sourceCollision: true });
		await h.run();
		expect(h.source.newSession).not.toHaveBeenCalled();
		expect(records(h.sourceEntries, NEXT_ATTEMPT_ENTRY)).toHaveLength(0);
		expect(h.target.sendUserMessage).not.toHaveBeenCalled();
	});

	it("rejects a collision introduced only in the target registry before dispatch", async () => {
		const h = harness({ targetCollision: true });
		expect(h.pureValidation()).toMatchObject({ ok: true });
		await h.run();
		expect(h.source.newSession).toHaveBeenCalledOnce();
		// Calling the disposed source getCommands is independently rejected by run().
		expect(h.target.sendUserMessage).not.toHaveBeenCalled();
	});

	it("rejects a literal tab after the skill name before resetting the source", async () => {
		const h = harness({ tab: true });
		expect(h.command).toContain("implement\t");
		await h.run();
		expect(h.source.newSession).not.toHaveBeenCalled();
		expect(records(h.sourceEntries, NEXT_ATTEMPT_ENTRY)).toHaveLength(0);
		expect(h.target.sendUserMessage).not.toHaveBeenCalled();
	});

	it.each<Failure>(["artifact", "issue", "dependency", "validation-throw", "preflight-throw"])(
		"invalidates pending target authorization after %s refusal/failure",
		async (failure) => {
			const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
			const h = harness({ failure });
			await h.run();
			expect(h.source.newSession).toHaveBeenCalledOnce();
			expect(records(h.sourceEntries, NEXT_ATTEMPT_ENTRY)).toHaveLength(1);
			expect(records(h.targetEntries, NEXT_AUTHORIZATION_ENTRY)).toHaveLength(1);
			expect(h.target.sendUserMessage).not.toHaveBeenCalled();
			if (failure.endsWith("throw")) {
				expect(diagnostics).toHaveBeenCalled();
			} else {
				expect(h.target.ui.notify).toHaveBeenCalled();
			}
			// Probe the real consumer, not a receipt count: no pending permission may
			// authorize the exact approved extension input after failed target checks.
			expect(h.laterInput().kind).not.toBe("authorized");
			expect(records(h.targetEntries, NEXT_RECEIPT_ENTRY)).not.toContainEqual(
				expect.objectContaining({ data: expect.objectContaining({ status: "accepted" }) }),
			);
		},
	);
});
