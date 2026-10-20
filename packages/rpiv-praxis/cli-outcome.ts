import { writeFileSync } from "node:fs";
import type { RunWorkflowResult } from "@juicesharp/rpiv-workflow";
import { formatPark, type Park } from "./park-store.ts";
import type { RunLedger } from "./run-ledger.ts";
import type { UsageTotals } from "./usage.ts";

export const EXIT = { ok: 0, failed: 1, usage: 2, parked: 75, budget: 76, timeout: 124, interrupted: 130 } as const;

export interface CliIo {
	out: (line: string) => void;
	err: (line: string) => void;
}

function reportResult(result: RunWorkflowResult, io: CliIo): number {
	const where = result.runId ? ` (run ${result.runId})` : "";
	if (result.success) {
		io.out(`completed${where}: ${result.stagesCompleted} stage(s)`);
		if (result.lastArtifact) io.out(`artifact: ${result.lastArtifact}`);
		return EXIT.ok;
	}
	io.err(`failed${where} after ${result.stagesCompleted} stage(s): ${result.error ?? "unknown error"}`);
	return EXIT.failed;
}

/** Surface one settled invocation, persist its terminal ledger row, and export requested metrics. */
export function reportInvocation({
	result,
	parked,
	limit,
	interrupted,
	ledger,
	io,
	totals,
	metricsFile,
}: {
	result: RunWorkflowResult;
	parked: readonly Park[];
	limit?: "budget" | "timeout";
	interrupted: boolean;
	ledger: RunLedger;
	io: CliIo;
	totals: UsageTotals;
	metricsFile?: string;
}): number {
	ledger.end();
	let code: number;
	if (parked.length > 0) {
		for (const park of parked) io.out(formatPark(park));
		io.out(`parked: answer with \`rpiv-wf answer ${parked[0]!.runId} ${parked[0]!.n} <choice>\``);
		code = EXIT.parked;
		ledger.terminal(
			"parked",
			parked.map((park) => `${park.stage ?? "stage"}: ${park.questions[0]?.question ?? "a question"}`).join("; "),
			code,
		);
	} else if (limit && !(limit === "budget" && result.success)) {
		io.err(`stopped (${limit})${result.runId ? ` — run ${result.runId}` : ""}`);
		code = limit === "budget" ? EXIT.budget : EXIT.timeout;
		ledger.terminal("aborted", `stopped at the ${limit} limit`, code);
	} else if (interrupted) {
		io.err("interrupted");
		code = EXIT.interrupted;
		ledger.terminal("aborted", "interrupted by a stop signal", code);
	} else {
		code = reportResult(result, io);
		if (result.success) ledger.terminal("completed", `${result.stagesCompleted} stage(s)`, code);
		else ledger.terminal("failed", result.error ?? "unknown error", code);
	}
	if (metricsFile) {
		const metrics = {
			exitCode: code,
			runId: result.runId ?? parked[0]?.runId ?? null,
			stagesCompleted: result.stagesCompleted,
			error: result.error ?? null,
			stopped: limit ?? null,
			parked: parked.map((park) => ({ n: park.n, stage: park.stage, question: park.questions[0]?.question })),
			usage: totals,
		};
		try {
			writeFileSync(metricsFile, `${JSON.stringify(metrics, null, "\t")}\n`);
		} catch (error) {
			process.stderr.write(`[warning] could not write metrics to ${metricsFile}: ${String(error)}\n`);
		}
	}
	return code;
}
