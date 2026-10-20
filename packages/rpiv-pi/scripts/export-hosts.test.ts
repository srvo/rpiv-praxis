// biome-ignore-all lint/suspicious/noTemplateCurlyInString: ${SKILL_DIR}-style strings here are literal shell variables, not templates.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	bangGrants,
	type Catalog,
	defaultPaths,
	diff,
	render,
	run,
	splitFrontmatter,
	transformAgent,
	transformBody,
	transformSkill,
} from "./export-hosts.ts";

const catalog: Catalog = { skills: new Set(["plan", "commit"]), agents: new Set(["codebase-locator"]) };

const skill = `---
name: plan
description: Plan things.
argument-hint: "[topic]"
allowed-tools: Read, Grep
shell-timeout: 10
contract:
  produces:
    kind: artifact
---

# Plan

\`\`\`!
node "\${SKILL_DIR}/../_shared/now.mjs"
echo
\`\`\`

Dispatch subagent_type: \`codebase-locator\`, then \`Agent({ subagent_type: "codebase-locator" })\`.
Ask via \`ask_user_question\`. Next: \`/skill:commit\`. Run \`node scripts/migrate.js --project-dir "\${CWD}"\`.
Mention \`unrelated-name\`.
`;

describe("splitFrontmatter", () => {
	it("keeps nested blocks verbatim under their top-level key", () => {
		const fm = splitFrontmatter(skill);
		expect(fm.keys.get("contract")).toBe("contract:\n  produces:\n    kind: artifact");
		expect(fm.body.startsWith("\n# Plan")).toBe(true);
	});

	it("rejects text without frontmatter", () => {
		expect(() => splitFrontmatter("# no frontmatter")).toThrow("missing frontmatter");
	});
});

describe("transformSkill — claude", () => {
	const out = transformSkill(skill, "claude", catalog, "plan");

	it("keeps only Claude skill keys", () => {
		const fm = splitFrontmatter(out);
		expect([...fm.keys.keys()]).toEqual(["name", "description", "argument-hint", "allowed-tools"]);
	});

	it("grants exactly the node helpers its ! blocks run", () => {
		expect(splitFrontmatter(out).keys.get("allowed-tools")).toBe(
			'allowed-tools: Read, Grep, Bash(node "${CLAUDE_SKILL_DIR}/../_shared/now.mjs")',
		);
	});

	it("rewrites host-specific references", () => {
		expect(out).toContain('node "${CLAUDE_SKILL_DIR}/../_shared/now.mjs"');
		expect(out).toContain("`rpiv:codebase-locator`");
		expect(out).toContain('subagent_type: "rpiv:codebase-locator"');
		expect(out).toContain("`AskUserQuestion`");
		expect(out).toContain("`/rpiv:commit`");
		expect(out).toContain('node "${CLAUDE_PLUGIN_ROOT}/scripts/migrate.js" --project-dir "$PWD"');
		expect(out).toContain("`unrelated-name`");
		expect(out).toContain("```!\n");
	});
});

describe("transformSkill — agents", () => {
	const out = transformSkill(skill, "agents", catalog, "plan");

	it("cuts frontmatter to the Agent Skills spec and adds the preamble", () => {
		expect([...splitFrontmatter(out).keys.keys()]).toEqual(["name", "description"]);
		expect(out).toContain("Portable build of an rpiv skill");
	});

	it("turns ! blocks into run-first steps and keeps names unnamespaced", () => {
		expect(out).not.toContain("```!");
		expect(out).toContain("Run these commands first");
		expect(out).toContain('node "${SKILL_DIR}/../../scripts/migrate.js"');
		expect(out).toContain("`/commit`");
		expect(out).toContain("`codebase-locator`");
	});
});

describe("transformBody fails closed", () => {
	it("on an unknown /skill: target", () => {
		expect(() => transformBody("see /skill:nope", "claude", catalog, "x")).toThrow("/skill:nope names no skill");
	});

	it("on positional placeholders for claude only", () => {
		expect(() => transformBody("deploy $1", "claude", catalog, "x")).toThrow("positional placeholder");
		expect(() => transformBody("slice ${@:2}", "claude", catalog, "x")).toThrow("positional placeholder");
		expect(transformBody("deploy $1", "agents", catalog, "x")).toBe("deploy $1");
	});
});

