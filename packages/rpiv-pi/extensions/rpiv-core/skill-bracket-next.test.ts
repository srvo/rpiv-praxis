import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { restoreNextAttempt } from "./next-authorization.ts";
import { registerSessionCapture } from "./session-capture.ts";
import { __resetSkillBracketState, registerSkillBracket } from "./skill-bracket.ts";

const BASELINE_MODEL = { provider: "anthropic", id: "baseline" };

interface TestHandlers {
	input?: (event: { text: string; source: string }, ctx?: never) => Promise<{ action: string }> | { action: string };
	agent_end?: (event?: unknown, ctx?: never) => Promise<unknown> | unknown;
	session_start?: (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
}

function writeModels(config: unknown) {
	const dir = join(process.env.HOME!, ".config", "rpiv-pi");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "models.json"), JSON.stringify(config), "utf-8");
}

async function setupBracket() {
	const handlers: TestHandlers = {};
	const setModel = vi.fn(async () => true);
	const appendEntry = vi.fn();
	const pi = {
		on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
			(handlers as Record<string, unknown>)[event] = handler;
		}),
		setModel,
		appendEntry,
		setThinkingLevel: vi.fn(),
		getCommands: () => [
			{ name: "skill:implement", source: "skill", sourceInfo: { path: "/skills/implement/SKILL.md" } },
		],
		getThinkingLevel: vi.fn(() => "medium"),
	} as unknown as ExtensionAPI;
	registerSessionCapture(pi);
	registerSkillBracket(pi);
	await handlers.session_start?.(
		{},
		{ modelRegistry: { find: vi.fn((provider: string, id: string) => ({ provider, id })) }, model: BASELINE_MODEL },
	);
	return { handlers, setModel, appendEntry };
}

const authorization = {
	attemptId: "attempt-1",
	sourceSessionId: "source-session",
	sourceSessionFile: "/sessions/source.jsonl",
	sourceEntryId: "assistant-entry",
	targetSessionId: "target-session",
	command: '/skill:implement "docs/a plan.md" Phase 1',
	stageName: "implement" as const,
	skillPath: "/skills/implement/SKILL.md",
	inputArtifact: "/work/praxis/docs/a plan.md",
	inputArtifactSha256: "a".repeat(64),
	workingDirectory: "/work/praxis",
	branch: "y9nt-next-phase1",
	kataIssue: "rpiv-praxis#y9nt",
	requiresTokenSubstitution: true,
};

const targetContext = (receipts: unknown[] = []) => {
	const sessionManager = {
		getSessionId: () => "target-session",
		getEntries: () => [{ type: "custom", customType: "rpiv_next_authorization", data: authorization }, ...receipts],
	};
	return { sessionManager };
};

describe("authorized fresh-session /next input", () => {
	beforeEach(() => __resetSkillBracketState());

	it("accepts the exact command and applies its ordinary model override", async () => {
		writeModels({ skills: { implement: { model: "zai/glm-4-7", thinking: "minimal" } } });
		const { handlers, setModel, appendEntry } = await setupBracket();
		await expect(
			handlers.input!({ text: authorization.command, source: "extension" }, targetContext() as never),
		).resolves.toEqual({ action: "continue" });
		expect(setModel).toHaveBeenCalledWith({ provider: "zai", id: "glm-4-7" });
		expect(appendEntry).toHaveBeenCalledWith(
			"rpiv_next_receipt",
			expect.objectContaining({ attemptId: "attempt-1", status: "accepted" }),
		);
	});

	it("consumes a replacement authorization before a repeated extension input", async () => {
		writeModels({ skills: { implement: { model: "zai/glm-4-7" } } });
		const { handlers, setModel, appendEntry } = await setupBracket();
		const receipts: unknown[] = [];
		appendEntry.mockImplementation((customType: string, data: unknown) =>
			receipts.push({ type: "custom", customType, data }),
		);
		const target = targetContext(receipts);
		await handlers.input!({ text: authorization.command, source: "extension" }, target as never);
		await handlers.input!({ text: authorization.command, source: "extension" }, target as never);
		expect(setModel).toHaveBeenCalledOnce();
		expect(appendEntry).toHaveBeenCalledTimes(1);
	});

	it("restores through the target-owned callback when dispatch fails before agent_end", async () => {
		writeModels({ skills: { implement: { model: "zai/glm-4-7" } } });
		const { handlers, setModel } = await setupBracket();
		const target = targetContext();
		await handlers.input!({ text: authorization.command, source: "extension" }, target as never);
		setModel.mockClear();
		await expect(restoreNextAttempt(target.sessionManager, "attempt-1")).resolves.toBe(true);
		expect(setModel).toHaveBeenCalledWith(BASELINE_MODEL);
		await expect(restoreNextAttempt(target.sessionManager, "attempt-1")).resolves.toBe(false);
	});

	it("restores on agent_end using the target session identity", async () => {
		writeModels({ skills: { implement: { model: "zai/glm-4-7" } } });
		const { handlers, setModel } = await setupBracket();
		const target = targetContext();
		await handlers.input!({ text: authorization.command, source: "extension" }, target as never);
		setModel.mockClear();
		await handlers.agent_end?.({}, target as never);
		expect(setModel).toHaveBeenCalledWith(BASELINE_MODEL);
	});

	it("accepts rpiv-args' installed skill wrapper and normalized token trailer", async () => {
		writeModels({ skills: { implement: { model: "zai/glm-4-7" } } });
		const { handlers, appendEntry } = await setupBracket();
		const wrapped =
			'<skill name="implement" location="/skills/implement/SKILL.md">\nbody\n</skill>\n\nSkill input: "docs/a plan.md" Phase 1';
		await handlers.input!({ text: wrapped, source: "extension" }, targetContext() as never);
		expect(appendEntry).toHaveBeenCalledWith(
			"rpiv_next_receipt",
			expect.objectContaining({ attemptId: "attempt-1", status: "accepted" }),
		);
	});

	it("rejects mismatched arguments before applying a model", async () => {
		writeModels({ skills: { implement: { model: "zai/glm-4-7" } } });
		const { handlers, setModel, appendEntry } = await setupBracket();
		await expect(
			handlers.input!(
				{ text: "/skill:implement docs/other.md Phase 1", source: "extension" },
				targetContext() as never,
			),
		).resolves.toEqual({ action: "handled" });
		expect(setModel).not.toHaveBeenCalled();
		expect(appendEntry).toHaveBeenCalledWith(
			"rpiv_next_receipt",
			expect.objectContaining({ attemptId: "attempt-1", status: "rejected" }),
		);
	});
});
