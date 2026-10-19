import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunWorkflowResult } from "@juicesharp/rpiv-workflow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliIo, EXIT, reportInvocation } from "./cli-outcome.js";
import type { Park } from "./park-store.js";
import type { RunLedger } from "./run-ledger.js";
import { emptyTotals } from "./usage.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rpiv-cli-outcome-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const park: Park = {
	n: 1,
	runId: "run-9",
	stage: "pick",
	prompt: "p",
	sessionId: "s",
	questions: [{ question: "Which colour?", options: [] } as never],
	status: "waiting",
	askedAt: "2026-10-18T00:00:00.000Z",
} as Park;

const ledger = () =>
	({ end: vi.fn(), terminal: vi.fn() }) as unknown as RunLedger & {
		terminal: ReturnType<typeof vi.fn>;
	};
const io = () => {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } as CliIo };
};
const success: RunWorkflowResult = { success: true, stagesCompleted: 2, runId: "run-9" };

describe("reportInvocation — parked outcome", () => {
	it("exits parked and exports the question text in the metrics file", () => {
		const metricsFile = join(dir, "metrics.json");
		const l = ledger();
		const { io: cio, out } = io();
		const code = reportInvocation({
			result: { success: false, stagesCompleted: 1, runId: "run-9" },
			parked: [park],
			interrupted: false,
			ledger: l,
			io: cio,
			totals: emptyTotals(),
			metricsFile,
		});
		expect(code).toBe(EXIT.parked);
		expect(out.join("\n")).toContain("rpiv-wf answer run-9 1");
		expect(l.terminal).toHaveBeenCalledWith("parked", "pick: Which colour?", EXIT.parked);
		const metrics = JSON.parse(readFileSync(metricsFile, "utf8"));
		expect(metrics).toMatchObject({
			exitCode: EXIT.parked,
			runId: "run-9",
			parked: [{ n: 1, stage: "pick", question: "Which colour?" }],
		});
	});
});

describe("reportInvocation — metrics export", () => {
	it("writes completion metrics when asked", () => {
		const metricsFile = join(dir, "metrics.json");
		const { io: cio } = io();
		const code = reportInvocation({
			result: success,
			parked: [],
			interrupted: false,
			ledger: ledger(),
			io: cio,
			totals: emptyTotals(),
			metricsFile,
		});
		expect(code).toBe(EXIT.ok);
		expect(JSON.parse(readFileSync(metricsFile, "utf8"))).toMatchObject({
			exitCode: EXIT.ok,
			stagesCompleted: 2,
			error: null,
			stopped: null,
			parked: [],
		});
	});

	it("warns on stderr instead of failing when the metrics path is unwritable", () => {
		const metricsFile = join(dir, "missing-dir", "metrics.json");
		const { io: cio } = io();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const code = reportInvocation({
			result: success,
			parked: [],
			interrupted: false,
			ledger: ledger(),
			io: cio,
			totals: emptyTotals(),
			metricsFile,
		});
		expect(code).toBe(EXIT.ok);
		expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain(
			`could not write metrics to ${metricsFile}`,
		);
	});
});
