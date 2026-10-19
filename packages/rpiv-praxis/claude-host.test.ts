import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BranchEntry, WorkflowSessionContext } from "@juicesharp/rpiv-workflow";
import { describe, expect, it, vi } from "vitest";
import {
	type ClaudeHostDeps,
	ClaudeWorkflowHost,
	childEnv,
	claudeModel,
	PARKED_MESSAGE,
	type Parking,
	recommendedAnswers,
} from "./claude-host.js";

type Call = { prompt: string; options: Record<string, any> };

/** A fake SDK: each `query` call yields the scripted messages for that turn. */
function fakeSdk(turns: Array<(call: Call) => unknown[] | Promise<never> | AsyncIterable<unknown>>) {
	const calls: Call[] = [];
	const query = vi.fn((params: { prompt: string; options: Record<string, any> }) => {
		const call = { prompt: params.prompt, options: params.options };
		calls.push(call);
		const script = turns[calls.length - 1] ?? (() => []);
		return (async function* () {
			const msgs = script(call);
			if (Symbol.asyncIterator in Object(msgs)) yield* msgs as AsyncIterable<unknown>;
			else for (const m of (await msgs) as unknown[]) yield m;
		})();
	});
	const forkSession = vi.fn(async (_id: string) => ({ sessionId: "forked-id" }));
	return { deps: { query, forkSession } as unknown as ClaudeHostDeps, calls, forkSession };
}

const init = (id: string) => ({ type: "system", subtype: "init", session_id: id });
const say = (id: string, text: string, parent: string | null = null) => ({
	type: "assistant",
	session_id: id,
	parent_tool_use_id: parent,
	message: { content: [{ type: "text", text }] },
});
const result = (id: string, subtype = "success", stop_reason: string | null = "end_turn") => ({
	type: "result",
	subtype,
	session_id: id,
	stop_reason,
});

function host(deps: ClaudeHostDeps, extra: Partial<ConstructorParameters<typeof ClaudeWorkflowHost>[0]> = {}) {
	const notes: string[] = [];
	const h = new ClaudeWorkflowHost(
		{
			cwd: "/proj",
			pluginDir: "/plugin",
			catalog: { plugin: new Set(["plan"]), local: new Set(["note"]) },
			permissionMode: "auto",
			maxConcurrency: 2,
			notify: (m) => notes.push(m),
			locate: (id) => `/sessions/${id}.jsonl`,
			...extra,
		},
		deps,
	);
	return { h, notes };
}

async function run(
	h: ClaudeWorkflowHost,
	opts: Record<string, unknown> = {},
	body?: (c: WorkflowSessionContext) => Promise<void>,
) {
	let branch: BranchEntry[] = [];
	let child!: WorkflowSessionContext;
	await h.spawnChild({
		prompt: "/skill:plan do it",
		...opts,
		withSession: async (c) => {
			child = c;
			await c.waitForIdle();
			await body?.(c);
			branch = c.sessionManager.getBranch() as BranchEntry[];
		},
	});
	return { branch, child };
}

const lastAssistant = (b: BranchEntry[]) => [...b].reverse().find((e) => e.message?.role === "assistant")!.message!;

