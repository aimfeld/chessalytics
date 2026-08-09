---
phase: 260809-jzz
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - frontend/src/lib/materialDiff.ts
  - frontend/src/lib/materialDiff.test.ts
  - frontend/src/components/board/MaterialDisplay.tsx
  - frontend/src/components/board/__tests__/MaterialDisplay.test.tsx
  - frontend/src/components/board/PlayerBar.tsx
  - frontend/src/pages/Analysis.tsx
  - frontend/src/components/bots/ClockDisplay.tsx
  - frontend/src/pages/Bots.tsx
autonomous: true
requirements: [QUICK-JZZ]

estimate:
  tokens: 55000
  raw_tokens: 55000
  tasks: 3
  confidence: low

must_haves:
  truths:
    - "On the Bots play page, after the user captures a queen for nothing, the user's clock row shows a queen icon and `+9`, and the bot's row shows no number (D-02, D-06)."
    - "The Bots material display updates on every move and tracks the viewed ply, not only the live ply (it is derived from the same FEN the board renders)."
    - "On the Analysis board in game mode, the White and Black PlayerBar rows show each side's net material surplus between the name and the clock (D-02, D-05)."
    - "On the Analysis board with a pasted PGN loaded, the same material rows render (D-02)."
    - "In Analysis free play (no fetched game, no pasted PGN) no material display renders at all (D-02)."
    - "An even trade (both sides lost a knight) shows nothing on either side; a mixed imbalance (White up a rook, Black up two pawns) shows a rook icon + `+3` on White and two pawn icons with no number on Black (D-06)."
    - "A promoted extra queen is counted per piece type, so White with two queens vs Black's one shows a queen surplus rather than a miscount (D-01)."
    - "Below the `sm` breakpoint only the `+N` number renders; the piece icons are hidden (D-04)."
    - "Repeated icons of the same piece type overlap slightly rather than sitting in a plain row (D-07)."
    - "A malformed FEN produces an empty material display instead of throwing and blanking the page."
  artifacts:
    - frontend/src/lib/materialDiff.ts
    - frontend/src/lib/materialDiff.test.ts
    - frontend/src/components/board/MaterialDisplay.tsx
    - frontend/src/components/board/__tests__/MaterialDisplay.test.tsx
  key_links:
    - "`Analysis.tsx`'s `playerBar()` helper passes the same `position` FEN that `ChessBoard` renders, so the material always matches the board."
    - "Every `playerBar(` call site in Analysis.tsx stays behind the existing `showPlayerBars` gate — that gate, not a new condition, is what keeps free play unchanged (D-02)."
    - "`Bots.tsx` passes `game.position` (the viewed-ply FEN, the same value handed to `ChessBoard`) plus the correct `side` to each of the two `ClockDisplay` instances."
    - "`MaterialDisplay` is the single renderer used by both `PlayerBar` and `ClockDisplay`; neither page re-implements the icon row."
---

<objective>
Add a lichess-style net material difference display to the Bots play page and the
Analysis board, computed client-side from the FEN currently on the board.

Purpose: the user can see at a glance who is up material and by how much, without
counting pieces, on both the live bot game and the analysis board.

Output: one pure computation module with unit tests, one shared presentational
component, and its integration into the two existing player rows.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE.md

@frontend/src/components/board/PlayerBar.tsx
@frontend/src/components/board/__tests__/PlayerBar.test.tsx
@frontend/src/components/bots/ClockDisplay.tsx
</context>

<locked_decisions>
These came out of a `/gsd-explore` discussion and are final. Do not revisit, do not
substitute a simpler alternative.

- **D-01 Semantics:** net material difference, lichess-style, computed client-side from
  the current position FEN via chess.js, comparing piece counts **per type** (so trades
  cancel out and promotions are handled without a special case).
- **D-02 Surfaces:** Bots play page (live, updates per move) and the Analysis board in
  game mode + pasted-PGN mode only (the PlayerBar rows). Analysis free play unchanged.
- **D-03 Icons:** `lucide-react`'s `ChessPawn` / `ChessKnight` / `ChessBishop` /
  `ChessRook` / `ChessQueen`. Verified present in the installed `lucide-react ^1.21.0`
  (`node_modules/lucide-react/dist/esm/icons/chess-*.mjs`). No new dependency — do not
  add one, do not hand-roll SVG glyphs.
