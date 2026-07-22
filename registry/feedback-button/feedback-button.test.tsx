import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSendPipeline } from "@/components/feedback/feedback-button";
import type { FeedbackReport } from "@/components/feedback/feedback-defaults";

const DRAFT = {
	type: "bug",
	message: "the sigil ate my cursor",
	screenshotPng: null,
};

/** A promise plus the handles to settle it from the test body. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	// Only the clock APIs the pipeline touches: faking queueMicrotask would
	// stall React's own act() flushing.
	vi.useFakeTimers({
		toFake: [
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
			"Date",
		],
	});
	vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

/** Let a started send() run up to its first suspension point. */
async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

/** Run the clock forward inside act(), so trickle ticks land as re-renders. */
async function tick(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

describe("useSendPipeline", () => {
	it("starts in compose with an idle bar", () => {
		const { result } = renderHook(() =>
			useSendPipeline({ onSubmit: vi.fn().mockResolvedValue(undefined) }),
		);

		expect(result.current.phase).toBe("compose");
		expect(result.current.percent).toBe(0);
		expect(result.current.stage).toBe("");
		expect(result.current.error).toBeNull();
		expect(result.current.submittedAt).toBeNull();
	});

	it("enters sending and shows the collecting stage while context is gathered", async () => {
		const gate = deferred<string>();
		const { result } = renderHook(() =>
			useSendPipeline({
				collectContext: () => gate.promise,
				onSubmit: vi.fn().mockResolvedValue(undefined),
			}),
		);

		act(() => {
			void result.current.send(DRAFT);
		});

		expect(result.current.phase).toBe("sending");
		expect(result.current.stage).toBe("Collecting diagnostics…");
		expect(result.current.percent).toBeGreaterThan(0);

		await act(async () => {
			gate.resolve("{}");
		});
		expect(result.current.stage).toBe("Sending…");
	});

	it("hands the consumer the assembled report", async () => {
		const seen: FeedbackReport[] = [];
		const { result } = renderHook(() =>
			useSendPipeline({
				collectContext: () => '{"events":[]}',
				onSubmit: async (report) => {
					seen.push(report);
				},
			}),
		);

		await act(async () => {
			await result.current.send({
				type: "idea",
				message: "more sigils",
				screenshotPng: new Uint8Array([1, 2, 3]),
			});
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({
			type: "idea",
			message: "more sigils",
			screenshotPng: new Uint8Array([1, 2, 3]),
			contextJson: '{"events":[]}',
			submittedAt: Date.now(),
		});
	});

	it("advances the bar on its own toward a ceiling it never reaches", async () => {
		const gate = deferred<void>();
		const { result } = renderHook(() =>
			useSendPipeline({ onSubmit: () => gate.promise }),
		);

		act(() => {
			void result.current.send(DRAFT);
		});
		const start = result.current.percent;

		await tick(1000);
		const early = result.current.percent;
		expect(early).toBeGreaterThan(start);

		await tick(60_000);
		expect(result.current.percent).toBeGreaterThan(early);
		expect(result.current.percent).toBeLessThan(90);
	});

	it("decelerates: each equal slice of time buys less progress", async () => {
		const gate = deferred<void>();
		const { result } = renderHook(() =>
			useSendPipeline({ onSubmit: () => gate.promise }),
		);

		act(() => {
			void result.current.send(DRAFT);
		});
		const start = result.current.percent;

		await tick(2000);
		const first = result.current.percent - start;
		const mid = result.current.percent;
		await tick(2000);
		const second = result.current.percent - mid;

		expect(second).toBeLessThan(first);
		expect(second).toBeGreaterThan(0);
	});

	it("lets progress() set the stage label and push the bar", async () => {
		const gate = deferred<void>();
		let advance: ((label: string) => void) | null = null;
		const { result } = renderHook(() =>
			useSendPipeline({
				onSubmit: (_report, progress) => {
					advance = progress;
					return gate.promise;
				},
			}),
		);

		act(() => {
			void result.current.send(DRAFT);
		});
		await flush();
		const before = result.current.percent;

		act(() => {
			advance?.("Uploading screenshot…");
		});

		expect(result.current.stage).toBe("Uploading screenshot…");
		expect(result.current.percent).toBeGreaterThan(before);
		expect(result.current.percent).toBeLessThan(90);
	});

	it("snaps to 100, holds, then lands in sent", async () => {
		const gate = deferred<void>();
		const { result } = renderHook(() =>
			useSendPipeline({ onSubmit: () => gate.promise }),
		);

		act(() => {
			void result.current.send(DRAFT);
		});
		await act(async () => {
			gate.resolve();
		});

		expect(result.current.percent).toBe(100);
		expect(result.current.phase).toBe("sending");

		await tick(1000);
		expect(result.current.phase).toBe("sent");
		expect(result.current.percent).toBe(100);
	});

	it("ignores progress() called after the send resolved", async () => {
		const gate = deferred<void>();
		let advance: ((label: string) => void) | null = null;
		const { result } = renderHook(() =>
			useSendPipeline({
				onSubmit: (_report, progress) => {
					advance = progress;
					return gate.promise;
				},
			}),
		);

		act(() => {
			void result.current.send(DRAFT);
		});
		await flush();
		await act(async () => {
			gate.resolve();
		});
		await tick(1000);

		act(() => {
			advance?.("a stray callback from a leaked request");
		});

		expect(result.current.phase).toBe("sent");
		expect(result.current.percent).toBe(100);
		expect(result.current.stage).not.toBe(
			"a stray callback from a leaked request",
		);
	});

	it("ignores progress() called after the send rejected", async () => {
		const gate = deferred<void>();
		let advance: ((label: string) => void) | null = null;
		const { result } = renderHook(() =>
			useSendPipeline({
				onSubmit: (_report, progress) => {
					advance = progress;
					return gate.promise;
				},
			}),
		);

		act(() => {
			void result.current.send(DRAFT);
		});
		await flush();
		await act(async () => {
			gate.reject(new Error("network down"));
		});

		act(() => {
			advance?.("a stray callback from a leaked request");
		});

		expect(result.current.phase).toBe("compose");
		expect(result.current.percent).toBe(0);
		expect(result.current.stage).toBe("");
		expect(result.current.error).toBe("network down");
	});

	it("keeps a late trickle tick from moving a finished bar", async () => {
		const gate = deferred<void>();
		const { result } = renderHook(() =>
			useSendPipeline({ onSubmit: () => gate.promise }),
		);

		act(() => {
			void result.current.send(DRAFT);
		});
		await tick(1000);
		await act(async () => {
			gate.resolve();
		});
		await tick(10_000);

		expect(result.current.percent).toBe(100);
		expect(result.current.phase).toBe("sent");
	});

	it("drains the bar and returns to compose when onSubmit rejects", async () => {
		const { result } = renderHook(() =>
			useSendPipeline({
				onSubmit: () => Promise.reject(new Error("server said no")),
			}),
		);

		await act(async () => {
			await result.current.send(DRAFT);
		});

		expect(result.current.phase).toBe("compose");
		expect(result.current.percent).toBe(0);
		expect(result.current.error).toBe("server said no");
	});

	it("falls back to a generic message for a non-Error rejection", async () => {
		const { result } = renderHook(() =>
			useSendPipeline({ onSubmit: () => Promise.reject("nope") }),
		);

		await act(async () => {
			await result.current.send(DRAFT);
		});

		expect(result.current.error).toBe("Something went wrong. Try again.");
	});

	it("falls back to a generic message for an Error with no message", async () => {
		const { result } = renderHook(() =>
			useSendPipeline({ onSubmit: () => Promise.reject(new Error("")) }),
		);

		await act(async () => {
			await result.current.send(DRAFT);
		});

		expect(result.current.error).toBe("Something went wrong. Try again.");
	});

	it("retries the full pipeline with the same submittedAt", async () => {
		const stamps: number[] = [];
		const onSubmit = vi
			.fn<(report: FeedbackReport) => Promise<void>>()
			.mockImplementation(async (report) => {
				stamps.push(report.submittedAt);
				if (stamps.length === 1) throw new Error("server said no");
			});
		const collectContext = vi.fn(() => "{}");
		const { result } = renderHook(() =>
			useSendPipeline({ collectContext, onSubmit }),
		);

		await act(async () => {
			await result.current.send(DRAFT);
		});
		expect(result.current.error).toBe("server said no");

		vi.setSystemTime(new Date("2026-07-22T12:05:00.000Z"));
		await act(async () => {
			await result.current.send(DRAFT);
		});
		await tick(1000);

		expect(stamps).toHaveLength(2);
		expect(stamps[1]).toBe(stamps[0]);
		// The whole pipeline reruns — context is gathered afresh, not reused.
		expect(collectContext).toHaveBeenCalledTimes(2);
		expect(result.current.phase).toBe("sent");
		expect(result.current.error).toBeNull();
	});

	it("ignores a second send() while one is in flight", async () => {
		const gate = deferred<void>();
		const onSubmit = vi.fn(() => gate.promise);
		const { result } = renderHook(() => useSendPipeline({ onSubmit }));

		act(() => {
			void result.current.send(DRAFT);
			void result.current.send(DRAFT);
		});
		await flush();

		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("ignores a send() during the completion hold", async () => {
		const gate = deferred<void>();
		const onSubmit = vi.fn(() => gate.promise);
		const { result } = renderHook(() => useSendPipeline({ onSubmit }));

		act(() => {
			void result.current.send(DRAFT);
		});
		await act(async () => {
			gate.resolve();
		});
		act(() => {
			void result.current.send(DRAFT);
		});
		await flush();

		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("reset() returns to compose and re-stamps the next report", async () => {
		const stamps: number[] = [];
		const { result } = renderHook(() =>
			useSendPipeline({
				onSubmit: async (report) => {
					stamps.push(report.submittedAt);
				},
			}),
		);

		await act(async () => {
			await result.current.send(DRAFT);
		});
		await tick(1000);
		expect(result.current.phase).toBe("sent");

		act(() => {
			result.current.reset();
		});
		expect(result.current.phase).toBe("compose");
		expect(result.current.percent).toBe(0);
		expect(result.current.stage).toBe("");
		expect(result.current.submittedAt).toBeNull();

		vi.setSystemTime(new Date("2026-07-22T12:05:00.000Z"));
		await act(async () => {
			await result.current.send(DRAFT);
		});

		expect(stamps).toHaveLength(2);
		expect(stamps[1]).toBeGreaterThan(stamps[0]);
	});

	it("ignores a send that resolves after reset()", async () => {
		const gate = deferred<void>();
		const { result } = renderHook(() =>
			useSendPipeline({ onSubmit: () => gate.promise }),
		);

		act(() => {
			void result.current.send(DRAFT);
		});
		await flush();
		act(() => {
			result.current.reset();
		});

		await act(async () => {
			gate.resolve();
		});
		await tick(2000);

		expect(result.current.phase).toBe("compose");
		expect(result.current.percent).toBe(0);
		expect(result.current.stage).toBe("");
		expect(result.current.submittedAt).toBeNull();
	});

	it("ignores a send that rejects after reset()", async () => {
		const gate = deferred<void>();
		const { result } = renderHook(() =>
			useSendPipeline({ onSubmit: () => gate.promise }),
		);

		act(() => {
			void result.current.send(DRAFT);
		});
		await flush();
		act(() => {
			result.current.reset();
		});

		await act(async () => {
			gate.reject(new Error("network down"));
		});
		await tick(2000);

		expect(result.current.phase).toBe("compose");
		expect(result.current.error).toBeNull();
		expect(result.current.percent).toBe(0);
		expect(result.current.stage).toBe("");
	});

	it("ignores a progress() from an abandoned attempt while a second is in flight", async () => {
		const gates = [deferred<void>(), deferred<void>()];
		const advances: ((label: string) => void)[] = [];
		let attempt = 0;
		const { result } = renderHook(() =>
			useSendPipeline({
				onSubmit: (_report, progress) => {
					advances.push(progress);
					const gate = gates[attempt];
					attempt += 1;
					return gate.promise;
				},
			}),
		);

		act(() => {
			void result.current.send(DRAFT);
		});
		await flush();
		act(() => {
			result.current.reset();
		});
		act(() => {
			void result.current.send(DRAFT);
		});
		await flush();
		const stage = result.current.stage;
		const percent = result.current.percent;

		act(() => {
			advances[0]("a stray callback from the abandoned attempt");
		});

		expect(result.current.stage).toBe(stage);
		expect(result.current.percent).toBe(percent);
	});

	it("keeps the live attempt's bar running when an abandoned one settles", async () => {
		const gates = [deferred<void>(), deferred<void>()];
		let attempt = 0;
		const { result } = renderHook(() =>
			useSendPipeline({
				onSubmit: () => {
					const gate = gates[attempt];
					attempt += 1;
					return gate.promise;
				},
			}),
		);

		act(() => {
			void result.current.send(DRAFT);
		});
		await flush();
		act(() => {
			result.current.reset();
		});
		act(() => {
			void result.current.send(DRAFT);
		});
		await flush();

		// The abandoned attempt settles mid-flight; its cleanup must not take the
		// live attempt's trickle with it.
		await act(async () => {
			gates[0].resolve();
		});
		const before = result.current.percent;
		await tick(2000);

		expect(result.current.phase).toBe("sending");
		expect(result.current.percent).toBeGreaterThan(before);
	});

	it("clears a stale error when a retry starts", async () => {
		const gate = deferred<void>();
		let attempt = 0;
		const { result } = renderHook(() =>
			useSendPipeline({
				onSubmit: () => {
					attempt += 1;
					return attempt === 1
						? Promise.reject(new Error("server said no"))
						: gate.promise;
				},
			}),
		);

		await act(async () => {
			await result.current.send(DRAFT);
		});
		expect(result.current.error).toBe("server said no");

		act(() => {
			void result.current.send(DRAFT);
		});
		expect(result.current.error).toBeNull();
		expect(result.current.phase).toBe("sending");
	});
});
