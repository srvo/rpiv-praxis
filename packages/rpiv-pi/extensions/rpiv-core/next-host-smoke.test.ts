import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// The shared test setup mocks compat's model catalog for unit tests. This suite
// deliberately exercises the real native provider/model/session implementation.
vi.unmock("@earendil-works/pi-ai");
vi.unmock("@earendil-works/pi-ai/compat");

import {
	createNativeSmokeFixture,
	OLD_TRANSCRIPT,
	PROVIDER,
} from "./built-ins/__fixtures__/next-host-smoke-fixture.ts";

describe("/next native host smoke (P3.2, rpiv-praxis#y9nt)", () => {
	let fixture: Awaited<ReturnType<typeof createNativeSmokeFixture>> | undefined;
	afterEach(async () => {
		await fixture?.cleanup();
		fixture = undefined;
	});

	it("replaces the real session, admits exactly one phase-bearing skill input, and stops at its footer", async () => {
		const network = vi.fn(() => {
			throw new Error("Native smoke must not access the network");
		});
		vi.stubGlobal("fetch", network);
		fixture = await createNativeSmokeFixture();
		const f = fixture;
		const source = f.runtime.session;
		const sourceId = source.sessionId;
		const sourceFile = source.sessionManager.getSessionFile();
		expect(sourceFile).toBeDefined();
		expect(f.runtime.services.resourceLoader.getExtensions().errors).toEqual([]);
		expect(f.runtime.services.resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["implement"]);

		// A real model turn writes both the old transcript and approved handoff.
		await source.prompt(`Remember ${OLD_TRANSCRIPT}. Return the inert approved handoff.`);
		expect(f.calls).toHaveLength(1);
		expect(existsSync(sourceFile!)).toBe(true);
		const persistedSource = readFileSync(sourceFile!, "utf8");
		expect(persistedSource).toContain(OLD_TRANSCRIPT);
		expect(persistedSource).toContain("**Next step:**");
		expect(f.events.filter((event) => event.sessionId === sourceId).map((event) => event.type)).toContain(
			"agent_end",
		);

		// Native prompt dispatch invokes the registered /next command, which
		// replaces/disposes source and queues real skill execution on the target.
		const disposeSource = vi.spyOn(source, "dispose");
		await source.prompt("/next");
		const target = f.runtime.session;
		expect(target).not.toBe(source);
		expect(target.sessionId).not.toBe(sourceId);
		await target.waitForIdle();
		// prompt dispatch can schedule the target turn after the command resolves.
		await vi.waitFor(
			() => {
				expect(
					f.events.filter((event) => event.sessionId === target.sessionId && event.type === "agent_end"),
				).toHaveLength(1);
			},
			{ timeout: 5000 },
		);
		await target.waitForIdle();

		const targetId = target.sessionId;
		const targetFile = target.sessionManager.getSessionFile();
		expect(targetFile).toBeDefined();
		expect(targetFile).not.toBe(sourceFile);
		const targetEntries = readFileSync(targetFile!, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const header = targetEntries.find((entry) => entry.type === "session");
		// SDK 1.1 stores parentSession as previousSessionFile (a path), not UUID.
		expect(header.parentSession).toBe(sourceFile);
		expect(header.cwd).toBe(f.cwd);
		expect(f.sessions).toEqual([source, target]);
		expect(f.shutdowns).toEqual([sourceId]);
		expect(f.starts).toEqual([
			{ sessionId: sourceId, reason: "startup" },
			{ sessionId: targetId, reason: "new" },
		]);
		expect(disposeSource).toHaveBeenCalledTimes(1);

		const targetJson = JSON.stringify(targetEntries);
		expect(targetJson).not.toContain(OLD_TRANSCRIPT);
		expect(targetJson).not.toContain("Remember ");
		const messages = targetEntries.filter((entry) => entry.type === "message").map((entry) => entry.message);
		const capsules = targetEntries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "rpiv_next_handoff",
		);
		expect(capsules).toHaveLength(1);
		expect(capsules[0].content).toContain("fresh session authorized for exactly one RPIV stage");
		expect(capsules[0].content).toContain(sourceId);
		expect(capsules[0].content).toContain(f.artifact);
		expect(capsules[0].content.length).toBeLessThan(5000);

		const receipts = targetEntries.filter(
			(entry) => entry.type === "custom" && entry.customType === "rpiv_next_receipt",
		);
		expect(receipts.map((entry) => entry.data.status)).toEqual(["accepted"]);
		const snapshots = targetEntries.filter(
			(entry) => entry.type === "custom" && entry.customType === "rpiv_next_authorization",
		);
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0].data.command).toBe(f.command);
		expect(snapshots[0].data.sourceSessionFile).toBe(sourceFile);
		expect(snapshots[0].data.sourceSessionId).toBe(sourceId);

		const targetInputs = f.inputs.filter((input) => input.sessionId === targetId);
		expect(targetInputs).toHaveLength(1);
		expect(targetInputs[0].source).toBe("extension");
		expect(targetInputs[0].cwd).toBe(f.cwd);
		expect(targetInputs[0].text).toContain('<skill name="implement"');
		expect(targetInputs[0].text).toContain('Skill input: "docs/a plan.md" Phase 1');
		expect(targetInputs[0].text).toContain("FILE=docs/a plan.md; PHASE=Phase 1");
		expect(targetInputs[0].text).toContain("ALL=docs/a plan.md Phase 1");
		expect(targetInputs[0].text).toContain(`DIR=${f.skillDir}; SESSION=${targetId}`);
		expect(targetInputs[0].text).toContain("SETUP_OK");
		expect(targetInputs[0].text).not.toMatch(/\$ARGUMENTS|\$\{SKILL_DIR\}|\$\{SESSION_ID\}|```!/);
		expect(readFileSync(f.setupFile, "utf8")).toBe("setup\n");

		expect(f.calls.map((call) => call.model)).toEqual(["baseline", "stage", "stage"]);
		expect(f.calls.slice(1).map((call) => call.reasoning)).toEqual(["high", "high"]);
		for (const call of f.calls.slice(1)) {
			expect(JSON.stringify(call.messages)).not.toContain(OLD_TRANSCRIPT);
			expect(JSON.stringify(call.messages)).toContain("fresh session authorized for exactly one RPIV stage");
		}
		expect(f.modelMutations).toEqual(["stage", "baseline"]);
		expect(f.thinkingMutations).toEqual(["high", "low"]);
		expect(target.model?.provider).toBe(PROVIDER);
		expect(target.model?.id).toBe("baseline");
		expect(target.thinkingLevel).toBe("low");

		const toolResults = messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].toolName).toBe("bash");
		expect(toolResults[0].isError).toBe(false);
		expect(toolResults[0].content).toEqual([{ type: "text", text: `${f.cwd}\n` }]);
		expect(
			f.events.filter((event) => event.sessionId === targetId && event.type === "tool_execution_end"),
		).toHaveLength(1);
		expect(f.facts).toEqual([
			{ sessionId: sourceId, persistedRequired: true },
			{ sessionId: sourceId, persistedRequired: true },
			{ sessionId: targetId, persistedRequired: false },
		]);
		expect(f.errors).toEqual([]);
		expect(f.notices.filter((message) => /did not|failed|refused/i.test(message))).toEqual([]);

		// A model-emitted validate footer is data, never permission to continue.
		expect(JSON.stringify(messages.at(-1))).toContain("/skill:validate");
		await new Promise((resolve) => setImmediate(resolve));
		expect(f.runtime.session).toBe(target);
		expect(f.sessions).toHaveLength(2);
		expect(f.calls).toHaveLength(3);
		expect(f.inputs.filter((input) => input.sessionId === targetId)).toHaveLength(1);
		expect(network).not.toHaveBeenCalled();
	}, 15000);
});
