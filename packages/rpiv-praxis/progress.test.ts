import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildProgressReport,
	discoverWorktrees,
	formatProgressMarkdown,
	type ProgressIssue,
	readKataIssues,
	reportProgress,
} from "./progress.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repoWithWorktree(): { root: string; first: string; second: string } {
	const root = mkdtempSync(join(tmpdir(), "rpiv-progress-"));
	roots.push(root);
	const first = join(root, "first");
	const second = join(root, "second");
	mkdirSync(first);
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	git(first, "init", "-q");
	git(first, "config", "user.email", "rpiv-progress@example.invalid");
	git(first, "config", "user.name", "RPIV Progress Test");
	writeFileSync(join(first, "README.md"), "fixture\n");
	git(first, "add", "README.md");
	git(first, "commit", "-qm", "fixture");
	git(first, "worktree", "add", "-qb", "second", second);
	return { root, first, second };
}

function artifact(worktree: string, bucket: string, filename: string, content: string): void {
	const dir = join(worktree, ".rpiv", "artifacts", bucket);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, filename), content);
}

const issue = (overrides: Partial<ProgressIssue> = {}): ProgressIssue => ({
	qualified_id: "rpiv-praxis#t3nf",
	short_id: "t3nf",
	title: "Workflow safety and progress view",
	status: "open",
	owner: "srvo",
	updated_at: "2026-10-18T15:00:00Z",
	...overrides,
});

