/**
 * scope-requarantine.test.ts — the scope floor halts on a path an earlier
 * `scope-quarantine` round already moved and something re-created, instead of
 * quarantining it again. Run 2026-10-16_19-30-04-6bc9: an implementer split
 * code into two files no phase declared; quarantine moved them, validate-fix
 * re-created them (other files import them), and check → quarantine →
 * re-create repeated until the backward-jump limit, 117 stages in.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunView } from "@juicesharp/rpiv-workflow";
import { fs as fsHandle } from "@juicesharp/rpiv-workflow/registration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findWorkflow } from "../workflow-test-harness.js";

type StageRun = (ctx: { cwd: string; input?: undefined; state: RunView }) => { data: Record<string, unknown> };

const PLAN_REL = ".rpiv/artifacts/plans/p.md";
const planBody = (files: string[]) =>
	`---\nstatus: ready\nphase_count: 1\nphases:\n  - { n: 1, title: P, files: ${JSON.stringify(files)} }\n---\n## Phase 1: P\n`;
const out = (rel: string) => ({ artifacts: [{ handle: fsHandle(rel) }], data: undefined, kind: "", meta: {} });
const plansState = (...plans: string[]) => ({ named: { plans: plans.map(out) } }) as unknown as RunView;

describe.each(["build", "vet"])("%s implement-scope-check re-quarantine halt", (wf) => {
	let cwd: string;
	const stageRun = (name: string): StageRun => {
		const run = findWorkflow(wf).stages[name]?.run;
		if (!run) throw new Error(`${wf} ${name} has no run function`);
		return run as unknown as StageRun;
	};
	const write = (rel: string, body = "x\n") => {
		mkdirSync(join(cwd, rel, ".."), { recursive: true });
		writeFileSync(join(cwd, rel), body);
	};

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "rpiv-requarantine-"));
		execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
		write(PLAN_REL, planBody(["packages/a/foo.ts"]));
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("halts instead of moving a re-created file again, and passes once the plan declares it", () => {
		const check = stageRun("implement-scope-check");
		write("packages/a/foo_split.ts");
		const first = check({ cwd, state: plansState(PLAN_REL) });
		expect(first.data.verdict).toBe("untracked-only");
		stageRun("scope-quarantine")({
			cwd,
			state: {
				named: {
					plans: [out(PLAN_REL)],
					"implement-scope-check": [{ artifacts: [], data: first.data, kind: "json", meta: {} }],
				},
			} as unknown as RunView,
		});
		expect(existsSync(join(cwd, "packages/a/foo_split.ts"))).toBe(false);

		// A repair re-creates the file the run depends on.
		write("packages/a/foo_split.ts");
		expect(() => check({ cwd, state: plansState(PLAN_REL) })).toThrow(
			/packages\/a\/foo_split\.ts was moved to \.rpiv\/tmp\/scope-quarantine\/.*Add each path to the owning phase's `files:` in \.rpiv\/artifacts\/plans\/p\.md/s,
		);
		expect(existsSync(join(cwd, "packages/a/foo_split.ts"))).toBe(true);

		// The operator's fix: declare it, then resume (re-run the check).
		write(PLAN_REL, planBody(["packages/a/foo.ts", "packages/a/foo_split.ts"]));
		expect(check({ cwd, state: plansState(PLAN_REL) }).data.verdict).toBe("pass");
	});

	it("still routes a first-time untracked path to quarantine", () => {
		write(
			".rpiv/artifacts/verdicts/scope-quarantine__p.json",
			JSON.stringify({ moved: [{ from: ".tmp/old.mjs", to: ".rpiv/tmp/scope-quarantine/.tmp/old.mjs" }] }),
		);
		write(".tmp/new.mjs");
		expect(stageRun("implement-scope-check")({ cwd, state: plansState(PLAN_REL) }).data.verdict).toBe(
			"untracked-only",
		);
	});

	it("reads every plan's manifest (vet appends one plan per fix round)", () => {
		const NEXT = ".rpiv/artifacts/plans/q.md";
		write(NEXT, planBody(["packages/a/foo.ts"]));
		write(
			".rpiv/artifacts/verdicts/scope-quarantine__p.json",
			JSON.stringify({ moved: [{ from: ".tmp/back.mjs", to: ".rpiv/tmp/scope-quarantine/.tmp/back.mjs" }] }),
		);
		write(".tmp/back.mjs");
		expect(() => stageRun("implement-scope-check")({ cwd, state: plansState(PLAN_REL, NEXT) })).toThrow(
			/\.tmp\/back\.mjs was moved/,
		);
	});
});
