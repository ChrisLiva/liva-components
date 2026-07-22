import type { ReactNode } from "react";

export type FeedbackReport = {
	/** Matches the `value` of one of the offered kinds. */
	type: string;
	/** The prose the reporter typed. */
	message: string;
	/** PNG bytes of an attached capture, or null when none was taken. */
	screenshotPng: Uint8Array | null;
	/** Serialized diagnostic manifest, or null when none was collected. */
	contextJson: string | null;
	/** Epoch milliseconds; stable across retries of the same report. */
	submittedAt: number;
};

/*
 * FeedbackReport, above, is one assembled report — the value handed to the
 * consumer's `onSubmit`. It heads the declarations because `shadcn add` strips
 * every comment above a file's imports, so the notes below have to sit under
 * something to reach a consumer at all.
 *
 * `submittedAt` is stamped once per dialog open and survives a retry, so a
 * server that keys on (user, submittedAt) collapses a resend of a failed
 * report onto the same row instead of filing a duplicate. Millisecond
 * granularity is enough because a human cannot complete two compose cycles
 * inside one millisecond; each genuine report re-opens the dialog and
 * re-stamps.
 */

// The customization map for the feedback flow: every piece of copy the dialog
// renders, the report kinds it offers, and the shapes those two travel in.
// This is the first — and for most consumers the only — file to edit after
// vendoring. Nothing here does any work; it is data plus types.
//
// Expected to change: all of it. DEFAULT_COPY is deliberately product-neutral
// so it reads as placeholder text rather than someone else's voice — replace
// it with your own. DEFAULT_KINDS is a two-entry starting point; add, remove,
// or re-label entries freely, and give each one an `accent` that suits your
// palette.
//
// Not expected to change: the FeedbackReport shape. It is the contract with
// the server — an `onSubmit` maps those five fields onto a request, and
// `submittedAt` in particular is idempotency material (see the note above).
// The types live here rather than beside the hook so that a consumer's
// wrapper can import them without pulling the component in. The one React
// reference is a type-only `ReactNode` import, which erases at compile time.

/**
 * One selectable report kind.
 *
 * `accent` is any CSS color; it is applied as `--lc-accent`, so it paints the
 * dialog's hairline ring and bloom, not text. `placeholder` seeds the message
 * field when that kind is selected.
 */
export type FeedbackKind = {
	value: string;
	label: string;
	accent?: string;
	placeholder?: string;
};

/**
 * Every piece of copy the flow renders.
 *
 * Three fields are more than a string, because the markup they land in is the
 * consumer's to shape: `title` takes any node, `receipt` takes a node-returning
 * function, and `triggerLabel` splits the floating button's wording off from
 * the dialog heading. The rest are plain strings and are meant to stay that
 * way — they land in places (a `<Button>`'s label, an `aria-label`) where a
 * node buys nothing.
 */
export type FeedbackCopy = {
	/**
	 * Dialog heading in the compose phase. Any node: a lone string, or markup —
	 * an accent-colored glyph ahead of the words, say. Base UI names the dialog
	 * from this element via `aria-labelledby`, and that name is computed from
	 * the rendered subtree, so mark decorative glyphs `aria-hidden` and the
	 * accessible name stays the words alone.
	 */
	title: ReactNode;
	/** Sub-heading under the compose title. */
	description: string;
	/**
	 * The floating trigger's wording, and its accessible name. Omit it and the
	 * trigger falls back to `title`, so a consumer who wants one phrase in both
	 * places writes it once; set it when the button and the heading should read
	 * differently ("Feedback" on the button, "Send Word" over the form).
	 *
	 * Plain string on purpose: this is the button's whole accessible name, and
	 * an `aria-hidden` glyph inside a node would silently shorten it. The
	 * trigger already renders `icon` ahead of this label.
	 */
	triggerLabel?: string;
	/** Button that attaches a screenshot. */
	captureLabel: string;
	/** Button that dismisses the dialog. */
	cancelLabel: string;
	/** Button that starts the send pipeline. */
	sendLabel: string;
	/** Dialog heading once the report is filed. */
	sentTitle: string;
	/** Sub-heading under the sent title. */
	sentDescription: string;
	/** Button that closes the dialog from the sent phase. */
	doneLabel: string;
	/** First stage label, shown while the diagnostic manifest is gathered. */
	collectingLabel: string;
	/** Stage label held for the rest of a send that never calls `progress()`. */
	progressLabel: string;
	/** Shown when a rejection carries no usable message of its own. */
	errorFallback: string;
	/**
	 * Optional line naming what rides along with the report. A bare string for a
	 * fixed line; a function to compose a live one ("carries 12 events · build
	 * a531918") that is evaluated at render rather than at module load.
	 *
	 * The function may return markup, which is the seam for a line that is not
	 * uniformly styled — a small-caps label ahead of a hex SHA that must not be,
	 * for instance. Return `undefined` and the footer drops the receipt line
	 * entirely, so a live receipt can decide it has nothing to say.
	 */
	receipt?: string | (() => ReactNode);
};

/**
 * A warm/cool pair of report kinds.
 *
 * The two accents are picked to stay visible against an unknown theme, since
 * this component ships without one. Measured as WCAG contrast against a light
 * surface (`oklch(0.97 0.005 290)`) and a dark one (`oklch(0.17 0.01 290)`):
 * the bug orange lands at 3.63:1 and 4.83:1, the idea blue at 3.33:1 and
 * 5.26:1. The bar applied is the 3:1 non-text/UI-component threshold, not the
 * 4.5:1 body-text one — these colors are only ever a hairline ring and a
 * blurred bloom, never a text color. Their hues sit 215° apart so the two
 * kinds read as different pigments at a glance rather than two shades of one.
 */
export const DEFAULT_KINDS: readonly FeedbackKind[] = [
	{
		value: "bug",
		label: "Bug",
		accent: "oklch(0.62 0.19 35)",
		placeholder: "What went wrong, and what were you doing at the time?",
	},
	{
		value: "idea",
		label: "Idea",
		accent: "oklch(0.62 0.16 250)",
		placeholder: "What would you like this to do?",
	},
];

/**
 * Product-neutral placeholder copy. Every string is meant to be replaced;
 * shipped wording is plain on purpose so an un-customized install reads as
 * unfinished rather than as another product's voice.
 */
export const DEFAULT_COPY: FeedbackCopy = {
	title: "Send feedback",
	/*
	 * No `triggerLabel` here on purpose. The field is absent rather than set to
	 * the same words, because the trigger reads `triggerLabel ?? title` — a
	 * default value here would win over the merge and leave a consumer who
	 * renamed only `title` with a button still saying "Send feedback".
	 */
	/*
	 * Deliberately says nothing about what the report carries. Whether any
	 * diagnostic manifest rides along at all is the `collectContext` prop's
	 * business, and what it contains — and whether it has been scrubbed — is
	 * known only to the consumer that wrote it. A default that promised a
	 * scrubbed record would be a lie on every install that omits the prop.
	 */
	description: "Tell us what's on your mind.",
	captureLabel: "Capture screenshot",
	cancelLabel: "Cancel",
	sendLabel: "Send",
	sentTitle: "Feedback sent",
	sentDescription: "Thanks — we read every report.",
	doneLabel: "Done",
	collectingLabel: "Collecting diagnostics…",
	progressLabel: "Sending…",
	errorFallback: "Something went wrong. Try again.",
};
