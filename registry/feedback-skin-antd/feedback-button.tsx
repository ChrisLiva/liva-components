import {
	CameraOutlined,
	CloseOutlined,
	ReloadOutlined,
} from "@ant-design/icons";
import { Button, Input, Modal, Progress, Segmented } from "antd";
import {
	cloneElement,
	isValidElement,
	type ReactElement,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
} from "react";

import {
	type FeedbackCopy,
	type FeedbackKind,
	type FeedbackReport,
	formatSize,
	type ProgressFn,
	type UseFeedbackOptions,
	useFeedback,
} from "@/lib/feedback/use-feedback";

// The antd skin of the feedback flow: a single file that binds the headless
// core (`@/lib/feedback/use-feedback`) to native antd primitives — Modal,
// Segmented, Input.TextArea, Progress, and @ant-design/icons — with no
// Tailwind, no `lc-` accent CSS, and no lucide. `kind.accent` is ignored; antd
// paints from its own theme. Every string comes from `fb.copy`, and the
// behaviour contract is identical to the base-ui skin (see skin-contract.md and
// skin-conformance.test.tsx).
//
// Vendor this and edit it. Deep styling is antd theming (ConfigProvider /
// theme tokens), not a classNames map — that is why this skin takes `className`
// but no per-node class hooks.
//
// Not expected to change without care: `data-capture-hide` on the modal
// content (via modalRender). That marker is how lib/feedback/capture leaves
// this dialog out of its own screenshot; drop it and every capture is a picture
// of the feedback form.

export type {
	FeedbackCopy,
	FeedbackKind,
	FeedbackReport,
	ProgressFn,
} from "@/lib/feedback/use-feedback";

/** Props for {@link FeedbackButton} (antd skin). */
export type FeedbackButtonProps = {
	/**
	 * Deliver the assembled report. The only required prop. Rejecting returns
	 * the dialog to compose with the rejection's message shown; resolving lands
	 * it in the sent phase.
	 */
	onSubmit: (report: FeedbackReport, progress: ProgressFn) => Promise<void>;
	/** Gather the diagnostic manifest that rides along; omit to send none. */
	collectContext?: UseFeedbackOptions["collectContext"];
	/**
	 * Capture the page automatically when the dialog opens. Failures are silent.
	 * @default false
	 */
	autoCapture?: boolean;
	/**
	 * The kinds offered in the picker. Exactly one hides the picker and files
	 * every report under it.
	 * @default DEFAULT_KINDS
	 */
	kinds?: readonly FeedbackKind[];
	/** Copy overrides, merged over DEFAULT_COPY key by key. */
	copy?: Partial<FeedbackCopy>;
	/** Replaces the glyph in the default trigger. Ignored when `trigger` is set. */
	icon?: ReactNode;
	/**
	 * Replaces the default floating button entirely. The open handler is wired
	 * onto whatever element you pass — your own `onClick` runs first, and
	 * `preventDefault()` in it suppresses the open.
	 */
	trigger?: ReactNode;
	/** Extra class for the trigger button. */
	className?: string;
};

/** A trigger element we are allowed to wire an open handler onto. */
type TriggerProps = {
	onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
};

/**
 * Attach `open` to the consumer's trigger, preserving its own handler. A
 * trigger that is not an element (a bare string, say) is wrapped in an antd
 * Button instead.
 */
function withOpenHandler(
	trigger: ReactNode,
	open: () => void,
	className?: string,
): ReactNode {
	if (!isValidElement(trigger)) {
		return (
			<Button htmlType="button" onClick={open} className={className}>
				{trigger}
			</Button>
		);
	}

	const element = trigger as ReactElement<TriggerProps>;
	return cloneElement(element, {
		onClick: (event: ReactMouseEvent<HTMLElement>) => {
			element.props.onClick?.(event);
			if (!event.defaultPrevented) open();
		},
	});
}