describe("ClaudeWorkflowHost — fresh stage", () => {
	it("sends the translated prompt with plugin, cwd and an env stripped of the launcher's session", async () => {
		const prev = process.env.CLAUDE_CODE_SESSION_ID;
		process.env.CLAUDE_CODE_SESSION_ID = "launcher-session";
		try {
			const sdk = fakeSdk([() => [init("s1"), say("s1", "ok"), result("s1")]]);
			await run(host(sdk.deps).h);
			const { prompt, options } = sdk.calls[0]!;
			expect(prompt).toBe("/rpiv:plan do it");
			expect(options.cwd).toBe("/proj");
			expect(options.plugins).toEqual([{ type: "local", path: "/plugin" }]);
			expect(options.permissionMode).toBe("auto");
			expect(options.resume).toBeUndefined();
			expect(options.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
			expect(options.env.PATH).toBe(process.env.PATH);
		} finally {
			if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
			else process.env.CLAUDE_CODE_SESSION_ID = prev;
		}
	});

	it("records main-thread assistant text, ignores subagent frames, and stamps the result's stop", async () => {
		const sdk = fakeSdk([() => [init("s1"), say("s1", "sub", "toolu_1"), say("s1", "main"), result("s1")]]);
		const { branch, child } = await run(host(sdk.deps).h);
		expect(branch.map((e) => e.message?.role)).toEqual(["user", "assistant"]);
		expect(lastAssistant(branch)).toMatchObject({ stopReason: "stop", content: [{ text: "main" }] });
		expect(child.sessionManager.getSessionId()).toBe("s1");
		expect(child.sessionManager.getSessionFile()).toBe("/sessions/s1.jsonl");
	});

	it("resumes the same session on a re-prompt", async () => {
		const sdk = fakeSdk([() => [init("s1"), say("s1", "one"), result("s1")], () => [say("s1", "two"), result("s1")]]);
		const { branch } = await run(host(sdk.deps).h, {}, async (c) => {
			await c.sendUserMessage("/skill:note fix it");
			await c.waitForIdle();
		});
		expect(sdk.calls[1]!.options.resume).toBe("s1");
		expect(sdk.calls[1]!.prompt).toBe("/note fix it");
		expect(branch.filter((e) => e.message?.role === "assistant")).toHaveLength(2);
	});

	it.each([
		["error_max_turns", null, "length"],
		["error_during_execution", null, "error"],
		["success", "max_tokens", "length"],
	])("maps a %s result (stop_reason %s) to %s", async (subtype, stop, expected) => {
		const sdk = fakeSdk([() => [init("s1"), say("s1", "x"), result("s1", subtype, stop)]]);
		const { branch } = await run(host(sdk.deps).h);
		expect(lastAssistant(branch).stopReason).toBe(expected);
	});

	it("records a turn with no assistant reply as an empty stopped assistant entry", async () => {
		const sdk = fakeSdk([() => [init("s1"), result("s1", "error_during_execution")]]);
		const { branch } = await run(host(sdk.deps).h);
		expect(lastAssistant(branch)).toEqual({ role: "assistant", content: [], stopReason: "error" });
	});

	it("turns an SDK failure into an error stop and a notification, never a throw", async () => {
		const sdk = fakeSdk([() => Promise.reject(new Error("boom"))]);
		const { h, notes } = host(sdk.deps);
		const { branch } = await run(h);
		expect(lastAssistant(branch).stopReason).toBe("error");
		expect(notes.join()).toContain("boom");
	});

	it("records an abort as aborted without notifying", async () => {
		const ac = new AbortController();
		const sdk = fakeSdk([
			() => {
				ac.abort();
				return Promise.reject(new Error("aborted"));
			},
		]);
		const { h, notes } = host(sdk.deps);
		const { branch } = await run(h, { signal: ac.signal });
		expect(lastAssistant(branch).stopReason).toBe("aborted");
		expect(notes).toEqual([]);
	});

	it("does not call the SDK when the run is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		const sdk = fakeSdk([]);
		const { branch } = await run(host(sdk.deps, { signal: ac.signal }).h);
		expect(sdk.calls).toHaveLength(0);
		expect(lastAssistant(branch).stopReason).toBe("aborted");
	});

	it("a halt lets the running turn finish and keeps it, but starts no new turn", async () => {
		const halt = new AbortController();
		const sdk = fakeSdk([
			() => {
				halt.abort(); // --max-cost reached during this turn
				return [init("s1"), say("s1", "done"), result("s1")];
			},
		]);
		const { branch } = await run(host(sdk.deps, { halt: halt.signal }).h, {}, async (c) => {
			expect(lastAssistant(c.sessionManager.getBranch() as BranchEntry[]).stopReason).toBe("stop");
			await c.sendUserMessage("/skill:note again");
			await c.waitForIdle();
		});
		expect(sdk.calls).toHaveLength(1);
		expect(lastAssistant(branch).stopReason).toBe("aborted");
	});

	it("applies the stage's model selection", async () => {
		const sdk = fakeSdk([() => [result("s1")]]);
		await run(host(sdk.deps).h, { model: { model: "anthropic/claude-opus-5-5", thinking: "xhigh" } });
		expect(sdk.calls[0]!.options).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" });
	});

	it("gives concurrent children independent sessions", async () => {
		let n = 0;
		const sdk = fakeSdk(
			[0, 1].map(() => () => {
				const id = `s${++n}`;
				return [init(id), say(id, id), result(id)];
			}),
		);
		const { h } = host(sdk.deps);
		const [a, b] = await Promise.all([run(h), run(h)]);
		expect(new Set([a.child.sessionManager.getSessionId(), b.child.sessionManager.getSessionId()])).toEqual(
			new Set(["s1", "s2"]),
		);
	});
});

