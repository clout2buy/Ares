# The `ares` TUI — architecture

The chat screen is a **fixed-height stack of pre-built rows**. That one decision is
what makes it render the same on macOS Terminal, iTerm, Windows Terminal, legacy
conhost, and a 256-color Linux box — and what makes it impossible to overflow.

## Why it was rebuilt

The previous face handed Ink a tree of wrapping `<Text>` nodes and decided what
fit by counting *messages*. A long markdown reply was one "line" that rendered
forty rows; the frame overflowed the terminal, Yoga clipped rows at random, the
header and toolbar vanished, and Ink fell back to a full-screen clear on every
frame (the flicker). It also painted every cell with near-identical dark hex
backgrounds — mud on 256-color terminals, a slab on light ones — and put emoji in
the chrome, whose width differs by terminal, which is what pushed rows past the
frame width in the first place.

## Rows, not boxes

```
packages/cli/src/ui/
  term.ts        capability probe (color tier, unicode/ascii) + the two glyph sets
  theme.ts       macOS system palette (truecolor) + its 16-color twin
  rows.ts        Span/Row model, wrapSpans, truncateSpans, justify, shed,
                 flattenTranscript (LogLine[] → exact-width rows)
  layout.ts      the frame budget: fixed chrome heights → transcript rows
  RowText.ts     the ONE Ink adapter: one <Text> per row, truncated + padded
  themes.ts      the TUI faces (midnight · graphite · daylight · ocean · rose ·
                 forest), each with a truecolor + 16-color palette
  launcher.ts    launcherRows(): provider / model / theme / workspace pickers as
                 row stacks — no splash, the first frame is the picker
  chat/
    header.ts    2 rows   wordmark · model chip · workspace · branch · mode
    activity.ts  0-3 rows thinking / current tool / fleet tree
    bottom.ts    status (1) · composer (3) · toolbar (1) · todo (1) · permission (4)
    palette.ts   0-10 rows command palette
    overlay.ts   Models / Effort / Settings — full-frame row stacks
    ChatMain.ts  chatMainRows(): composes everything into exactly `height` rows
```

Every builder is a pure function `(props) → Row[]` where `Row = Span[]` and
`Span = { text, color?, bold?, dim?, italic?, inverse?, underline? }`. `RowsView`
paints them. Nothing else in the chat screen touches Ink layout.

**Frame geometry.** The frame is `columns - 1` wide and `rows - 1` tall. One
column short so the last cell never triggers pending-wrap scrolling (conhost and
Terminal.app both do it); one row short so Ink never enters its overflow path.
`inkTui.ts` enters the alternate screen itself (`?1049h`, clear, home) before
Ink renders, so the frame is **top-anchored**: app row === terminal row, which is
what every mouse hit-test assumes.

**The budget** (`layout.ts`): header 2 · activity 0–3 · transcript N · todo 0–1 ·
palette 0–10 · permission 0–4 · status 1 · composer 3 · toolbar 1. Optional
strips squeeze before the transcript starves (minimum 3 rows). Below 50×14 the
screen draws a resize notice instead of chrome.

**Scrolling** is measured in rendered rows. `chatMainRows()` returns `maxScroll`
and the host clamps to it.

**Geometry contracts with `tuiChrome.ts`** (the pure hit-test module):

| surface | contract |
| --- | --- |
| toolbar | last row; labels verbatim from `TOOLBAR_ITEMS` at col 2, separator 3 cells |
| model chip | row 1, `" ARES  {model} ⌄"` → `slateModelSpan()` |
| permission | 4 rows directly above status → buttons on row `H-6`, content from col 3 |
| overlays | row 1 title · row 2 tabs · row 3 hint · rows 4… one item per row · footer last |
| effort | pills on row 4 (`EFFORT_PILL_ROW`); `effortPillIndexAt(x)` maps a click to a level |
| launcher lists | items one per row from `LIST_FIRST_ROW` (7); click row → `y - LIST_FIRST_ROW` |

## Terminal capabilities

`probeTerminal()` (pure; pinned in `tests/tui/term.test.mjs`) decides once:

- **color tier** — truecolor for Windows Terminal / VS Code / iTerm / kitty /
  WezTerm / Ghostty / `COLORTERM=truecolor`; 256 for macOS Terminal.app and
  `xterm-256color`; 16 for `TERM=linux`; none for no-TTY or `NO_COLOR`.
  The palette (`themeFor(level)`) switches to **named ANSI colors** below 256
  so chalk never quantizes hex into mud.
- **glyphs** — unicode unless the console is legacy conhost, `TERM=linux`, or the
  locale isn't UTF-8. Every glyph in both sets is single-cell; there is no emoji
  anywhere in the chrome. Toolbar labels are plain words so hit-test widths
  agree on every terminal.

Overrides: `ARES_TUI_COLOR=16|256|true`, `ARES_TUI_ASCII=1`. Other knobs:
`ARES_NO_MOTION=1` (static, no spinners), `ARES_NO_MOUSE=1`, `ARES_NO_INTRO=1`.
The old `ARES_TUI=classic` fire theme is gone.

## Themes and effort

The TUI face is a theme id persisted as `tuiTheme` in `~/.ares` settings and
resolved to a palette at the terminal's color tier (`resolveTheme`). It applies
live: the launcher's theme phase previews as you move, and the chat's Themes
overlay (or the Appearance tab) switches every screen on the spot. `/theme` is a
different thing — it colors plain, non-TUI printing only.

Effort is a segmented control over the seven `SLIDER_LEVELS`. Picking a level
calls the host's `/reasoning` handler directly (`applyEffort` in `inkTui.ts`) —
not through the composer's submit path, which refused while busy and printed
the command as a fake user turn. The dial seeds itself from the host's reply on
first open; `parseReasoningLevel` knows all seven levels.

## Rendering

`render()` runs with `alternateScreen: true`, `incrementalRendering: true`
(line-diff redraws), and `maxFps: 20`. One animation clock: 100 ms while a turn
is busy (spinners, elapsed readouts, wordmark sweep), 500 ms idle (cursor blink
only), none without motion.

## Verifying without a terminal

Ink needs a raw-mode TTY, so the visuals are verified in the harness:

```bash
pnpm --filter @ares/cli test:tui
```

`tests/tui/frame.test.mjs` is the regression class that matters: exact height and
width at seven sizes in both glyph sets, plus a 60-iteration fuzz over random
content. `rows.test.mjs`, `chrome.test.mjs`, `overlay.test.mjs`, `term.test.mjs`
pin the builders and the probe. A frame that is one row too tall fails the suite.
