/**
 * verdict-collector — the disk-first collector behind every grade/confirm
 * stage's verdict channel. The grade skill writes its verdict JSON to
 * `<VERDICT_DIR>/<artifact-basename>__<dimension>__<slug>.json` (grade skill
 * step 6's naming contract), so the FILESYSTEM is the primary channel: a unit
 * collects the newest `<basename>__<dimension>__*.json` written since its
 * snapshot — prior rounds (listed at snapshot time) and sibling dimensions
 * (different name prefix) are excluded by construction, and a mangled or
 * typo'd transcript announcement can never hide a verdict that exists.
 *
 * Three arms, in order, all three missing ⇒ ONE composite fatal naming them:
 *   1. DISK — the listing above (requires the determined name: the graded
 *      artifact's basename, off `sourceChannel`, plus the unit's label as the
 *      dimension; without both, this arm is skipped — no loose disk glob,
 *      which would collect a sibling dimension's verdict).
 *   2. TEXT — `transcriptPathCollector`, pattern tightened to the determined
 *      name when known, else today's loose directory pattern. Inherits the
 *      text+tool-arguments widening (collectors/text-scan.ts), tool-args
 *      narrowed to write/edit calls (a read of the prior round's verdict is not
 *      a collection).
 *   3. WRITE ARGS — a `toolCallCollector` arm matching `write`/`edit` calls whose
 *      `input.path` sits under the verdict dir (tightened to the determined
 *      name when known); the last write wins.
 *
 * Determined-name tightness: with `(basename, dimension)` known, a text or
 * tool-args announcement of a DIFFERENT dimension's or a different artifact's
 * verdict is not collected. With `unitLabel` absent (a non-panel wiring), the
 * collector degrades to the loose pattern + widening — never fataling on
 * shapes the prior directory collector accepted.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
	type Artifact,
	type ArtifactCollector,
	type CollectContext,
	defineCollector,
	fs as fsHandle,
	type RunView,
	toolCallCollector,
	transcriptPathCollector,
} from "@juicesharp/rpiv-workflow/registration";
import { latestFsArtifact } from "./shared.ts";

/** The verdict dir listing at unit start — filename → mtimeMs. `undefined`
 *  when the dir was absent/unreadable (fail-soft: everything present then
 *  reads as new; the arm still cannot throw). */
export type VerdictSnapshot = Map<string, number> | undefined;