describe("ClaudeWorkflowHost — reattach and fork", () => {
	function sessionFile(): string {
		const dir = mkdtempSync(join(tmpdir(), "rpiv-praxis-"));
		const file = join(dir, "orig-id.jsonl");
		const rows = [
			{ type: "user", message: { role: "user", content: "first" } },
			{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
		];
		writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));
		return file;
	}

	it("reattach loads the transcript, sends nothing, and resumes on the next turn", async () => {
		const sdk = fakeSdk([() => [say("orig-id", "again"), result("orig-id")]]);
		const file = sessionFile();
		const { branch, child } = await run(host(sdk.deps).h, { reattach: { sessionFile: file } }, async (c) => {
			expect(sdk.calls).toHaveLength(0);
			expect(c.sessionManager.getBranch()).toHaveLength(2);
			await c.sendUserMessage("continue");
			await c.waitForIdle();
		});
		expect(sdk.calls[0]!.options.resume).toBe("orig-id");
		expect(child.sessionManager.getSessionFile()).toBe(file);
		expect(branch).toHaveLength(4);
	});

	it("fork copies the predecessor into a new session and keeps its transcript as the prefix", async () => {
		const sdk = fakeSdk([() => [say("forked-id", "cont"), result("forked-id")]]);
		const file = sessionFile();
		const { child } = await run(host(sdk.deps).h, { fork: { sessionFile: file } }, async (c) => {
			expect(c.sessionManager.getBranch()).toHaveLength(2);
			await c.sendUserMessage("next");
			await c.waitForIdle();
		});
		expect(sdk.forkSession).toHaveBeenCalledWith("orig-id", { dir: "/proj" });
		expect(sdk.calls[0]!.options.resume).toBe("forked-id");
		expect(child.sessionManager.getSessionId()).toBe("forked-id");
		expect(child.sessionManager.getSessionFile()).toBe("/sessions/forked-id.jsonl");
		expect(child.sessionManager.getSessionFile()).not.toBe(file);
	});

	it("an unlocatable fork reports no file rather than its predecessor's", async () => {
		const sdk = fakeSdk([]);
		const { child } = await run(host(sdk.deps, { locate: () => undefined }).h, {
			fork: { sessionFile: sessionFile() },
		});
		expect(child.sessionManager.getSessionFile()).toBeUndefined();
	});
});

