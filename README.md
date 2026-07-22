# liva-components

A component registry: `shadcn`-style items published for reuse across other
projects, developed locally against vendored shadcn primitives.

The four registry items today: `feedback-button` (a component), and
`screenshot-capture` / `diagnostics` / `scrub` (lib-shaped items that pair
with it).

## Install

**Requirements:** these items compose Base UI primitives (the `render` prop
on `DialogClose`, a multi-value `ToggleGroup`) — the consumer's project must
be on a Base UI style, which is the shadcn CLI's default. Choosing Radix UI
at the CLI's "Select a component library" prompt produces an install that
reports no error at install time, then fails typecheck with 4 errors and
throws `Error: Missing prop 'type' expected on 'ToggleGroup'` at runtime when
the dialog opens — with no error boundary in place, React 19 unmounts the
whole root and the page goes blank. This is a documented non-goal, not a bug;
stay on Base UI (`-b base`).

There is no hosted registry and nothing is published to npm. A consumer
installs from a local clone by pointing `shadcn add` at the built JSON in
`public/r/`, which is committed:

```bash
npx shadcn@latest add \
  /absolute/path/to/liva-components/public/r/scrub.json \
  /absolute/path/to/liva-components/public/r/screenshot-capture.json \
  /absolute/path/to/liva-components/public/r/diagnostics.json \
  /absolute/path/to/liva-components/public/r/feedback-button.json
```

For a `shadcn init` that can't drift from the Base UI requirement, use the
explicit non-interactive form:

```bash
npx shadcn@latest init -b base -p luma <json paths…>
```

The preset flag is `luma`, **not** `base-luma` — `-p base-luma` is rejected
(valid presets: `nova`, `vega`, `maia`, `lyra`, `mira`, `luma`, `sera`,
`rhea`). The `-b base -p luma` pair is what yields `"style": "base-luma"` in
the generated `components.json`.

Name only the items you want. `feedback-button` needs `screenshot-capture`
alongside it — it imports `@/lib/feedback/capture` — so those two always
travel together:

```bash
npx shadcn@latest add \
  /absolute/path/to/liva-components/public/r/screenshot-capture.json \
  /absolute/path/to/liva-components/public/r/feedback-button.json
```

