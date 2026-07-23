# liva-components

A component registry: `shadcn`-style items published for reuse across other
projects, developed locally against vendored primitives.

The feedback flow is a **headless core plus per-design-system skins**. One hook,
`useFeedback`, owns all the logic (dialog state, the compose draft, the capture
flow, the staged send). Two skins bind it to a design system:

- **`feedback-base-ui`** — the Base UI / shadcn look, with an accent system and
  per-node class hooks.
- **`feedback-antd`** — the native antd look, no Tailwind required.

Each is one installable item that **bundles its skin, the core, and the lib
helpers** (`screenshot-capture`, `diagnostics`, `scrub`). There are **no
`registryDependencies`**, so `shadcn add` never writes into your
`components/ui/` or flattens a primitive you customized. Tests never ship.

Pick one skin. Both install to the same path, so your app imports
`@/components/feedback/feedback-button` regardless of which you chose.

## Install

There is no hosted registry and nothing is published to npm. A consumer installs
from a local clone by pointing `shadcn add` at the built JSON in `public/r/`,
which is committed.

### `feedback-base-ui`

**Prerequisites.** The Base UI skin composes four shadcn primitives —
`button`, `dialog`, `textarea`, `toggle-group` — and they are **not** installed
for you (that is the whole point: your customized primitives stay untouched).
Install any you are missing, on a **Base UI style**, and you own that decision:

```bash
npx shadcn@latest add button dialog textarea toggle-group
```

Then add the component:

```bash
npx shadcn@latest add /absolute/path/to/liva-components/public/r/feedback-base-ui.json
```

`lucide-react` and `modern-screenshot` are installed automatically, and the
`lc-` accent CSS is written into your global stylesheet.

> **Base UI, not Radix.** The skin uses Base UI primitives (the `render` prop on
> `DialogClose`, a multi-value `ToggleGroup`). On a Radix-style install it
> reports no error at install time, then fails typecheck and throws
> `Missing prop 'type' expected on 'ToggleGroup'` at runtime when the dialog
> opens — with no error boundary, React 19 unmounts the whole root and the page
> goes blank. Stay on Base UI (`-b base`). For a `shadcn init` that can't drift:
>
> ```bash
> npx shadcn@latest init -b base -p luma
> ```
>
> The preset flag is `luma`, **not** `base-luma` — the `-b base -p luma` pair is
> what yields `"style": "base-luma"` in the generated `components.json`.

### `feedback-antd`

The antd skin needs no Tailwind and no shadcn primitives — `antd`,
`@ant-design/icons`, and `modern-screenshot` are installed automatically.

```bash
npx shadcn@latest add /absolute/path/to/liva-components/public/r/feedback-antd.json
```

A non-Tailwind project still needs a `components.json` so `shadcn add` knows
where to place files. The minimal recipe:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-luma",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "", "css": "src/styles.css", "baseColor": "stone", "cssVariables": false, "prefix": "" },
  "iconLibrary": "lucide",
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks" }
}
```

The `tailwind.css` path only has to exist; the antd skin writes no CSS to it.

### What lands where

`target` paths are written against the `@components/` and `@lib/` alias
placeholders, so they follow whatever `components.json` says — including a
`src/` directory.

| Item | Files | Lands at |
| --- | --- | --- |
| `feedback-base-ui` | `feedback-button.tsx`, `feedback-progress.tsx` | `<components>/feedback/` |
| | `use-feedback.ts`, `feedback-defaults.ts`, `capture.ts`, `diagnostics.ts`, `scrub.ts` | `<lib>/feedback/` |
| `feedback-antd` | `feedback-button.tsx` | `<components>/feedback/` |
| | `use-feedback.ts`, `feedback-defaults.ts`, `capture.ts`, `diagnostics.ts`, `scrub.ts` | `<lib>/feedback/` |

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
carries is decided in consumer wiring, by composing `collectContext` out of the
bundled `diagnostics` and `scrub` helpers:

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
    receipt: () => `carries ${eventCount()} events`,
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
/>;
```

- `collectContext` runs at the head of every attempt, including a retry, so the
  manifest describes the browser at send time. Scrub before returning.
- `progress(label)` moves the bar toward its ceiling and swaps the stage label.
  A send that never calls it still animates.