describe("claudeModel", () => {
	it("drops an anthropic/ prefix and passes bare ids and aliases through", () => {
		expect(claudeModel("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
		expect(claudeModel("opus")).toBe("opus");
	});

	it("refuses another provider's model", () => {
		expect(() => claudeModel("zai/glm-5.1")).toThrow("not an Anthropic model");
	});

	it("a refused model fails the stage, not the process", async () => {
		const sdk = fakeSdk([]);
		const { branch } = await run(host(sdk.deps).h, { model: { model: "zai/glm-5.1" } });
		expect(sdk.calls).toHaveLength(0);
		expect(lastAssistant(branch).stopReason).toBe("error");
	});
});

describe("childEnv", () => {
	it("strips both session-identity variables and tags the client", () => {
		const env = childEnv({ CLAUDE_CODE_SESSION_ID: "a", CLAUDE_CODE_REMOTE_SESSION_ID: "b", HOME: "/h" });
		expect(env).toEqual({ HOME: "/h", CLAUDE_AGENT_SDK_CLIENT_APP: "rpiv-praxis" });
	});
});

describe("ClaudeWorkflowHost — parking", () => {
	const ask = { questions: [{ question: "Red or blue?", options: [{ label: "Red" }, { label: "Blue" }] }] };
	const parkingStub = (over: Partial<Parking> = {}): Parking & { park: ReturnType<typeof vi.fn> } =>
		({ park: vi.fn(), answerFor: vi.fn(() => undefined), ...over }) as never;

	it("installs no permission callback when parking is off", async () => {
		const sdk = fakeSdk([() => [result("s1")]]);
		await run(host(sdk.deps).h);
		expect(sdk.calls[0]!.options.canUseTool).toBeUndefined();
	});

	it("parks an AskUserQuestion: records it, tells the model to stop, and ends the stage aborted", async () => {
		const parking = parkingStub();
		let verdict: unknown;
		const sdk = fakeSdk([
			(call) =>
				(async function* () {
					yield init("s1");
					verdict = await call.options.canUseTool("AskUserQuestion", ask, {
						signal: new AbortController().signal,
					});
					yield result("s1", "error_during_execution");
				})(),
		]);
		const { branch } = await run(host(sdk.deps, { parking }).h);
		expect(parking.park).toHaveBeenCalledWith({
			prompt: "/skill:plan do it",
			sessionId: "s1",
			sessionFile: "/sessions/s1.jsonl",
			questions: ask.questions,
		});
		expect(verdict).toEqual({ behavior: "deny", message: PARKED_MESSAGE, interrupt: true });
		expect(lastAssistant(branch).stopReason).toBe("aborted");
	});

	it("stores the text written before the question as the park's context (kata r923)", async () => {
		const parking = parkingStub({ noteContext: vi.fn() });
		const asking = {
			type: "assistant",
			session_id: "s1",
			parent_tool_use_id: null,
			message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: ask }] },
		};
		const sdk = fakeSdk([
			(call) =>
				(async function* () {
					yield init("s1");
					yield say("s1", "Found 5 cross-slice issues:\n1. slice 2 and 4 both own the schema");
					yield asking;
					await call.options.canUseTool("AskUserQuestion", ask, { signal: new AbortController().signal });
					yield say("s1", "Stopping as instructed.");
					yield result("s1", "error_during_execution");
				})(),
		]);
		await run(host(sdk.deps, { parking }).h);
		const context = "Found 5 cross-slice issues:\n1. slice 2 and 4 both own the schema";
		expect(parking.park).toHaveBeenCalledWith(expect.objectContaining({ context }));
		// The turn-end refresh keeps the text before the question, not the post-park acknowledgement.
		expect(parking.noteContext).toHaveBeenCalledWith("s1", context);
	});

	it("names the stage that actually asked in the park (kata 79yy)", async () => {
		const parking = parkingStub();
		const sdk = fakeSdk([
			(call) =>
				(async function* () {
					yield init("s1");
					await call.options.canUseTool("AskUserQuestion", ask, { signal: new AbortController().signal });
					yield result("s1", "error_during_execution");
				})(),
		]);
		await run(host(sdk.deps, { parking }).h, { stage: "design (slice-2)" });
		expect(parking.park).toHaveBeenCalledWith(expect.objectContaining({ stage: "design (slice-2)" }));
	});

	it("denies every other tool, exactly as an unattended run without the callback would", async () => {
		const parking = parkingStub();
		let verdict: any;
		const sdk = fakeSdk([
			(call) =>
				(async function* () {
					yield init("s1");
					verdict = await call.options.canUseTool("Bash", { command: "rm -rf /" }, {});
					yield result("s1");
				})(),
		]);
		const { branch } = await run(host(sdk.deps, { parking }).h);
		expect(verdict.behavior).toBe("deny");
		expect(verdict.message).toContain("no one can grant it");
		expect(parking.park).not.toHaveBeenCalled();
		expect(lastAssistant(branch).stopReason).toBe("stop");
	});

	it("reopens an answered park's own session and sends the answer instead of the stage prompt", async () => {
		const delivered = vi.fn();
		const parking = parkingStub({
			answerFor: vi.fn(() => ({ sessionId: "parked-s", message: "Answer: Blue", delivered })),
		});
		const sdk = fakeSdk([() => [say("parked-s", "painted blue"), result("parked-s")]]);
		const { child } = await run(host(sdk.deps, { parking }).h, { stage: "plan" });
		expect(parking.answerFor).toHaveBeenCalledWith("plan");
		expect(sdk.calls[0]).toMatchObject({ prompt: "Answer: Blue", options: { resume: "parked-s" } });
		expect(delivered).toHaveBeenCalledOnce();
		expect(child.sessionManager.getSessionId()).toBe("parked-s");
	});

	it("keeps the answer deliverable when an already-aborted turn sends no queries", async () => {
		// Resume raced a stop: `turn` returns at its already-aborted guard before
		// calling query(), so nothing reached the stage. Marking the park resumed
		// here loses the answer permanently — it can no longer be re-answered.
		const delivered = vi.fn();
		const parking = parkingStub({
			answerFor: vi.fn(() => ({ sessionId: "parked-s", message: "Answer: Blue", delivered })),
		});
		const sdk = fakeSdk([() => [say("parked-s", "painted blue"), result("parked-s")]]);
		const stop = new AbortController();
		stop.abort();
		await run(host(sdk.deps, { parking, halt: stop.signal }).h, { stage: "plan" });
		expect(sdk.calls).toHaveLength(0);
		expect(delivered).not.toHaveBeenCalled();
	});

	it("a later live turn never delivers an answer that an earlier aborted turn dropped", async () => {
		const delivered = vi.fn();
		const parking = parkingStub({
			answerFor: vi.fn(() => ({ sessionId: "parked-s", message: "Answer: Blue", delivered })),
		});
		const sdk = fakeSdk([() => [say("parked-s", "follow-up done"), result("parked-s")]]);
		// The first (answer) turn sees the halt; the second turn does not.
		let polls = 0;
		const halt = {
			get aborted() {
				return polls++ === 0;
			},
		} as AbortSignal;
		await run(host(sdk.deps, { parking, halt }).h, { stage: "plan" }, async (c) => {
			await c.sendUserMessage("follow-up");
		});
		expect(sdk.calls).toHaveLength(1);
		expect(sdk.calls[0]).toMatchObject({ prompt: "follow-up" });
		expect(delivered).not.toHaveBeenCalled();
	});

	it("delivers the answer only after a turn actually reached the stage", async () => {
		const delivered = vi.fn();
		const parking = parkingStub({
			answerFor: vi.fn(() => ({ sessionId: "parked-s", message: "Answer: Blue", delivered })),
		});
		const sdk = fakeSdk([() => [say("parked-s", "painted blue"), result("parked-s")]]);
		await run(host(sdk.deps, { parking }).h, { stage: "plan" });
		expect(sdk.calls).toHaveLength(1);
		expect(delivered).toHaveBeenCalledOnce();
	});
});