export interface VerdictCollectorOpts {
	/** cwd-relative verdict directory (`.rpiv/artifacts/verdicts`). */
	dir: string;
	/**
	 * The channel carrying the artifact under judgment — resolves the verdict
	 * filename's `<basename>__` segment (the graded artifact's basename without
	 * extension) for determined-name collection. Optional: without it (or with
	 * no fs artifact on the channel) the collector runs its loose degradation.
	 */
	sourceChannel?: string;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pi's file-writing tools (`write`, `edit`) by name — the single spelling
 *  shared by the text arm's `match` filter and the write-args arm below. The Pi tool-name literal
 *  stays in this convention layer (never in rpiv-workflow's host-agnostic
 *  collectors); the structural `{ name }` param is assignable to
 *  `(tc: ToolCall) => boolean` under contravariance, so no `ToolCall`
 *  import is needed. */
const isWriteTool = (tc: { name: string }): boolean => tc.name === "write" || tc.name === "edit";

/** The graded artifact's basename without extension, off the source channel
 *  (undefined when no channel / no fs artifact). */
const gradedBasename = (state: RunView, sourceChannel: string | undefined): string | undefined => {
	if (!sourceChannel) return undefined;
	const doc = latestFsArtifact(state, sourceChannel);
	return doc?.handle.kind === "fs" ? basename(doc.handle.path).replace(/\.[^.]+$/, "") : undefined;
};

/** Absolute paths under cwd collapse to cwd-relative (write tool inputs carry
 *  absolute paths); anything else passes through unchanged. */
const normalized = (cwd: string, path: string): string => {
	const prefix = `${cwd}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
};

/**
 * The unit's own verdict-name shape. With the graded artifact's stem AND the
 * dimension known: `<stem>__<dimension>__` as a filename PREFIX. With only the
 * dimension known (no source channel / no fs artifact): `__<dimension>__`
 * anywhere in the name — still per-member, so a panel member never collects a
 * sibling dimension's verdict. `undefined` when the dimension is unknown (a
 * non-panel wiring): the loose degradation.
 */
interface VerdictName {
	/** Human-readable glob for the fatal message. */
	scope: string;
	/** Regex source for the transcript arm, relative to the verdict dir. */
	source: string;
	matches: (fileName: string) => boolean;
}

const verdictNameOf = (stem: string | undefined, dimension: string | undefined): VerdictName | undefined => {
	if (dimension === undefined) return undefined;
	if (stem !== undefined) {
		const prefix = `${stem}__${dimension}__`;
		return { scope: `${prefix}*`, source: `${escapeRegex(prefix)}[\\w.-]+`, matches: (n) => n.startsWith(prefix) };
	}
	const infix = `__${dimension}__`;
	return {
		scope: `*${infix}*`,
		source: `[\\w.-]*${escapeRegex(infix)}[\\w.-]+`,
		matches: (n) => n.includes(infix),
	};
};

/** Arm 1 — the disk listing: this unit's `*.json` entries (per `name`) NEW since
 *  the snapshot (absent from the listing, or mtime moved), newest first (mtime,
 *  tie broken by name descending — the slug is a timestamp). `undefined` when the
 *  name is unknown, the dir is absent, or nothing is new. Never throws. */
const collectFromDisk = (
	ctx: CollectContext<VerdictSnapshot>,
	dir: string,
	name: VerdictName | undefined,
): string | undefined => {
	if (name === undefined) return undefined;
	try {
		const abs = join(ctx.cwd, dir);
		const candidates: Array<{ name: string; mtime: number }> = [];
		for (const entry of readdirSync(abs)) {
			if (!entry.endsWith(".json") || !name.matches(entry)) continue;
			const mtime = statSync(join(abs, entry)).mtimeMs;
			const known = ctx.snapshot?.get(entry);
			if (known !== undefined && mtime <= known) continue; // prior round — listed at snapshot
			candidates.push({ name: entry, mtime });
		}
		if (candidates.length === 0) return undefined;
		candidates.sort((a, b) => (a.mtime !== b.mtime ? b.mtime - a.mtime : a.name < b.name ? 1 : -1));
		return `${dir}/${candidates[0]!.name}`;
	} catch {
		return undefined; // no dir / unreadable — the arm misses
	}
};

/** Arm 1's discriminator applied to a tool-arg path: `false` when the file was
 *  listed at snapshot and its mtime has not moved (a prior round the unit
 *  merely named — a failed edit, a read-back — is not a collection). */
const writtenSinceSnapshot = (ctx: CollectContext<VerdictSnapshot>, raw: unknown): boolean => {
	if (typeof raw !== "string") return false;
	const p = normalized(ctx.cwd, raw);
	const known = ctx.snapshot?.get(basename(p));
	if (known === undefined) return true;
	try {
		return statSync(join(ctx.cwd, p)).mtimeMs > known;
	} catch {
		return true; // gone since snapshot — not a stale prior round
	}
};

/** Arm 2's pattern: tightened to the determined name when both segments are
 *  known, else today's loose directory pattern (the `directoryPathCollector`
 *  idiom over the verdict dir). */
const transcriptPattern = (dir: string, name: VerdictName | undefined): RegExp =>
	name !== undefined
		? new RegExp(String.raw`${escapeRegex(dir)}/${name.source}\.json`, "g")
		: new RegExp(String.raw`${escapeRegex(dir)}/[\w.-]+\.json`, "g");

/** Arm 3 — write tool-calls whose `input.path` sits under the verdict dir
 *  (tightened to the determined name when known); last write wins. */
const lastWriteUnderDir = async (
	ctx: CollectContext<VerdictSnapshot>,
	dir: string,
	name: VerdictName | undefined,
): Promise<Artifact | undefined> => {
	const writes = toolCallCollector({
		match: (tc) => {
			if (!isWriteTool(tc) || !writtenSinceSnapshot(ctx, tc.input.path)) return false;
			const raw = tc.input.path;
			if (typeof raw !== "string") return false;
			const p = normalized(ctx.cwd, raw);
			if (!p.includes(`${dir}/`)) return false;
			return name === undefined || name.matches(basename(p));
		},
		toArtifact: (tc) => {
			const raw = tc.input.path;
			return typeof raw === "string" ? { handle: fsHandle(normalized(ctx.cwd, raw)), role: "primary" } : undefined;
		},
	});
	const scanned = await writes.collect(ctx);
	return scanned.kind === "ok" && scanned.artifacts.length > 0
		? scanned.artifacts[scanned.artifacts.length - 1]
		: undefined;
};

/** Build the disk-first verdict collector. */
export function verdictCollector(opts: VerdictCollectorOpts): ArtifactCollector<VerdictSnapshot> {
	const { dir, sourceChannel } = opts;
	return defineCollector<VerdictSnapshot>({
		snapshot: (ctx) => {
			try {
				const listing = new Map<string, number>();
				for (const name of readdirSync(join(ctx.cwd, dir))) {
					if (!name.endsWith(".json")) continue;
					listing.set(name, statSync(join(ctx.cwd, dir, name)).mtimeMs);
				}
				return listing;
			} catch {
				return undefined; // absent/unreadable at snapshot time — fail-soft
			}
		},
		collect: async (ctx) => {
			const stem = gradedBasename(ctx.state, sourceChannel);
			const dimension = ctx.unitLabel;
			const name = verdictNameOf(stem, dimension);
			// Arm 1: disk.
			const rel = collectFromDisk(ctx, dir, name);
			if (rel !== undefined) return { kind: "ok", artifacts: [{ handle: fsHandle(rel), role: "primary" }] };
			// Arm 2: transcript text (pattern tightened when determined; tool-args
			// narrowed to write/edit calls on paths written since the snapshot).
			// A text mention of a verdict listed at snapshot (a prior round) is not a
			// collection either — the freshness proof applies to both surfaces.
			const scanned = await transcriptPathCollector({
				pattern: transcriptPattern(dir, name),
				match: (tc) => isWriteTool(tc) && writtenSinceSnapshot(ctx, tc.input.path),
				isFresh: (hit) => writtenSinceSnapshot(ctx, hit),
			}).collect(ctx);
			if (scanned.kind === "ok" && scanned.artifacts.length > 0) return scanned;
			// Arm 3: write tool-call arguments.
			const written = await lastWriteUnderDir(ctx, dir, name);
			if (written !== undefined) return { kind: "ok", artifacts: [written] };
			// All three missed — ONE composite fatal naming every attempted surface.
			const scope = name !== undefined ? `${dir}/${name.scope}.json` : `${dir}/*.json`;
			return {
				kind: "fatal",
				message: `${ctx.skill}: no verdict collected — ${scope} new since snapshot, assistant text, and write tool-call arguments all missed`,
			};
		},
	});
}
