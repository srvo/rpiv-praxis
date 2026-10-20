import { describe, expect, it, vi } from "vitest";
import { registerNextRestorer } from "./next-authorization.ts";
import {
	registerNextCommand,
	selectNextHandoff,
	validateNextHandoffArguments,
	validateNextPreflight,
} from "./next-command.ts";
import { RPIV_STAGE_NAMES } from "./pipeline-pointer.ts";

const footer = (
	overrides: Partial<Record<"command" | "workdir" | "artifact" | "branch" | "issue" | "marker", string>> = {},
) =>
	[
		`**Next step:** \`${overrides.command ?? '/skill:implement "docs/a plan.md" Phase 1'}\``,
		`**Working directory:** \`${overrides.workdir ?? "/work/praxis"}\``,
		`**Input artifact:** \`${overrides.artifact ?? "/work/praxis/docs/a plan.md"}\``,
		`**Branch:** \`${overrides.branch ?? "y9nt-next-phase1"}\``,
		`**Kata issue:** \`${overrides.issue ?? "rpiv-praxis#y9nt"}\``,
		overrides.marker ?? "Reply /next to run only the step above in a fresh session.",
	].join("\n");

const assistant = (id: string, text: string, stopReason = "stop") => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-10-18T00:00:00.000Z",
	message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
});

const select = (text: string) => selectNextHandoff([assistant("entry-1", text)]);

const validPreflightFacts = () => ({
	cwd: "/work/praxis",
	worktreeRoot: "/work/praxis",
	processCwd: "/work/praxis",
	branch: "y9nt-next-phase1",
	detached: false,
	preflightAvailable: true,
	preflightRequired: true,
	preflightPassed: true,
	preflightArgs: ["--allow-dirty"],
	projectRegistered: true,
	issueRef: "rpiv-praxis#y9nt",
	issueStatus: "open",
	issueReady: true,
	trustedProject: true,
	sessionPersisted: true,
	foregroundBusy: false,
	queuedInput: false,
	laneStatuses: [],
	protectedBranch: false,
});

