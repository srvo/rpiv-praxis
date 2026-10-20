/**
 * verdict-collector per-member tightness (kata es63): a panel member collects
 * only its OWN dimension's verdict written in its own window — never a
 * sibling dimension's, and never a prior round's that it merely names.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fs as fsHandle, type RunView } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VERDICT_DIR } from "./shared.ts";
import { type VerdictSnapshot, verdictCollector } from "./verdict-collector.ts";

const DIR = VERDICT_DIR;
const PLAN_BASE = "2026-01-01_00-00-00_demo-plan";

const say = (text: string): unknown => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

describe("verdictCollector — per-member verdict names", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "rpiv-verdict-member-"));
		mkdirSync(join(cwd, DIR), { recursive: true });
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	const seed = (name: string) => writeFileSync(join(cwd, DIR, name), "{}", "utf-8");
	const stateWith = (plans: boolean): RunView =>
		({
			named: plans
				? { plans: [{ artifacts: [{ handle: fsHandle(`.rpiv/artifacts/plans/${PLAN_BASE}.md`) }] }] }
				: {},
		}) as unknown as RunView;
	const collectWith = async (
		collector: ReturnType<typeof verdictCollector>,
		snapshot: VerdictSnapshot,
		branch: unknown[],
		plans: boolean,
	) =>
		collector.collect({
			cwd,
			runId: "r",
			stageIndex: 0,
			state: stateWith(plans),
			branch: branch as never,
			branchOffset: undefined,
			snapshot,
			skill: "grade",
			unitLabel: "actionability",
		} as never);
	const snap = (collector: ReturnType<typeof verdictCollector>, plans: boolean) =>
		collector.snapshot?.({ cwd, runId: "r", stageIndex: 0, state: stateWith(plans) }) as VerdictSnapshot;

	it("without a source channel, the dimension alone still excludes a sibling dimension's NEW verdict", async () => {
		const collector = verdictCollector({ dir: DIR }); // no sourceChannel → no stem
		const snapshot = snap(collector, false);
		seed(`${PLAN_BASE}__correctness__new.json`); // sibling, written in the window
		const sibling = await collectWith(
			collector,
			snapshot,
			[say(`verdict at ${DIR}/${PLAN_BASE}__correctness__new.json`)],
			false,
		);
		expect(sibling.kind).toBe("fatal");
		seed(`${PLAN_BASE}__actionability__new.json`);
		const own = await collectWith(collector, snapshot, [], false);
		expect(own).toMatchObject({
			kind: "ok",
			artifacts: [{ handle: { path: `${DIR}/${PLAN_BASE}__actionability__new.json` } }],
		});
	});

	it("a prior round's verdict named in assistant text is not collected", async () => {
		const collector = verdictCollector({ dir: DIR, sourceChannel: "plans" });
		seed(`${PLAN_BASE}__actionability__round1.json`); // listed at snapshot, untouched since
		const snapshot = snap(collector, true);
		const result = await collectWith(
			collector,
			snapshot,
			[say(`prior verdict: ${DIR}/${PLAN_BASE}__actionability__round1.json`)],
			true,
		);
		expect(result.kind).toBe("fatal");
	});
});