`diagnostics` and `scrub` are optional: the dialog runs without them, and
they only matter once you want a diagnostic manifest to ride along (see
[Advanced wiring](#advanced-wiring)).

Items must be listed explicitly because `registryDependencies` cannot express
a sibling in the same *local* registry. The shadcn CLI resolves a
`.json` registry dependency with `path.resolve()` against the **consumer's**
working directory, not against the file that declared it, so a relative
`./screenshot-capture.json` looks for the file inside the consumer's project
and fails; a bare `screenshot-capture` is looked up on `ui.shadcn.com` and
404s; and a `@namespace/item` entry requires an HTTP registry URL (`file://`
is not fetchable). Only the shadcn-hosted primitives — `button`, `dialog`,
`textarea`, `toggle-group` — are declared as `registryDependencies`, and the
CLI pulls those in automatically.

### What lands where

`target` paths are written against the `@components/` and `@lib/` alias
placeholders, so they follow whatever `components.json` says — including a
`src/` directory.

| Item | Files | Lands at |
| --- | --- | --- |
| `feedback-button` | `feedback-button.tsx`, `feedback-progress.tsx`, `feedback-defaults.ts`, `feedback-button.test.tsx`, `feedback-button.dialog.test.tsx` | `<components>/feedback/` |
| `screenshot-capture` | `capture.ts`, `capture.test.ts` | `<lib>/feedback/` |
| `diagnostics` | `diagnostics.ts`, `diagnostics.test.ts` | `<lib>/feedback/` |
| `scrub` | `scrub.ts`, `scrub.test.ts` | `<lib>/feedback/` |

Tests are vendored next to their implementation and import through the same
`@/lib/feedback/...` specifiers as the source, so they run under any consumer
with the standard shadcn `@/` alias.

The test files ship unconditionally — `shadcn add` has no way to make a file
conditional on a dev dependency being present. Until the consumer installs
`vitest`, `tsc` will report `Cannot find module 'vitest'` for each vendored
test file; `feedback-button`'s two also want `@testing-library/react`,
`@testing-library/user-event` and a `jsdom` environment.

`feedback-button` also carries a `css` field, so `shadcn add` writes the `lc-`
accent frame system — the `@property --lc-accent` registration, the
`lc-accent-frame` and `lc-accent-shift` utilities, and the `:root`
fallbacks — into the project's global stylesheet.

npm dependencies are installed by the CLI: `lucide-react` for
`feedback-button`, `modern-screenshot` for `screenshot-capture`.

### ⚠️ Installing overwrites the shadcn primitives

`feedback-button` declares `button`, `dialog`, `textarea` and `toggle-group`
as `registryDependencies`, and `toggle-group` drags `toggle` in behind it — so
`shadcn add` writes five files into `components/ui/` whether or not they are
already there. On a project that already has them, `--overwrite` replaces
each one with the upstream version and **silently discards any local
customization** — no prompt, no mention in the CLI's summary.

Review the diff to `components/ui/` after every install and restore what you
had. This has been hit for real: brew-pg's `button.tsx` carried custom
`default` and `link` variants (its theme defines no `--primary`, so the stock
variants render invisible text), and installing flattened them back to
upstream. The fix is a `git checkout` of the five files, which is only
available if the working tree was clean going in — so install onto a clean
tree.

## Use

One required prop:

```tsx
import { FeedbackButton } from "@/components/feedback/feedback-button";

<FeedbackButton
  onSubmit={async (report) => {
    await fetch("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ type: report.type, message: report.message }),
    });
  }}
/>;
```

## Advanced wiring

The dialog deliberately depends on no diagnostics collector. What a report
carries is decided in consumer wiring, by composing `collectContext` out of
the `diagnostics` and `scrub` items:

```tsx
import { FeedbackButton } from "@/components/feedback/feedback-button";
import { collectContext, eventCount } from "@/lib/feedback/diagnostics";
import { scrub } from "@/lib/feedback/scrub";

<FeedbackButton
  autoCapture
  collectContext={() =>
    JSON.stringify(scrub(collectContext({ build: __BUILD_SHA__ })))
  }
  copy={{
    triggerLabel: "Feedback",
    title: (
      <>
        <span aria-hidden="true" className="mr-1.5" style={{ color: "var(--lc-accent)" }}>
          ✦
        </span>
        Send Word
      </>
    ),
    receipt: () => (
      <>
        <span className="small-caps">Carries</span> {eventCount()} events · build{" "}
        {__BUILD_SHA__}
      </>
    ),
  }}
  onSubmit={async (report, progress) => {
    progress("Uploading screenshot…");
    const screenshotUrl = report.screenshotPng
      ? await uploadPng(report.screenshotPng)
      : null;

    progress("Filing report…");
    await client.createReport({
      type: report.type,
      message: report.message,
      contextJson: report.contextJson,
      submittedAt: report.submittedAt,
      screenshotUrl,
    });
  }}
  classNames={{
    trigger: "bottom-6 left-6",
    content: "max-w-lg",
    progress: "h-1",
  }}
/>;
```

- `collectContext` runs at the head of every attempt, including a retry, so
  the manifest describes the browser at send time. Scrub before returning —
  `collectContext` gathers, `scrub` sanitizes.
- `progress(label)` moves the bar toward its ceiling and swaps the stage
  label. A send that never calls it still animates.
- `report.submittedAt` is stamped once per dialog open and survives a retry,
  so a server keying on `(user, submittedAt)` collapses a resend onto one row.
- `autoCapture` takes the screenshot when the dialog opens; failures are
  silent.
- `classNames` restyles individual nodes; `className` is the dialog popup.

Three `copy` fields take more than a string, because the markup they land in
belongs to the consumer:

- `copy.title` is a `ReactNode`, so the heading can lead with an
  accent-colored glyph. Base UI names the dialog from this element via
  `aria-labelledby` and the name is computed from its rendered subtree, so a
  decorative glyph must carry `aria-hidden` — with it, the example above gives
  the dialog the accessible name `Send Word`, not `✦ Send Word`.
- `copy.triggerLabel` is the floating button's wording and its whole
  accessible name. Omit it and the trigger falls back to `copy.title`, which is
  right whenever the button and the heading say the same thing. It stays a
  plain string on purpose: an `aria-hidden` run inside a node would silently
  shorten the button's name.
- `copy.receipt` is a string, or a function returning a `ReactNode` evaluated
  at render. The node form is the seam for a line that is not uniformly
  styled — a small-caps label ahead of a hex build SHA that must not be, since
  small-caps renders `a531918` at three different cap heights. A function that
  returns `undefined` drops the receipt line entirely.

Every other field is a plain string and is meant to stay one: they land in
button labels and `aria-label`s, where a node buys nothing.

`installDiagnostics()` from `@/lib/feedback/diagnostics` belongs in boot code,
not here — it patches console and window error hooks so the ring buffer is
already full by the time a report is filed.

### Styling hooks

Every node the dialog owns carries a `data-slot`, so a consumer's own
stylesheet can target it from outside the vendored file:

`feedback-trigger`, `feedback-content`, `feedback-kinds`, `feedback-textarea`,
`feedback-capture`, `feedback-error`, `feedback-progress`, `feedback-footer`,
`feedback-receipt`, `feedback-sent`.

Two more markers are behavioral rather than decorative:
`data-capture-hide` on the dialog popup is how `capture.ts` leaves the
feedback dialog out of its own screenshot, and `--lc-frame-radius` must track
whatever `border-radius` the popup actually uses, or the accent bloom's
corners drift away from the card's.

## Development

### Layout

```
components/ui/    vendored shadcn primitives (dev-only — never shipped as registry items)
lib/               shared dev-only helpers (cn, etc.)
registry/<item>/   registry item sources — one directory per publishable item
public/r/          `shadcn build` output — the committed distributable
```

### `@/` alias scheme

`tsconfig.json` (mirrored in `vitest.config.ts` via `resolve.tsconfigPaths`)
resolves `@/*` two ways: a repo-root fallback for the vendored dev primitives,
plus overrides that map each registry item to **the exact specifier a consumer
will use after `shadcn add`** drops it at `components/feedback/` or
`lib/feedback/`.

```jsonc
"paths": {
  "@/components/feedback/*": ["./registry/feedback-button/*"],
  "@/lib/feedback/capture":      ["./registry/screenshot-capture/capture"],
  "@/lib/feedback/diagnostics":  ["./registry/diagnostics/diagnostics"],
  "@/lib/feedback/scrub":        ["./registry/scrub/scrub"],
  "@/*": ["./*"]
}
```

The generic `@/*` entry is what makes `@/components/ui/button` resolve to
`components/ui/button.tsx` and `@/lib/utils` resolve to `lib/utils.ts` — no
extra entries are needed for those, since they already sit at the repo root in
the conventional shadcn shape. The overrides exist because registry item
sources live under `registry/<item>/`, not under `components/feedback/` or
`lib/feedback/` directly.

The three lib entries are **exact, non-wildcard** mappings, and that is
load-bearing: the authoring path and the vendored path must be the same
string, so no import needs rewriting on the way out of the registry. A
`@/lib/feedback/scrub/*` style wildcard would introduce a path segment that
does not exist in a consumer, and every vendored import would break on
install. A new lib-shaped item gets one more exact entry in the same shape;
TypeScript prefers exact mappings over the generic pattern.

### A registry item's preamble goes below the imports

`shadcn add` drops every leading comment before a file's first statement —
`//`, `/* */`, and `/** */` alike. A comment placed after the first statement
(or after the last import, for a file with imports) survives. A new registry
item's customization-map header therefore has to sit immediately below its
import block, not above it — for a file with no imports, below its first
statement instead. Verify empirically after adding an item: install it into a
throwaway consumer and confirm the header text is actually present in the
installed file.

### The `lc-` CSS lives in two places

`styles.css` carries the `lc-` accent block for the dev app; `registry.json`
carries the same CSS in `feedback-button`'s `css` field, which is what a
consumer gets on `shadcn add`. Edit the two together — nothing checks that
they agree, and a drifted `css` field installs stale utilities.

### Commands

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm lint        # biome check .
pnpm format      # biome format --write .
pnpm build:registry  # shadcn build → public/r/*.json (commit the output)
```