describe("project-wide authoring progress", () => {
	it("discovers linked worktrees and aggregates topic stages, Kata links, and overlap evidence", () => {
		const { first, second } = repoWithWorktree();
		artifact(
			first,
			"goals",
			"2026-10-18_09-00-00_alpha-workflow.md",
			"---\ntopic: Alpha workflow\nstatus: started\n---\n",
		);
		artifact(
			first,
			"research",
			"2026-10-18_10-00-00_alpha-workflow.md",
			"---\ntopic: Alpha workflow\nstatus: ready\n---\nTarget: `packages/rpiv-praxis/cli.ts`\nIssue: rpiv-praxis#t3nf\n",
		);
		artifact(
			second,
			"designs",
			"2026-10-18_11-00-00_beta-workflow.md",
			"---\ntopic: Beta workflow\nstatus: in-review\n---\nTarget: `packages/rpiv-praxis/cli.ts`\n",
		);
		const worktrees = discoverWorktrees(first);
		expect(worktrees).toContain(realpathSync(first));
		expect(worktrees).toContain(realpathSync(second));
		const report = buildProgressReport(first, worktrees, { issues: [issue()] });
		expect(report.topics).toHaveLength(2);
		expect(report.topics.find((topic) => topic.title === "Alpha workflow")).toMatchObject({
			latestStage: "research",
			status: "ready",
			pipeline: { current: "research", furthestStep: 2, totalSteps: 6, observedStages: ["discover", "research"] },
			issues: [{ qualifiedId: "rpiv-praxis#t3nf", status: "open" }],
		});
		expect(report.overlapCandidates).toEqual([
			expect.objectContaining({
				topics: ["Alpha workflow", "Beta workflow"],
				evidence: ["shared target file: packages/rpiv-praxis/cli.ts"],
			}),
		]);
		const markdown = formatProgressMarkdown(report);
		expect(markdown).toContain("## RPIV authoring progress");
		expect(markdown).toContain("Handoff");
		expect(markdown).toContain("rpiv-praxis#t3nf");
	});

	it.each(["frontmatter", "body"])("links arbitrary project refs in %s by their qualified IDs", (location) => {
		const { first } = repoWithWorktree();
		const refs = "garden-tools#t3nf and client_portal.v2#b7c8";
		artifact(
			first,
			"plans",
			"linked.md",
			location === "frontmatter"
				? `---\ntopic: Linked\nissues:\n  related: "${refs}"\n---\n`
				: `---\ntopic: Linked\n---\nRelated: ${refs}\n`,
		);
		const report = buildProgressReport(first, [first], {
			issues: [
				issue({ qualified_id: "garden-tools#t3nf" }),
				issue({ qualified_id: "client_portal.v2#b7c8", short_id: "b7c8" }),
			],
		});
		expect(report.topics[0]?.issues.map((linked) => linked.qualifiedId)).toEqual([
			"client_portal.v2#b7c8",
			"garden-tools#t3nf",
		]);
	});

	it("does not link matching short IDs from another project", () => {
		const { first } = repoWithWorktree();
		artifact(first, "plans", "right.md", "---\ntopic: Right\nissue: garden-tools#t3nf\n---\n");
		artifact(first, "plans", "wrong.md", "---\ntopic: Wrong\nissue: rpiv-praxis#t3nf\n---\narchive#t3nf\n");
		const report = buildProgressReport(first, [first], {
			issues: [issue({ qualified_id: "garden-tools#t3nf" })],
		});
		expect(report.topics.find((topic) => topic.title === "Wrong")?.issues).toEqual([]);
		expect(report.topics.find((topic) => topic.title === "Right")?.issues).toMatchObject([
			{ qualifiedId: "garden-tools#t3nf" },
		]);
		expect(report.unlinkedIssues).toEqual([]);
	});

	it("does not synthesize qualified IDs for unqualified stale issues", () => {
		const { first } = repoWithWorktree();
		const report = buildProgressReport(
			first,
			[first],
			{ issues: [issue({ qualified_id: undefined, updated_at: "2020-01-01T00:00:00Z" })] },
			new Date("2026-10-18T00:00:00Z"),
		);
		expect(report.unlinkedIssues).toEqual([]);
	});

	it.each(["issues: &refs [*refs, rpiv-praxis#t3nf]", "issues: &refs {self: *refs, issue: rpiv-praxis#t3nf}"])(
		"handles valid self-referential YAML without losing other topics: %s",
		(metadata) => {
			const { first } = repoWithWorktree();
			artifact(first, "plans", "cyclic.md", `---\ntopic: Cyclic\n${metadata}\n---\n`);
			artifact(first, "designs", "other.md", "---\ntopic: Other\n---\n");
			const report = buildProgressReport(first, [first], { issues: [issue()] });
			expect(report.topics.map((topic) => topic.title)).toEqual(["Cyclic", "Other"]);
			expect(report.topics[0]?.issues).toMatchObject([{ qualifiedId: "rpiv-praxis#t3nf" }]);
			expect(report.warnings).toEqual([]);
		},
	);

	it("keeps distinct topics distinct and reports malformed metadata without failing the report", () => {
		const { first } = repoWithWorktree();
		artifact(first, "plans", "2026-10-18_10-00-00_same.md", "---\ntopic: Same\nstatus: in-progress\n---\n");
		artifact(first, "designs", "2026-10-18_11-00-00_other.md", "---\ntopic: [invalid\n---\n");
		const report = buildProgressReport(first, [first], { issues: [] });
		expect(report.topics).toHaveLength(2);
		expect(report.warnings.join("\n")).toContain("malformed frontmatter");
	});

	it("marks Kata unavailable explicitly and suggests stale open issues without mutating them", () => {
		const { first } = repoWithWorktree();
		const report = buildProgressReport(
			first,
			[first],
			{
				issues: [
					issue({
						short_id: "old1",
						qualified_id: "rpiv-praxis#old1",
						title: "Old unrelated ticket",
						updated_at: "2020-01-01T00:00:00Z",
					}),
				],
				unavailableReason: "kata daemon unavailable",
			},
			new Date("2026-10-18T00:00:00Z"),
		);
		expect(report.kata.available).toBe(false);
		expect(report.kata.unavailableReason).toBe("kata daemon unavailable");
		expect(report.unlinkedIssues).toEqual([
			expect.objectContaining({
				qualifiedId: "rpiv-praxis#old1",
				reason: "open issue has no linked authoring artifact and is older than 30 days",
			}),
		]);
		expect(formatProgressMarkdown(report)).toContain("Kata unavailable");
	});

	it("queries only the read-only Kata list command and reports an unavailable daemon without fallback", () => {
		const { first, root } = repoWithWorktree();
		const bin = join(root, "bin");
		mkdirSync(bin);
		const kata = join(bin, "kata");
		const log = join(root, "kata-argv.log");
		writeFileSync(
			kata,
			`#!/bin/sh\nprintf '%s\\n' "$*" "$PWD" >> "$RPIV_PROGRESS_KATA_LOG"\nif [ "$RPIV_PROGRESS_KATA_FAIL" = "1" ]; then\n  printf '%s\\n' 'daemon unavailable' >&2\n  exit 7\nfi\nprintf '%s\\n' '{"issues":[]}'\n`,
		);
		chmodSync(kata, 0o755);
		const previous = {
			path: process.env.PATH,
			log: process.env.RPIV_PROGRESS_KATA_LOG,
			fail: process.env.RPIV_PROGRESS_KATA_FAIL,
		};
		process.env.PATH = `${bin}${delimiter}${previous.path ?? ""}`;
		process.env.RPIV_PROGRESS_KATA_LOG = log;
		delete process.env.RPIV_PROGRESS_KATA_FAIL;
		try {
			expect(readKataIssues(first)).toEqual({ issues: [] });
			process.env.RPIV_PROGRESS_KATA_FAIL = "1";
			expect(readKataIssues(first).unavailableReason).toContain("daemon unavailable");
			expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
				"list --json",
				realpathSync(first),
				"list --json",
				realpathSync(first),
			]);
		} finally {
			for (const [key, value] of [
				["PATH", previous.path],
				["RPIV_PROGRESS_KATA_LOG", previous.log],
				["RPIV_PROGRESS_KATA_FAIL", previous.fail],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("emits deterministic JSON for an unchanged filesystem and issue snapshot", () => {
		const { first } = repoWithWorktree();
		artifact(first, "goals", "2026-10-18_10-00-00_one.md", "---\ntopic: One\nstatus: started\n---\n");
		const args: [string, string[], { issues: ProgressIssue[] }] = [first, [first], { issues: [issue()] }];
		expect(JSON.stringify(buildProgressReport(...args))).toBe(JSON.stringify(buildProgressReport(...args)));
	});
});

/** Run `fn` with a fake `kata` binary first on PATH; `script` is the shell body. */
function withFakeKata<T>(script: string, fn: () => T): T {
	const root = mkdtempSync(join(tmpdir(), "rpiv-progress-kata-"));
	roots.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const kata = join(bin, "kata");
	writeFileSync(kata, `#!/bin/sh\n${script}\n`);
	chmodSync(kata, 0o755);
	const previous = process.env.PATH;
	process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env.PATH;
		else process.env.PATH = previous;
	}
}

describe("progress — stale candidates and Kata boundaries", () => {
	it("orders stale unlinked issues oldest first, without mutating them", () => {
		const { first } = repoWithWorktree();
		const report = buildProgressReport(
			first,
			[first],
			{
				issues: [
					issue({
						short_id: "mid",
						qualified_id: "rpiv-praxis#mid",
						title: "Middle",
						updated_at: "2020-06-01T00:00:00Z",
					}),
					issue({
						short_id: "old",
						qualified_id: "rpiv-praxis#old",
						title: "Oldest",
						updated_at: "2019-01-01T00:00:00Z",
					}),
				],
			},
			new Date("2026-10-18T00:00:00Z"),
		);
		expect(report.unlinkedIssues.map((c) => c.qualifiedId)).toEqual(["rpiv-praxis#old", "rpiv-praxis#mid"]);
	});

	it("reports a Kata response that is not JSON as unavailable instead of throwing", () => {
		const { first } = repoWithWorktree();
		withFakeKata("printf '%s\\n' 'not json at all'", () => {
			expect(readKataIssues(first)).toEqual({ issues: [], unavailableReason: "Kata returned invalid JSON" });
		});
	});

	it("reportProgress reads Kata through the same read-only list command", () => {
		const { first } = repoWithWorktree();
		withFakeKata("printf '%s\\n' '{\"issues\":[]}'", () => {
			const report = reportProgress(first);
			expect(report.kata.available).toBe(true);
			expect(report.root).toBe(resolve(first));
		});
	});
});
