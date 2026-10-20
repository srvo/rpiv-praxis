import type { RunWorkflowResult } from "@juicesharp/rpiv-workflow";
import { describe, expect, it } from "vitest";
import { rerunRefusal } from "./rerun-notice.ts";

const failed = (over: Partial<RunWorkflowResult>): RunWorkflowResult => ({
	success: false,
	stagesCompleted: 0,
	error: "boom",
	...over,
});

// The shape an in-run failure really has: runId, error and a termination outcome.
const inRunFailure = (error: string): RunWorkflowResult =>
	failed({ runId: "run-1", error, termination: { status: "failed", error } });

describe("rerun refusal surfacing", () => {
	it("surfaces a lease refusal that carries a runId but no termination", () => {
		// withRunLease returns the runId it could not claim; nothing else tells the person.
		const refusal = failed({
			runId: "run-1",
			error: "another RPIV writer already holds the lease for run-1",
		});
		expect(rerunRefusal(refusal)).toBe("another RPIV writer already holds the lease for run-1");
	});

	it("surfaces a pre-run refusal with no runId and no termination", () => {
		expect(rerunRefusal(failed({ error: "run not found" }))).toBe("run not found");
	});

	it("stays silent on an in-run failure, which the stage machinery already notified", () => {
		expect(rerunRefusal(inRunFailure("research produced no assistant message"))).toBeUndefined();
	});

	it("stays silent on success", () => {
		expect(rerunRefusal({ success: true, stagesCompleted: 3, runId: "run-1" })).toBeUndefined();
	});

	it("stays silent on an unsuccessful result without error text", () => {
		expect(rerunRefusal(failed({ error: "" }))).toBeUndefined();
	});
});