/**
 * A floating button that opens a native antd feedback dialog: pick a kind,
 * write, attach the page as a screenshot, send.
 *
 * ```tsx
 * <FeedbackButton
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
}: FeedbackButtonProps) {
	const fb = useFeedback({
		onSubmit,
		collectContext,
		autoCapture,
		kinds,
		copy: copyOverrides,
	});

	// Evaluated at render, so a function receipt can name live values; undefined
	// drops the line entirely.
	const receipt =
		typeof fb.copy.receipt === "function" ? fb.copy.receipt() : fb.copy.receipt;

	return (
		<>
			{trigger === undefined ? (
				<Button
					size="large"
					onClick={fb.launch}
					className={className}
					style={{ position: "fixed", bottom: 16, left: 16, zIndex: 40 }}
				>
					{/* The glyph is decorative, so the button's accessible name is the
					    label alone — the same contract the base-ui trigger keeps. */}
					<span aria-hidden="true">{icon}</span>
					{fb.copy.triggerLabel ?? fb.copy.title}
				</Button>
			) : (
				withOpenHandler(trigger, fb.launch, className)
			)}

			<Modal
				open={fb.open}
				onCancel={() => fb.setOpen(false)}
				afterOpenChange={fb.notifyOpenComplete}
				footer={null}
				title={fb.phase === "sent" ? fb.copy.sentTitle : fb.copy.title}
				// Keeps this dialog out of its own screenshot; see lib/feedback/capture.
				modalRender={(node) => <div data-capture-hide="">{node}</div>}
			>
				{fb.phase === "sent" ? (
					<div style={{ display: "grid", gap: 16, paddingTop: 8 }}>
						<p>{fb.copy.sentDescription}</p>
						<div style={{ display: "flex", justifyContent: "flex-end" }}>
							<Button type="primary" onClick={() => fb.setOpen(false)}>
								{fb.copy.doneLabel}
							</Button>
						</div>
					</div>
				) : (
					<div style={{ display: "grid", gap: 16, paddingTop: 8 }}>
						<p>{fb.copy.description}</p>

						{/* One kind is not a choice: file everything under it and spend
						    the space on the message instead. */}
						{fb.kinds.length > 1 && (
							<Segmented
								block
								aria-label={fb.copy.kindGroupLabel}
								value={fb.kind.value}
								onChange={(value) => fb.setKind(String(value))}
								disabled={fb.sending}
								options={fb.kinds.map((option) => ({
									label: option.label,
									value: option.value,
								}))}
							/>
						)}

						<Input.TextArea
							value={fb.message}
							onChange={(event) => fb.setMessage(event.target.value)}
							disabled={fb.sending}
							autoFocus
							aria-label={fb.copy.messageLabel}
							placeholder={fb.kind.placeholder}
							autoSize={{ minRows: 4, maxRows: 8 }}
						/>

						{/* Live, because the capture is asynchronous and its outcome — a
						    thumbnail appearing — is otherwise silent. */}
						<div aria-live="polite">
							{fb.screenshot === null ? (
								<Button
									// The glyph is decorative; antd icons carry their own
									// aria-label, so hide it or it joins the button's name.
									icon={<CameraOutlined aria-hidden />}
									onClick={fb.capture}
									disabled={fb.capturing || fb.sending}
								>
									{fb.capturing ? fb.copy.capturingLabel : fb.copy.captureLabel}
								</Button>
							) : (
								<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
									{fb.screenshotUrl !== null && (
										// Decorative: the row already names what was caught and
										// how big it is, which is all a screen reader can use.
										<img
											src={fb.screenshotUrl}
											alt=""
											style={{
												width: 64,
												height: 40,
												objectFit: "cover",
												borderRadius: 6,
												border: "1px solid rgba(0,0,0,0.1)",
											}}
										/>
									)}
									<span style={{ flex: 1 }}>
										{fb.copy.attached(formatSize(fb.screenshot.length))}
									</span>
									<Button
										icon={<ReloadOutlined aria-hidden />}
										aria-label={fb.copy.retakeLabel}
										onClick={fb.capture}
										disabled={fb.capturing || fb.sending}
									/>
									<Button
										icon={<CloseOutlined aria-hidden />}
										aria-label={fb.copy.discardLabel}
										onClick={fb.discardScreenshot}
										disabled={fb.sending}
									/>
								</div>
							)}
						</div>

						{/* An alert rather than a status: every error here is the direct
						    result of something the reporter just did. */}
						{fb.error !== null && (
							<p role="alert" style={{ color: "#ff4d4f", margin: 0 }}>
								{fb.error}
							</p>
						)}

						{fb.sending && (
							<div>
								<Progress percent={Math.round(fb.percent)} showInfo={false} />
								{/* Announced on change, so a send the reporter is not
								    watching still speaks. */}
								<p aria-live="polite" style={{ margin: 0, minHeight: 20 }}>
									{fb.stage}
								</p>
							</div>
						)}

						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 12,
								justifyContent:
									receipt === undefined ? "flex-end" : "space-between",
							}}
						>
							{receipt !== undefined && (
								<span style={{ fontSize: 12, opacity: 0.65 }}>{receipt}</span>
							)}
							<div style={{ display: "flex", gap: 8 }}>
								<Button onClick={() => fb.setOpen(false)}>
									{fb.copy.cancelLabel}
								</Button>
								<Button
									type="primary"
									onClick={fb.send}
									disabled={fb.sending || fb.message.trim() === ""}
								>
									{fb.copy.sendLabel}
								</Button>
							</div>
						</div>
					</div>
				)}
			</Modal>
		</>
	);
}
