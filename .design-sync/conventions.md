# AZITO Design System — how to build with it

AZITO is a **dark-only developer-tool UI** (a browser-based tmux/agent manager).
Components are React, imported from `window.Azito.*` (e.g. `window.Azito.Button`).

## Surface & setup (no provider needed)
There is no theme provider or React context to wrap — components read no context.
What they DO assume is the **dark token surface**: render every screen on
`background: var(--bg)` with `color: var(--text)`. On a white/default background
the light text is invisible. There is no light mode.

```jsx
<div style={{ background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh' }}>
  {/* screen content */}
</div>
```

## Styling idiom: CSS-variable tokens + inline styles (+ a small utility vocabulary)
No Tailwind, no CSS-in-JS. Components style themselves with inline styles that
reference tokens; do the same for your layout glue.

**Color tokens** (the only colors to use — never hardcode hex):
`--bg` (app background) · `--bg-card` (raised panels) · `--bg-elevated` /
`--bg-solid` (always-opaque floating UI: menus, modals, dropdowns — never
`--bg-card` for those) · `--bg-hover` · `--border` · `--overlay` (modal scrim) ·
`--text` · `--text-dim` (secondary/labels) · `--accent` (blue, primary action) ·
`--green` `--red` `--orange` `--purple` (semantic/status). Each accent/status
color also has alpha steps `-a08` (tint bg), `-a15` (stronger tint), `-a35`
(tinted border) — e.g. `var(--green-a08)` bg + `var(--green-a35)` border +
`var(--green)` text is the standard chip/badge recipe.

**Scale tokens**: spacing `--space-1..6` (4px grid) · radius `--radius-sm/md/lg/full`
· font sizes `--font-xs/sm/md/base/lg/xl` (11–18px).

**Utility classes** (defined in the bound `styles.css`, use verbatim):
`.btn` + `.btn-primary` `.btn-danger` `.btn-ghost` `.btn-sm` (buttons — or use the
`Button` component) · `.data-table` (dense tables) · `.row-hover` `.row-selected`
(interactive rows) · `.toggle` `.toggle-slider` (switch) · `.kbd-key` (keyboard
hints) · `.log-entry` · `.kanban-card`.

## Where the truth lives
Read the bound **`styles.css`** (and its `@import`s — all tokens and utility
classes above) before styling, and each component's **`<Name>.d.ts`** (props
contract) + **`<Name>.prompt.md`** (usage) under `components/<group>/<Name>/`.

## Components: composition patterns
Prefer components over hand-rolled markup: `Button`, `IconButton`, `Chip`
(pill meta / statuses, tones `default|accent|green|orange|red|purple`), `Badge`
(square-ish refs, tones `neutral|accent|green|orange|purple|red`), `StatusBadge`
(task status string → toned chip), `StatusDot`, `ListRow`/`ListRowGroup` (settings
& list screens), `Modal` (+`ConfirmDialog`), `ContextMenu`, `TabBar`/`MiniTabBar`,
`FormField`+`FormInput`/`FormSelect`/`FormTextarea`, `SectionHeader` (uppercase
group label), `EmptyState`/`LoadingState`/`Spinner`, `PhaseProgressBar` (task
phase pipeline), `MarkdownRenderer` (inject its `mdStyles` export as a `<style>`
so `.md-content` rules apply), `PixelIcon` (pixel-art icon set), `AzitoLogo`.

## One idiomatic example
```jsx
const { SectionHeader, ListRow, ListRowGroup, Chip, Button, StatusDot } = window.Azito;

<div style={{ background: 'var(--bg)', color: 'var(--text)', padding: 'var(--space-6)', minHeight: '100vh' }}>
  <SectionHeader>Projects</SectionHeader>
  <ListRowGroup>
    <ListRow
      icon={<StatusDot status="busy" />}
      title="azito-agent-base"
      description="Browser-based tmux session manager"
      chips={<Chip tone="green">3 tasks</Chip>}
      onClick={() => {}}
    />
  </ListRowGroup>
  <div style={{ marginTop: 'var(--space-4)', display: 'flex', gap: 'var(--space-2)' }}>
    <Button variant="primary">New task</Button>
    <Button variant="ghost">View logs</Button>
  </div>
</div>
```
