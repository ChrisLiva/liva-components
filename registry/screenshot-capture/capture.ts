const EXCLUDED = '[data-capture-hide],[data-slot="dialog-overlay"]';

/*
 * EXCLUDED, above, names the nodes dropped from the clone: the feedback
 * dialog's popup (marked by the component) and the backdrop that dims the page
 * behind it. A Base UI dialog is modal, so only one can be open at a time —
 * whenever this runs, the open dialog *is* the feedback one, and what's left is
 * the page the reader means. Excluding a node excludes its subtree, so an empty
 * portal wrapper may survive; it paints nothing.
 *
 * It leads the file because `shadcn add` strips every comment above the first
 * statement, so a declaration has to come first for these notes to reach a
 * consumer at all.
 */

// Captures the current viewport to PNG bytes via `modern-screenshot`, for
// attaching a visual to a bug/feedback report without a getDisplayMedia
// permission prompt.
//
// Expected to change: MAX_SCALE (how much retina headroom to pay for in
// bytes) and the `domToBlob` options — width/height/type and the `fetch`
// placeholder policy are all reasonable to retune per consumer. The
// `restoreScrollPosition` feature flag should stay on for any app with
// internal scroll panes, per the comment below.
//
// Not expected to change: the EXCLUDED selector and `includeInCapture`'s
// signature. `data-capture-hide` and `data-slot="dialog-overlay"` are a
// cross-item convention — whatever dialog/modal component calls this capture
// is expected to mark its own popup and backdrop with those, and a test pins
// exactly this selector. Renaming either marker here without updating the
// dialog component (or vice versa) makes the dialog capture itself.

// Viewport capture for feedback reports. The page is re-rendered into an
// off-screen SVG <foreignObject> and rasterized — no getDisplayMedia, so there
// is no picker, no permission prompt, and the feedback modal never has to close
// or blink. The browser draws the clone itself, so oklch(), color-mix() and the
// accent bloom come out as authored.

/** True for nodes that belong in the shot — the `filter` modern-screenshot calls. */
export function includeInCapture(node: Node): boolean {
	return !(node instanceof Element && node.matches(EXCLUDED));
}

// Fallback for afterPaint when frame callbacks are paused. Long enough that a
// live rAF (fires within ~2 frames, <35ms) always wins in the foreground, yet a
// hidden tab still proceeds promptly rather than waiting for a refocus.
const PAINT_FALLBACK_MS = 250;

/**
 * Resolves after the next paint — or after a short fallback delay when no paint
 * is coming.
 *
 * `captureViewport` blocks the main thread for as long as the clone takes, so a
 * caller that starts it in the same tick as opening a dialog freezes that
 * dialog's enter animation and the open reads as a stall. Awaiting this first
 * puts the blocking work after the paint instead.
 *
 * Browsers pause requestAnimationFrame entirely in hidden tabs, so a bare
 * double-rAF deferral would strand a caller whose tab lost visibility; the
 * timeout guarantees settlement either way. A bare `setTimeout(0)` is not a
 * substitute — it fires BEFORE the next paint, ahead of the render it defers to.
 */
export function afterPaint(): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, PAINT_FALLBACK_MS);
		// Two frames: the first lets the pending render commit paint; work
		// scheduled on the second runs after it.
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				clearTimeout(timer);
				resolve();
			}),
		);
	});
}

// Retina is worth the bytes for legible text, but a 3x display would quadruple
// the PNG for no added clarity in a bug report.
const MAX_SCALE = 2;

/**
 * Rasterize the visible viewport, minus the feedback dialog, as PNG bytes.
 *
 * Rejects if the render fails. The app shell is `h-svh` with its own internal
 * scroll panes, so the document itself never scrolls and body at viewport size
 * is exactly what the reader sees; scrolled panes inside it are offset by
 * modern-screenshot.
 *
 * Known gap: `position: sticky` doesn't survive the clone. A scrolled pane's
 * offset is faked with a transform, so there is no scrollport for sticky to
 * resolve against and a pinned header (the spell list's level heading) is
 * missing from the shot. The rows themselves are correct, which is what a
 * report is about.
 */
export async function captureViewport(): Promise<Uint8Array> {
	// Loaded on demand: ~180 KB that only a reader filing a report ever pays for,
	// and it touches `document` at call time, so it must not run during SSR.
	const { domToBlob } = await import("modern-screenshot");

	const blob = await domToBlob(document.body, {
		width: window.innerWidth,
		height: window.innerHeight,
		scale: Math.min(window.devicePixelRatio || 1, MAX_SCALE),
		type: "image/png",
		filter: includeInCapture,
		// Off by default, and without it every scroll pane in the clone snaps back
		// to the top — the spell list is one, so the shot would show the head of
		// the list instead of the rows the reader is actually looking at.
		features: { restoreScrollPosition: true },
		// A cross-origin avatar that won't hand over CORS headers leaves a gap
		// rather than failing the capture — a screenshot is a nicety, not a gate.
		fetch: { placeholderImage: "" },
	});

	return new Uint8Array(await blob.arrayBuffer());
}
