// Living docs for the feedback dialog, and the one place its CSS is looked at
// rather than asserted about. The unit tests run in jsdom, which has no layout,
// no filters and no masks — the accent ring, the bloom, the accent transition
// and the progress bar only exist in a real browser, so they are only ever
// verified here.
//
// Each story is a scenario, not a prop dump: Minimal is the acceptance check
// that one prop is genuinely enough, Playground exercises the send pipeline's
// staged progress and its failure path, AutoCapture puts real page content
// behind the dialog so the thumbnail has something to be a picture of,
// Diagnostics wires the manifest end to end, and RichCopy is where the copy
// fields that take more than a string are looked at.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";

import {
	FeedbackButton,
	type FeedbackButtonProps,
	type ProgressFn,
} from "@/components/feedback/feedback-button";
import {
	DEFAULT_KINDS,
	type FeedbackReport,
} from "@/components/feedback/feedback-defaults";
import { Button } from "@/components/ui/button";
import {
	collectContext,
	eventCount,
	installDiagnostics,
	record,
} from "@/lib/feedback/diagnostics";
import { scrub } from "@/lib/feedback/scrub";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const meta = {
	title: "Feedback/FeedbackButton",
	component: FeedbackButton,
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FeedbackButton>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The whole component with one prop and nothing else — the acceptance check
 * that minimal wiring really is `onSubmit` alone. Sending resolves after a
 * beat, so the bar animates and the sent phase is reachable.
 */
export const Minimal: Story = {
	args: {
		onSubmit: async () => {
			await wait(1200);
		},
	},
	render: (args) => <FeedbackButton onSubmit={args.onSubmit} />,
};

/** Extra knobs the playground adds on top of the component's own props. */
type PlaygroundArgs = {
	/** Reject the send instead of resolving, to see the error path and retry. */
	fail: boolean;
	/** How long each staged step of the fake transport takes. */
	stageMs: number;
};

/**
 * Everything wired: a fake transport that reports three named stages before it
 * settles, and a `fail` toggle that rejects instead — the bar drains, the
 * message lands under the form, and Send becomes a retry that keeps the
 * original `submittedAt`.
 */
export const Playground: StoryObj<PlaygroundArgs & FeedbackButtonProps> = {
	args: {
		fail: false,
		stageMs: 900,
		onSubmit: async () => {},
	},
	argTypes: {
		fail: { control: "boolean", name: "onSubmit rejects" },
		stageMs: { control: { type: "range", min: 200, max: 3000, step: 100 } },
		kinds: { control: "object" },
		copy: { control: "object" },
		icon: { control: "text" },
		autoCapture: { control: "boolean" },
		onSubmit: { table: { disable: true } },
	},
	render: ({ fail, stageMs, onSubmit: _onSubmit, ...rest }) => {
		return (
			<div className="grid min-h-svh place-items-center p-8">
				<p className="max-w-sm text-center text-sm text-muted-foreground">
					Open the dialog, type something, and send. The transport below
					announces three stages before it settles.
				</p>
				<FeedbackButton
					{...rest}
					onSubmit={async (_report: FeedbackReport, progress: ProgressFn) => {
						progress("Uploading screenshot…");
						await wait(stageMs);
						progress("Filing report…");
						await wait(stageMs);
						progress("Notifying the team…");
						await wait(stageMs);
						if (fail) throw new Error("The report server refused the upload.");
					}}
				/>
			</div>
		);
	},
};

/**
 * `autoCapture` against a page worth photographing. Open the dialog and the
 * thumbnail in the attachment row should be a legible picture of the content
 * behind it — the dialog itself excluded, per `data-capture-hide`.
 */
export const AutoCapture: Story = {
	args: {
		autoCapture: true,
		onSubmit: async () => {
			await wait(800);
		},
	},
	render: (args) => (
		<div className="min-h-svh bg-background p-10">
			<div className="mx-auto grid max-w-3xl gap-6">
				<h1 className="font-heading text-4xl font-semibold tracking-tight">
					Something to photograph
				</h1>
				<p className="text-muted-foreground leading-relaxed">
					The capture rasterizes the viewport minus the feedback dialog, so this
					block is what should turn up in the attachment thumbnail.
				</p>
				<div className="grid grid-cols-3 gap-4">
					{["Ochre", "Verdigris", "Cobalt"].map((name, index) => (
						<div key={name} className="grid gap-2 rounded-2xl border p-4">
							<span
								className="h-10 rounded-lg"
								style={{
									background: `oklch(0.62 0.17 ${35 + index * 105})`,
								}}
							/>
							<span className="text-sm font-medium">{name}</span>
							<span className="text-xs text-muted-foreground">
								Swatch {index + 1} of 3
							</span>
						</div>
					))}
				</div>
			</div>
			<FeedbackButton {...args} />
		</div>
	),
};

/**
 * The three copy fields that take more than a string, in one dialog: a
 * `triggerLabel` that differs from the heading ("Feedback" on the button,
 * "Send Word" over the form), a `title` node leading with an accent-colored
 * glyph, and a `receipt` function returning markup so the label is small-caps
 * while the hex build SHA beside it is not — small-caps renders `a531918` at
 * three different cap heights, which is the whole reason the seam exists.
 *
 * What to check in the browser: the glyph takes the kind's accent and re-tempers
 * with it, the trigger reads "✦ Feedback" (its accessible name is "Feedback" —
 * the glyph is aria-hidden), and the dialog's accessible name is "Send Word".
 */
export const RichCopy: Story = {
	args: {
		onSubmit: async () => {
			await wait(900);
		},
	},
	render: (args) => (
		<FeedbackButton
			onSubmit={args.onSubmit}
			copy={{
				triggerLabel: "Feedback",
				title: (
					<>
						<span
							aria-hidden="true"
							className="mr-1.5 select-none"
							style={{ color: "var(--lc-accent)" }}
						>
							✦
						</span>
						Send Word
					</>
				),
				// This repo ships no theme, so the small-caps run is written as an
				// arbitrary property rather than leaning on a utility a consumer's
				// stylesheet may or may not define.
				receipt: () => (
					<>
						<span className="tracking-wide [font-variant-caps:small-caps]">
							Carries
						</span>{" "}
						12 events · build a531918
					</>
				),
			}}
		/>
	),
};

/**
 * The diagnostics item, exercised in a browser: the buttons feed the ring
 * buffer, the panel shows the manifest that `collectContext` would attach, and
 * the receipt line under the form counts the same events.
 */
export const Diagnostics: Story = {
	args: {
		onSubmit: async () => {
			await wait(900);
		},
	},
	render: (args) => <DiagnosticsDemo onSubmit={args.onSubmit} />,
};

function DiagnosticsDemo({ onSubmit }: Pick<FeedbackButtonProps, "onSubmit">) {
	const [manifest, setManifest] = useState("");
	const [count, setCount] = useState(0);

	useEffect(() => {
		installDiagnostics();
		setCount(eventCount());
	}, []);

	const refresh = () => {
		setManifest(
			JSON.stringify(scrub(collectContext({ story: "Diagnostics" })), null, 2),
		);
		setCount(eventCount());
	};

	return (
		<div className="min-h-svh bg-background p-10">
			<div className="mx-auto grid max-w-3xl gap-6">
				<div className="grid gap-2">
					<h1 className="font-heading text-4xl font-semibold tracking-tight">
						Diagnostics manifest
					</h1>
					<p className="text-muted-foreground leading-relaxed">
						Fire some events, then refresh the manifest. The buffer holds the
						last 50; the same collector is wired to the dialog below, so a sent
						report carries exactly this JSON.
					</p>
				</div>

				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							console.log("story: a routine log line", { attempt: count + 1 });
							refresh();
						}}
					>
						console.log
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							console.error("story: something went wrong");
							refresh();
						}}
					>
						console.error
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							// Thrown asynchronously so it reaches window.onerror rather than
							// React's error boundary, which is the path installDiagnostics
							// actually listens on.
							setTimeout(() => {
								throw new Error("story: uncaught from a timer");
							}, 0);
							setTimeout(refresh, 20);
						}}
					>
						throw (uncaught)
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							record("rpc-error", "story: ListSpells failed (fake)");
							refresh();
						}}
					>
						record(&quot;rpc-error&quot;)
					</Button>
					<Button type="button" variant="ghost" onClick={refresh}>
						Refresh manifest
					</Button>
				</div>

				<p className="text-sm text-muted-foreground">
					eventCount(): <strong className="text-foreground">{count}</strong>
				</p>

				<pre className="max-h-96 overflow-auto rounded-2xl border bg-muted/40 p-4 text-xs leading-relaxed">
					{manifest === "" ? "Fire an event, or refresh." : manifest}
				</pre>
			</div>

			<FeedbackButton
				onSubmit={onSubmit}
				collectContext={() =>
					JSON.stringify(scrub(collectContext({ story: "Diagnostics" })))
				}
				kinds={DEFAULT_KINDS}
				copy={{ receipt: () => `carries ${eventCount()} events` }}
			/>
		</div>
	);
}
