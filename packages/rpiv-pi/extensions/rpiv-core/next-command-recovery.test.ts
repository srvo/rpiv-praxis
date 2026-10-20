import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionCommandContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { parseCommandArgs } from "../../../rpiv-args/args.ts";
import {
	authorizeNextInput,
	NEXT_AUTHORIZATION_ENTRY,
	NEXT_RECEIPT_ENTRY,
	type NextAuthorization,
} from "./next-authorization.ts";
import {
	NEXT_APPROVAL_MARKER,
	NEXT_ATTEMPT_ENTRY,
	NEXT_CANCELLED_ENTRY,
	NEXT_HANDOFF_MESSAGE,
	type NextPreflightFacts,
	registerNextCommand,
} from "./next-command.ts";

type Entry = {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	customType?: string;
	data?: unknown;
	message?: unknown;
};
type Source = {
	id: string;
	command: string;
	entries: Entry[];
	disposed: boolean;
	ctx: ExtensionCommandContext & { sendMessage: () => Promise<void>; sendUserMessage: () => Promise<void> };
};
type Outcome = "success" | "veto" | "creation-failure" | "setup-failure" | "changed-artifact";

function customEntry(entries: Entry[], customType: string, data: unknown): void {
	entries.push({
		type: "custom",
		id: `custom-${entries.length}`,
		parentId: entries.at(-1)?.id ?? null,
		timestamp: new Date().toISOString(),
		customType,
		data,
	});
}
const records = (entries: Entry[], type: string) => entries.filter((entry) => entry.customType === type);
const command = (phase: number) => `/skill:${phase === 1 ? "implement" : "validate"} "docs/a plan.md" Phase ${phase}`;

