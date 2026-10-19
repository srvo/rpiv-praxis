/**
 * Execution-host seam — round-trip + graceful-degrade + slot durability.
 *
 * The seam is the injection point rpiv-pi uses to hand the runner an
 * SDK-backed executor. These tests pin the contract `runWorkflow` relies on:
 *   - register → get returns the same provider;
 *   - absent provider ⇒ `get` returns `undefined` (the degrade-to-live arm);
 *   - `__resetWorkflowExecutionHost` clears it (the per-test reset channel);
 *   - the provider slot is process-global: a re-`import()` of the module
 *     reads the SAME slot, so a duplicate module load across the peer-dependency
 *     boundary can't split `register` and `get` onto different slots.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as first from "./execution-host.js";
import {
	__resetWorkflowExecutionHost,
	getWorkflowExecutionProvider,
	registerWorkflowExecutionHost,
	type WorkflowExecution,
	type WorkflowExecutionProvider,
} from "./execution-host.js";
import type { WorkflowHostContext } from "./host.js";

// A minimal provider: createHost echoes the observer back as the executor — the
// seam never inspects the host, it only stores/returns the provider.
function fakeProvider(): WorkflowExecutionProvider {
	return {
		createHost: (observer: WorkflowHostContext): WorkflowExecution => ({ host: observer }),
	};
}

describe("execution-host seam", () => {
	beforeEach(() => __resetWorkflowExecutionHost());
	afterEach(() => __resetWorkflowExecutionHost());

	it("returns undefined when no provider is registered (degrade-to-live)", () => {
		expect(getWorkflowExecutionProvider()).toBeUndefined();
	});

	it("register → get round-trips the same provider instance", () => {
		const provider = fakeProvider();
		registerWorkflowExecutionHost(provider);
		expect(getWorkflowExecutionProvider()).toBe(provider);
	});

	it("a later registration replaces the earlier provider", () => {
		const first = fakeProvider();
		const second = fakeProvider();
		registerWorkflowExecutionHost(first);
		registerWorkflowExecutionHost(second);
		expect(getWorkflowExecutionProvider()).toBe(second);
	});
	it("out-of-order disposal never restores a provider whose registration was disposed", () => {
		const first = fakeProvider();
		const second = fakeProvider();
		const disposeFirst = registerWorkflowExecutionHost(first);
		const disposeSecond = registerWorkflowExecutionHost(second);
		disposeFirst();
		expect(getWorkflowExecutionProvider()).toBe(second);
		disposeSecond();
		expect(getWorkflowExecutionProvider()).toBeUndefined();
	});
	it("supports top-first and repeated disposal without disturbing the live predecessor", () => {
		const first = fakeProvider();
		const second = fakeProvider();
		const disposeFirst = registerWorkflowExecutionHost(first);
		const disposeSecond = registerWorkflowExecutionHost(second);
		disposeSecond();
		disposeSecond();
		expect(getWorkflowExecutionProvider()).toBe(first);
		disposeFirst();
		expect(getWorkflowExecutionProvider()).toBeUndefined();
	});

	it("__resetWorkflowExecutionHost clears the slot", () => {
		registerWorkflowExecutionHost(fakeProvider());
		expect(getWorkflowExecutionProvider()).toBeDefined();
		__resetWorkflowExecutionHost();
		expect(getWorkflowExecutionProvider()).toBeUndefined();
	});

	// The provider lives on a process-global Symbol.for slot, not a module-local
	// `let`. A second module instance (peer-dependency duplication) must read the
	// SAME slot, or register/get silently split and the runner degrades to live.
	// A plain re-import returns the cached instance and proves nothing, so reset
	// the module registry first to force a genuinely separate module graph.
	it("a second module instance reads the same process-global slot", async () => {
		const provider = fakeProvider();
		registerWorkflowExecutionHost(provider);
		vi.resetModules();
		const second = await import("./execution-host.js");
		expect(second).not.toBe(first); // a genuinely separate module instance
		expect(second.getWorkflowExecutionProvider()).toBe(provider);
	});

	it("registration through a second instance is visible to the first", async () => {
		vi.resetModules();
		const second = await import("./execution-host.js");
		const provider = fakeProvider();
		second.registerWorkflowExecutionHost(provider);
		expect(getWorkflowExecutionProvider()).toBe(provider);
	});
});
