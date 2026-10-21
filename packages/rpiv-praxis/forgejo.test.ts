import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_FORGEJO_URL,
	detectForgejo,
	forgejoConfig,
	forgejoRef,
	parkMarker,
	parseForgejoRef,
	pickTracker,
	scrub,
} from "./forgejo.ts";
import type { Exec } from "./kata.ts";
import type { Park } from "./park-store.ts";

const TOKEN = "tok_SECRET_1234";

const park: Park = {
	n: 2,
	runId: "run-7",
	workflow: "build",
	stage: "design-review",
	prompt: "/skill:x",
	sessionId: "s",
	questions: [{ question: "Accept?", options: [{ label: "Accept" }, { label: "Adjust" }] }],
	status: "waiting",
	askedAt: "t",
};

/** A PATH containing a fake `curl` so onPath("curl") is true; exec is injected anyway. */
function pathWithCurl(): NodeJS.ProcessEnv {
	const dir = mkdtempSync(join(tmpdir(), "rpiv-forgejo-"));
	writeFileSync(join(dir, "curl"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(dir, "curl"), 0o755);
	return { PATH: dir, FORGEJO_ACCESS_TOKEN: TOKEN };
}

interface Call {
	cmd: string;
	args: string[];
	input: string;
}

/** An exec that records calls and answers by the request's URL line. */
function fake(answers: (url: string, method: string, input: string) => string): { exec: Exec; calls: Call[] } {
	const calls: Call[] = [];
	const exec: Exec = (cmd, args, input = "") => {
		calls.push({ cmd, args, input });
		const url = /^url = "(.*)"$/m.exec(input)?.[1] ?? "";
		const method = /^request = "(.*)"$/m.exec(input)?.[1] ?? "";
		return answers(url, method, input);
	};
	return { exec, calls };
}

const LABELS = JSON.stringify([
	{ id: 11, name: "rpiv-parked" },
	{ id: 12, name: "human" },
]);

describe("refs", () => {
	it("round-trips a forgejo ref and refuses a kata ref", () => {
		expect(forgejoRef("EthicalCapital", "monocloud", 3233)).toBe("forgejo:EthicalCapital/monocloud#3233");
		expect(parseForgejoRef("forgejo:EthicalCapital/monocloud#3233")).toEqual({
			owner: "EthicalCapital",
			repo: "monocloud",
			n: 3233,
		});
		expect(parseForgejoRef("avtb")).toBeUndefined();
	});
	it("ties an issue to one park with a marker", () => {
		expect(parkMarker(park)).toBe("<!-- rpiv-park:run-7:2 -->");
	});
});

describe("forgejoConfig", () => {
	it("needs a token", () => {
		expect(forgejoConfig({})).toBeUndefined();
		expect(forgejoConfig({ FORGEJO_ACCESS_TOKEN: "  " })).toBeUndefined();
	});
	it("defaults to the internal tailnet URL and monocloud", () => {
		const cfg = forgejoConfig({ FORGEJO_ACCESS_TOKEN: TOKEN });
		expect(cfg).toMatchObject({ base: DEFAULT_FORGEJO_URL, owner: "EthicalCapital", repo: "monocloud" });
	});
	it("honours FORGEJO_URL and owner/repo", () => {
		const cfg = forgejoConfig({ FORGEJO_ACCESS_TOKEN: TOKEN, FORGEJO_URL: "http://x:1/" }, { repo: "o/r" });
		expect(cfg).toMatchObject({ base: "http://x:1", owner: "o", repo: "r" });
	});
});

describe("detectForgejo", () => {
	it("without a token files nothing and says so", () => {
		const warnings: string[] = [];
		expect(detectForgejo((m) => warnings.push(m), undefined, { PATH: "" })).toBeUndefined();
		expect(warnings.join()).toContain("FORGEJO_ACCESS_TOKEN is not set");
	});
	it("RPIV_WF_TRACKER=off is silent", () => {
		const warnings: string[] = [];
		expect(detectForgejo((m) => warnings.push(m), undefined, { RPIV_WF_TRACKER: "off" })).toBeUndefined();
		expect(warnings).toEqual([]);
	});

	it("files one issue with the marker, resolved label ids, and no token in argv", () => {
		const env = pathWithCurl();
		const { exec, calls } = fake((url, method) => {
			if (url.includes("/issues?")) return "[]";
			if (url.includes("/labels")) return LABELS;
			if (method === "POST") return JSON.stringify({ number: 3300 });
			return "";
		});
		const warnings: string[] = [];
		const ref = detectForgejo((m) => warnings.push(m), exec, env)!.file(park, "rpiv-wf answer run-7 2 <choice>");
		expect(ref).toBe("forgejo:EthicalCapital/monocloud#3300");
		expect(warnings).toEqual([]);
		const post = calls.find((c) => /^request = "POST"/m.test(c.input))!;
		const body = JSON.parse(/^data = "(.*)"$/m.exec(post.input)![1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
		expect(body.labels).toEqual([11, 12]);
		expect(body.body).toContain("<!-- rpiv-park:run-7:2 -->");
		expect(body.title).toContain("rpiv: build needs an answer");
		// The token rides on stdin only.
		for (const c of calls) {
			expect(c.cmd).toBe("curl");
			expect(c.args.join(" ")).not.toContain(TOKEN);
			expect(c.input).toContain(`Authorization: token ${TOKEN}`);
		}
	});

	it("a retried file reuses the issue the first attempt made (no duplicate)", () => {
		const env = pathWithCurl();
		const { exec, calls } = fake((url) =>
			url.includes("/issues?") ? JSON.stringify([{ number: 41, body: `x\n\n${parkMarker(park)}` }]) : "[]",
		);
		const ref = detectForgejo(() => {}, exec, env)!.file(park, "hint");
		expect(ref).toBe("forgejo:EthicalCapital/monocloud#41");
		expect(calls.some((c) => /^request = "POST"/m.test(c.input))).toBe(false);
	});

	it("ignores a search hit whose body lacks this park's marker", () => {
		const env = pathWithCurl();
		const { exec } = fake((url, method) => {
			if (url.includes("/issues?")) return JSON.stringify([{ number: 9, body: "<!-- rpiv-park:other:1 -->" }]);
			if (url.includes("/labels")) return LABELS;
			if (method === "POST") return JSON.stringify({ number: 50 });
			return "";
		});
		expect(detectForgejo(() => {}, exec, env)!.file(park, "hint")).toBe("forgejo:EthicalCapital/monocloud#50");
	});

	it("files without a label that does not exist, and says which", () => {
		const env = pathWithCurl();
		const { exec } = fake((url, method) => {
			if (url.includes("/issues?")) return "[]";
			if (url.includes("/labels")) return JSON.stringify([{ id: 11, name: "rpiv-parked" }]);
			if (method === "POST") return JSON.stringify({ number: 5 });
			return "";
		});
		const warnings: string[] = [];
		expect(detectForgejo((m) => warnings.push(m), exec, env)!.file(park, "h")).toBe(
			"forgejo:EthicalCapital/monocloud#5",
		);
		expect(warnings.join()).toContain("not found");
		expect(warnings.join()).toContain("human");
	});

	it("a failing curl is reported, swallowed, and never leaks the token", () => {
		const env = pathWithCurl();
		const exec: Exec = () => {
			throw new Error(`curl: (22) The requested URL returned error: 403 Authorization: token ${TOKEN}`);
		};
		const warnings: string[] = [];
		expect(detectForgejo((m) => warnings.push(m), exec, env)!.file(park, "h")).toBeUndefined();
		expect(warnings.join()).toContain("Forgejo create failed");
		expect(warnings.join()).not.toContain(TOKEN);
	});

	it("close comments then closes the issue it filed", () => {
		const env = pathWithCurl();
		const { exec, calls } = fake(() => "{}");
		detectForgejo(() => {}, exec, env)!.close({
			...park,
			kata: "forgejo:EthicalCapital/monocloud#3300",
			answer: "Accept",
		});
		const reqs = calls.map(
			(c) => `${/^request = "(.*)"$/m.exec(c.input)![1]} ${/^url = "(.*)"$/m.exec(c.input)![1]}`,
		);
		expect(reqs[0]).toMatch(/^POST .*\/issues\/3300\/comments$/);
		expect(reqs[1]).toMatch(/^PATCH .*\/issues\/3300$/);
		expect(calls[1]!.input).toContain('"{\\"state\\":\\"closed\\"}"');
	});

	it("close leaves a pre-switch kata ref alone", () => {
		const env = pathWithCurl();
		const { exec, calls } = fake(() => "{}");
		detectForgejo(() => {}, exec, env)!.close({ ...park, kata: "avtb", answer: "x" });
		expect(calls).toEqual([]);
	});
});

describe("pickTracker", () => {
	const kataStub = () => ({ file: () => "kata-ref", close: () => {} });
	it("defaults to forgejo, not kata", () => {
		const warnings: string[] = [];
		const t = pickTracker((m) => warnings.push(m), kataStub, undefined, { PATH: "" }, {});
		expect(t).toBeUndefined(); // no token: nothing filed, and it said so
		expect(warnings.join()).toContain("FORGEJO_ACCESS_TOKEN");
	});
	it("RPIV_WF_TRACKER=kata still reaches kata", () => {
		const t = pickTracker(() => {}, kataStub, undefined, { RPIV_WF_TRACKER: "kata" }, {});
		expect(t?.file(park, "h")).toBe("kata-ref");
	});
	it("the old RPIV_WF_KATA=off still silences ticketing", () => {
		const warnings: string[] = [];
		expect(pickTracker((m) => warnings.push(m), kataStub, undefined, { RPIV_WF_KATA: "off" }, {})).toBeUndefined();
		expect(warnings).toEqual([]);
	});
	it("says --kata <ref> is ignored for forgejo", () => {
		const warnings: string[] = [];
		pickTracker(
			(m) => warnings.push(m),
			kataStub,
			undefined,
			{ PATH: "", FORGEJO_ACCESS_TOKEN: TOKEN },
			{ parent: "abcd" },
		);
		expect(warnings.join()).toContain("--kata <ref> is ignored");
	});
});

describe("scrub", () => {
	it("removes every occurrence of the token", () => {
		expect(scrub(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe("a *** b ***");
	});
});
