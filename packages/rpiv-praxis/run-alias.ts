import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

const RUN_DIR = join(".rpiv", "workflows", "runs");
const REGISTRY_DIR = "rpiv-workflow-aliases";
const VALID_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const VALID_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface RunAlias {
	name: string;
	runId: string;
	cwd: string;
	workflow: string;
	updatedAt: string;
}

function gitCommonDir(cwd: string): string | undefined {
	try {
		const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.error || result.status !== 0) return undefined;
		const path = result.stdout.trim();
		return path ? realpathSync(resolve(cwd, path)) : undefined;
	} catch {
		return undefined;
	}
}

function registryPath(cwd: string): string | undefined {
	const commonDir = gitCommonDir(cwd);
	return commonDir ? join(commonDir, REGISTRY_DIR) : undefined;
}

function statePath(cwd: string, runId: string): string {
	return join(cwd, RUN_DIR, `${runId}.jsonl`);
}

function readAlias(path: string): RunAlias | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const row = parsed as Partial<RunAlias>;
		if (
			typeof row.name !== "string" ||
			!VALID_NAME.test(row.name) ||
			typeof row.runId !== "string" ||
			!VALID_RUN_ID.test(row.runId) ||
			typeof row.cwd !== "string" ||
			!isAbsolute(row.cwd) ||
			typeof row.workflow !== "string" ||
			typeof row.updatedAt !== "string"
		)
			return undefined;
		return {
			name: row.name,
			runId: row.runId,
			cwd: realpathSync(resolve(row.cwd)),
			workflow: row.workflow,
			updatedAt: row.updatedAt,
		};
	} catch {
		return undefined;
	}
}

/** Create a readable run alias with a short random suffix to avoid parallel-start collisions. */
export function generateRunAlias(
	workflow: string,
	topic: string,
	now = new Date(),
	suffix = randomBytes(2).toString("hex"),
): string {
	const slug = (value: string, max: number) =>
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, max)
			.replace(/-+$/g, "");
	const workflowSlug = slug(workflow, 16) || "run";
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/T/, "-").slice(0, 15);
	const prefix = `rpiv-${workflowSlug}`;
	const ending = `-${stamp}-${suffix}`;
	const topicSlug = slug(topic, Math.max(0, 64 - prefix.length - ending.length - 1));
	return topicSlug ? `${prefix}-${topicSlug}${ending}` : `${prefix}${ending}`;
}

/** Reserve admission separately from the durable alias; an interrupted claim needs explicit recovery. */
export function reserveRunAlias(cwd: string, name: string): (() => void) | undefined {
	if (!VALID_NAME.test(name)) throw new Error(`invalid RPIV run alias "${name}"`);
	const dir = registryPath(cwd);
	if (!dir) return undefined; // Non-Git runs remain local.
	const claim = join(dir, `${name}.claim`);
	const record = `${JSON.stringify({ token: randomUUID(), pid: process.pid, cwd: resolve(cwd) })}\n`;
	const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
	let owned = false;
	const release = () => {
		if (!owned) return;
		owned = false;
		try {
			if (readFileSync(claim, "utf8") === record) unlinkSync(claim);
		} catch {
			// Missing/replaced/unreadable claims are never ours to remove.
		}
	};
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(temp, record, { flag: "wx" });
		linkSync(temp, claim); // Publish the complete record exclusively across processes/worktrees.
		owned = true;
		// A previous owner may have published and released after our caller's preflight.
		if (hasRunAliasEntry(cwd, name)) {
			throw new Error(`final alias ${join(dir, `${name}.json`)} already exists (possibly stale or unreadable)`);
		}
		return release;
	} catch (error) {
		release();
		throw new Error(
			`Cannot reserve RPIV run alias "${name}" at ${claim}: ${String(error)}. ` +
				"Choose a new --name or explicitly repair the alias/claim only after checking its originating worktree/run and confirming no starter is active.",
		);
	} finally {
		try {
			unlinkSync(temp);
		} catch {
			// The temporary publication file may not have been created.
		}
	}
}

/** Publish a completed/parked run alias atomically in the Git-common directory. */
export function registerRunAlias(cwd: string, name: string, runId: string, workflow: string): boolean {
	if (!VALID_NAME.test(name) || !VALID_RUN_ID.test(runId) || !existsSync(statePath(resolve(cwd), runId))) return false;
	const dir = registryPath(cwd);
	if (!dir) return false;
	const row: RunAlias = { name, runId, cwd: resolve(cwd), workflow, updatedAt: new Date().toISOString() };
	const target = join(dir, `${name}.json`);
	const temp = join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(temp, `${JSON.stringify(row)}\n`, { flag: "wx" });
		try {
			linkSync(temp, target);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = readAlias(target);
			return existing?.cwd === row.cwd && existing.runId === row.runId;
		}
	} catch {
		return false;
	} finally {
		try {
			unlinkSync(temp);
		} catch {
			// The temp file may already be absent after a failed write.
		}
	}
}

/** Treat every existing entry (including dangling symlinks) and unreadable path as occupied. */
export function hasRunAliasEntry(cwd: string, name: string): boolean {
	if (!VALID_NAME.test(name)) return false;
	const dir = registryPath(cwd);
	if (!dir) return false;
	try {
		lstatSync(join(dir, `${name}.json`));
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

export function resolveRunAlias(cwd: string, name: string): RunAlias | undefined {
	if (!VALID_NAME.test(name)) return undefined;
	const dir = registryPath(cwd);
	if (!dir) return undefined;
	const row = readAlias(join(dir, `${name}.json`));
	if (!row || gitCommonDir(row.cwd) !== gitCommonDir(cwd) || !existsSync(statePath(row.cwd, row.runId)))
		return undefined;
	return row;
}

/** List valid run aliases visible to any worktree of this repository. */
export function listRunAliases(cwd: string): RunAlias[] {
	const dir = registryPath(cwd);
	if (!dir || !existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((file) => file.endsWith(".json"))
			.map((file) => resolveRunAlias(cwd, basename(file, ".json")))
			.filter((row): row is RunAlias => row !== undefined)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} catch {
		return [];
	}
}
