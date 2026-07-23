import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DiagnosticEvent } from "@/lib/feedback/diagnostics";

// The module holds one shared ring buffer (and an `installed` latch) at
// top-level scope, so importing it fresh per test via vi.resetModules() is
// what keeps these tests from leaking into each other — a static top-of-file
// import would let every test after the first inherit the previous test's
// buffered events.
type DiagnosticsModule = typeof import("@/lib/feedback/diagnostics");
let diagnostics: DiagnosticsModule;

const originalConsole = {
	log: console.log,
	warn: console.warn,
	error: console.error,
};

beforeEach(async () => {
	vi.resetModules();
	diagnostics = await import("@/lib/feedback/diagnostics");
});

afterEach(() => {
	// installDiagnostics patches the real global console object; resetting
	// the module registry doesn't undo that, so restore it by hand.
	console.log = originalConsole.log;
	console.warn = originalConsole.warn;
	console.error = originalConsole.error;
});

describe("record / collectContext (ring buffer)", () => {
	it("keeps only the most recent CAPACITY events, dropping the oldest", () => {
		for (let i = 0; i < 55; i++) {
			diagnostics.record("log", `event-${i}`);
		}
		const events = diagnostics.collectContext().events as DiagnosticEvent[];
		expect(events).toHaveLength(50);
		expect(events[0].message).toBe("event-5");
		expect(events[49].message).toBe("event-54");
	});

	it("truncates a message longer than MAX_MESSAGE to MAX_MESSAGE", () => {
		diagnostics.record("log", "x".repeat(2500));
		const events = diagnostics.collectContext().events as DiagnosticEvent[];
		expect(events[0].message).toHaveLength(2000);
	});
});

describe("collectContext (manifest merge)", () => {
	it("returns caller-supplied extra fields intact alongside page and events", () => {
		const identity = { userId: "user_123", email: "a@b.com" };
		const build = { sha: "abc123", time: "2026-01-01T00:00:00Z" };
		const manifest = diagnostics.collectContext({ identity, build });

		expect(manifest.identity).toEqual(identity);
		expect(manifest.build).toEqual(build);
		expect(manifest.page).toBeTruthy();
		expect(Array.isArray(manifest.events)).toBe(true);
	});

	it("returns a valid manifest with no argument", () => {
		const manifest = diagnostics.collectContext();
		expect(manifest.page).toBeTruthy();
		expect(Array.isArray(manifest.events)).toBe(true);
		expect(manifest.identity).toBeUndefined();
	});

	it("lets its own page/events keys win over a same-named key in extra", () => {
		const manifest = diagnostics.collectContext({
			page: "should not survive",
			events: "should not survive either",
		});
		expect(manifest.page).not.toBe("should not survive");
		expect(typeof manifest.page).toBe("object");
		expect(Array.isArray(manifest.events)).toBe(true);
	});
});

describe("eventCount", () => {
	it("reflects the number of buffered events", () => {
		expect(diagnostics.eventCount()).toBe(0);

		diagnostics.record("log", "a");
		diagnostics.record("warn", "b");
		diagnostics.record("error", "c");

		expect(diagnostics.eventCount()).toBe(3);
	});
});

describe("installDiagnostics", () => {
	it("is idempotent: calling it twice does not double-record a single console.log", () => {
		const logSpy = vi.fn();
		console.log = logSpy;

		diagnostics.installDiagnostics();
		diagnostics.installDiagnostics();
		console.log("hello");

		expect(diagnostics.eventCount()).toBe(1);
		expect(logSpy).toHaveBeenCalledTimes(1);
	});

	it("no-ops under SSR (no window) rather than throwing", () => {
		const logSpy = vi.fn();
		console.log = logSpy;
		// jsdom supplies a window, so the SSR path only exists if this test takes
		// it away for the duration of the call.
		vi.stubGlobal("window", undefined);

		try {
			expect(() => diagnostics.installDiagnostics()).not.toThrow();
			console.log("hello");

			// Nothing was patched and nothing was buffered: the call left the
			// console exactly as it found it.
			expect(console.log).toBe(logSpy);
			expect(diagnostics.eventCount()).toBe(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
