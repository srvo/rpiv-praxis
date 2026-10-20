import { describe, expect, it } from "vitest";
import { combineAbortSignals } from "./abort-signal.ts";

describe("combineAbortSignals", () => {
	it("combines caller and execution-host cancellation", () => {
		const caller = new AbortController();
		const host = new AbortController();
		const combined = combineAbortSignals(caller.signal, host.signal)!;

		host.abort();
		expect(combined.aborted).toBe(true);
	});

	it("retains either sole signal and leaves an absent signal undefined", () => {
		const caller = new AbortController();
		expect(combineAbortSignals(caller.signal)).toBe(caller.signal);
		expect(combineAbortSignals()).toBeUndefined();
	});
});
