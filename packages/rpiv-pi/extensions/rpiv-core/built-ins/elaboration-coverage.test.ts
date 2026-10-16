/**
 * code-splice coverage precondition (kata es63): the stitch leaves an
 * unelaborated phase as-is, so the splice refuses unless every plan phase has
 * a non-failed elaboration from THIS run on the elaborations channel.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunView } from "@juicesharp/rpiv-workflow";
import { fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkflow } from "../workflow-test-harness.js";
import { elaborationCoverageGaps } from "./elaboration.js";

const STEM = "2026-01-01_00-00-00_demo";
const PLAN = `.rpiv/artifacts/plans/${STEM}.md`;
const PLAN_BODY = [
	"---",
	"phase_count: 2",
	"---",
	"## Phase 1: one",
	"x",
	"```md",
	"## Phase 9: fenced example, not a phase",
	"```",
	"## Phase 2: two",
	"y",
].join("\n");

const elab = (n: number) => ({
	kind: "artifact-md",
	artifacts: [{ handle: fsHandle(`.rpiv/artifacts/elaborations/${STEM}__phase-${n}.md`) }],
	data: {},
	meta: {},
});
const failed = { kind: "failed", artifacts: [], data: { reason: "boom" }, meta: {} };
const stateOf = (elaborations: unknown[]): RunView =>
	({ named: { plans: [{ artifacts: [{ handle: fsHandle(PLAN) }] }], elaborations } }) as unknown as RunView;

describe("elaborationCoverageGaps", () => {
	it("is empty when every out-of-fence phase has an elaboration", () => {
		expect(elaborationCoverageGaps(stateOf([elab(1), elab(2)]), PLAN, PLAN_BODY)).toEqual([]);
	});

	it("names an uncovered phase and a failed unit", () => {
		expect(elaborationCoverageGaps(stateOf([elab(1), failed]), PLAN, PLAN_BODY)).toEqual([
			"phase 2",
			"1 failed elaborate unit(s)",
		]);
	});

	it("an elaboration for a different plan does not cover", () => {
		const other = {
			...elab(2),
			artifacts: [{ handle: fsHandle(".rpiv/artifacts/elaborations/other-plan__phase-2.md") }],
		};
		expect(elaborationCoverageGaps(stateOf([elab(1), other]), PLAN, PLAN_BODY)).toEqual(["phase 2"]);
	});
});

describe("code-splice refuses a partial elaboration set", () => {
	let tmpDir: string;
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "rpiv-splice-cov-"));
		mkdirSync(join(tmpDir, ".rpiv", "artifacts", "plans"), { recursive: true });
		writeFileSync(join(tmpDir, PLAN), PLAN_BODY);
	});
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("halts before the stitch runs when a phase is missing", () => {
		const stage = findWorkflow("build").stages["code-splice"];
		if (!stage?.run) throw new Error("build code-splice stage has no run function");
		const run = stage.run as (ctx: { cwd: string; state: RunView }) => unknown;
		expect(() => run({ cwd: tmpDir, state: stateOf([elab(1)]) })).toThrow(/missing elaborations: phase 2/);
	});
});
