import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_KATA_LABELS, detectKata, type Exec, KATA_LABEL, onPath, refFrom, ticketBody } from "./kata.js";
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
	const labelsOf = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "--label" ? [a] : []));

	it("files a ticket labelled rpiv-parked and human by default, so it reaches the timeline (kata 79yy)", () => {
		const { calls, exec } = recorder({ create: '{"issue":{"ref":"ab12"}}' });
		const kata = detectKata(() => {}, exec, { PATH: binDir() })!;
		expect(kata.file(park, "rpiv-wf answer r1 1 <choice>")).toBe("ab12");
		expect(calls[0]!.args.slice(0, 1)).toEqual(["create"]);
		expect(calls[0]!.args).toEqual(expect.arrayContaining(["--body-stdin", "--json"]));
		expect(calls[0]!.input).toContain("rpiv-wf answer r1 1 <choice>");
		expect(labelsOf(calls[0]!.args)).toEqual([KATA_LABEL, "human"]);
		expect(DEFAULT_KATA_LABELS).toContain("human");
		expect(calls[0]!.args).not.toContain("--parent");
		expect(calls).toHaveLength(1);
	});

	it("labels are configurable (option over env) and --kata files the park under the phase ticket", () => {
		const a = recorder({ create: '{"ref":"x1"}' });
		detectKata(() => {}, a.exec, { PATH: binDir() }, { labels: ["rpiv-parked"], parent: "ph42" })!.file(park, "h");
		expect(labelsOf(a.calls[0]!.args)).toEqual(["rpiv-parked"]);
		expect(a.calls[0]!.args.join(" ")).toContain("--parent ph42");
		const b = recorder({ create: '{"ref":"x1"}' });
		detectKata(() => {}, b.exec, { PATH: binDir(), RPIV_WF_KATA_LABELS: "a, b" })!.file(park, "h");
		expect(labelsOf(b.calls[0]!.args)).toEqual(["a", "b"]);
		const c = recorder({ create: '{"ref":"x1"}' });
		detectKata(() => {}, c.exec, { PATH: binDir() }, { labels: [] })!.file(park, "h");
		expect(labelsOf(c.calls[0]!.args)).toEqual([]);
	});

	it("closes the ticket with the answer, typed evidence and a message kata 0.18 accepts (kata raw9)", () => {
		const { calls, exec } = recorder();
		detectKata(() => {}, exec, { PATH: binDir() })!.close({ ...park, kata: "ab12", answer: "Red" });
		const args = calls[0]!.args;
		expect(args.slice(0, 3)).toEqual(["close", "ab12", "--done"]);
		expect(args[args.indexOf("--evidence") + 1]).toBe("external:rpiv-wf:r1#1");
		const message = args[args.indexOf("--message") + 1]!;
		expect(message).toContain("Red");
		// kata 0.18: "message too short for reason=done (need >=40 chars)".
		expect(message.length).toBeGreaterThanOrEqual(40);
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
		expect(warnings).toHaveLength(3);
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
