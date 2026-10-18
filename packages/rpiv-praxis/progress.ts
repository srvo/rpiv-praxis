import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

const ARTIFACT_ROOT = ".rpiv/artifacts";
const MAX_ARTIFACTS = 10_000;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const STALE_DAYS = 30;
const STAGES = [
	"goal",
	"discovery",
	"research",
	"exploration",
	"design",
	"plan",
	"slice",
	"subplan",
	"elaboration",
	"implementation",
	"validation",
	"review",
] as const;
type Stage = (typeof STAGES)[number];
const AUTHORING_STAGES = ["discover", "research", "design", "plan", "implement", "validate"] as const;
type AuthoringStage = (typeof AUTHORING_STAGES)[number];

export interface ProgressIssue {
	qualified_id?: string;
	short_id?: string;
	title: string;
	status: string;
	owner?: string;
	updated_at?: string;
}

export interface ProgressIssueSnapshot {
	issues: ProgressIssue[];
	unavailableReason?: string;
}

export interface ProgressArtifact {
	stage: Stage | "other";
	path: string;
	worktree: string;
	status?: string;
	updatedAt: string;
}

export interface ProgressTopic {
	key: string;
	title: string;
	latestStage: Stage | "other";
	status: string;
	pipeline: {
		current: AuthoringStage | "not started";
		furthestStep: number;
		totalSteps: 6;
		observedStages: AuthoringStage[];
	};
	artifacts: ProgressArtifact[];
	worktrees: string[];
	issues: { qualifiedId: string; title: string; status: string; owner?: string }[];
	targetFiles: string[];
}

export interface ProgressReport {
	root: string;
	worktrees: string[];
	topics: ProgressTopic[];
	kata: { available: boolean; issueCount: number; unavailableReason?: string };
	overlapCandidates: { topics: [string, string]; evidence: string[] }[];
	unlinkedIssues: { qualifiedId: string; title: string; owner?: string; updatedAt: string; reason: string }[];
	warnings: string[];
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/^\d{4}-\d{2}-\d{2}[T_-]?\d{2}[-:]\d{2}[-:]\d{2}[-_]?/, "")
		.replace(/__(?:phase|cluster|slice)[-_].*$/i, "")
		.replace(/\.r\d+$/i, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function titleFrom(value: string): string {
	return slug(value).replace(/\b\w/g, (c) => c.toUpperCase()) || "Untitled topic";
}

function stageOf(bucket: string): Stage | "other" {
	const name = bucket.toLowerCase().replace(/s$/, "");
	if (name === "goal") return "goal";
	if (["discover", "discovery"].includes(name)) return "discovery";
	if (name === "research") return "research";
	if (["exploration", "explore"].includes(name)) return "exploration";
	if (name === "design") return "design";
	if (name === "plan") return "plan";
	if (name === "slice") return "slice";
	if (name === "subplan") return "subplan";
	if (name === "elaboration") return "elaboration";
	if (["implementation", "implement"].includes(name)) return "implementation";
	if (name === "validation") return "validation";
	if (name === "review") return "review";
	return "other";
}

function authoringStageOf(stage: Stage | "other"): AuthoringStage | undefined {
	if (stage === "goal" || stage === "discovery") return "discover";
	if (stage === "research" || stage === "exploration") return "research";
	if (stage === "design") return "design";
	if (["plan", "slice", "subplan", "elaboration"].includes(stage)) return "plan";
	if (stage === "implementation") return "implement";
	if (stage === "validation" || stage === "review") return "validate";
	return undefined;
}

function markdownFiles(root: string): string[] {
	const artifactRoot = resolve(root, ARTIFACT_ROOT);
	if (!existsSync(artifactRoot)) return [];
	const files: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 5 || files.length >= MAX_ARTIFACTS) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
			const path = resolve(dir, entry.name);
			if (entry.isDirectory()) walk(path, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
			if (files.length >= MAX_ARTIFACTS) return;
		}
	};
	walk(artifactRoot, 0);
	return files;
}

function parseFrontmatter(content: string): { data?: Record<string, unknown>; body: string; malformed: boolean } {
	const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
	if (!match) return { body: content, malformed: false };
	try {
		const value: unknown = parseYaml(match[1] ?? "");
		return {
			data: value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
			body: content.slice(match[0].length),
			malformed: false,
		};
	} catch {
		return { body: content.slice(match[0].length), malformed: true };
	}
}