function makeHarness() {
	const cwd = process.cwd();
	const sourceFile = `${cwd}/package.json`;
	const artifact = `${cwd}/docs/a plan.md`;
	const commands = ["implement", "validate"].map(
		(stage): SlashCommandInfo => ({
			name: `skill:${stage}`,
			source: "skill",
			sourceInfo: {
				path: `/skills/${stage}/SKILL.md`,
				source: "local",
				scope: "project",
				origin: "top-level",
			},
		}),
	);
	const sourceScope = new AsyncLocalStorage<Source>();
	const afterDisposal: string[] = [];
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	let handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	let artifactText = "# approved plan\n";
	let outcome: Outcome = "success";
	let pausePreflight: (() => Promise<void>) | undefined;
	let targetCount = 0;
	const targets: ReturnType<typeof makeTarget>[] = [];

	function live<T>(source: Source, name: string, action: () => T): T {
		if (source.disposed) {
			afterDisposal.push(`${source.id}:${name}`);
			throw new Error(`source API after disposal: ${name}`);
		}
		return action();
	}
	function makeTarget() {
		const id = `target-${++targetCount}`;
		const entries: Entry[] = [];
		const manager = {
			getSessionId: () => id,
			getSessionFile: () => undefined,
			getBranch: () => entries,
			getEntries: () => entries,
			getLeafId: () => entries.at(-1)?.id,
			appendCustomEntry: vi.fn((type: string, data: unknown) => {
				customEntry(entries, type, data);
				if (outcome === "setup-failure" && type === NEXT_AUTHORIZATION_ENTRY) {
					throw new Error("injected setup failure");
				}
				return entries.at(-1)!.id;
			}),
		};
		const ctx = {
			cwd,
			sessionManager: manager,
			isIdle: () => true,
			hasPendingMessages: () => false,
			isProjectTrusted: () => true,
			ui: { notify: vi.fn() },
			sendMessage: vi.fn(async () => {}),
			sendUserMessage: vi.fn(async () => {}),
		};
		const input = (text: string, sessionId = id) =>
			authorizeNextInput(
				{
					appendEntry: (type, data) => customEntry(entries, type, data),
					getCommands: () => commands,
				},
				{ type: "input", source: "extension", text, images: undefined },
				{ ...ctx, sessionManager: { ...manager, getSessionId: () => sessionId } } as never,
			);
		return { id, entries, manager, ctx, input };
	}
	function source(id = "source-1", approvedCommand = command(1), saved?: Entry[]): Source {
		const footer = [
			`**Next step:** \`${approvedCommand}\``,
			`**Working directory:** \`${cwd}\``,
			`**Input artifact:** \`${artifact}\``,
			"**Branch:** `y9nt-next-phase1`",
			"**Kata issue:** `rpiv-praxis#y9nt`",
			NEXT_APPROVAL_MARKER,
		].join("\n");
		const entries = saved ?? [
			{
				type: "message",
				id: "assistant-entry",
				parentId: null,
				timestamp: "2026-10-18T00:00:00.000Z",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: footer }] },
			},
		];
		const result: Source = { id, command: approvedCommand, entries, disposed: false, ctx: undefined as never };
		const api = <T>(name: string, action: () => T) => vi.fn(() => live(result, name, action));
		result.ctx = {
			get cwd() {
				return live(result, "cwd", () => cwd);
			},
			sessionManager: {
				getSessionId: api("getSessionId", () => id),
				getSessionFile: api("getSessionFile", () => sourceFile),
				getBranch: api("getBranch", () => entries),
				getEntries: api("getEntries", () => entries),
				getLeafId: api("getLeafId", () => entries.at(-1)?.id),
			},
			isIdle: api("isIdle", () => true),
			hasPendingMessages: api("hasPendingMessages", () => false),
			isProjectTrusted: api("isProjectTrusted", () => true),
			ui: { notify: api("notify", () => {}) },
			sendMessage: api("sendMessage", async () => {}),
			sendUserMessage: api("sendUserMessage", async () => {}),
			newSession: vi.fn(
				async (options: {
					setup?: (manager: never) => Promise<void>;
					withSession?: (ctx: never) => Promise<void>;
				}) => {
					live(result, "newSession", () => {});
					if (outcome === "veto") return { cancelled: true };
					result.disposed = true;
					if (outcome === "creation-failure") throw new Error("injected creation failure");
					const target = makeTarget();
					targets.push(target);
					await options.setup?.(target.manager as never);
					if (outcome === "changed-artifact") artifactText = "# changed after reset\n";
					await options.withSession?.(target.ctx as never);
					return { cancelled: false };
				},
			),
		} as unknown as Source["ctx"];
		return result;
	}
	const pi = {
		on: vi.fn(),
		registerCommand: (_name: string, options: { handler: typeof handler }) => {
			handler = options.handler;
		},
		getCommands: () => commands,
		appendEntry: (type: string, data: unknown) => {
			const owner = sourceScope.getStore();
			if (!owner) throw new Error("append outside command invocation");
			live(owner, "appendEntry", () => customEntry(owner.entries, type, data));
		},
	};
	registerNextCommand(pi as never, {
		parseCommandArgs,
		isReadableFile: (path) => path === artifact || commands.some((skill) => skill.sourceInfo.path === path),
		readFile: (path) => (path === artifact ? artifactText : "$ARGUMENTS"),
		argsExtensionLoaded: () => true,
		getTargetCommands: () => commands,
		collectPreflightFacts: async (ctx, handoff): Promise<NextPreflightFacts> => {
			await pausePreflight?.();
			return {
				cwd: ctx.cwd,
				processCwd: cwd,
				worktreeRoot: cwd,
				branch: handoff.branch,
				detached: false,
				sessionPersisted: true,
				trustedProject: ctx.isProjectTrusted(),
				foregroundBusy: !ctx.isIdle(),
				queuedInput: ctx.hasPendingMessages(),
				laneStatuses: [],
				preflightRequired: true,
				preflightAvailable: true,
				preflightPassed: true,
				preflightArgs: ["--allow-dirty"],
				projectRegistered: true,
				issueRef: handoff.kataIssue,
				issueStatus: "open",
				issueReady: true,
				protectedBranch: false,
			};
		},
	});
	const run = (owner: Source) => sourceScope.run(owner, () => handler("", owner.ctx));
	function retained(owner: Source, count = 1) {
		expect(records(owner.entries, NEXT_ATTEMPT_ENTRY)).toHaveLength(count);
		for (const entry of records(owner.entries, NEXT_ATTEMPT_ENTRY)) {
			expect(entry).toMatchObject({
				type: "custom",
				id: expect.any(String),
				timestamp: expect.any(String),
				data: {
					sourceSessionId: owner.id,
					sourceSessionFile: sourceFile,
					sourceEntryId: "assistant-entry",
					command: owner.command,
					workingDirectory: cwd,
					inputArtifact: artifact,
					attemptId: expect.any(String),
				},
			});
		}
		expect(afterDisposal).toEqual([]);
		expect(owner.ctx.sendMessage).not.toHaveBeenCalled();
		expect(owner.ctx.sendUserMessage).not.toHaveBeenCalled();
	}
	function delivered(target: ReturnType<typeof makeTarget>, approved: string) {
		expect(target.ctx.sendUserMessage).toHaveBeenCalledExactlyOnceWith(approved, { expandPromptTemplates: true });
		expect(target.ctx.sendMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ customType: NEXT_HANDOFF_MESSAGE }),
			{ triggerTurn: false },
		);
		expect(records(target.entries, NEXT_AUTHORIZATION_ENTRY)).toHaveLength(1);
	}
	async function refuseReplay(owner: Source) {
		const reopened = source(owner.id, owner.command, owner.entries);
		const snapshot = [...owner.entries];
		await run(reopened);
		expect(reopened.ctx.newSession).not.toHaveBeenCalled();
		expect(owner.entries).toEqual(snapshot);
		expect(reopened.ctx.sendMessage).not.toHaveBeenCalled();
		expect(reopened.ctx.sendUserMessage).not.toHaveBeenCalled();
		for (const detail of ["refusing automatic replay", owner.command, sourceFile, cwd]) {
			expect(reopened.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(detail), "warning");
		}
		expect(afterDisposal).toEqual([]);
	}
	return {
		source,
		run,
		targets,
		retained,
		delivered,
		refuseReplay,
		sourceFile,
		cwd,
		setOutcome: (next: Outcome) => {
			outcome = next;
		},
		pause: (wait: () => Promise<void>) => {
			pausePreflight = wait;
		},
		diagnostics: () => errors.mock.calls.map((args) => args.map(String).join("\n")).join("\n"),
	};
}