- `report.submittedAt` is stamped once per dialog open and survives a retry, so
  a server keying on `(user, submittedAt)` collapses a resend onto one row.
- `autoCapture` takes the screenshot when the dialog opens; failures are silent.

Three `copy` fields take more than a string, because the markup they land in is
the consumer's: `copy.title` is a `ReactNode` (a decorative glyph inside it must
be `aria-hidden`, since the dialog is named from the title), `copy.triggerLabel`
is the trigger's whole accessible name, and `copy.receipt` is a string or a
function returning a `ReactNode` evaluated at render (returning `undefined`
drops the line). Every other field is a plain string.

`installDiagnostics()` from `@/lib/feedback/diagnostics` belongs in boot code —
it patches console and window error hooks so the ring buffer is full by the time
a report is filed.

### base-ui styling hooks

Every node the Base UI skin owns carries a `data-slot`
(`feedback-trigger`, `feedback-content`, `feedback-kinds`, `feedback-textarea`,
`feedback-capture`, `feedback-error`, `feedback-progress`, `feedback-footer`,
`feedback-receipt`, `feedback-sent`), and `classNames` restyles individual
nodes. The antd skin uses antd theming instead of class hooks. `data-capture-hide`
on the dialog surface is how `capture.ts` leaves the dialog out of its own
screenshot.

## Adding a skin

To port the flow to another design system (Material UI, Mantine, …), see
[`AGENTS.md`](./AGENTS.md) for the recipe and
[`registry/feedback-core/skin-contract.md`](./registry/feedback-core/skin-contract.md)
for the full wiring, visual-state, primitive, and accessibility contract. The
executable half is `registry/skin-conformance.test.tsx` — register your skin in
its `SKINS` array and the suite holds it to the same behaviour as the two that
ship.

## Development

### Layout

```
components/ui/                     vendored primitives (dev-only — never shipped)
lib/                                shared dev-only helpers (cn, etc.)
registry/feedback-core/             the headless hook, defaults, skin contract
registry/feedback-skin-base-ui/     the Base UI skin
registry/feedback-skin-antd/        the antd skin
registry/screenshot-capture|diagnostics|scrub/   bundled lib helpers
registry/skin-conformance.test.tsx  the cross-skin behaviour suite
public/r/                           `shadcn build` output — the committed distributable
```

### `@/` alias scheme

`tsconfig.json` (mirrored in `vitest.config.ts` via `resolve.tsconfigPaths`)
resolves `@/*` two ways: a repo-root fallback for the vendored dev primitives,
plus overrides that map each registry source to **the exact specifier a consumer
will use after `shadcn add`** drops it at `components/feedback/` or
`lib/feedback/`.

```jsonc
"paths": {
  "@/components/feedback/*":        ["./registry/feedback-skin-base-ui/*"],
  "@/lib/feedback/use-feedback":    ["./registry/feedback-core/use-feedback"],
  "@/lib/feedback/feedback-defaults": ["./registry/feedback-core/feedback-defaults"],
  "@/lib/feedback/capture":         ["./registry/screenshot-capture/capture"],
  "@/lib/feedback/diagnostics":     ["./registry/diagnostics/diagnostics"],
  "@/lib/feedback/scrub":           ["./registry/scrub/scrub"],
  "@/*": ["./*"]
}
```

The lib entries are **exact, non-wildcard** mappings, and that is load-bearing:
the authoring path and the vendored path must be the same string, so no import
needs rewriting on the way out of the registry. The antd skin is imported into
the conformance suite by a relative path, since both skins claim the same
`@/components/feedback/*` alias.

### A registry item's preamble goes below the imports

`shadcn add` drops every leading comment before a file's first statement. A
comment placed after the last import survives, so each source's header note sits
immediately below its import block. Verify empirically after adding an item:
install it into a throwaway consumer and confirm the header text is present.

### The `lc-` CSS lives in two places

`styles.css` carries the `lc-` accent block for the dev app; `registry.json`
carries the same CSS in `feedback-base-ui`'s `css` field, which is what a
consumer gets on `shadcn add`. Edit the two together — `styles-sync.test.ts`
parses the block out of the stylesheet and fails on any drift.

### Commands

```bash
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run
pnpm lint             # biome check .
pnpm format           # biome format --write .
pnpm build:registry   # shadcn build → public/r/*.json (commit the output)
pnpm storybook        # both skins render here
```
