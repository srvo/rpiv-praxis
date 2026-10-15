import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectKata, type Exec, KATA_LABEL, onPath, refFrom, ticketBody } from "./kata.js";
import type { Park } from "./park-store.js";

const park: Park = {
	n: 1,
	runId: "r1",
	workflow: "build",
	stage: "design-review",
	prompt: "/skill:x",
	sessionId: "s",
	questions: [{ question: "Accept?", options: [{ label: "Accept", description: "go" }, { label: "Adjust" }] }],
	status: "waiting",
	askedAt: "t",
};

function binDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-kata-"));
	writeFileSync(join(dir, "kata"), "#!/bin/sh\n");
	chmodSync(join(dir, "kata"), 0o755);
	return dir;
}

function recorder(responses: Record<string, string | Error> = {}) {
	const calls: Array<{ args: string[]; input?: string }> = [];
	const exec: Exec = (_cmd, args, input) => {
		calls.push({ args, input });
		const r = responses[args[0]!];
		if (r instanceof Error) throw r;
		return r ?? "";
	};
	return { calls, exec };
}

describe("kata detection", () => {
	it("is off without kata on PATH, or when switched off", () => {
		expect(detectKata(() => {}, recorder().exec, { PATH: "/nonexistent" })).toBeUndefined();
		expect(detectKata(() => {}, recorder().exec, { PATH: binDir(), RPIV_WF_KATA: "off" })).toBeUndefined();
		expect(onPath("kata", { PATH: `:${binDir()}` })).toBe(true);
		expect(onPath("kata", {})).toBe(false);
	});
});

describe("kata tickets", () => {
	it("files a ticket labelled rpiv-parked, never human or decision", () => {
		const { calls, exec } = recorder({ create: '{"issue":{"ref":"ab12"}}' });
		const kata = detectKata(() => {}, exec, { PATH: binDir() })!;
		expect(kata.file(park, "rpiv-wf answer r1 1 <choice>")).toBe("ab12");
		expect(calls[0]!.args.slice(0, 1)).toEqual(["create"]);
		expect(calls[0]!.args).toEqual(expect.arrayContaining(["--body-stdin", "--json"]));
		expect(calls[0]!.input).toContain("rpiv-wf answer r1 1 <choice>");
		expect(calls[1]!.args).toEqual(["label", "add", "ab12", KATA_LABEL]);
		expect(KATA_LABEL).not.toMatch(/^(human|decision)$/);
	});

	it("closes the ticket with the answer", () => {
		const { calls, exec } = recorder();
		detectKata(() => {}, exec, { PATH: binDir() })!.close({ ...park, kata: "ab12", answer: "Accept" });
		expect(calls[0]!.args).toEqual(["close", "ab12", "--done", "--message", "Answered via rpiv-wf: Accept"]);
	});

	it("never throws: failures are warnings and parking carries on", () => {
		const warnings: string[] = [];
		const boom = new Error("daemon down");
		const failing = detectKata((m) => warnings.push(m), recorder({ create: boom, close: boom }).exec, {
			PATH: binDir(),
		})!;
		expect(failing.file(park, "hint")).toBeUndefined();
		failing.close({ ...park, kata: "ab12" });
		failing.close(park);
		const noRef = detectKata((m) => warnings.push(m), recorder({ create: "not json" }).exec, { PATH: binDir() })!;
		expect(noRef.file(park, "hint")).toBeUndefined();
		const badLabel = detectKata((m) => warnings.push(m), recorder({ create: '{"ref":"x1"}', label: boom }).exec, {
			PATH: binDir(),
		})!;
		expect(badLabel.file(park, "hint")).toBe("x1");
		expect(warnings).toHaveLength(4);
	});

	it("reads the ref from the common response shapes", () => {
		expect(refFrom('{"ref":"a"}')).toBe("a");
		expect(refFrom('{"issue":{"short_id":"b"}}')).toBe("b");
		expect(refFrom('{"id":""}')).toBeUndefined();
		expect(refFrom("nope")).toBeUndefined();
	});

	it("puts the workflow, stage, options and answer command in the body", () => {
		const body = ticketBody(park, "rpiv-wf answer r1 1 <choice>");
		expect(body).toContain("`build` parked at stage `design-review`");
		expect(body).toContain("1. Accept — go");
		expect(body).toContain("2. Adjust");
	});
});
