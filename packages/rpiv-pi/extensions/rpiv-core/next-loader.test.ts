import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
	type ExecOptions,
	type ExtensionAPI,
	type ExtensionContext,
	type InputEventResult,
	parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import { configPath } from "@juicesharp/rpiv-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerArgsHandler } from "../../../rpiv-args/args.js";
import { NEXT_AUTHORIZATION_ENTRY, NEXT_RECEIPT_ENTRY, type NextAuthorization } from "./next-authorization.js";
import { registerSessionCapture } from "./session-capture.js";
import { registerSkillBracket } from "./skill-bracket.js";

const runFile = promisify(execFile);
const BASELINE = { provider: "anthropic", id: "baseline" };
const OVERRIDE = { provider: "zai", id: "glm-4-7" };
const SESSION_ID = "next-loader-target";
const RAW_ARGS = '"docs/a plan.md" Phase 1';
const orders = ["args-first", "bracket-first"] as const;
type Order = (typeof orders)[number];
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown | Promise<unknown>;
const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function loader(order: Order, tokens = true, rawArgs = RAW_ARGS, wrongRegistryPath = false) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "rpiv-next-loader-")));
	roots.push(cwd);
	const skillDir = join(cwd, "public skills", "implement");
	const skillPath = join(skillDir, "SKILL.md");
	const artifact = join(cwd, "docs", "a plan.md");
	mkdirSync(skillDir, { recursive: true });
	mkdirSync(dirname(artifact), { recursive: true });
	writeFileSync(artifact, "# Approved plan\n\n## Phase 1\nImplement only this phase.\n");
	writeFileSync(join(skillDir, "reference.md"), "# Skill-relative reference\n");
	const body = [
		"# Implement fixture",
		...(tokens ? ["Arguments: $ARGUMENTS", "First: $1", "Phase: $2 $3"] : []),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal skill-loader substitution token.
		"Directory: ${SKILL_DIR}",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal skill-loader substitution token.
		"Session: ${SESSION_ID}",
		"Read reference.md relative to this skill.",
		"```!",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal skill-loader substitution token.
		'printf "setup\\n" >> "${SKILL_DIR}/setup-runs.txt"',
		"pwd -P",
		"```",
	].join("\n");
	writeFileSync(
		skillPath,
		`---\nname: implement\ndescription: Public implementation stage fixture\ndisable-model-invocation: true\n---\n\n  ${body}\n\n  `,
	);
	const registryPath = wrongRegistryPath ? join(skillDir, "other-SKILL.md") : skillPath;
	if (wrongRegistryPath) writeFileSync(registryPath, readFileSync(skillPath));
	const command = `/skill:implement ${rawArgs}`;
	const authorization: NextAuthorization = {
		attemptId: "next-loader-attempt",
		sourceSessionId: "source-session",
		sourceEntryId: "assistant-handoff",
		sourceSessionFile: join(cwd, "source-session.jsonl"),
		targetSessionId: SESSION_ID,
		command,
		stageName: "implement",
		skillPath,
		inputArtifact: artifact,
		inputArtifactSha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"),
		workingDirectory: cwd,
		branch: "y9nt-next-phase1",
		kataIssue: "rpiv-praxis#y9nt",
		requiresTokenSubstitution: tokens,
	};
	const entries: { type: string; customType: string; data: unknown }[] = [
		{ type: "custom", customType: NEXT_AUTHORIZATION_ENTRY, data: authorization },
	];
	const handlers = new Map<string, Handler[]>();
	const seen: string[] = [];
	const errors: unknown[] = [];
	let thinking = "medium";
	const setModel = vi.fn(async () => true);
	const setThinkingLevel = vi.fn((value: string) => {
		thinking = value;
	});
	const appendEntry = vi.fn((customType: string, data: unknown) => {
		entries.push({ type: "custom", customType, data });
	});
	const exec = vi.fn(async (executable: string, args: string[], options?: ExecOptions) => {
		const { stdout, stderr } = await runFile(executable, args, { cwd: options?.cwd, timeout: options?.timeout });
		return { stdout, stderr, code: 0, killed: false };
	});
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getCommands: () => [
			{ name: "skill:implement", source: "skill", sourceInfo: { path: registryPath, baseDir: cwd } },
			{ name: "skill:plan", source: "skill", sourceInfo: { path: registryPath, baseDir: cwd } },
		],
		exec,
		appendEntry,
		setModel,
		getThinkingLevel: () => thinking,
		setThinkingLevel,
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => SESSION_ID, getEntries: () => entries },
		model: BASELINE,
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
	} as unknown as ExtensionContext;
	const modelsPath = configPath("rpiv-pi", "models.json");
	mkdirSync(dirname(modelsPath), { recursive: true });
	writeFileSync(modelsPath, JSON.stringify({ skills: { implement: { model: "zai/glm-4-7", thinking: "minimal" } } }));
	// Vitest cannot change cwd in every pool; exec still spawns a real shell in this real directory.
	vi.spyOn(process, "cwd").mockReturnValue(cwd);
	registerSessionCapture(pi);
	for (const register of order === "args-first"
		? [registerArgsHandler, registerSkillBracket]
		: [registerSkillBracket, registerArgsHandler])
		register(pi);
	const emit = async (type: string, data: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(type) ?? []) await handler({ type, ...data }, ctx);
	};
	await emit("session_start", { reason: "startup" });
	const modelInput = vi.fn();
	const dispatch = async (original = command) => {
		let text = original;
		// Mirrors ExtensionRunner.emitInput: await each handler, feed transforms forward,
		// preserve source, catch handler errors, and stop immediately on handled.
		for (const handler of handlers.get("input") ?? []) {
			seen.push(text);
			try {
				const result = (await handler({ type: "input", text, source: "extension" }, ctx)) as
					| InputEventResult
					| undefined;
				if (result?.action === "handled") return { action: "handled" as const, text };
				if (result?.action === "transform") text = result.text;
			} catch (error) {
				errors.push(error);
			}
		}
		modelInput(text);
		return { action: text === original ? ("continue" as const) : ("transform" as const), text };
	};
	return {
		cwd,
		skillDir,
		skillPath,
		artifact,
		command,
		rawArgs,
		tokens,
		body,
		ctx,
		seen,
		errors,
		exec,
		setModel,
		setThinkingLevel,
		appendEntry,
		modelInput,
		dispatch,
		emit,
	};
}

