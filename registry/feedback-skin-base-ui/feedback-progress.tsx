import { cn } from "@/lib/utils";

// The progress readout for an in-flight report: a 2px accent bar plus the
// stage label under it.
//
// This is the piece most likely to be restyled or thrown out — it is pure
// presentation, and every product has its own idea of what a progress
// indicator looks like. Swap it freely, but a replacement has to keep three
// things or the flow regresses:
//
//   1. The props below (`percent` 0–100 and `stage`), which are exactly what
//      useSendPipeline returns — nothing here computes or times anything.
//   2. The ARIA progressbar semantics and the polite live region. An animated
//      bare <div> is invisible to a screen reader, and a send can take long
//      enough that silence reads as a hang.
//   3. `data-slot="feedback-progress"`, which is the handle a consumer's own
//      stylesheet targets from outside.
//
// Expected to change: the bar's thickness, radius, track color, and the
// label's typography.
//
// Not expected to change: the fill's color. It substitutes the bare
// `var(--lc-accent)`, which is what lets the bar travel with the dialog's
// accent when the reporter switches kind — a literal color, or a color-mix()
// wrapped around that var, resolves once and would cut instead of tweening.

/** Props for {@link FeedbackProgress}. */
export type FeedbackProgressProps = {
	/** Bar fill, 0–100. */
	percent: number;
	/** Current stage label, rendered beneath the bar. */
	stage: string;
	/** Accessible name for the bar itself. */
	label?: string;
	/** Extra classes for the wrapper. */
	className?: string;
};

/**
 * Render a send's progress: a hairline bar filled to `percent` in the current
 * `--lc-accent`, with `stage` announced politely below it.
 *
 * Keep this mounted for the whole `sending` phase rather than remounting it
 * per stage — a live region that appears at the same moment its text does may
 * not be announced at all.
 */
export function FeedbackProgress({
	percent,
	stage,
	label = "Sending feedback",
	className,
}: FeedbackProgressProps) {
	const value = Math.min(100, Math.max(0, Math.round(percent)));

	return (
		<div
			data-slot="feedback-progress"
			className={cn("grid w-full gap-2", className)}
		>
			<div
				role="progressbar"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={value}
				// The stage names what the percentage means; without it a screen
				// reader announces a bare number.
				aria-valuetext={stage === "" ? undefined : `${value}% — ${stage}`}
				className="h-0.5 w-full overflow-hidden rounded-full bg-border"
			>
				{/* motion-reduce drops the tween rather than the movement: the width
				    still updates, it just arrives instead of sliding. */}
				<div
					className="h-full transition-[width] duration-200 ease-out motion-reduce:transition-none"
					style={{ width: `${value}%`, backgroundColor: "var(--lc-accent)" }}
				/>
			</div>
			{/* Not aria-hidden even though the bar carries the same text in
			    aria-valuetext: valuetext is announced on focus, this region is
			    announced on change, and a send the user is not focused on still
			    needs to speak. */}
			<p
				aria-live="polite"
				className="min-h-4 text-xs leading-4 text-muted-foreground"
			>
				{stage}
			</p>
		</div>
	);
}