describe("ClaudeWorkflowHost — usage is per turn, not cumulative", () => {
	const res = (id: string, cost: number) => ({
		type: "result",
		subtype: "success",
		session_id: id,
		stop_reason: "end_turn",
		total_cost_usd: cost,
		num_turns: 1,
		modelUsage: {},
	});

	it("charges a re-prompt only for what it added to the session", async () => {
		const seen: number[] = [];
		const sdk = fakeSdk([
			() => [init("s1"), say("s1", "a"), res("s1", 0.02)],
			() => [say("s1", "b"), res("s1", 0.05)],
		]);
		await run(host(sdk.deps, { onUsage: (u) => seen.push(u.costUsd) }).h, {}, async (c) => {
			await c.sendUserMessage("again");
			await c.waitForIdle();
		});
		expect(seen[0]).toBeCloseTo(0.02);
		expect(seen[1]).toBeCloseTo(0.03);
	});

	it("attributes each turn's usage to the engine's stage name for the child", async () => {
		const seen: Array<{ stage?: string; sessionId: string }> = [];
		const sdk = fakeSdk([() => [init("s1"), say("s1", "a"), res("s1", 0.02)]]);
		await run(host(sdk.deps, { onUsage: (_u, info) => seen.push(info) }).h, { stage: "impl (phase-2)" });
		expect(seen).toEqual([{ stage: "impl (phase-2)", sessionId: "s1" }]);
	});

	it("starts a resumed parked session from the baseline saved with the park", async () => {
		const seen: number[] = [];
		const parking = {
			park: vi.fn(),
			answerFor: vi.fn(() => ({
				sessionId: "p1",
				message: "Answer: Blue",
				delivered: () => {},
				usage: { costUsd: 0.06, models: {} },
			})),
		};
		const sdk = fakeSdk([() => [say("p1", "done"), res("p1", 0.08)]]);
		await run(host(sdk.deps, { parking, onUsage: (u) => seen.push(u.costUsd) }).h);
		expect(seen[0]).toBeCloseTo(0.02);
	});

	it("starts a fork from its source session's total", async () => {
		const seen: number[] = [];
		const dir = mkdtempSync(join(tmpdir(), "rpiv-fork-usage-"));
		writeFileSync(join(dir, "src-id.jsonl"), "");
		const sdk = fakeSdk([
			() => [init("src-id"), res("src-id", 0.04)],
			() => [say("forked-id", "x"), res("forked-id", 0.05)],
		]);
		const { h } = host(sdk.deps, { onUsage: (u) => seen.push(u.costUsd) });
		await run(h);
		await run(h, { fork: { sessionFile: join(dir, "src-id.jsonl") } }, async (c) => {
			await c.sendUserMessage("continue");
			await c.waitForIdle();
		});
		expect(seen[0]).toBeCloseTo(0.04);
		expect(seen[1]).toBeCloseTo(0.01);
	});
});