function nestedStrings(value: unknown, seen = new WeakSet<object>()): string[] {
	if (typeof value === "string") return [value];
	if (!value || typeof value !== "object" || seen.has(value)) return [];
	seen.add(value);
	return Object.values(value).flatMap((child) => nestedStrings(child, seen));
}

function issueReferences(data: Record<string, unknown> | undefined, body: string): string[] {
	const refs = new Set<string>();
	const add = (value: string) => {
		for (const match of value.matchAll(/\b([a-z0-9][a-z0-9._-]*)#([a-z0-9]{4,})\b/gi)) {
			refs.add(`${match[1]!.toLowerCase()}#${match[2]!.toLowerCase()}`);
		}
	};
	for (const key of ["kata", "issue", "issues", "related", "parent"]) {
		for (const value of nestedStrings(data?.[key])) add(value);
	}
	add(body);
	return [...refs].sort();
}

function targetFiles(body: string): string[] {
	const files = new Set<string>();
	const pathPattern = /(?:^|[\s`])((?:packages|scripts|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?=[\s`),:]|$)/gm;
	for (const match of body.matchAll(pathPattern)) files.add(match[1]!);
	return [...files].sort();
}

function artifactDate(file: string): string {
	return basename(file).match(/^(\d{4}-\d{2}-\d{2}[T_-]\d{2}[-:]\d{2}[-:]\d{2})/)?.[1] ?? "";
}

function readArtifact(file: string, worktree: string, warnings: string[]) {
	let content = "";
	try {
		content = readFileSync(file, "utf8").slice(0, MAX_ARTIFACT_BYTES);
	} catch {
		warnings.push(`unreadable artifact: ${relative(worktree, file)}`);
	}
	const parsed = parseFrontmatter(content);
	const path = relative(resolve(worktree), file).split(sep).join("/");
	if (parsed.malformed) warnings.push(`malformed frontmatter: ${path}`);
	const bucket = path.split("/")[2] ?? "other";
	const rawTopic = typeof parsed.data?.topic === "string" ? parsed.data.topic : undefined;
	const filenameTopic = basename(file, ".md");
	const status = [parsed.data?.status, parsed.data?.verdict].find((value) => typeof value === "string");
	return {
		key: slug(rawTopic || filenameTopic),
		title: rawTopic?.trim() || titleFrom(filenameTopic),
		artifact: {
			stage: stageOf(bucket),
			path,
			worktree: resolve(worktree),
			...(typeof status === "string" ? { status } : {}),
			updatedAt: artifactDate(file),
		} satisfies ProgressArtifact,
		issueRefs: issueReferences(parsed.data, parsed.body),
		targetFiles: targetFiles(parsed.body),
	};
}

function issueIndex(issues: ProgressIssue[]): Map<string, ProgressIssue> {
	const index = new Map<string, ProgressIssue>();
	for (const issue of issues) {
		if (issue.qualified_id) index.set(issue.qualified_id.toLowerCase(), issue);
	}
	return index;
}

export function discoverWorktrees(cwd: string): string[] {
	const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 5_000,
	});
	const paths = new Set<string>();
	if (!result.error && result.status === 0) {
		for (const match of result.stdout.matchAll(/^worktree (.+)$/gm)) {
			try {
				paths.add(realpathSync(match[1]!));
			} catch {
				// Pruned worktrees are unavailable and have no reachable artifacts.
			}
		}
	}
	try {
		paths.add(realpathSync(cwd));
	} catch {
		paths.add(resolve(cwd));
	}
	return [...paths].sort();
}

export function readKataIssues(cwd: string): ProgressIssueSnapshot {
	const result = spawnSync("kata", ["list", "--json"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 8_000,
	});
	if (result.error || result.status !== 0) {
		const reason = result.error?.message ?? result.stderr.trim() ?? `kata exited with ${result.status}`;
		return { issues: [], unavailableReason: reason || "Kata CLI failed" };
	}
	try {
		const parsed = JSON.parse(result.stdout) as { issues?: unknown };
		if (!Array.isArray(parsed.issues)) {
			return { issues: [], unavailableReason: "Kata returned an invalid issue list" };
		}
		const issues = parsed.issues.filter(
			(row): row is ProgressIssue =>
				!!row &&
				typeof row === "object" &&
				typeof (row as ProgressIssue).title === "string" &&
				typeof (row as ProgressIssue).status === "string",
		);
		return { issues };
	} catch {
		return { issues: [], unavailableReason: "Kata returned invalid JSON" };
	}
}

