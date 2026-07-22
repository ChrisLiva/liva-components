import { Camera, RefreshCw, X } from "lucide-react";
import {
	type CSSProperties,
	cloneElement,
	isValidElement,
	type ReactElement,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

import {
	DEFAULT_COPY,
	DEFAULT_KINDS,
	type FeedbackCopy,
	type FeedbackKind,
	type FeedbackReport,
} from "@/components/feedback/feedback-defaults";
import { FeedbackProgress } from "@/components/feedback/feedback-progress";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { afterPaint, captureViewport } from "@/lib/feedback/capture";
import { cn } from "@/lib/utils";

// The feedback dialog: a floating trigger, a compose form, a send with a
// progress bar, and a confirmation. Two files sit under it — feedback-defaults
// (copy and kinds) and feedback-progress (the bar) — and the pipeline hook at
// the bottom of this file owns everything about the send itself.
//
// Vendor this and edit it. There is no slot system and no render props on
// purpose: the two views are named components below (ComposeView, SentView),
// and rearranging one is a matter of moving JSX rather than learning an API.
//
// Expected to change: the two views' layout, the default trigger (a plain
// floating button — replace it wholesale with the `trigger` prop or rewrite it
// here), MAX_SCREENSHOT_BYTES to match your transport's own limit, and LABELS,
// which holds the handful of strings that are not part of FeedbackCopy.
//
// Not expected to change without care:
//   - `data-capture-hide` on the dialog popup. That marker is how
//     lib/feedback/capture leaves this dialog out of its own screenshot;
//     drop it and every capture is a picture of the feedback form.
//   - The accent plumbing (ACCENT_GRADIENT, FRAME_RADIUS). Both are load-
//     bearing for the ring animation and the bloom's alignment — the comments
//     on each say why.
//   - The data-slot attributes. They are the documented styling handles a
//     consumer's own stylesheet targets from outside this file.

// ── The send pipeline ────────────────────────────────────────────────────────

// The send pipeline behind the feedback dialog: one hook that owns the
// compose → sending → sent progression and everything the bar under it renders
// from. It holds no markup, so the dialog can be restyled or rebuilt without
// disturbing any of this.
//
// Expected to change: the pacing constants below (trickle interval, ceiling,
// how far a progress() call jumps, how long 100% is held), and the shape of
// `onSubmit` — that function is where a consumer's transport lives, and this
// hook has no opinion about it beyond "returns a promise".
//
// Not expected to change: two guarantees the dialog leans on. Only the current
// attempt may move the UI — a late progress() from a consumer's leaked request
// cannot nudge a finished bar, and an attempt the reporter walked away from
// cannot drag the dialog into `sent` or post an error over the report they are
// writing now, however long its promise takes to settle. And a retry reuses the
// first attempt's `submittedAt`, so a server that keys on it collapses the
// resend onto one row.

export type {
	FeedbackCopy,
	FeedbackKind,
	FeedbackReport,
} from "@/components/feedback/feedback-defaults";

/** Where the flow is: composing a report, sending it, or done. */
export type FeedbackPhase = "compose" | "sending" | "sent";

/**
 * What the compose form owns. The pipeline supplies the other two fields of a
 * {@link FeedbackReport} — the diagnostic manifest and the submit stamp.
 */
export type FeedbackDraft = Pick<
	FeedbackReport,
	"type" | "message" | "screenshotPng"
>;

/**
 * Report the stage a long send has reached, e.g. `"Uploading screenshot…"`.
 * The label is shown under the bar and the bar advances toward its ceiling.
 * Calling this after the send has settled is a no-op, always.
 */
export type ProgressFn = (label: string) => void;

/** Inputs to {@link useSendPipeline}. */
export type SendPipelineOptions = {
	/**
	 * Deliver the report. Rejecting returns the flow to `compose` with the
	 * rejection's message surfaced; resolving completes the bar and lands in
	 * `sent`. Call the supplied `progress` as often as the transport can say
	 * something useful — a send that never calls it still animates.
	 */
	onSubmit: (report: FeedbackReport, progress: ProgressFn) => Promise<void>;
	/**
	 * Gather the diagnostic manifest that rides along, already serialized and
	 * scrubbed. Runs at the head of every attempt (including a retry), so the
	 * manifest describes the browser at send time. Omit to send no context.
	 */
	collectContext?: () => string | null | Promise<string | null>;
	/**
	 * Override the strings this hook produces: `collectingLabel` (the first
	 * stage), `progressLabel` (held when the consumer never calls `progress`),
	 * and `errorFallback` (used when a rejection carries no usable message).
	 */
	copy?: Partial<FeedbackCopy>;
};

/** Everything the dialog and its progress bar render from. */
export type SendPipeline = {
	/** Which phase the flow is in. */
	phase: FeedbackPhase;
	/** Bar fill, 0–100. Zero outside a send; exactly 100 once one succeeds. */
	percent: number;
	/** Current stage label; empty string outside a send. */
	stage: string;
	/** Message from the last failed attempt, or null. */
	error: string | null;
	/** The stamp the current report will carry, or null before the first send. */
	submittedAt: number | null;
	/** Run the pipeline. Ignored while a send is already in flight. */
	send: (draft: FeedbackDraft) => Promise<void>;
	/** Discard all send state, so the next `send` starts a fresh report. */
	reset: () => void;
};

// Where the bar starts, so it is visible the instant a send begins.
const START_PERCENT = 8;
// The bar's self-driven ceiling. It approaches this asymptotically and only
// ever reaches 100 because the send actually finished — an honest bar never
// claims a completion it hasn't observed.
const CEILING = 90;
// How often the bar advances on its own.
const TRICKLE_INTERVAL_MS = 200;
// Each tick closes this fraction of the gap to the ceiling, which is what
// makes the motion decelerate: constant time, shrinking distance.
const TRICKLE_FRACTION = 0.08;
// A progress() call is worth a visible jump — several ticks' worth.
const STAGE_FRACTION = 0.35;
// How long a full bar is held before the sent phase replaces it, so the
// completion registers instead of flashing past.
const COMPLETE_HOLD_MS = 450;

/** Close `fraction` of the distance from `from` to the ceiling. */
function toward(from: number, fraction: number): number {
	return from + (CEILING - from) * fraction;
}

/** A rejection's own message, or the generic fallback when it hasn't one. */
function messageFor(reason: unknown, fallback: string): string {
	return reason instanceof Error && reason.message.trim() !== ""
		? reason.message
		: fallback;
}

/**
 * Own the send half of a feedback dialog: phases, a self-advancing progress
 * bar, stage labels, and errors.
 *
 * ```tsx
 * const pipeline = useSendPipeline({
 *   collectContext: () => JSON.stringify(scrub(collectContext())),
 *   onSubmit: async (report, progress) => {
 *     progress("Uploading…");
 *     await api.submitReport(report);
 *   },
 * });
 * ```
 *
 * Call `reset()` when the dialog opens: that clears the previous outcome and
 * releases the stamp, so the next send files a new report rather than
 * retrying the last one.
 */
export function useSendPipeline(options: SendPipelineOptions): SendPipeline {
	const [phase, setPhase] = useState<FeedbackPhase>("compose");
	const [percent, setPercent] = useState(0);
	const [stage, setStage] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [submittedAt, setSubmittedAt] = useState<number | null>(null);

	// Read at send time rather than captured, so `send` stays referentially
	// stable while still seeing the caller's latest closures.
	const optionsRef = useRef(options);
	useEffect(() => {
		optionsRef.current = options;
	});

	// The mechanism behind "only the current attempt may move the UI": every
	// attempt takes a generation number, and settling — or a reset, or a later
	// send — increments the counter. The `progress` handed to `onSubmit` and
	// both of the attempt's own settle paths compare their captured number
	// against the counter and do nothing once they differ, so a leaked callback
	// or an abandoned promise is inert no matter how long it takes to arrive.
	const generation = useRef(0);
	// Covers the whole in-flight window, including the completion hold — a
	// state flag would lag a synchronous double-click.
	const busy = useRef(false);
	const stampRef = useRef<number | null>(null);
	const trickle = useRef<ReturnType<typeof setInterval> | null>(null);
	const hold = useRef<ReturnType<typeof setTimeout> | null>(null);

	const stopClocks = useCallback(() => {
		if (trickle.current !== null) clearInterval(trickle.current);
		if (hold.current !== null) clearTimeout(hold.current);
		trickle.current = null;
		hold.current = null;
	}, []);

	useEffect(() => stopClocks, [stopClocks]);

	const reset = useCallback(() => {
		generation.current += 1;
		stopClocks();
		busy.current = false;
		stampRef.current = null;
		setPhase("compose");
		setPercent(0);
		setStage("");
		setError(null);
		setSubmittedAt(null);
	}, [stopClocks]);

	const send = useCallback(
		async (draft: FeedbackDraft) => {
			if (busy.current) return;
			busy.current = true;

			generation.current += 1;
			const run = generation.current;
			const copy = { ...DEFAULT_COPY, ...optionsRef.current.copy };

			// Held across attempts: a retry must reach the server with the
			// original stamp or it files a second row.
			const stamp = stampRef.current ?? Date.now();
			stampRef.current = stamp;
			setSubmittedAt(stamp);

			setError(null);
			setPhase("sending");
			setStage(copy.collectingLabel);
			setPercent(START_PERCENT);

			stopClocks();
			const ownTrickle = setInterval(() => {
				if (generation.current !== run) return;
				setPercent((p) => toward(p, TRICKLE_FRACTION));
			}, TRICKLE_INTERVAL_MS);
			trickle.current = ownTrickle;

			/**
			 * Settle once. This run's own trickle is always cleared, whoever it
			 * belongs to now; everything else happens only while this run is still
			 * the current one. `false` means the run was superseded — by a reset or
			 * a later send — and the caller must touch no state at all, or a send
			 * the reporter walked away from redraws the dialog over the report they
			 * are writing now.
			 */
			const finish = (): boolean => {
				clearInterval(ownTrickle);
				if (trickle.current === ownTrickle) trickle.current = null;
				if (generation.current !== run) return false;
				generation.current += 1;
				stopClocks();
				return true;
			};

			try {
				const collect = optionsRef.current.collectContext;
				const contextJson = collect ? await collect() : null;
				if (generation.current === run) setStage(copy.progressLabel);

				await optionsRef.current.onSubmit(
					{ ...draft, contextJson, submittedAt: stamp },
					(label) => {
						if (generation.current !== run) return;
						setStage(label);
						setPercent((p) => toward(p, STAGE_FRACTION));
					},
				);

				if (!finish()) return;
				setPercent(100);
				hold.current = setTimeout(() => {
					busy.current = false;
					setPhase("sent");
				}, COMPLETE_HOLD_MS);
			} catch (reason) {
				if (!finish()) return;
				busy.current = false;
				setPercent(0);
				setStage("");
				setPhase("compose");
				setError(messageFor(reason, copy.errorFallback));
			}
		},
		[stopClocks],
	);

	return { phase, percent, stage, error, submittedAt, send, reset };
}

// ── The dialog ───────────────────────────────────────────────────────────────

/**
 * The strings FeedbackCopy does not carry: accessible names for the two form
 * controls, the screenshot row's controls, and the two ways a capture can
 * fail. They sit here rather than in FeedbackCopy because they describe *this
 * markup* — rearrange the markup and some of them stop applying. Translate
 * them in place.
 */
const LABELS = {
	kindGroup: "Feedback type",
	message: "Feedback message",
	capturing: "Capturing…",
	retake: "Retake screenshot",
	discard: "Discard screenshot",
	attached: (size: string) => `Screenshot attached (${size})`,
	tooLarge: (size: string, limit: string) =>
		`That capture came to ${size} — the limit is ${limit}.`,
	captureFailed: "The page wouldn't render to an image. Send the words anyway.",
};

/**
 * Cap an attachment rather than let it fail the whole report.
 *
 * The rule: pick the largest raw PNG whose *encoded* size still clears
 * whatever your transport accepts, then set this below it. Encodings inflate —
 * base64 by about a third — and the manifest rides in the same request, so the
 * raw ceiling is meaningfully lower than the request limit. 10 MiB suits a
 * 16 MiB base64 request cap; retune it against your own server the moment you
 * know that number, because the failure it prevents is a report the reporter
 * already wrote being rejected whole.
 */
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

/**
 * Both stops substitute the bare custom property rather than a resolved color,
 * which is what makes the ring *travel* between kinds: var() is re-resolved on
 * every frame of the registered property's transition, while a literal color —
 * or a color-mix() wrapping the var — would only repaint once it landed.
 */
const ACCENT_GRADIENT =
	"linear-gradient(135deg, var(--lc-accent), var(--lc-accent))";

/**
 * The radius the bloom punches out of itself, which has to match the dialog's
 * own corners or the glow's corners drift away from the card's. DialogContent
 * rounds with `rounded-4xl`, so this reads that same theme token; the literal
 * fallback is its value under the default scale, for a theme that has no such
 * token. Restyle the dialog's rounding and change this in the same edit.
 */
const FRAME_RADIUS = "var(--radius-4xl, 1.625rem)";

/** Bytes as a short human string, for the attachment row and the size error. */
function formatSize(bytes: number): string {
	return bytes >= 1024 * 1024
		? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
		: `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Every class hook the dialog exposes, one per structural node. */
export type FeedbackButtonClassNames = {
	/**
	 * The floating trigger button — and the button shell a non-element `trigger`
	 * (a bare string, say) gets wrapped in. Ignored when `trigger` is an element,
	 * which keeps its own classes.
	 */
	trigger?: string;
	/** The dialog popup. Same target as the top-level `className`. */
	content?: string;
	/** The header block wrapping title and description. */
	header?: string;
	/** The dialog title, in both phases. */
	title?: string;
	/** The dialog description, in both phases. */
	description?: string;
	/** The kind toggle group. */
	kinds?: string;
	/** The message field. */
	textarea?: string;
	/** The capture control, and the attachment row that replaces it. */
	capture?: string;
	/** The inline error line. */
	error?: string;
	/** The progress bar shown while sending. */
	progress?: string;
	/** The receipt line in the footer. */
	receipt?: string;
	/** The footer row holding the receipt and the actions. */
	footer?: string;
	/** The sent phase's body. */
	sent?: string;
};

/** Props for {@link FeedbackButton}. */
export type FeedbackButtonProps = {
	/**
	 * Deliver the assembled report. The only required prop: everything else has
	 * a default. Rejecting returns the dialog to compose with the rejection's
	 * message shown; resolving lands it in the sent phase. Call the supplied
	 * `progress` as the transport learns something — a send that never calls it
	 * still animates.
	 */
	onSubmit: (report: FeedbackReport, progress: ProgressFn) => Promise<void>;
	/**
	 * Gather the diagnostic manifest that rides along, already serialized and
	 * scrubbed. Runs at the head of every attempt, so it describes the browser
	 * at send time. Omit and `report.contextJson` is null — this component
	 * deliberately depends on no diagnostics collector, so what a report carries
	 * is entirely yours to decide here.
	 */
	collectContext?: SendPipelineOptions["collectContext"];
	/**
	 * Capture the page automatically when the dialog opens, so the reporter has
	 * an attachment without asking for one. Failures are silent — see the note
	 * on the capture routine.
	 * @default false
	 */
	autoCapture?: boolean;
	/**
	 * The kinds offered in the toggle, each with its own accent and
	 * placeholder. Exactly one kind hides the toggle entirely and files every
	 * report under it.
	 * @default DEFAULT_KINDS
	 */
	kinds?: readonly FeedbackKind[];
	/**
	 * Copy overrides, merged over DEFAULT_COPY key by key, so supplying one
	 * string leaves the rest alone. `title` takes any node, so the heading can
	 * lead with a glyph; `receipt` may be a function returning a node, evaluated
	 * at render, so the line can name live values and style them unevenly — omit
	 * it and the footer has no receipt line at all. `triggerLabel` gives the
	 * floating button wording of its own, and falls back to `title`.
	 */
	copy?: Partial<FeedbackCopy>;
	/**
	 * Replaces the glyph in the default trigger. Ignored when `trigger` is
	 * supplied, since that replaces the whole button.
	 */
	icon?: ReactNode;
	/**
	 * Replaces the default floating button entirely. The open handler is wired
	 * onto whatever element you pass — keep your own `onClick` if you have one,
	 * it runs first, and calling `preventDefault()` in it suppresses the open.
	 */
	trigger?: ReactNode;
	/** Extra classes for the dialog popup. */
	className?: string;
	/** Extra classes for individual nodes; see {@link FeedbackButtonClassNames}. */
	classNames?: FeedbackButtonClassNames;
};

/** A trigger element we are allowed to wire an open handler onto. */
type TriggerProps = {
	onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
	"data-slot"?: string;
};

/**
 * Attach `open` to the consumer's trigger, preserving its own handler. A
 * trigger that is not an element (a bare string, say) has nothing to attach
 * to, so it gets wrapped in the default button shell instead.
 */
function withOpenHandler(
	trigger: ReactNode,
	open: () => void,
	className?: string,
): ReactNode {
	if (!isValidElement(trigger)) {
		return (
			<Button
				data-slot="feedback-trigger"
				type="button"
				onClick={open}
				className={className}
			>
				{trigger}
			</Button>
		);
	}

	const element = trigger as ReactElement<TriggerProps>;
	return cloneElement(element, {
		"data-slot": "feedback-trigger",
		onClick: (event: ReactMouseEvent<HTMLElement>) => {
			element.props.onClick?.(event);
			if (!event.defaultPrevented) open();
		},
	});
}

/** Props for {@link ComposeView}. */
export type ComposeViewProps = {
	/** Fully merged copy — every key present. */
	copy: FeedbackCopy;
	/** The kinds to offer; one or fewer renders no toggle. */
	kinds: readonly FeedbackKind[];
	/** The kind currently selected. */
	kind: FeedbackKind;
	/** Select a kind by value. */
	onKindChange: (value: string) => void;
	/** The prose written so far. */
	message: string;
	/** Replace the prose. */
	onMessageChange: (value: string) => void;
	/** The attached PNG bytes, or null when nothing is attached. */
	screenshot: Uint8Array | null;
	/** A blob URL for the thumbnail, or null when one cannot be made. */
	screenshotUrl: string | null;
	/** True while a capture is in flight. */
	capturing: boolean;
	/** Take (or retake) a capture. */
	onCapture: () => void;
	/** Drop the attachment. */
	onDiscard: () => void;
	/** The one error line to show, or null. */
	error: string | null;
	/** True during a send: inputs lock and the progress bar appears. */
	sending: boolean;
	/** Bar fill, 0–100. */
	percent: number;
	/** Current stage label. */
	stage: string;
	/** Start the send. */
	onSend: () => void;
	/** Class hooks, passed straight through. */
	classNames: FeedbackButtonClassNames;
};

/**
 * The form half of the dialog: kind, message, attachment, and the footer that
 * carries the receipt, the actions, and — mid-send — the progress bar.
 *
 * This stays mounted for the whole send rather than being swapped for a
 * spinner, so the reporter's words are still on screen if the send fails and
 * they are dropped back here to retry.
 */
export function ComposeView({
	copy,
	kinds,
	kind,
	onKindChange,
	message,
	onMessageChange,
	screenshot,
	screenshotUrl,
	capturing,
	onCapture,
	onDiscard,
	error,
	sending,
	percent,
	stage,
	onSend,
	classNames,
}: ComposeViewProps) {
	const receipt =
		typeof copy.receipt === "function" ? copy.receipt() : copy.receipt;

	return (
		<div className="grid gap-4">
			<DialogHeader className={cn("gap-2", classNames.header)}>
				<DialogTitle className={cn("text-xl", classNames.title)}>
					{copy.title}
				</DialogTitle>
				<DialogDescription
					className={cn("text-pretty", classNames.description)}
				>
					{copy.description}
				</DialogDescription>
			</DialogHeader>

			{/* One kind is not a choice: file everything under it and spend the
			    row on the message instead. */}
			{kinds.length > 1 && (
				<ToggleGroup
					data-slot="feedback-kinds"
					value={[kind.value]}
					onValueChange={(value) => {
						// Pressing the active item clears the group; a report always has
						// a kind, so an empty selection keeps the current one.
						const next = value[0];
						if (next !== undefined) onKindChange(next);
					}}
					variant="outline"
					spacing={0}
					disabled={sending}
					aria-label={LABELS.kindGroup}
					className={classNames.kinds}
				>
					{kinds.map((option) => (
						<ToggleGroupItem key={option.value} value={option.value}>
							{option.label}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			)}

			<Textarea
				data-slot="feedback-textarea"
				value={message}
				onChange={(event) => onMessageChange(event.target.value)}
				disabled={sending}
				// Base UI has already trapped focus inside the popup; this only
				// decides which control in it starts with the focus, and the dialog
				// exists to be typed into.
				autoFocus
				aria-label={LABELS.message}
				placeholder={kind.placeholder}
				className={cn("min-h-28 leading-relaxed", classNames.textarea)}
			/>

			{/* Live, because the capture is asynchronous and its outcome — a
			    thumbnail appearing — is otherwise silent. */}
			<div
				data-slot="feedback-capture"
				aria-live="polite"
				className={classNames.capture}
			>
				{screenshot === null ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="gap-2 text-muted-foreground"
						onClick={onCapture}
						disabled={capturing || sending}
					>
						<Camera className="size-4" />
						{capturing ? LABELS.capturing : copy.captureLabel}
					</Button>
				) : (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						{screenshotUrl !== null && (
							// Decorative: the row already names what was caught and how
							// big it is, which is all a screen reader can use.
							<img
								src={screenshotUrl}
								alt=""
								className="h-10 w-16 shrink-0 rounded-md border object-cover"
							/>
						)}
						<span className="truncate">
							{LABELS.attached(formatSize(screenshot.length))}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={LABELS.retake}
							onClick={onCapture}
							disabled={capturing || sending}
						>
							<RefreshCw className="size-4" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={LABELS.discard}
							onClick={onDiscard}
							disabled={sending}
						>
							<X className="size-4" />
						</Button>
					</div>
				)}
			</div>

			{/* An alert rather than a status: every error here is the direct
			    result of something the reporter just did. */}
			{error !== null && (
				<p
					data-slot="feedback-error"
					role="alert"
					className={cn("text-sm text-destructive", classNames.error)}
				>
					{error}
				</p>
			)}

			<div
				data-slot="feedback-footer"
				className={cn("grid gap-3 border-t pt-4", classNames.footer)}
			>
				{sending && (
					<FeedbackProgress
						percent={percent}
						stage={stage}
						className={classNames.progress}
					/>
				)}
				{/* The receipt sits opposite the actions rather than stacked above
				    them, so the footer reads as one seated row; with no receipt the
				    actions keep the right edge on their own. */}
				<div
					className={cn(
						"flex flex-wrap items-center gap-3",
						receipt === undefined ? "justify-end" : "justify-between",
					)}
				>
					{receipt !== undefined && (
						<p
							data-slot="feedback-receipt"
							className={cn(
								"text-xs text-muted-foreground",
								classNames.receipt,
							)}
						>
							{receipt}
						</p>
					)}
					<div className="flex gap-2">
						{/* Live during a send, like Escape and the overlay: a dialog that
						    cannot be dismissed traps the reporter behind a transport
						    that may never answer, and the request is already gone — the
						    pipeline simply ignores whatever it settles into, and
						    `submittedAt` collapses a resend onto the same row. */}
						<DialogClose render={<Button type="button" variant="outline" />}>
							{copy.cancelLabel}
						</DialogClose>
						<Button
							type="button"
							onClick={onSend}
							disabled={sending || message.trim() === ""}
						>
							{copy.sendLabel}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}

/** Props for {@link SentView}. */
export type SentViewProps = {
	/** Fully merged copy — every key present. */
	copy: FeedbackCopy;
	/** The glyph, shown large and in the current accent. */
	icon: ReactNode;
	/** Class hooks, passed straight through. */
	classNames: FeedbackButtonClassNames;
};

/** The confirmation: the report is filed and there is one way out. */
export function SentView({ copy, icon, classNames }: SentViewProps) {
	return (
		<div
			data-slot="feedback-sent"
			className={cn("grid gap-4 py-2 text-center", classNames.sent)}
		>
			<DialogHeader className={cn("gap-2", classNames.header)}>
				<span
					aria-hidden="true"
					className="text-4xl leading-none select-none"
					style={{ color: "var(--lc-accent)" }}
				>
					{icon}
				</span>
				<DialogTitle className={cn("text-xl", classNames.title)}>
					{copy.sentTitle}
				</DialogTitle>
				<DialogDescription className={classNames.description}>
					{copy.sentDescription}
				</DialogDescription>
			</DialogHeader>
			<DialogClose render={<Button type="button" />}>
				{copy.doneLabel}
			</DialogClose>
		</div>
	);
}

/**
 * A floating button that opens a feedback dialog: pick a kind, write, attach
 * the page as a screenshot, send.
 *
 * ```tsx
 * <FeedbackButton
 *   collectContext={() => JSON.stringify(scrub(collectContext()))}
 *   onSubmit={async (report, progress) => {
 *     progress("Uploading…");
 *     await api.submitReport(report);
 *   }}
 * />
 * ```
 *
 * Mount it once, near the root — it positions itself and portals its dialog.
 */
export function FeedbackButton({
	onSubmit,
	collectContext,
	autoCapture = false,
	kinds = DEFAULT_KINDS,
	copy: copyOverrides,
	icon = "✦",
	trigger,
	className,
	classNames = {},
}: FeedbackButtonProps) {
	const copy = { ...DEFAULT_COPY, ...copyOverrides };
	// An empty list would leave the dialog with nothing to file under, so it
	// falls back rather than rendering a form that cannot produce a report.
	const options = kinds.length > 0 ? kinds : DEFAULT_KINDS;

	const [open, setOpen] = useState(false);
	const [type, setType] = useState(options[0].value);
	const [message, setMessage] = useState("");
	const [screenshot, setScreenshot] = useState<Uint8Array | null>(null);
	const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
	const [capturing, setCapturing] = useState(false);
	// An auto-capture waiting for the dialog to finish opening. A ref, not state:
	// nothing renders from it, and it is read inside a Base UI callback.
	const armed = useRef(false);
	const [captureError, setCaptureError] = useState<string | null>(null);

	const pipeline = useSendPipeline({ onSubmit, collectContext, copy });

	const kind = options.find((option) => option.value === type) ?? options[0];

	// The preview is a blob URL that has to be released, so it is derived here
	// rather than built inline. Absent createObjectURL — a non-browser render
	// target — the attachment row simply has no thumbnail.
	useEffect(() => {
		if (screenshot === null || typeof URL.createObjectURL !== "function") {
			setScreenshotUrl(null);
			return;
		}
		// The cast is the DOM lib's SharedArrayBuffer caveat, not a real
		// mismatch: captureViewport only ever returns a plain, non-shared view.
		const url = URL.createObjectURL(
			new Blob([screenshot as BlobPart], { type: "image/png" }),
		);
		setScreenshotUrl(url);
		return () => {
			URL.revokeObjectURL(url);
		};
	}, [screenshot]);

	/**
	 * Attach the page behind the dialog.
	 *
	 * `silent` is the whole difference between the two ways this is reached, and
	 * the asymmetry is deliberate. A manual capture is something the reporter
	 * asked for and is waiting on, so a failure has to be said out loud. An
	 * automatic one they never asked for; an error about it would be the first
	 * thing they read in a dialog they opened to write a sentence, about a
	 * nicety, when the manual button sitting right there is the retry. So the
	 * automatic path swallows both failure modes — a render that throws and a
	 * capture over the size cap — and leaves the form as if it had never run.
	 */
	const capture = useCallback(async (silent: boolean) => {
		if (!silent) setCaptureError(null);
		setCapturing(true);
		try {
			const bytes = await captureViewport();
			if (bytes.length > MAX_SCREENSHOT_BYTES) {
				if (!silent) {
					setCaptureError(
						LABELS.tooLarge(
							formatSize(bytes.length),
							formatSize(MAX_SCREENSHOT_BYTES),
						),
					);
				}
				return;
			}
			setScreenshot(bytes);
		} catch {
			if (!silent) setCaptureError(LABELS.captureFailed);
		} finally {
			setCapturing(false);
		}
	}, []);

	/** Open onto an empty form; the next send stamps a fresh report. */
	function launch() {
		pipeline.reset();
		setType(options[0].value);
		setMessage("");
		setScreenshot(null);
		setCapturing(false);
		setCaptureError(null);
		setOpen(true);
		// Armed here, fired from onOpenChangeComplete once the dialog has finished
		// animating open. The clone blocks the main thread for as long as it runs,
		// so starting it in this tick freezes the dialog's own enter animation and
		// the open reads as a stall — deferring by a frame is not enough, because
		// the animation spans many. `capturing` is still set synchronously, so the
		// footer reads as pending from the first frame rather than flashing the
		// attach button and swapping.
		if (autoCapture) {
			armed.current = true;
			setCapturing(true);
		}
	}

	/**
	 * Run the armed auto-capture, now that nothing is animating for it to block.
	 *
	 * `afterPaint` buys one more frame so the animation's last frame is on screen
	 * before the main thread goes away, and — the reason it is a raced timeout
	 * rather than a bare rAF — settles even if the tab is hidden by now, which
	 * would otherwise pause frame callbacks and strand the capture forever.
	 */
	function onOpenComplete(isOpen: boolean) {
		if (!isOpen || !armed.current) return;
		armed.current = false;
		void afterPaint().then(() => capture(true));
	}

	function send() {
		setCaptureError(null);
		void pipeline.send({ type, message, screenshotPng: screenshot });
	}

	const sending = pipeline.phase === "sending";

	return (
		<>
			{trigger === undefined ? (
				<Button
					data-slot="feedback-trigger"
					type="button"
					variant="outline"
					size="lg"
					onClick={launch}
					className={cn(
						"fixed bottom-4 left-4 z-40 gap-2 bg-background shadow-lg",
						classNames.trigger,
					)}
				>
					<span
						aria-hidden="true"
						className="text-base leading-none select-none"
					>
						{icon}
					</span>
					{/* The button's whole accessible name: the glyph beside it is
					    aria-hidden, so nothing else contributes. Falls back to the
					    dialog heading, which is right whenever the two match. */}
					{copy.triggerLabel ?? copy.title}
				</Button>
			) : (
				withOpenHandler(trigger, launch, classNames.trigger)
			)}

			<Dialog
				open={open}
				onOpenChange={setOpen}
				onOpenChangeComplete={onOpenComplete}
			>
				<DialogContent
					data-slot="feedback-content"
					// Keeps this dialog out of its own screenshot; see
					// lib/feedback/capture.
					data-capture-hide=""
					className={cn(
						"lc-accent-frame lc-accent-shift gap-0 sm:max-w-md",
						className,
						classNames.content,
					)}
					style={
						{
							...(kind.accent === undefined
								? null
								: { "--lc-accent": kind.accent }),
							"--lc-accent-gradient": ACCENT_GRADIENT,
							"--lc-frame-radius": FRAME_RADIUS,
						} as CSSProperties
					}
				>
					{pipeline.phase === "sent" ? (
						<SentView copy={copy} icon={icon} classNames={classNames} />
					) : (
						<ComposeView
							copy={copy}
							kinds={options}
							kind={kind}
							onKindChange={setType}
							message={message}
							onMessageChange={setMessage}
							screenshot={screenshot}
							screenshotUrl={screenshotUrl}
							capturing={capturing}
							onCapture={() => void capture(false)}
							onDiscard={() => setScreenshot(null)}
							error={captureError ?? pipeline.error}
							sending={sending}
							percent={pipeline.percent}
							stage={pipeline.stage}
							onSend={send}
							classNames={classNames}
						/>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