describe("ClaudeWorkflowHost — human checkpoints (kata ac4x)", () => {
	const confirm = {
		questions: [
			{ question: "Accept the design?", options: [{ label: "Accept (Recommended)" }, { label: "Adjust a slice" }] },
		],
	};
	const stub = (over: Partial<Parking> = {}) =>
		({ park: vi.fn(), answerFor: vi.fn(() => undefined), record: vi.fn(), ...over }) as Parking & {
			park: ReturnType<typeof vi.fn>;
			record: ReturnType<typeof vi.fn>;
		};
	const asking = () =>
		fakeSdk([
			(call) =>
				(async function* () {
					yield init("s1");
					call.options.verdict = await call.options.canUseTool("AskUserQuestion", confirm, {
						signal: new AbortController().signal,
					});
					yield result("s1");
				})(),
		]);
	const silent = () => fakeSdk([() => [init("s1"), say("s1", "design accepted: 3 slices"), result("s1")]]);

	it("a checkpoint that completes without asking fails the stage", async () => {
		const { h, notes } = host(silent().deps, { parking: stub() });
		const { branch } = await run(h, { stage: "design-review", checkpoint: true });
		expect(lastAssistant(branch).stopReason).toBe("error");
		expect(notes.join("\n")).toMatch(/human checkpoint design-review completed without a person's answer/);
	});

	it("an ordinary stage that completes without asking is fine", async () => {
		const { branch } = await run(host(silent().deps, { parking: stub() }).h, { stage: "plan" });
		expect(lastAssistant(branch).stopReason).toBe("stop");
	});

	it("a checkpoint resumed with a person's answer may complete", async () => {
		const delivered = vi.fn();
		const parking = stub({ answerFor: vi.fn(() => ({ sessionId: "p1", message: "Answer: Accept", delivered })) });
		const sdk = fakeSdk([() => [say("p1", "design accepted"), result("p1")]]);
		const { branch } = await run(host(sdk.deps, { parking }).h, { stage: "design-review", checkpoint: true });
		expect(lastAssistant(branch).stopReason).toBe("stop");
	});

	it("a checkpoint's question always parks, even when it carries a (Recommended) option", async () => {
		const parking = stub();
		const sdk = asking();
		await run(host(sdk.deps, { parking, autoAcceptConfirmations: true }).h, {
			stage: "design-review",
			checkpoint: true,
		});
		expect(parking.park).toHaveBeenCalledOnce();
		expect(sdk.calls[0]!.options.verdict).toMatchObject({ behavior: "deny", interrupt: true });
	});

	it("--auto-accept-checkpoints answers with the recommendation and logs it", async () => {
		const parking = stub();
		const sdk = asking();
		const { branch } = await run(host(sdk.deps, { parking, autoAcceptCheckpoints: true }).h, {
			stage: "design-review",
			checkpoint: true,
		});
		expect(parking.park).not.toHaveBeenCalled();
		expect(sdk.calls[0]!.options.verdict).toEqual({
			behavior: "allow",
			updatedInput: { ...confirm, answers: { "Accept the design?": "Accept (Recommended)" } },
		});
		expect(parking.record).toHaveBeenCalledWith(
			expect.objectContaining({ type: "checkpoint-auto-accepted", stage: "design-review" }),
		);
		expect(lastAssistant(branch).stopReason).toBe("stop");
	});

	it("--auto-accept-checkpoints lets a silent checkpoint pass, and logs that too", async () => {
		const parking = stub();
		const { branch } = await run(host(silent().deps, { parking, autoAcceptCheckpoints: true }).h, {
			stage: "design-review",
			checkpoint: true,
		});
		expect(lastAssistant(branch).stopReason).toBe("stop");
		expect(parking.record).toHaveBeenCalledWith(expect.objectContaining({ type: "checkpoint-auto-accepted" }));
	});
});

describe("ClaudeWorkflowHost — routine confirmations (kata 439b)", () => {
	const q = (question: string, labels: string[], multiSelect = false) => ({
		question,
		options: labels.map((label) => ({ label })),
		...(multiSelect ? { multiSelect } : {}),
	});
	const stub = () =>
		({ park: vi.fn(), answerFor: vi.fn(() => undefined), record: vi.fn() }) as Parking & {
			park: ReturnType<typeof vi.fn>;
			record: ReturnType<typeof vi.fn>;
		};
	const asking = (questions: unknown[]) =>
		fakeSdk([
			(call) =>
				(async function* () {
					yield init("s1");
					call.options.verdict = await call.options.canUseTool(
						"AskUserQuestion",
						{ questions },
						{ signal: new AbortController().signal },
					);
					yield result("s1", call.options.verdict.behavior === "deny" ? "error_during_execution" : "success");
				})(),
		]);
	const writeIt = q("Scan complete. Write the research doc?", ["Write it (Recommended)", "Keep scanning"]);

	it("classifies: one (Recommended) option per single-select question is a confirmation", () => {
		expect(recommendedAnswers([writeIt])).toEqual({
			"Scan complete. Write the research doc?": "Write it (Recommended)",
		});
		expect(recommendedAnswers([q("Which store?", ["Postgres", "SQLite"])])).toBeUndefined();
		expect(recommendedAnswers([q("Pick", ["A (Recommended)", "B (Recommended)"])])).toBeUndefined();
		expect(recommendedAnswers([q("Pick", ["A (Recommended)", "B"], true)])).toBeUndefined();
		expect(recommendedAnswers([writeIt, q("Which store?", ["Postgres", "SQLite"])])).toBeUndefined();
		expect(recommendedAnswers([])).toBeUndefined();
	});

	it("auto-accepts a confirmation with its recommendation and logs it, instead of parking", async () => {
		const parking = stub();
		const sdk = asking([writeIt]);
		const { branch, child } = await run(host(sdk.deps, { parking, autoAcceptConfirmations: true }).h, {
			stage: "research",
		});
		expect(parking.park).not.toHaveBeenCalled();
		expect(sdk.calls[0]!.options.verdict).toEqual({
			behavior: "allow",
			updatedInput: { questions: [writeIt], answers: { [writeIt.question]: "Write it (Recommended)" } },
		});
		expect(parking.record).toHaveBeenCalledWith(
			expect.objectContaining({ type: "confirmation-auto-accepted", stage: "research" }),
		);
		expect(lastAssistant(branch).stopReason).toBe("stop");
		expect((child as unknown as { parked(): boolean }).parked()).toBe(false);
	});

	it("parks a decision, and parks a confirmation when auto-accept is off", async () => {
		for (const [questions, auto] of [
			[[q("Which store?", ["Postgres", "SQLite"])], true],
			[[writeIt], false],
		] as const) {
			const parking = stub();
			await run(host(asking([...questions]).deps, { parking, autoAcceptConfirmations: auto }).h, { stage: "s" });
			expect(parking.park).toHaveBeenCalledOnce();
			expect(parking.record).not.toHaveBeenCalled();
		}
	});

	it("a park is reported as parked, without the error_during_execution warning", async () => {
		const parking = stub();
		const { h, notes } = host(asking([q("Which store?", ["Postgres", "SQLite"])]).deps, { parking });
		const { child } = await run(h, { stage: "s" });
		expect((child as unknown as { parked(): boolean }).parked()).toBe(true);
		expect(notes.join("\n")).not.toContain("error_during_execution");
	});
});