export function buildProgressReport(
	cwd: string,
	worktrees: string[],
	snapshot: ProgressIssueSnapshot,
	now = new Date(),
): ProgressReport {
	const warnings: string[] = [];
	const byKey = new Map<
		string,
		{ title: string; artifacts: ProgressArtifact[]; refs: Set<string>; files: Set<string> }
	>();
	let artifactCount = 0;
	for (const worktree of [...new Set(worktrees)].sort()) {
		for (const file of markdownFiles(worktree)) {
			artifactCount++;
			const parsed = readArtifact(file, worktree, warnings);
			const topic = byKey.get(parsed.key) ?? {
				title: parsed.title,
				artifacts: [],
				refs: new Set<string>(),
				files: new Set<string>(),
			};
			topic.artifacts.push(parsed.artifact);
			for (const ref of parsed.issueRefs) topic.refs.add(ref);
			for (const fileRef of parsed.targetFiles) topic.files.add(fileRef);
			byKey.set(parsed.key, topic);
		}
	}
	if (artifactCount >= MAX_ARTIFACTS) warnings.push(`artifact scan reached the ${MAX_ARTIFACTS} file cap`);
	const issuesById = issueIndex(snapshot.issues);
	const linkedIssueIds = new Set<string>();
	const topics: ProgressTopic[] = [...byKey.entries()]
		.map(([key, value]) => {
			value.artifacts.sort(
				(a, b) =>
					STAGES.indexOf(a.stage as Stage) - STAGES.indexOf(b.stage as Stage) ||
					a.updatedAt.localeCompare(b.updatedAt) ||
					a.path.localeCompare(b.path) ||
					a.worktree.localeCompare(b.worktree),
			);
			const current =
				[...value.artifacts].reverse().find((artifact) => artifact.stage !== "other") ?? value.artifacts.at(-1)!;
			const observedStages = AUTHORING_STAGES.filter((stage) =>
				value.artifacts.some((artifact) => authoringStageOf(artifact.stage) === stage),
			);
			const currentAuthoringStage = observedStages.at(-1);
			const pipeline: ProgressTopic["pipeline"] = {
				current: currentAuthoringStage ?? "not started",
				furthestStep: currentAuthoringStage ? AUTHORING_STAGES.indexOf(currentAuthoringStage) + 1 : 0,
				totalSteps: AUTHORING_STAGES.length,
				observedStages,
			};
			const issues = [...value.refs]
				.map((ref) => {
					const issue = issuesById.get(ref.toLowerCase());
					if (!issue?.qualified_id) return undefined;
					const qualifiedId = issue.qualified_id;
					linkedIssueIds.add(qualifiedId.toLowerCase());
					return {
						qualifiedId,
						title: issue.title,
						status: issue.status,
						...(issue.owner ? { owner: issue.owner } : {}),
					};
				})
				.filter((issue): issue is NonNullable<typeof issue> => issue !== undefined)
				.sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId));
			return {
				key,
				title: value.title,
				latestStage: current.stage,
				status: current.status ?? "status not recorded",
				pipeline,
				artifacts: value.artifacts,
				worktrees: [...new Set(value.artifacts.map((artifact) => artifact.worktree))].sort(),
				issues,
				targetFiles: [...value.files].sort(),
			};
		})
		.sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
	const overlapCandidates: ProgressReport["overlapCandidates"] = [];
	for (let i = 0; i < topics.length; i++) {
		for (let j = i + 1; j < topics.length; j++) {
			const left = topics[i]!;
			const right = topics[j]!;
			const sharedFiles = left.targetFiles.filter((file) => right.targetFiles.includes(file));
			const leftTokens = new Set(
				slug(left.title)
					.split(" ")
					.filter((token) => token.length > 3),
			);
			const rightTokens = new Set(
				slug(right.title)
					.split(" ")
					.filter((token) => token.length > 3),
			);
			const sharedTerms = [...leftTokens].filter((token) => rightTokens.has(token)).sort();
			if (sharedFiles.length || sharedTerms.length >= 2) {
				overlapCandidates.push({
					topics: [left.title, right.title],
					evidence: [
						...sharedFiles.map((file) => `shared target file: ${file}`),
						...(sharedTerms.length >= 2 ? [`shared topic terms: ${sharedTerms.join(", ")}`] : []),
					],
				});
			}
		}
	}
	const cutoff = now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000;
	const unlinkedIssues = snapshot.issues
		.filter((issue) => issue.status === "open")
		.flatMap((issue) => {
			if (!issue.qualified_id || linkedIssueIds.has(issue.qualified_id.toLowerCase())) return [];
			const updated = Date.parse(issue.updated_at ?? "");
			if (!Number.isFinite(updated) || updated > cutoff) return [];
			return [
				{
					qualifiedId: issue.qualified_id,
					title: issue.title,
					...(issue.owner ? { owner: issue.owner } : {}),
					updatedAt: issue.updated_at!,
					reason: `open issue has no linked authoring artifact and is older than ${STALE_DAYS} days`,
				},
			];
		})
		.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.qualifiedId.localeCompare(b.qualifiedId));
	if (snapshot.unavailableReason) warnings.push(`Kata unavailable: ${snapshot.unavailableReason}`);
	return {
		root: resolve(cwd),
		worktrees: [...new Set(worktrees)].sort(),
		topics,
		kata: {
			available: !snapshot.unavailableReason,
			issueCount: snapshot.issues.length,
			...(snapshot.unavailableReason ? { unavailableReason: snapshot.unavailableReason } : {}),
		},
		overlapCandidates,
		unlinkedIssues,
		warnings: [...new Set(warnings)].sort(),
	};
}

