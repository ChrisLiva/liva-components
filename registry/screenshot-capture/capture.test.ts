import { afterEach, describe, expect, it, vi } from "vitest";

import { afterPaint, includeInCapture } from "@/lib/feedback/capture";

// The whole point of capturing from the DOM rather than the screen is that the
// feedback dialog can stay open and stay out of its own screenshot. These pin
// the two markers that make that true — rename either one in the component or
// in ui/dialog.tsx and the dialog silently starts photographing itself.
describe("includeInCapture", () => {
	function element(html: string): Element {
		const host = document.createElement("div");
		host.innerHTML = html;
		// biome-ignore lint/style/noNonNullAssertion: the fragment above has one child
		return host.firstElementChild!;
	}

	it("drops the feedback dialog and the backdrop dimming the page", () => {
		expect(includeInCapture(element("<div data-capture-hide></div>"))).toBe(
			false,
		);
		expect(
			includeInCapture(element('<div data-slot="dialog-overlay"></div>')),
		).toBe(false);
	});

	it("keeps the page behind, including other dialog parts", () => {
		expect(includeInCapture(element("<main>spells</main>"))).toBe(true);
		expect(
			includeInCapture(element('<div data-slot="dialog-portal"></div>')),
		).toBe(true);
	});

	it("keeps non-element nodes, which carry the page's text", () => {
		expect(includeInCapture(document.createTextNode("Fire Bolt"))).toBe(true);
	});
});

// A capture is expensive enough to freeze whatever animation is playing when it
// starts, so callers put it after the paint. These pin that the wait actually
// waits — and, just as load-bearing, that it always ends: browsers pause frame
// callbacks in a hidden tab, and a caller stranded there would never file its
// report at all.
describe("afterPaint", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("waits for a painted frame rather than the current tick", async () => {
		const order: string[] = [];
		const done = afterPaint().then(() => order.push("afterPaint"));
		// A plain task queued now must still get to run first — settling in this
		// tick would put the blocking clone ahead of the render being deferred to.
		await Promise.resolve().then(() => order.push("microtask"));
		await done;
		expect(order).toEqual(["microtask", "afterPaint"]);
	});

	it("settles anyway when frames never come, as in a hidden tab", async () => {
		vi.useFakeTimers();
		vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(0);

		const settled = vi.fn();
		const done = afterPaint().then(settled);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(250);
		await done;
		expect(settled).toHaveBeenCalled();
	});
});
