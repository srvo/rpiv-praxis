/**
 * Which code an eval measured, and whether a later `--continue` still measures it.
 *
 * `--continue` pins the spec, but the code under test (rpiv-wf, its workflows and
 * skills) changes day to day. Trials recorded on one checkout and trials run on
 * another would be compared as if they were the same measurement. So a fresh eval
 * records a fingerprint of the checkout, and `--continue` refuses when it differs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "provenance.json";
/** Fingerprint of a checkout git cannot describe. It never matches, so it cannot prove "unchanged". */
const UNVERSIONED = "unversioned";

function git(cwd: string, args: string[]): string | undefined {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		maxBuffer: 512 * 1024 * 1024,
	});
	return result.error || result.status !== 0 ? undefined : result.stdout;
}

/** HEAD plus every uncommitted change, including the contents of untracked files. */
export function codeFingerprint(dir: string): string {
	const head = git(dir, ["rev-parse", "HEAD"]);
	if (!head) return UNVERSIONED;
	const hash = createHash("sha256").update(head.trim()).update("\0");
	hash.update(git(dir, ["diff", "HEAD", "--binary"]) ?? "").update("\0");
	const untracked = (git(dir, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "")
		.split("\0")
		.filter(Boolean)
		.sort();
	for (const file of untracked) {
		hash.update(file).update("\0");
		try {
			hash.update(readFileSync(join(dir, file)));
		} catch {
			hash.update("unreadable");
		}
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function writeProvenance(outDir: string, fingerprint: string): void {
	writeFileSync(
		join(outDir, FILE),
		`${JSON.stringify({ codeFingerprint: fingerprint, recordedAt: new Date().toISOString() }, null, "\t")}\n`,
	);
}

/** The fingerprint written with a fresh eval, if any: the code recorded trials ran on. */
export function recordedProvenance(outDir: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(outDir, FILE), "utf8")) as { codeFingerprint?: unknown };
		return typeof parsed.codeFingerprint === "string" ? parsed.codeFingerprint : undefined;
	} catch {
		return undefined;
	}
}

export type ContinueGate = { ok: true; drift?: { recorded: string } } | { ok: false; message: string };

const short = (fingerprint: string) => (fingerprint === UNVERSIONED ? fingerprint : fingerprint.slice(0, 12));

/** May `--continue` add trials to `outDir` on the code checked out now? */
export function checkContinuable(outDir: string, current: string, allowDrift: boolean): ContinueGate {
	const recorded = recordedProvenance(outDir);
	if (current === UNVERSIONED) {
		if (allowDrift) return { ok: true, drift: { recorded: recorded ?? "unknown" } };
		return {
			ok: false,
			message:
				"this checkout is not under git, so the code cannot be verified as unchanged. Pass --allow-drift to continue anyway.",
		};
	}
	if (recorded === undefined) {
		if (allowDrift) return { ok: true, drift: { recorded: "unknown" } };
		return {
			ok: false,
			message:
				"this eval records no code provenance (it predates provenance tracking). Pass --allow-drift to continue on the current code anyway, or start a new eval.",
		};
	}
	if (recorded === current) return { ok: true };
	if (allowDrift) return { ok: true, drift: { recorded } };
	return {
		ok: false,
		message: `the code changed since this eval started (recorded ${short(recorded)}, now ${short(current)}); the results would mix code versions. Pass --allow-drift to continue anyway, or start a new eval.`,
	};
}