export function formatProgressMarkdown(report: ProgressReport): string {
	const lines = [
		"## RPIV authoring progress",
		"",
		`Repository: ${report.root}`,
		`Worktrees scanned: ${report.worktrees.length}`,
		`Topics found: ${report.topics.length}`,
		"Stage evidence: ● artifact observed; ○ no matching artifact found (not a completion verdict).",
	];
	if (report.kata.available) lines.push(`Kata issues read: ${report.kata.issueCount}`);
	else lines.push(`Kata unavailable: ${report.kata.unavailableReason ?? "unknown reason"}`);
	lines.push("", "### Topics", "");
	if (!report.topics.length) lines.push("No RPIV authoring artifacts found in reachable worktrees.");
	for (const topic of report.topics) {
		lines.push(
			`- **${topic.title}** — ${topic.status}; furthest artifact stage: ${topic.pipeline.current} (${topic.pipeline.furthestStep}/${topic.pipeline.totalSteps})`,
			`  - Pipeline evidence: ${AUTHORING_STAGES.map((stage) => `${topic.pipeline.observedStages.includes(stage) ? "●" : "○"} ${stage}`).join(" → ")}`,
		);
		for (const artifact of topic.artifacts) {
			lines.push(`  - ${artifact.stage}: \`${artifact.worktree}/${artifact.path}\``);
		}
		if (topic.issues.length) {
			for (const issue of topic.issues) {
				lines.push(`  - Kata: ${issue.qualifiedId} — ${issue.status}${issue.owner ? ` (${issue.owner})` : ""}`);
			}
		} else lines.push("  - Kata: no explicit issue link found");
	}
	lines.push("", "### Handoff signals", "");
	if (!report.overlapCandidates.length && !report.unlinkedIssues.length) {
		lines.push("No overlap or stale-task candidates detected by the available evidence.");
	}
	for (const candidate of report.overlapCandidates) {
		lines.push(
			`- **Possible overlap:** ${candidate.topics.join(" ↔ ")} — ${candidate.evidence.join("; ")}. Review before merging or pruning.`,
		);
	}
	for (const issue of report.unlinkedIssues) {
		lines.push(
			`- **Possible stale task:** ${issue.qualifiedId} — ${issue.title} (${issue.updatedAt}). ${issue.reason}; review before changing Kata.`,
		);
	}
	if (report.warnings.length) lines.push("", "### Warnings", "", ...report.warnings.map((warning) => `- ${warning}`));
	lines.push("", "Advisory only: verify evidence and ask an accountable owner before changing the task list.");
	return lines.join("\n");
}

export function reportProgress(cwd: string): ProgressReport {
	return buildProgressReport(cwd, discoverWorktrees(cwd), readKataIssues(cwd));
}
