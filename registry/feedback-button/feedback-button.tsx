import { Camera, RefreshCw, X } from "lucide-react";
import {
	type CSSProperties,
	cloneElement,
	isValidElement,
	type ReactElement,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
} from "react";

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
import {
	type FeedbackCopy,
	type FeedbackKind,
	type FeedbackReport,
	formatSize,
	type ProgressFn,
	type UseFeedbackOptions,
	useFeedback,
} from "@/lib/feedback/use-feedback";
import { cn } from "@/lib/utils";

// The base-ui skin of the feedback flow: a floating trigger, a compose form, a
// send with a progress bar, and a confirmation. All logic lives in the core
// hook (`@/lib/feedback/use-feedback`); this file is markup and the base-ui/
// shadcn primitives it binds to. Its sibling `feedback-progress` is the bar.
//
// Vendor this and edit it. There is no slot system and no render props on
// purpose: the two views are named components below (ComposeView, SentView),
// and rearranging one is a matter of moving JSX rather than learning an API.
//
// Expected to change: the two views' layout, the default trigger (a plain
// floating button — replace it wholesale with the `trigger` prop or rewrite it
// here). All copy, including the strings this file reads off `fb.copy`, is
// customized through the `copy` prop and DEFAULT_COPY in the core.
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

export type {
	FeedbackCopy,
	FeedbackKind,
	FeedbackReport,
	ProgressFn,
} from "@/lib/feedback/use-feedback";

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
	collectContext?: UseFeedbackOptions["collectContext"];
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
					aria-label={copy.kindGroupLabel}
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
				aria-label={copy.messageLabel}
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
						{capturing ? copy.capturingLabel : copy.captureLabel}
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
							{copy.attached(formatSize(screenshot.length))}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={copy.retakeLabel}
							onClick={onCapture}
							disabled={capturing || sending}
						>
							<RefreshCw className="size-4" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={copy.discardLabel}
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
	kinds,
	copy: copyOverrides,
	icon = "✦",
	trigger,
	className,
	classNames = {},
}: FeedbackButtonProps) {
	const fb = useFeedback({
		onSubmit,
		collectContext,
		autoCapture,
		kinds,
		copy: copyOverrides,
	});

	return (
		<>
			{trigger === undefined ? (
				<Button
					data-slot="feedback-trigger"
					type="button"
					variant="outline"
					size="lg"
					onClick={fb.launch}
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
					{fb.copy.triggerLabel ?? fb.copy.title}
				</Button>
			) : (
				withOpenHandler(trigger, fb.launch, classNames.trigger)
			)}

			<Dialog
				open={fb.open}
				onOpenChange={fb.setOpen}
				onOpenChangeComplete={fb.notifyOpenComplete}
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
							...(fb.kind.accent === undefined
								? null
								: { "--lc-accent": fb.kind.accent }),
							"--lc-accent-gradient": ACCENT_GRADIENT,
							"--lc-frame-radius": FRAME_RADIUS,
						} as CSSProperties
					}
				>
					{fb.phase === "sent" ? (
						<SentView copy={fb.copy} icon={icon} classNames={classNames} />
					) : (
						<ComposeView
							copy={fb.copy}
							kinds={fb.kinds}
							kind={fb.kind}
							onKindChange={fb.setKind}
							message={fb.message}
							onMessageChange={fb.setMessage}
							screenshot={fb.screenshot}
							screenshotUrl={fb.screenshotUrl}
							capturing={fb.capturing}
							onCapture={fb.capture}
							onDiscard={fb.discardScreenshot}
							error={fb.error}
							sending={fb.sending}
							percent={fb.percent}
							stage={fb.stage}
							onSend={fb.send}
							classNames={classNames}
						/>
					)}
				</DialogContent>
			</Dialog>
		</>
	);
}
