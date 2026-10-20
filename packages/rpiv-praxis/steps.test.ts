import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflows } from "@juicesharp/rpiv-workflow/registration";
import { describe, expect, it } from "vitest";
import { registerRpivWorkflowSupport } from "./rpiv-support.ts";
import { registerStep, stepSkill, stepSkills, stepWorkflowName } from "./steps.ts";

function project() {
	const cwd = mkdtempSync(join(tmpdir(), "rpiv-steps-"));
	const skill = (dir: string, name: string, body = "") => {
		mkdirSync(join(dir, name), { recursive: true });
		writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n${body}---\nbody\n`);
	};
	skill(join(cwd, ".claude", "skills"), "write-note");
	skill(join(cwd, ".claude", "skills"), "commit"); // shadowed by rpiv's own commit
	skill(join(cwd, "config", "skills"), "personal", "contract:\n  produces:\n    kind: side-effect\n");
	return { cwd, config: join(cwd, "config") };
}

describe("step naming", () => {
	it("round-trips a skill through its workflow name", () => {
		expect(stepWorkflowName("research")).toBe("step-research");
		expect(stepSkill("step-research")).toBe("research");
		expect(stepSkill("build")).toBeUndefined();
	});
});

describe("stepSkills", () => {
	it("lists rpiv skills first, then project and user skills, first name winning", () => {
		const { cwd, config } = project();
		const skills = stepSkills(cwd, config);
		const by = (n: string) => skills.find((s) => s.name === n);
		expect(by("research")).toMatchObject({ source: "rpiv", kind: "produces", artifactKind: "research" });
		expect(by("commit")).toMatchObject({ source: "rpiv", kind: "side-effect" });
		expect(by("write-note")).toMatchObject({ source: "project", kind: "none" });
		expect(by("personal")).toMatchObject({ source: "user", kind: "side-effect" });
		expect(skills.filter((s) => s.name === "commit")).toHaveLength(1);
	});
});

describe("registerStep", () => {
	it("refuses a skill that does not exist", async () => {
		const { cwd, config } = project();
		expect(await registerStep("no-such-skill", cwd, config)).toBeUndefined();
	});

	// The guard that matters: the runner refuses to start while ANY catalog
	// workflow has a load error, so every rpiv skill must load cleanly as a step.
	it("turns every rpiv skill into a step workflow that loads with no errors", async () => {
		const { cwd, config } = project();
		const rpiv = stepSkills(cwd, config).filter((s) => s.source === "rpiv");
		expect(rpiv.length).toBeGreaterThan(25);
		const failures: string[] = [];
		const internal = await import("@juicesharp/rpiv-workflow/internal");
		for (const s of rpiv) {
			internal.__resetBuiltIns();
			internal.__resetLoadCache();
			internal.__resetSkillContracts();
			await registerRpivWorkflowSupport(cwd, config);
			await registerStep(s.name, cwd, config);
			const loaded = await loadWorkflows(cwd);
			const errors = loaded.issues.filter((i) => i.severity === "error");
			if (!loaded.workflows.some((w) => w.name === stepWorkflowName(s.name)) || errors.length > 0) {
				failures.push(`${s.name}: ${errors.map((e) => e.message).join("; ") || "not registered"}`);
			}
		}
		expect(failures).toEqual([]);
	}, 120_000);

	it("runs a project skill without a contract as a side-effect step", async () => {
		const { cwd, config } = project();
		await registerRpivWorkflowSupport(cwd, config);
		await registerStep("write-note", cwd, config);
		const wf = (await loadWorkflows(cwd)).workflows.find((w) => w.name === "step-write-note")!;
		expect(wf.start).toBe("write-note");
		expect(wf.stages["write-note"]?.kind).toBe("side-effect");
	});
});