function expectAccepted(f: Awaited<ReturnType<typeof loader>>, text: string) {
	expect(f.errors).toEqual([]);
	expect(f.appendEntry).toHaveBeenCalledWith(NEXT_RECEIPT_ENTRY, expect.objectContaining({ status: "accepted" }));
	expect(f.modelInput).toHaveBeenCalledExactlyOnceWith(text);
	expect(f.setModel).toHaveBeenCalledExactlyOnceWith(OVERRIDE);
	expect(f.setThinkingLevel).toHaveBeenCalledExactlyOnceWith("minimal");
}

for (const order of orders) {
	describe(`real /next skill loader (${order})`, () => {
		it.each([true, false])(
			"expands the public stage, executes setup once and restores (tokens=%s)",
			async (tokens) => {
				const f = await loader(order, tokens);
				const result = await f.dispatch();
				expect(result.action).toBe("transform");
				expectAccepted(f, result.text);
				const block = parseSkillBlock(result.text)!;
				expect(block).toMatchObject({ name: "implement", location: f.skillPath });
				expect(block.content).toBe(
					`References are relative to ${f.skillDir}.\n\n${f.body
						.replace("$ARGUMENTS", "docs/a plan.md Phase 1")
						.replace("$1", "docs/a plan.md")
						.replace("$2", "Phase")
						.replace("$3", "1")
						// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal skill-loader substitution token.
						.replaceAll("${SKILL_DIR}", f.skillDir)
						// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal skill-loader substitution token.
						.replaceAll("${SESSION_ID}", SESSION_ID)
						.replace(/```!\n[\s\S]*?\n```/, `${f.cwd}\n`)}`,
				);
				expect(block.userMessage).toBe(`${tokens ? "Skill input: " : ""}${RAW_ARGS}`);
				expect(readFileSync(f.artifact, "utf8")).toContain("## Phase 1");
				expect(readFileSync(join(f.skillDir, "reference.md"), "utf8")).toContain("Skill-relative reference");
				expect(f.exec).toHaveBeenCalledOnce();
				expect(f.exec.mock.calls[0]?.[2]).toEqual({ cwd: f.cwd, timeout: 120_000 });
				expect(readFileSync(join(f.skillDir, "setup-runs.txt"), "utf8")).toBe("setup\n");
				expect(f.seen[1]).toBe(order === "args-first" ? result.text : f.command);
				await f.emit("agent_end");
				expect(f.setModel.mock.calls).toEqual([[OVERRIDE], [BASELINE]]);
				expect(f.setThinkingLevel.mock.calls).toEqual([["minimal"], ["medium"]]);
				await f.emit("agent_end");
				expect(f.setModel).toHaveBeenCalledTimes(2);
				expect(f.exec).toHaveBeenCalledOnce();
			},
		);

		it.each([true, false])("preserves a literal user tail beginning Skill input: (tokens=%s)", async (tokens) => {
			const f = await loader(order, tokens, `Skill input: ${RAW_ARGS}`);
			const result = await f.dispatch();
			expectAccepted(f, result.text);
			const block = parseSkillBlock(result.text)!;
			expect(block.userMessage).toBe(`${tokens ? "Skill input: " : ""}Skill input: ${RAW_ARGS}`);
			if (tokens) {
				expect(block.content).toContain("Arguments: Skill input: docs/a plan.md Phase 1");
				expect(block.content).toContain("First: Skill");
			}
		});

		it.each([true, false])(
			"normalizes leading/trailing argument whitespace independent of order (tokens=%s)",
			async (tokens) => {
				const f = await loader(order, tokens);
				const result = await f.dispatch(`/skill:implement  \t${RAW_ARGS} \t\n`);
				expect(result.action).toBe("transform");
				expectAccepted(f, result.text);
				expect(parseSkillBlock(result.text)?.userMessage).toBe(`${tokens ? "Skill input: " : ""}${RAW_ARGS}`);
			},
		);

		it.each(["name", "path", "args", "leading command whitespace"])(
			"rejects wrong %s before any model use",
			async (mismatch) => {
				const f = await loader(order, true, RAW_ARGS, mismatch === "path");
				const text =
					mismatch === "name"
						? f.command.replace("implement", "plan")
						: mismatch === "args"
							? f.command.replace("Phase 1", "Phase 2")
							: mismatch === "leading command whitespace"
								? ` \t${f.command}`
								: f.command;
				const result = await f.dispatch(text);
				expect.soft(result.action).toBe("handled");
				expect.soft(f.errors).toEqual([]);
				expect
					.soft(f.appendEntry)
					.toHaveBeenCalledWith(NEXT_RECEIPT_ENTRY, expect.objectContaining({ status: "rejected" }));
				expect.soft(f.setModel).not.toHaveBeenCalled();
				expect.soft(f.setThinkingLevel).not.toHaveBeenCalled();
				expect.soft(f.modelInput).not.toHaveBeenCalled();
				await f.emit("agent_end");
			},
		);
	});
}