describe("bangGrants", () => {
	it("ignores node lines outside ! blocks", () => {
		expect(bangGrants('```\nnode "x.mjs"\n```\n')).toEqual([]);
	});
});

describe("transformAgent", () => {
	const agent = `---
name: codebase-locator
description: Finds files.
tools: read, grep, find, ls, ext:rpiv-web-tools/web_search
isolated: true
---

Use \`read\` then \`ls\`.
`;

	it("maps Pi tools to Claude tools, deduped, and drops Pi-only keys", () => {
		const out = transformAgent(agent, "claude", catalog, "a");
		expect(out).toContain("tools: Read, Grep, Glob, WebSearch\n");
		expect(out).not.toContain("isolated");
		expect(out).toContain("Use `Read` then `Glob`.");
	});

	it("keeps only name and description for the portable pack", () => {
		const out = transformAgent(agent, "agents", catalog, "a");
		expect([...splitFrontmatter(out).keys.keys()]).toEqual(["name", "description"]);
		expect(out).toContain("Use `read` then `ls`.");
	});

	it("throws on a tool with no Claude equivalent", () => {
		expect(() => transformAgent(agent.replace("read,", "teleport,"), "claude", catalog, "a")).toThrow(
			'no Claude Code tool for "teleport"',
		);
	});
});

describe("committed hosts/ output", () => {
	it("matches a fresh render of skills/ and agents/", () => {
		const paths = defaultPaths();
		expect(diff(paths, render(paths))).toEqual([]);
	});
});

describe("run", () => {
	let root: string | undefined;
	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	function fixture() {
		root = mkdtempSync(join(tmpdir(), "export-hosts-"));
		const pkgRoot = join(root, "packages", "p");
		mkdirSync(join(pkgRoot, "skills", "plan"), { recursive: true });
		mkdirSync(join(pkgRoot, "skills", "_shared"), { recursive: true });
		mkdirSync(join(pkgRoot, "agents"), { recursive: true });
		mkdirSync(join(pkgRoot, "scripts"), { recursive: true });
		writeFileSync(join(pkgRoot, "package.json"), JSON.stringify({ name: "p", version: "1.2.3", author: "a" }));
		writeFileSync(join(pkgRoot, "skills", "plan", "SKILL.md"), "---\nname: plan\ndescription: d\n---\nbody\n");
		writeFileSync(join(pkgRoot, "skills", "_shared", "now.mjs"), "x\n");
		writeFileSync(join(pkgRoot, "skills", "_shared", "now.test.ts"), "test\n");
		writeFileSync(join(pkgRoot, "agents", "codebase-locator.md"), "---\nname: c\ndescription: d\ntools: read\n---\n");
		writeFileSync(join(pkgRoot, "scripts", "migrate.js"), "m\n");
		return { repoRoot: root, pkgRoot };
	}

	it("writes, then checks clean, then reports a hand edit and a stale file", () => {
		const paths = fixture();
		const log: string[] = [];
		expect(run(["--write"], paths, (m) => log.push(m))).toBe(0);
		expect(run(["--check"], paths, (m) => log.push(m))).toBe(0);

		const files = render(paths);
		expect(files.has("packages/p/hosts/claude/skills/_shared/now.test.ts")).toBe(false);
		expect(files.get("packages/p/hosts/claude/.claude-plugin/plugin.json")).toContain('"version": "1.2.3"');

		writeFileSync(join(paths.pkgRoot, "hosts", "claude", "skills", "plan", "SKILL.md"), "edited\n");
		writeFileSync(join(paths.pkgRoot, "hosts", "agents", "orphan.md"), "x\n");
		log.length = 0;
		expect(run(["--check"], paths, (m) => log.push(m))).toBe(1);
		expect(log.join("\n")).toContain("packages/p/hosts/claude/skills/plan/SKILL.md");
		expect(log.join("\n")).toContain("packages/p/hosts/agents/orphan.md (stale)");
	});

	it("rejects an unknown mode", () => {
		expect(run([], fixture(), () => {})).toBe(2);
	});
});