describe("/next handoff selection", () => {
	it("selects the exact phase-bearing command and binds all five footer fields", () => {
		const result = select(`Work is ready.\n\n${footer()}`);
		expect(result).toMatchObject({
			ok: true,
			handoff: {
				command: '/skill:implement "docs/a plan.md" Phase 1',
				workingDirectory: "/work/praxis",
				inputArtifact: "/work/praxis/docs/a plan.md",
				branch: "y9nt-next-phase1",
				kataIssue: "rpiv-praxis#y9nt",
			},
		});
	});

	it("rejects legacy footers and does not fall back to an older assistant handoff", () => {
		const legacy = "**Next step:** `/skill:implement plan.md Phase 1`\n**Working directory:** `/work`";
		expect(select(legacy)).toMatchObject({ ok: false });
		expect(
			selectNextHandoff([assistant("old", footer()), assistant("new", "The work is blocked; no next step.")]),
		).toMatchObject({ ok: false });
	});

	it("ignores footer-shaped examples in quotes and fenced code", () => {
		const text = `Example only:\n> ${footer().replaceAll("\n", "\n> ")}\n\n\`\`\`md\n${footer()}\n\`\`\``;
		expect(select(text)).toMatchObject({ ok: false });
	});

	it("uses only the declared default and rejects a missing default when alternatives are present", () => {
		const pieces = footer().split("\n");
		const alternative = [pieces[0], "**Alternative:** `/skill:blueprint docs/design.md`", ...pieces.slice(1)].join(
			"\n",
		);
		expect(select(alternative)).toMatchObject({
			ok: true,
			handoff: { command: '/skill:implement "docs/a plan.md" Phase 1' },
		});
		const noDefault = `**Alternative:** \`/skill:blueprint docs/design.md\`\n**Working directory:** \`/work/praxis\`\n${footer().split("\n").slice(2).join("\n")}`;
		expect(select(noDefault)).toMatchObject({ ok: false });
	});

	it("rejects duplicate defaults, malformed or unresolved metadata, and non-stage commands", () => {
		const valid = footer();
		expect(select(`${valid}\n\n${footer({ command: "/skill:research docs/research.md" })}`)).toMatchObject({
			ok: false,
		});
		expect(select(footer({ artifact: "{artifact}" }))).toMatchObject({ ok: false });
		expect(select(footer({ workdir: "relative/path" }))).toMatchObject({ ok: false });
		expect(select(footer({ issue: "unknown" }))).toMatchObject({ ok: false });
		expect(select(footer({ command: "/skill:commit" }))).toMatchObject({ ok: false });
		expect(RPIV_STAGE_NAMES).toEqual([
			"discover",
			"research",
			"design",
			"explore",
			"plan",
			"blueprint",
			"implement",
			"validate",
		]);
	});

	it("selects the latest completed assistant message, not a user message as authorization", () => {
		expect(selectNextHandoff([assistant("partial", footer(), "toolUse")])).toMatchObject({ ok: false });
		const withUserPrompt = selectNextHandoff([
			assistant("done", footer()),
			{
				type: "message",
				id: "user-2",
				parentId: "done",
				timestamp: "x",
				message: { role: "user", content: " /next " },
			},
		]);
		expect(withUserPrompt).toMatchObject({ ok: true, handoff: { sourceEntryId: "done" } });
		expect(
			selectNextHandoff([{ type: "message", id: "user-only", message: { role: "user", content: footer() } }]),
		).toMatchObject({ ok: false });
	});
	describe("pre-reset validation", () => {
		const selected = select(footer());
		if (!selected.ok) throw new Error(selected.reason);
		const handoff = selected.handoff;

		it("binds one quoted file argument to the advertised artifact without rebuilding the raw command", () => {
			const result = validateNextHandoffArguments(handoff, {
				cwd: "/work/praxis",
				parseCommandArgs: () => ["/skill:implement", "docs/a plan.md", "Phase 1"],
				commands: [
					{ name: "skill:implement", source: "skill", sourceInfo: { path: "/skills/implement/SKILL.md" } },
				],
				isReadableFile: (path) => path === "/skills/implement/SKILL.md" || path === "/work/praxis/docs/a plan.md",
				readFile: () => "# approved plan\n",
			});
			expect(result).toMatchObject({
				ok: true,
				command: handoff.command,
				stageName: "implement",
				skillPath: "/skills/implement/SKILL.md",
			});
		});

		it("rejects an unbalanced quote before parsing or mutating handoff state", () => {
			const parseCommandArgs = vi.fn(() => ["/skill:implement", "docs/a plan.md", "Phase 1"]);
			const malformed = { ...handoff, command: '/skill:implement "docs/a plan.md Phase 1' };
			const result = validateNextHandoffArguments(malformed, {
				cwd: "/work/praxis",
				parseCommandArgs,
				commands: [
					{ name: "skill:implement", source: "skill", sourceInfo: { path: "/skills/implement/SKILL.md" } },
				],
				isReadableFile: () => true,
				readFile: () => "# plan",
			});
			expect(result).toMatchObject({ ok: false });
			expect(parseCommandArgs).not.toHaveBeenCalled();
		});
		it("rejects an absent artifact argument, wrong skill provenance, and unreadable files", () => {
			const base = {
				cwd: "/work/praxis",
				parseCommandArgs: () => ["/skill:implement", "other.md", "Phase 1"],
				commands: [
					{ name: "skill:implement", source: "prompt", sourceInfo: { path: "/skills/implement/SKILL.md" } },
				],
				isReadableFile: () => false,
				readFile: () => "",
			};
			expect(validateNextHandoffArguments(handoff, base)).toMatchObject({ ok: false });
		});

		it("accepts dirty continuation only with read-only allow-dirty preflight and a ready exact issue", () => {
			const facts = validPreflightFacts();
			expect(validateNextPreflight(handoff, facts)).toMatchObject({ ok: true });
			expect(validateNextPreflight(handoff, { ...facts, preflightArgs: ["--ensure-issue"] })).toMatchObject({
				ok: false,
			});
			expect(
				validateNextPreflight(handoff, { ...facts, preflightArgs: ["--allow-dirty", "--branch-bootstrap"] }),
			).toMatchObject({ ok: false });
			expect(validateNextPreflight(handoff, { ...facts, preflightPassed: false })).toMatchObject({ ok: false });
			expect(validateNextPreflight(handoff, { ...facts, issueStatus: "closed" })).toMatchObject({ ok: false });
			expect(validateNextPreflight(handoff, { ...facts, issueReady: false })).toMatchObject({ ok: false });
		});

		it("allows an in-memory replacement session when revalidating its other preflight facts", () => {
			expect(
				validateNextPreflight(
					handoff,
					{ ...validPreflightFacts(), sessionPersisted: false },
					{ requirePersistedSession: false },
				),
			).toMatchObject({ ok: true });
		});

		it("allows Pi's cwd to be a subdirectory inside the same Git worktree", () => {
			const facts = validPreflightFacts();
			const subdirectory = "/work/praxis/packages/rpiv-pi";
			const nestedHandoff = { ...handoff, workingDirectory: subdirectory };
			expect(
				validateNextPreflight(nestedHandoff, {
					...facts,
					cwd: subdirectory,
					processCwd: subdirectory,
					worktreeRoot: "/work/praxis",
				}),
			).toMatchObject({ ok: true });
		});

		it("rejects wrong cwd, branch, unavailable checks, untrusted/busy sessions, queued input, and running lanes", () => {
			const facts = validPreflightFacts();
			for (const changed of [
				{ processCwd: "/wrong" },
				{ cwd: "/wrong" },
				{ branch: "other" },
				{ detached: true },
				{ preflightAvailable: false },
				{ trustedProject: false },
				{ sessionPersisted: false },
				{ foregroundBusy: true },
				{ queuedInput: true },
				{ laneStatuses: ["running"] },
				{ projectRegistered: false },
				{ protectedBranch: true },
			]) {
				expect(validateNextPreflight(handoff, { ...facts, ...changed })).toMatchObject({ ok: false });
			}
		});
	});

	function makeRuntimeHarness(
		overrides: {
			facts?: ReturnType<typeof validPreflightFacts>;
			cancelled?: boolean;
			priorAttempt?: boolean;
			argsExtensionLoaded?: boolean;
			dispatchFails?: boolean;
		} = {},
	) {
		let registeredHandler: ((args: string, ctx: never) => Promise<void>) | undefined;
		const sourceEntries: Array<{ type: string; customType?: string; data?: unknown }> = [];
		const targetEntries: Array<{ type: string; customType?: string; data?: unknown }> = [];
		const targetRestore = vi.fn(async () => {});
		const targetSessionManager = {
			getBranch: () => [],
			getEntries: () => targetEntries,
			getSessionId: () => "target-session",
			getSessionFile: () => undefined,
			getLeafId: () => undefined,
			appendCustomEntry: vi.fn((customType: string, data?: unknown) => {
				targetEntries.push({ type: "custom", customType, data });
				if (
					customType === "rpiv_next_authorization" &&
					typeof (data as { attemptId?: unknown } | undefined)?.attemptId === "string"
				) {
					registerNextRestorer(targetSessionManager, (data as { attemptId: string }).attemptId, targetRestore);
				}
				return `target-entry-${targetEntries.length}`;
			}),
		};
		const targetCtx = {
			cwd: process.cwd(),
			sessionManager: targetSessionManager,
			isIdle: () => true,
			isProjectTrusted: () => true,
			hasPendingMessages: () => false,
			ui: { notify: vi.fn() },
			sendMessage: vi.fn(async () => {}),
			sendUserMessage: vi.fn(async () => {
				if (overrides.dispatchFails) throw new Error("simulated pre-agent dispatch failure");
			}),
		};
		const sessionManager = {
			getBranch: () => [
				assistant("entry-1", footer({ workdir: process.cwd(), artifact: `${process.cwd()}/docs/a plan.md` })),
			],
			getEntries: () => sourceEntries,
			getSessionId: () => "source-session",
			getSessionFile: () => `${process.cwd()}/package.json`,
			getLeafId: () => "entry-1",
		};
		if (overrides.priorAttempt) {
			sourceEntries.push({
				type: "custom",
				customType: "rpiv_next_attempt",
				data: { sourceSessionId: "source-session", sourceEntryId: "entry-1", attemptId: "source-session:entry-1" },
			});
		}
		const ctx = {
			cwd: process.cwd(),
			sessionManager,
			isIdle: () => true,
			isProjectTrusted: () => true,
			hasPendingMessages: () => false,
			ui: { notify: vi.fn() },
			newSession: vi.fn(
				async (options: {
					setup?: (manager: never) => Promise<void>;
					withSession?: (context: never) => Promise<void>;
				}) => {
					if (overrides.cancelled) return { cancelled: true };
					await options.setup?.(targetSessionManager as never);
					await options.withSession?.(targetCtx as never);
					return { cancelled: false };
				},
			),
		};
		const pi = {
			on: vi.fn(),
			registerCommand: vi.fn(
				(_name: string, options: { handler: (args: string, context: never) => Promise<void> }) => {
					registeredHandler = options.handler;
				},
			),
			getCommands: () => [
				{ name: "skill:implement", source: "skill", sourceInfo: { path: "/skills/implement/SKILL.md" } },
			],
			appendEntry: vi.fn((customType: string, data?: unknown) =>
				sourceEntries.push({ type: "custom", customType, data }),
			),
		};
		const dependencies = {
			parseCommandArgs: () => ["/skill:implement", `${process.cwd()}/docs/a plan.md`, "Phase 1"],
			isReadableFile: (path: string) =>
				path === "/skills/implement/SKILL.md" || path === `${process.cwd()}/docs/a plan.md`,
			readFile: (path: string) => (path === "/skills/implement/SKILL.md" ? "$ARGUMENTS" : "# approved plan\n"),
			collectPreflightFacts: async (_ctx: unknown, handoff: { branch: string; kataIssue: string }) =>
				overrides.facts ?? {
					...validPreflightFacts(),
					cwd: process.cwd(),
					processCwd: process.cwd(),
					worktreeRoot: process.cwd(),
					branch: handoff.branch,
					issueRef: handoff.kataIssue,
				},
			argsExtensionLoaded: () => overrides.argsExtensionLoaded ?? true,
			getTargetCommands: () => pi.getCommands(),
		};
		registerNextCommand(pi as never, dependencies as never);
		if (!registeredHandler) throw new Error("/next command was not registered");
		return {
			handler: registeredHandler,
			ctx,
			pi,
			sourceEntries,
			targetEntries,
			targetCtx,
			targetSessionManager,
			targetRestore,
		};
	}

	describe("/next runtime command", () => {
		it("preflights, records the attempt, replaces once, and sends the exact approved command in the fresh context", async () => {
			const runtime = makeRuntimeHarness();
			await runtime.handler("", runtime.ctx as never);
			expect(runtime.pi.registerCommand).toHaveBeenCalledWith(
				"next",
				expect.objectContaining({ description: expect.any(String) }),
			);
			expect(runtime.pi.appendEntry).toHaveBeenCalledWith(
				"rpiv_next_attempt",
				expect.objectContaining({ sourceSessionId: "source-session", sourceEntryId: "entry-1" }),
			);
			expect(runtime.ctx.newSession).toHaveBeenCalledOnce();
			expect(runtime.ctx.newSession).toHaveBeenCalledWith(
				expect.objectContaining({ parentSession: runtime.ctx.sessionManager.getSessionFile() }),
			);
			expect(runtime.targetSessionManager.appendCustomEntry).toHaveBeenCalledWith(
				"rpiv_next_authorization",
				expect.objectContaining({ command: '/skill:implement "docs/a plan.md" Phase 1' }),
			);
			expect(runtime.targetCtx.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({ customType: "rpiv_next_handoff" }),
				{ triggerTurn: false },
			);
			expect(runtime.targetRestore).toHaveBeenCalledOnce();
			expect(runtime.targetCtx.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
				'/skill:implement "docs/a plan.md" Phase 1',
				{ expandPromptTemplates: true },
			);
		});

		it("refuses to reset when the required rpiv-args extension is unavailable", async () => {
			const runtime = makeRuntimeHarness({ argsExtensionLoaded: false });
			await runtime.handler("", runtime.ctx as never);
			expect(runtime.ctx.newSession).not.toHaveBeenCalled();
			expect(runtime.pi.appendEntry).not.toHaveBeenCalled();
		});

		it("restores target model and reports unknown delivery when pre-agent dispatch rejects", async () => {
			const runtime = makeRuntimeHarness({ dispatchFails: true });
			await runtime.handler("", runtime.ctx as never);
			expect(runtime.targetRestore).toHaveBeenCalledOnce();
			expect(runtime.targetCtx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("unknown delivery"),
				"warning",
			);
			expect(runtime.sourceEntries.some((entry) => entry.customType === "rpiv_next_cancelled")).toBe(false);
		});

		it("leaves source session and state untouched when live preflight fails", async () => {
			const runtime = makeRuntimeHarness({ facts: { ...validPreflightFacts(), branch: "wrong-branch" } });
			await runtime.handler("", runtime.ctx as never);
			expect(runtime.ctx.newSession).not.toHaveBeenCalled();
			expect(runtime.pi.appendEntry).not.toHaveBeenCalled();
			expect(runtime.targetCtx.sendUserMessage).not.toHaveBeenCalled();
		});

		it("refuses replay when a prior attempt has no cancellation receipt", async () => {
			const runtime = makeRuntimeHarness({ priorAttempt: true });
			await runtime.handler("", runtime.ctx as never);
			expect(runtime.ctx.newSession).not.toHaveBeenCalled();
			expect(runtime.pi.appendEntry).not.toHaveBeenCalled();
		});

		it("records a vetoed replacement as cancelled without dispatching", async () => {
			const runtime = makeRuntimeHarness({ cancelled: true });
			await runtime.handler("", runtime.ctx as never);
			expect(runtime.ctx.newSession).toHaveBeenCalledOnce();
			expect(runtime.pi.appendEntry).toHaveBeenCalledWith(
				"rpiv_next_cancelled",
				expect.objectContaining({ sourceSessionId: "source-session", sourceEntryId: "entry-1" }),
			);
			expect(runtime.targetCtx.sendUserMessage).not.toHaveBeenCalled();
		});
	});
});
