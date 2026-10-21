/**
 * Forgejo issues for parked questions — the replacement for kata tickets.
 *
 * kata is being retired in favour of Forgejo (CIO, 2026-10-21): a park files
 * one Forgejo issue, answering closes it. Same `Kata` shape as kata.ts, so the
 * CLI does not care which one it holds.
 *
 * Auth: `FORGEJO_ACCESS_TOKEN` (a PAT, from BWS: run under `bws run --`).
 * The token is fed to curl on stdin as a `-K -` config, never in argv, and is
 * never put in a warning. No token means NO ticket, reported once per run and
 * never silently: the question still lands in `rpiv-wf inbox`.
 *
 * Idempotency: Forgejo has no idempotency key, so each issue body carries a
 * marker comment `<!-- rpiv-park:<run>:<n> -->` and a retried `file` searches
 * for it first and reuses that issue (the same guarantee kata gives via its
 * idempotency key, kata ryvn).
 *
 * Every failure is reported and swallowed: a missing token, a down Forgejo or
 * an unknown label must never stop a question from parking or an answer from
 * resuming.
 */

import { execFileSync } from "node:child_process";
import { DEFAULT_KATA_LABELS, type Exec, type Kata, type KataOptions, onPath, parkKey, ticketBody } from "./kata.ts";
import type { Park } from "./park-store.ts";

/** Internal tailnet name: reaches Forgejo without Cloudflare Access. */
export const DEFAULT_FORGEJO_URL = "http://forgejo:3000";
export const DEFAULT_FORGEJO_OWNER = "EthicalCapital";
export const DEFAULT_FORGEJO_REPO = "monocloud";
export const DEFAULT_FORGEJO_USER_AGENT = "rpiv-wf";

export interface ForgejoOptions extends Pick<KataOptions, "labels"> {
	/** `owner/repo` to file in (default EthicalCapital/monocloud). */
	repo?: string;
}

interface ForgejoConfig {
	base: string;
	token: string;
	owner: string;
	repo: string;
	userAgent: string;
}

const realExec: Exec = (cmd, args, input) =>
	execFileSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 45_000 });

