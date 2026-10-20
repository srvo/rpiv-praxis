import { describe, expect, it } from "vitest";
import type { TrialResult } from "./eval.ts";
import { memorySink, trialActivity } from "./eval-activity.ts";
import { emptyTotals } from "./usage.ts";

const trial = (over: Partial<TrialResult> = {}): TrialResult => ({
	variant: "base",
	repeat: 1,
	state: "completed",
	exitCodes: [0],
	answered: 0,
	stagesCompleted: 3,
	wallMs: 12_000,
	usage: emptyTotals(),
	checks: [{ name: "marker", pass: true, output: "found" }],
	dir: "/tmp/out/trials/base__1",
	alias: "eval-base-1-abc123",
	...over,
});

describe("trialActivity — what 'functional' means", () => {
	it("is functional when the workflow completed and every check passed", () => {
		const item = trialActivity("demo", "0123456789abcdef", trial());
		expect(item.status).toBe("observed");
		expect(item.sourceType).toBe("eval_trial");
		expect(item.payload.functional).toBe(true);
		expect(item.title).toMatch(/functional$/); // ends in "functional", not "not functional (...)"
		expect(item.summary).toContain("on code 0123456789ab");
		expect(item.summary).toContain("run eval-base-1-abc123");
	});

	it("is not functional when a check fails, and names it", () => {
		const item = trialActivity(
			"demo",
			"code",
			trial({
				checks: [
					{ name: "marker", pass: true, output: "" },
					{ name: "footer", pass: false, output: "missing" },
				],
			}),
		);
		expect(item.payload.functional).toBe(false);
		expect(item.payload.checksFailed).toEqual(["footer"]);
		expect(item.summary).toContain("failed checks: footer");
	});

	it("is not functional when the trial parked or was cut off, even with no failed check", () => {
		for (const state of ["parked", "interrupted", "error"]) {
			const item = trialActivity("demo", "code", trial({ state, checks: [] }));
			expect(item.payload.functional, state).toBe(false);
			expect(item.title).toContain(`not functional (${state})`);
		}
	});

	it("carries the code version and run attempt so a row traces to what actually ran", () => {
		const item = trialActivity("demo", "deadbeefdeadbeef", trial());
		expect(item.payload.codeFingerprint).toBe("deadbeefdeadbeef");
		expect(item.payload.attempt).toBe("abc123");
		expect(item.sourceId).toBe("demo:base#1@abc123");
		expect(item.payload.eval).toBe("demo");
		expect(item.payload.variant).toBe("base");
		expect(item.payload.repeat).toBe(1);
	});

	it("reports an unknown attempt rather than inventing one when the alias is absent", () => {
		const item = trialActivity("demo", "code", trial({ alias: undefined }));
		expect(item.payload.attempt).toBe("unknown");
		expect(item.sourceId).toBe("demo:base#1@unknown");
		expect(item.summary).not.toContain("run eval-");
	});

	it("includes the error text when the trial errored", () => {
		const item = trialActivity("demo", "code", trial({ state: "error", error: "fixture missing" }));
		expect(item.payload.error).toBe("fixture missing");
		expect(item.summary).toContain("error: fixture missing");
	});
});

describe("memorySink", () => {
	it("collects emitted items in order and hands back a copy", () => {
		const sink = memorySink();
		sink.emit(trialActivity("demo", "c", trial({ variant: "a" })));
		sink.emit(trialActivity("demo", "c", trial({ variant: "b" })));
		const items = sink.items();
		expect(items.map((i) => i.payload.variant)).toEqual(["a", "b"]);
		items.pop();
		expect(sink.items()).toHaveLength(2);
	});
});