describe("/next P2.2 recovery through registerNextCommand", () => {
	it.each(["creation-failure", "setup-failure"] as const)(
		"retains recoverable provenance after %s disposes the source",
		async (outcome) => {
			const runtime = makeHarness();
			const source = runtime.source();
			runtime.setOutcome(outcome);
			await runtime.run(source);
			expect(source.disposed).toBe(true);
			expect(source.ctx.newSession).toHaveBeenCalledOnce();
			runtime.retained(source);
			expect(records(source.entries, NEXT_CANCELLED_ENTRY)).toHaveLength(0);
			expect(runtime.targets).toHaveLength(outcome === "creation-failure" ? 0 : 1);
			for (const target of runtime.targets) {
				expect(target.ctx.sendMessage).not.toHaveBeenCalled();
				expect(target.ctx.sendUserMessage).not.toHaveBeenCalled();
				expect(records(target.entries, NEXT_AUTHORIZATION_ENTRY)).toHaveLength(1);
			}
			await runtime.refuseReplay(source);
			runtime.retained(source);
			expect(runtime.diagnostics()).toContain("unknown delivery");
			expect(runtime.diagnostics()).toContain("do not replay automatically");
			// Recovery must survive loss of the source context; opaque attempt IDs are insufficient.
			for (const detail of [runtime.sourceFile, source.command, runtime.cwd]) {
				expect.soft(runtime.diagnostics()).toContain(detail);
			}
		},
	);

	it("refuses dispatch and replay if the artifact changes after reset", async () => {
		const runtime = makeHarness();
		const source = runtime.source();
		runtime.setOutcome("changed-artifact");
		await runtime.run(source);
		expect(source.disposed).toBe(true);
		expect(source.ctx.newSession).toHaveBeenCalledOnce();
		expect(runtime.targets).toHaveLength(1);
		const target = runtime.targets[0]!;
		expect(target.ctx.sendMessage).not.toHaveBeenCalled();
		expect(target.ctx.sendUserMessage).not.toHaveBeenCalled();
		expect(target.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("changed after replacement"),
			"warning",
		);
		expect(target.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(source.command), "warning");
		expect(records(target.entries, NEXT_AUTHORIZATION_ENTRY)).toHaveLength(1);
		expect(records(source.entries, NEXT_CANCELLED_ENTRY)).toHaveLength(0);
		runtime.retained(source);
		await runtime.refuseReplay(source);
		runtime.retained(source);
	});

	it.each(["command", "target-session"] as const)(
		"isolates two source sessions against wrong %s authorization",
		async (mismatch) => {
			const runtime = makeHarness();
			const sources = [runtime.source("source-A", command(1)), runtime.source("source-B", command(2))];
			await Promise.all(sources.map(runtime.run));
			expect(runtime.targets).toHaveLength(2);
			const authorizations = runtime.targets.map(
				(target) => records(target.entries, NEXT_AUTHORIZATION_ENTRY)[0]!.data as NextAuthorization,
			);
			expect(new Set(authorizations.map((auth) => auth.attemptId)).size).toBe(2);
			for (let index = 0; index < 2; index++) {
				const source = sources[index]!;
				const authorization = authorizations.find((auth) => auth.sourceSessionId === source.id)!;
				const target = runtime.targets.find((candidate) => candidate.id === authorization.targetSessionId)!;
				expect(source.disposed).toBe(true);
				expect(source.ctx.newSession).toHaveBeenCalledOnce();
				runtime.delivered(target, source.command);
				const wrongTarget = runtime.targets.find((candidate) => candidate.id !== target.id)!;
				const result =
					mismatch === "command"
						? target.input(sources[1 - index]!.command)
						: target.input(source.command, wrongTarget.id);
				expect(result).toEqual({ kind: "handled" });
				expect(records(target.entries, NEXT_RECEIPT_ENTRY)).toEqual([
					expect.objectContaining({
						type: "custom",
						data: expect.objectContaining({ sourceSessionId: source.id, status: "rejected" }),
					}),
				]);
				// A mismatched delivery consumes the one-shot grant rather than leaving it reusable.
				expect(target.input(source.command)).toEqual({ kind: "unrelated" });
				runtime.retained(source);
				await runtime.refuseReplay(source);
				runtime.retained(source);
			}
		},
	);

	it("coalesces repeated simultaneous invocations and refuses a later replay", async () => {
		const runtime = makeHarness();
		const source = runtime.source();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		runtime.pause(() => gate);
		const pending = Array.from({ length: 20 }, () => runtime.run(source));
		expect(source.ctx.newSession).not.toHaveBeenCalled();
		release();
		await Promise.all(pending);
		expect(source.disposed).toBe(true);
		expect(source.ctx.newSession).toHaveBeenCalledOnce();
		expect(runtime.targets).toHaveLength(1);
		const target = runtime.targets[0]!;
		runtime.delivered(target, source.command);
		expect(target.input(source.command)).toMatchObject({
			kind: "authorized",
			authorization: { sourceSessionId: source.id },
		});
		expect(target.input(source.command)).toEqual({ kind: "unrelated" });
		expect(records(source.entries, NEXT_CANCELLED_ENTRY)).toHaveLength(0);
		runtime.retained(source);
		await runtime.refuseReplay(source);
		runtime.retained(source);
	});

	it("allows a valid retry after veto without duplicating delivery or cancelling the successful attempt", async () => {
		const runtime = makeHarness();
		const source = runtime.source();
		runtime.setOutcome("veto");
		await runtime.run(source);
		expect(source.disposed).toBe(false);
		expect(runtime.targets).toHaveLength(0);
		runtime.retained(source);
		const firstAttempt = records(source.entries, NEXT_ATTEMPT_ENTRY)[0]!.data as NextAuthorization;
		expect(records(source.entries, NEXT_CANCELLED_ENTRY)).toEqual([
			expect.objectContaining({
				type: "custom",
				data: {
					attemptId: firstAttempt.attemptId,
					sourceSessionId: source.id,
					sourceEntryId: "assistant-entry",
				},
			}),
		]);
		runtime.setOutcome("success");
		await runtime.run(source);
		expect(source.disposed).toBe(true);
		expect(source.ctx.newSession).toHaveBeenCalledTimes(2);
		expect(runtime.targets).toHaveLength(1);
		const target = runtime.targets[0]!;
		runtime.delivered(target, source.command);
		const secondAttempt = records(source.entries, NEXT_ATTEMPT_ENTRY)[1]!.data as NextAuthorization;
		expect(secondAttempt.attemptId).not.toBe(firstAttempt.attemptId);
		expect(records(target.entries, NEXT_AUTHORIZATION_ENTRY)).toEqual([
			expect.objectContaining({ data: { ...secondAttempt, targetSessionId: target.id } }),
		]);
		expect(records(source.entries, NEXT_CANCELLED_ENTRY)).toHaveLength(1);
		runtime.retained(source, 2);
		await runtime.refuseReplay(source);
		runtime.retained(source, 2);
	});
});