/** A curl config line value, escaped for `curl -K`: backslash and double quote. */
function q(v: string): string {
	return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** The marker that ties an issue to one park, for retry-safe filing. */
export function parkMarker(park: Park): string {
	return `<!-- ${parkKey(park)} -->`;
}

/** `forgejo:owner/repo#N` — the ref stored on the park. */
export function forgejoRef(owner: string, repo: string, n: number): string {
	return `forgejo:${owner}/${repo}#${n}`;
}

export function parseForgejoRef(ref: string): { owner: string; repo: string; n: number } | undefined {
	const m = /^forgejo:([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(ref);
	return m ? { owner: m[1]!, repo: m[2]!, n: Number(m[3]) } : undefined;
}

export function forgejoConfig(env: NodeJS.ProcessEnv, opts: ForgejoOptions = {}): ForgejoConfig | undefined {
	const token = env.FORGEJO_ACCESS_TOKEN?.trim();
	if (!token) return undefined;
	const [ownerFromRepo, repoFromRepo] = (opts.repo ?? env.RPIV_WF_FORGEJO_REPO ?? "").split("/");
	return {
		base: (env.FORGEJO_URL?.trim() || DEFAULT_FORGEJO_URL).replace(/\/+$/, ""),
		token,
		owner: ownerFromRepo && repoFromRepo ? ownerFromRepo : DEFAULT_FORGEJO_OWNER,
		repo: ownerFromRepo && repoFromRepo ? repoFromRepo : DEFAULT_FORGEJO_REPO,
		userAgent: env.FORGEJO_USER_AGENT?.trim() || DEFAULT_FORGEJO_USER_AGENT,
	};
}

/**
 * One request. The token and the body ride on stdin as a curl config; argv is
 * only `-sS --max-time N -K -` and so can be logged or shown in an error.
 */
function call(exec: Exec, cfg: ForgejoConfig, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): unknown {
	const lines = [
		`url = ${q(`${cfg.base}/api/v1${path}`)}`,
		`request = ${q(method)}`,
		`header = ${q(`Authorization: token ${cfg.token}`)}`,
		`header = ${q(`User-Agent: ${cfg.userAgent}`)}`,
		`header = ${q("Accept: application/json")}`,
		"fail",
	];
	if (body !== undefined) {
		lines.push(`header = ${q("Content-Type: application/json")}`);
		lines.push(`data = ${q(JSON.stringify(body))}`);
	}
	const out = exec("curl", ["-sS", "--max-time", "30", "-K", "-"], `${lines.join("\n")}\n`);
	return out.trim() ? (JSON.parse(out) as unknown) : undefined;
}

function asArray(v: unknown): Record<string, unknown>[] {
	return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

/** A Forgejo client in the `Kata` shape, or undefined without a token. */
export function detectForgejo(
	warn: (m: string) => void,
	exec: Exec = realExec,
	env: NodeJS.ProcessEnv = process.env,
	opts: ForgejoOptions = {},
): Kata | undefined {
	if (env.RPIV_WF_TRACKER === "off") return undefined;
	const cfg = forgejoConfig(env, opts);
	if (!cfg) {
		warn("FORGEJO_ACCESS_TOKEN is not set: parked questions get no Forgejo issue (they stay in `rpiv-wf inbox`)");
		return undefined;
	}
	if (!onPath("curl", env)) {
		warn("curl is not on PATH: parked questions get no Forgejo issue (they stay in `rpiv-wf inbox`)");
		return undefined;
	}
	const wanted = (
		opts.labels ??
		env.RPIV_WF_KATA_LABELS?.split(",").map((l) => l.trim()) ??
		DEFAULT_KATA_LABELS
	).filter((l) => l.length > 0);
	const repoPath = `/repos/${cfg.owner}/${cfg.repo}`;
	return {
		file(park, answerHint) {
			try {
				const marker = parkMarker(park);
				// Retry safety: reuse the issue an earlier attempt already filed.
				const found = asArray(
					call(
						exec,
						cfg,
						"GET",
						`${repoPath}/issues?type=issues&state=all&q=${encodeURIComponent(parkKey(park))}`,
					),
				).find((i) => typeof i.body === "string" && i.body.includes(marker));
				if (found && typeof found.number === "number") return forgejoRef(cfg.owner, cfg.repo, found.number);

				const known = asArray(call(exec, cfg, "GET", `${repoPath}/labels?limit=200`));
				const ids: number[] = [];
				const missing: string[] = [];
				for (const name of wanted) {
					const hit = known.find((l) => l.name === name);
					if (hit && typeof hit.id === "number") ids.push(hit.id);
					else missing.push(name);
				}
				if (missing.length > 0)
					warn(`Forgejo label(s) not found in ${cfg.owner}/${cfg.repo}, filed without: ${missing.join(", ")}`);

				const title =
					`rpiv: ${park.workflow ?? "workflow"} needs an answer — ${park.questions[0]?.question ?? "question"}`.slice(
						0,
						120,
					);
				const created = call(exec, cfg, "POST", `${repoPath}/issues`, {
					title,
					body: `${ticketBody(park, answerHint)}\n\n${marker}`,
					labels: ids,
				}) as { number?: unknown } | undefined;
				if (typeof created?.number !== "number") {
					warn("Forgejo create returned no issue number; the question is still in `rpiv-wf inbox`");
					return undefined;
				}
				return forgejoRef(cfg.owner, cfg.repo, created.number);
			} catch (err) {
				warn(`Forgejo create failed: ${scrub(String(err), cfg.token)}; the question is still in \`rpiv-wf inbox\``);
				return undefined;
			}
		},
		close(park) {
			if (!park.kata) return;
			const ref = parseForgejoRef(park.kata);
			if (!ref) return; // a kata ref from before the switch: not ours to close
			try {
				const path = `/repos/${ref.owner}/${ref.repo}/issues/${ref.n}`;
				call(exec, cfg, "POST", `${path}/comments`, {
					body: `Answered via rpiv-wf (run ${park.runId}, question #${park.n}): ${park.answer ?? "(no answer text)"}`,
				});
				call(exec, cfg, "PATCH", path, { state: "closed" });
			} catch (err) {
				warn(`Forgejo close ${park.kata} failed: ${scrub(String(err), cfg.token)}`);
			}
		},
	};
}

/** Never let the token reach a warning, whatever curl echoed back. */
export function scrub(message: string, token: string): string {
	return token ? message.split(token).join("***") : message;
}

/**
 * Which tracker files parked questions. Forgejo is the default; kata stays
 * available only when asked for with RPIV_WF_TRACKER=kata (and `kata` is on
 * PATH), because kata is being retired. RPIV_WF_TRACKER=off files nothing.
 */
export function pickTracker(
	warn: (m: string) => void,
	detectKata: (w: (m: string) => void, exec?: Exec, env?: NodeJS.ProcessEnv, o?: KataOptions) => Kata | undefined,
	exec: Exec | undefined,
	env: NodeJS.ProcessEnv,
	opts: KataOptions,
): Kata | undefined {
	const which = env.RPIV_WF_TRACKER ?? (env.RPIV_WF_KATA === "off" ? "off" : "forgejo");
	if (which === "off") return undefined;
	if (which === "kata") return detectKata(warn, exec, env, opts);
	if (opts.parent) warn("--kata <ref> is ignored for Forgejo issues (they have no parent field); filing without it");
	return detectForgejo(warn, exec, env, { labels: opts.labels });
}
