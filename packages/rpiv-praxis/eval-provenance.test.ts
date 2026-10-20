import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkContinuable, codeFingerprint, writeProvenance } from "./eval-provenance.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkout() {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-provenance-"));
	roots.push(dir);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: dir,
			stdio: "ignore",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@e.invalid",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@e.invalid",
			},
		});
	git("init", "-q");
	writeFileSync(join(dir, "skill.md"), "v1\n");
	git("add", "skill.md");
	git("commit", "-qm", "initial");
	return { dir, git };
}

describe("codeFingerprint", () => {
	it("is stable for an unchanged checkout", () => {
		const { dir } = checkout();
		expect(codeFingerprint(dir)).toBe(codeFingerprint(dir));
	});

	it("changes when HEAD moves", () => {
		const { dir, git } = checkout();
		const before = codeFingerprint(dir);
		writeFileSync(join(dir, "skill.md"), "v2\n");
		git("commit", "-qam", "next");
		expect(codeFingerprint(dir)).not.toBe(before);
	});

	it("changes on an uncommitted edit to a tracked file, and returns to the first value when reverted", () => {
		const { dir } = checkout();
		const clean = codeFingerprint(dir);
		writeFileSync(join(dir, "skill.md"), "edited\n");
		expect(codeFingerprint(dir)).not.toBe(clean);
		writeFileSync(join(dir, "skill.md"), "v1\n");
		expect(codeFingerprint(dir)).toBe(clean);
	});

	it("changes when an untracked file is added or its contents change", () => {
		const { dir } = checkout();
		const clean = codeFingerprint(dir);
		writeFileSync(join(dir, "new-skill.md"), "one\n");
		const added = codeFingerprint(dir);
		expect(added).not.toBe(clean);
		writeFileSync(join(dir, "new-skill.md"), "two\n");
		expect(codeFingerprint(dir)).not.toBe(added);
	});

	it("reports a checkout git cannot describe as unversioned", () => {
		const dir = mkdtempSync(join(tmpdir(), "rpiv-provenance-plain-"));
		roots.push(dir);
		mkdirSync(join(dir, "pkg"));
		expect(codeFingerprint(dir)).toBe("unversioned");
	});
});

describe("checkContinuable", () => {
	function eval_(recorded?: string) {
		const dir = mkdtempSync(join(tmpdir(), "rpiv-provenance-out-"));
		roots.push(dir);
		if (recorded !== undefined) writeProvenance(dir, recorded);
		return dir;
	}

	it("continues silently on the recorded code", () => {
		expect(checkContinuable(eval_("abc"), "abc", false)).toEqual({ ok: true });
	});

	it("refuses drift, naming both fingerprints, and allows it only with the override", () => {
		const dir = eval_("abcdef0123456789");
		const refused = checkContinuable(dir, "fedcba9876543210", false);
		expect(refused).toMatchObject({ ok: false });
		expect(refused.ok === false && refused.message).toMatch(/recorded abcdef012345, now fedcba987654/);
		expect(checkContinuable(dir, "fedcba9876543210", true)).toEqual({
			ok: true,
			drift: { recorded: "abcdef0123456789" },
		});
	});

	it("refuses an eval with no provenance, or an unreadable provenance file", () => {
		expect(checkContinuable(eval_(), "abc", false)).toMatchObject({ ok: false });
		const dir = eval_();
		writeFileSync(join(dir, "provenance.json"), "{ not json");
		expect(checkContinuable(dir, "abc", false)).toMatchObject({ ok: false });
	});

	it("refuses an unversioned checkout even against an unversioned record", () => {
		expect(checkContinuable(eval_("unversioned"), "unversioned", false)).toMatchObject({ ok: false });
		expect(checkContinuable(eval_("unversioned"), "unversioned", true)).toMatchObject({ ok: true, drift: {} });
	});
});
