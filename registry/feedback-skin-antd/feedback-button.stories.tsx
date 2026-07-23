// Living docs for the antd skin, and the one place its native look is seen
// rather than asserted about — the Modal chrome, the Segmented picker, the
// Progress bar, and antd's own motion only exist in a real browser. The unit
// tests run in jsdom, which has no antd animation, so auto-capture-on-open
// (which rides antd's afterOpenChange) is only ever verified here.

import type { Meta, StoryObj } from "@storybook/react-vite";

import type { FeedbackReport, ProgressFn } from "@/lib/feedback/use-feedback";
import { FeedbackButton, type FeedbackButtonProps } from "./feedback-button";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const meta = {
	title: "Feedback/FeedbackButton (antd)",
	component: FeedbackButton,
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FeedbackButton>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The whole antd skin with one prop and nothing else — the acceptance check
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

/** Extra knobs the playground adds on top of the skin's own props. */
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
		copy: { control: "object" },
		icon: { control: "text" },
		autoCapture: { control: "boolean" },
		onSubmit: { table: { disable: true } },
	},
	render: ({ fail, stageMs, onSubmit: _onSubmit, ...rest }) => (
		<div className="grid min-h-svh place-items-center p-8">
			<p style={{ maxWidth: "24rem", textAlign: "center" }}>
				Open the dialog, type something, and send. The transport below announces
				three stages before it settles.
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
	),
};

/**
 * `autoCapture` against a page worth photographing. Open the dialog and the
 * thumbnail in the attachment row should be a legible picture of the content
 * behind it — the dialog itself excluded, per `data-capture-hide`. This is the
 * path jsdom can't run, since it rides antd's `afterOpenChange`.
 */
export const AutoCapture: Story = {
	args: {
		autoCapture: true,
		onSubmit: async () => {
			await wait(800);
		},
	},
	render: (args) => (
		<div style={{ minHeight: "100svh", padding: "2.5rem" }}>
			<div
				style={{
					maxWidth: "48rem",
					margin: "0 auto",
					display: "grid",
					gap: "1.5rem",
				}}
			>
				<h1 style={{ fontSize: "2.25rem", fontWeight: 600 }}>
					Something to photograph
				</h1>
				<p>
					The capture rasterizes the viewport minus the feedback dialog, so this
					block is what should turn up in the attachment thumbnail.
				</p>
			</div>
			<FeedbackButton {...args} />
		</div>
	),
};