- **D-04 Mobile:** balance number only (e.g. `+9`), no piece icons. Use Tailwind
  responsive classes (`hidden sm:flex` on the icon group).
- **D-05 Placement:** inside the existing rows — `PlayerBar.tsx` (Analysis, gated by
  `showPlayerBars`) and the Bots player/clock rows — between the name and the clock,
  left-aligned right after the name.
- **D-06:** each side shows the piece types it is up; the `+N` number appears **only**
  next to the side that is ahead on points. Standard values 1/3/3/5/9.
- **D-07:** icons of the same piece type overlap slightly via a negative margin,
  chess.com style.
- **D-08:** pure frontend change, no backend work. Vitest coverage for the
  material-diff computation is required.
</locked_decisions>

<tasks>

<task type="tracer" tdd="true">
  <name>Task 1: computeMaterialDiff — the pure per-type material computation</name>
  <files>frontend/src/lib/materialDiff.ts, frontend/src/lib/materialDiff.test.ts</files>
  <behavior>
    Write `frontend/src/lib/materialDiff.test.ts` FIRST, red, then implement. Cases:
    - Starting position: both sides have an empty surplus list and 0 points.
    - White up a queen (Black's queen removed): White surplus `[{ type: 'q', count: 1 }]`
      and 9 points; Black surplus empty and 0 points.
    - Even trade (each side missing one knight): both surplus lists empty, both 0 points.
    - Mixed imbalance — White up a rook, Black up two pawns: White surplus is the rook,
      White points 3; Black surplus is two pawns, Black points 0 (D-06: only the leading
      side carries a number).
    - Equal points, different pieces — White up a bishop, Black up three pawns: both
      surplus lists non-empty, both point totals 0.
    - Promotion — White has two queens, Black one: White carries a queen surplus of 1
      (per-type diff, D-01), points reflect the 9-point gap minus whatever Black is up.
    - Kings never appear in either surplus list, at any point total.
    - Surplus entries are ordered ascending by piece value: pawn, knight, bishop, rook,
      queen (lichess ordering, D-01).
    - A malformed FEN string returns the same zeroed structure as the starting position
      and does not throw.
  </behavior>
  <action>
    Create `frontend/src/lib/materialDiff.ts` with a module docstring naming this quick
    task and D-01/D-06.

    Export a piece-type union covering the five non-king types keyed by the chess.js
    single-letter codes, and the result shape: one entry per side, each carrying an
    ordered list of `{ type, count }` surplus entries plus a numeric point total.
    Export `computeMaterialDiff(fen: string)` returning that shape.

    Implementation: build the board with chess.js (`new Chess(fen)`), read `.board()`,
    tally counts per color per type, skipping kings. For each type compute
    `whiteCount - blackCount`; a positive delta becomes a White surplus entry, a negative
    delta a Black surplus entry, zero contributes nothing. Compute the signed net point
    total from a named `PIECE_VALUES` constant map (pawn 1, knight 3, bishop 3, rook 5,
    queen 9 — no bare numerals in the loop, per the project's no-magic-numbers rule) and
    assign it to White when positive, to Black when negative, leaving the other side at
    zero (D-06). Emit surplus entries in ascending piece-value order by iterating a named
    ordered type constant rather than object key order.

    `new Chess(fen)` throws on an unparseable FEN, and the Analysis board can be fed a
    user-pasted position, so wrap construction in try/catch and return the zeroed result
    on failure; add a short note at the catch site saying why it exists.

    Keep the module pure and React-free. Annotate every exported function's return type
    (project ty/tsc discipline).
  </action>
  <verify>
    <automated>(cd frontend && npm test -- --run src/lib/materialDiff.test.ts)</automated>
  </verify>
  <done>All the behavior cases above pass; the module has no React or DOM import.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: MaterialDisplay component + Analysis PlayerBar integration</name>
  <files>frontend/src/components/board/MaterialDisplay.tsx, frontend/src/components/board/__tests__/MaterialDisplay.test.tsx, frontend/src/components/board/PlayerBar.tsx, frontend/src/pages/Analysis.tsx</files>
  <behavior>
    `frontend/src/components/board/__tests__/MaterialDisplay.test.tsx` (jsdom, same
    header/`cleanup` pattern as the sibling `PlayerBar.test.tsx`):
    - Given a FEN where White is up a queen, the White instance renders the text `+9`
      and the Black instance renders no numeric text.
    - Given the starting position, both instances render no numeric text.
    - Given White up a rook and Black up two pawns, the White instance shows `+3` and
      the Black instance shows no number.
    - The icon group carries the `sm` responsive class pair so it is absent below the
      breakpoint (assert on the container's className), while the number is outside that
      group (D-04).
    - A malformed FEN renders an empty display without throwing.
    Extend `frontend/src/components/board/__tests__/PlayerBar.test.tsx` with one case:
    passing a FEN where the row's own side is up a queen puts `+9` in the row, and the
    existing cases (which pass no FEN) still render no material text.
  </behavior>
  <action>
    Create `frontend/src/components/board/MaterialDisplay.tsx` exporting a
    `MaterialDisplay` component taking `{ fen: string; side: 'white' | 'black' }` (plus an
    optional `className`). It calls `computeMaterialDiff` inside a `useMemo` keyed on the
    FEN and reads the entry for its own `side`.

    Render, in order: the icon group, then the point total. The icon group is a flex
    container hidden below the `sm` breakpoint and shown at `sm` and above (D-04); inside
    it, one sub-group per surplus entry, each repeating that type's lucide icon `count`
    times. Import the five icons named in D-03 from `lucide-react` and map them through a
    named record keyed by piece type. Icons are decorative: mark them `aria-hidden`. Size
    them to match the existing `Clock` icon in `PlayerBar` (`h-4 w-4`) and tint them with
    `text-muted-foreground` — no new color constant, so nothing to add to `theme.ts`.

    Same-type overlap (D-07): every icon after the first *within* a sub-group gets a small
    negative left margin from a named constant class; sub-groups of different types are
    separated by the container's gap so the overlap never crosses a type boundary.

    The point total renders only when this side's total is greater than zero (D-06), as
    `+{n}` at `text-sm` (the project's minimum font size — do not use `text-xs` here)
    with `tabular-nums` and `text-muted-foreground`. When the side is up material, also
    render an `sr-only` sentence naming the side and the point total so the icon-only
    desktop state is readable to a screen reader. When there is nothing to show, the
    component returns `null`.

    Put a `data-testid` of `material-{side}` on the outer element.

    `PlayerBar.tsx`: add an optional `fen?: string` prop, documented as "the FEN of the
    position currently on the board; omitted means no material display". Restructure the
    left half of the row into a `flex min-w-0 items-center gap-2` group holding the
    existing name span (which keeps `truncate min-w-0`) followed by `<MaterialDisplay>`
    with `shrink-0`, rendered only when `fen` is provided. The clock / right-slot half is
    unchanged, and the outer `justify-between` still pushes it right (D-05).

    `Analysis.tsx`: in the `playerBar()` helper (around line 3058) pass `fen={position}` —
    the same value already handed to `ChessBoard` at line 3010 and to `sideToMoveFromFen`,
    so the material always matches the rendered board. Add no new mode condition: every
    `playerBar(` call site already sits behind `showPlayerBars`, which is exactly the
    "game mode or pasted PGN" gate D-02 asks for; note that in a brief comment at the
    `fen=` prop.
  </action>
  <verify>
    <automated>(cd frontend && npm test -- --run src/components/board/__tests__/MaterialDisplay.test.tsx src/components/board/__tests__/PlayerBar.test.tsx)</automated>
    <automated>(cd /home/aimfeld/Projects/Python/flawchess/frontend && test "$(grep -c 'playerBar(' src/pages/Analysis.tsx)" = 7 && test "$(grep -c 'fen={position}' src/pages/Analysis.tsx)" = 1)</automated>
  </verify>
  <done>MaterialDisplay renders the correct icons and number per side; the Analysis PlayerBar rows show material between name and clock; the seven pre-existing playerBar call sites are unchanged in count (no new call site slipped outside the showPlayerBars gate) and the helper feeds the board's own FEN through exactly once.</done>
</task>

<task type="auto">
  <name>Task 3: Bots play page clock rows</name>
  <files>frontend/src/components/bots/ClockDisplay.tsx, frontend/src/pages/Bots.tsx</files>
  <action>
    `ClockDisplay.tsx`: add two optional props — `fen?: string` (the FEN currently on the
    board) and `side?: 'white' | 'black'` (which color this card represents; the component
    only knows `sideLabel` today, which is a display name, not a color). Render
    `<MaterialDisplay>` only when both are supplied.

    Placement (D-05): today the card is a `justify-between` row with the name/persona span
    on the left and the clock digits on the right. Wrap the name/persona span and the new
    `MaterialDisplay` in a single left group (`flex min-w-0 items-center gap-2`) so the
    material sits immediately after the name and does NOT get spread to the middle by
    `justify-between`; the clock stays right. This must hold for both branches of the
    existing persona ternary — the persona-avatar card and the compact text-only card.
    Give the material `shrink-0` and keep the name span able to shrink.

    `Bots.tsx`: at the two `ClockDisplay` instances (around lines 417-435) pass
    `fen={game.position}` to both — that is the same viewed-ply FEN already given to
    `ChessBoard` at line 439, so the material tracks the board when the user steps back
    through the game rather than only the live ply. Pass `side={botColor}` on the bot card
    and `side={settings.userColor}` on the user card.

    Do not touch the clock math, the low-time ring, the active-side highlight, the
    thinking indicator, or the avatar sizing.
  </action>
  <verify>
    <automated>(cd frontend && npm test -- --run src/components/bots/__tests__/ClockDisplay.test.tsx)</automated>
    <automated>(cd frontend && npm test -- --run && npm run lint && npm run knip && npx tsc -b)</automated>
  </verify>
  <done>Both bot-game clock cards show their side's material surplus between the name and the clock, driven by the same FEN the board renders; no backend file and no dependency changed (D-08); the full frontend suite, lint, knip, and tsc are clean.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| user-pasted PGN/FEN → Analysis board state | An arbitrary user-supplied string reaches `position`, and from there `computeMaterialDiff`. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-260809-jzz-01 | Denial of Service | `computeMaterialDiff` in `frontend/src/lib/materialDiff.ts` | low | mitigate | `new Chess(fen)` throws on an unparseable FEN and would unmount the Analysis tree; Task 1 wraps construction in try/catch returning a zeroed result, with a Vitest case asserting the malformed-FEN path. |
| T-260809-jzz-02 | Information Disclosure | material display | low | accept | The material balance is derived purely from the position already rendered on the board; it exposes nothing the user cannot already see. |

No package-manager installs in this plan (D-03: `lucide-react` is already a dependency), so no package-legitimacy gate applies.
</threat_model>

<verification>
Run the full frontend gate from `frontend/`:

```
npm test -- --run
npm run lint
npm run knip
npx tsc -b
```

`npm test`/`npm run lint` do not type-check (esbuild strips types), so `npx tsc -b` is
not optional here — Tasks 2 and 3 change shared component prop types.

No backend files change (D-08), so the backend half of the pre-merge gate is not
exercised by this task.

Human UAT (record in the summary, do not self-approve):
1. Bots page — play a game, win a queen: the user's clock card shows a queen icon and
   `+9`, the bot's card shows nothing. Trade evenly: both clear.
2. Bots page — step back through the move list with the board controls; the material
   follows the viewed position, not the live one.
3. Analysis in game mode — open an imported game, scrub the move list; both player rows
   track the board. Analysis with a pasted PGN — same.
4. Analysis free play — no material anywhere.
5. At 375px width both pages show the `+N` number with no piece icons.
</verification>

<success_criteria>
- Every `must_haves.truths` entry is observably true in the running app.
- `computeMaterialDiff` is the only place material is computed; no duplicate tally in
  either page or component.
- No backend file and no `package.json` dependency changed.
- Frontend tests, lint, knip, and `tsc -b` all pass.
</success_criteria>

<output>
Create `.planning/quick/260809-jzz-material-display-net-material-difference/260809-jzz-SUMMARY.md` when done.
</output>
