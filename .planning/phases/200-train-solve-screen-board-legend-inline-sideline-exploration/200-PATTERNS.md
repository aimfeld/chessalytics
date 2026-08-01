# Phase 200: Train Solve Screen — Pattern Map

**Mapped:** 2026-08-01
**Files analyzed:** 8 (5 modified, 2-3 new)
**Analogs found:** 8 / 8

RESEARCH.md already carries file:line-verified specs for every change. This
document only adds the "copy from here" analog mapping RESEARCH.md doesn't
provide — concrete files/lines to model new code on, especially for the two
genuinely new pieces of UI (`ArrowGlyphIcon`, `TrainExplorationLine`) and the
second-engine wiring.

## File Classification

| File | Role | Data Flow | Closest Analog | Match Quality |
|------|------|-----------|-----------------|----------------|
| `frontend/src/lib/trainArrows.ts` (modify: `applyTrainSpotlight`, `toDisplayQuality`, `alsoFineMoves`) | utility (pure overlay builder) | transform | itself (extend existing exported functions in the same file) | exact |
| `frontend/src/lib/__tests__/trainArrows.test.ts` (modify) | test | transform | itself — existing `describe('buildTrainRevealOverlay', ...)` blocks | exact |
| `frontend/src/components/icons/ArrowGlyphIcon.tsx` (NEW) | component (icon) | request-response (pure render) | `frontend/src/components/icons/MoveQualityIcon.tsx` (glyph-per-quality icon component) + `frontend/src/components/board/arrowGeometry.ts` (geometry fn to call) | role-match (icon shell) + exact (geometry source) |
| `frontend/src/components/train/TrainLineStepper.tsx` (modify: strip header) | component | request-response | itself — remove lines 243-276, keep body | exact |
| `frontend/src/components/train/TrainReveal.tsx` (modify: Card wrap, spotlight wiring, exploration swap) | component (container) | request-response | `frontend/src/components/train/TrainStatsCard.tsx` / `TrainStreakCard.tsx` for `Card`/`CardHeader` idiom; `frontend/src/pages/Analysis.tsx` (Stockfish `Card`/`CardHeader`/`CardBody` block ~3550-3587) for the engine-card swap-in shell | exact (Card idiom), role-match (swap-in) |
| `frontend/src/components/train/TrainSolveScreen.tsx` (modify: `isExploring` state, 2nd `useStockfishEngine`, `handlePieceDrop`/`handleShowSolution` branches) | component (screen/orchestrator) | event-driven + request-response | `frontend/src/pages/Analysis.tsx` lines ~644-647 (`useStockfishEngine({ fen, enabled })` instantiation) | exact |
| `frontend/src/components/train/TrainExplorationLine.tsx` (NEW component/hook) | component + hook (move-list state) | event-driven | `frontend/src/components/train/TrainLineStepper.tsx` for the **interaction shape only** (prev/next chevrons, clickable SAN tokens, active-token styling) — explicitly NOT for its reset-on-content-change state model | role-match (UI shape), anti-pattern flagged (state model) |
| `frontend/src/hooks/useIsDesktop.ts` (NEW, or inline in `TrainSolveScreen.tsx`) | hook | event-driven | `frontend/src/pages/Bots.tsx` lines 101-113 (`useIsDesktop` via `matchMedia`) | exact |

## Pattern Assignments

### `frontend/src/lib/trainArrows.ts` — spotlight + recolor + alsoFineMoves

**Analog:** itself. RESEARCH.md already gives the exact `applyTrainSpotlight` function body and the `alsoFineMoves` field addition to `TrainRevealOverlay`. Follow the existing file's conventions:

- Use the existing `squaresFromUci` helper (already at `trainArrows.ts:178-181`) rather than writing a new UCI-to-square parser.
- Export new functions the same way existing ones are exported: `export function buildTrainRevealOverlay(...)`, `export function classifyTrainMoveQuality(...)` — flat named exports, no default export, no class.
- Add `toDisplayQuality` next to `classifyTrainMoveQuality` (same file, same export style) since both are "quality → presentation" mapping functions consumed by both the pure builder and `TrainReveal`'s `CardHeader`.

**Imports pattern (top of file)** — this file has zero React imports; keep it that way:
```typescript
import { DARK_GREEN } from '@/lib/arrowColor';
import {
  MOVE_QUALITY_GOOD, MOVE_QUALITY_INACCURACY, MOVE_QUALITY_MISTAKE,
  MOVE_QUALITY_BLUNDER, NEXT_MOVE_ARROW, TRAIN_BEST_MOVE_ARROW,
} from '@/lib/theme';
```

---

### `frontend/src/lib/__tests__/trainArrows.test.ts` — new test cases

**Analog:** itself — existing `describe('buildTrainRevealOverlay', ...)` blocks (`trainArrows.test.ts:27+`).

**Test-shape pattern to copy:**
```typescript
import { describe, it, expect } from 'vitest';
import { buildTrainRevealOverlay, /* + applyTrainSpotlight, toDisplayQuality */ } from '@/lib/trainArrows';
import type { TrainFineMove } from '@/lib/trainArrows';
import { DARK_GREEN } from '@/lib/arrowColor';
import { MOVE_QUALITY_GOOD, /* ... */ } from '@/lib/theme';

function good(...ucis: string[]): TrainFineMove[] {
  return ucis.map((uci) => ({ uci, quality: 'good' as const }));
}

describe('applyTrainSpotlight', () => {
  it('filters arrows/markers to only the active UCIs', () => { /* ... */ });
  it('is a no-op when activeUcis is null or empty', () => { /* ... */ });
  it('keeps BOTH stacked arrows (quality-colored + white game hint) for a merged box', () => { /* ... */ });
});
```
Add new `describe` blocks alongside the existing ones; do not create a second test file — `trainArrows.test.ts` is the single test file for this module (established convention).

---

### `frontend/src/components/icons/ArrowGlyphIcon.tsx` (NEW)

**Analog 1 (icon component shell):** `frontend/src/components/icons/MoveQualityIcon.tsx` — read its prop shape (`quality` in, colored glyph out) and its use of `SEVERITY_GLYPH`/color lookups. Model `ArrowGlyphIcon`'s prop signature (`color: string`, sized `className`) the same way: a small typed functional component returning inline SVG, no external icon library.

**Analog 2 (geometry to reuse):** `frontend/src/components/board/arrowGeometry.ts:71-107` — `buildArrowPath(x1, y1, x2, y2, shaftHalf, headHalf, headLen)`. Call this SAME function with fixed glyph-local coordinates (e.g. a horizontal arrow across a small `viewBox="0 0 24 24"`) so the glyph's shape matches the board's real arrows, not just its color.

```typescript
// Pattern: small colored SVG icon component, sibling to MoveQualityIcon
import { buildArrowPath } from '@/components/board/arrowGeometry';

interface ArrowGlyphIconProps {
  color: string;
  className?: string;
}

export function ArrowGlyphIcon({ color, className }: ArrowGlyphIconProps) {
  const d = buildArrowPath(2, 12, 20, 12, 2, 5, 6); // fixed horizontal glyph geometry
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d={d} fill={color} />
    </svg>
  );
}
```
`data-testid` is not required on this icon itself (non-interactive, decorative) — per CLAUDE.md, `aria-hidden="true"` is correct here since the semantic verdict/title text next to it already carries the accessible label; only the enclosing interactive `Card`/glyph-tap-target needs `data-testid`/`aria-label`.

---

### `frontend/src/components/train/TrainReveal.tsx` — Card/CardHeader wrap + spotlight + exploration swap

**Analog for the Card/CardHeader idiom:** `frontend/src/components/train/TrainStatsCard.tsx` and `TrainStreakCard.tsx` — both already import `Card`/`CardHeader`/`CardBody` from `@/components/ui/card` and place a title/summary row in `CardHeader` with body content in `CardBody`. Copy that import and structural pattern verbatim for the three reveal line boxes (D-01):
```typescript
import { Card, CardHeader, CardBody } from '@/components/ui/card';

<Card
  data-testid="train-reveal-card-your"
  onMouseEnter={() => setSpotlightUcis(box.ucis)}
  onMouseLeave={() => setSpotlightUcis(null)}
  onFocus={() => setSpotlightUcis(box.ucis)}
  onBlur={() => setSpotlightUcis(null)}
  tabIndex={0}
  className={spotlightUcis === box.ucis ? 'ring-2 ring-brand-brown' : undefined}
>
  <CardHeader>
    <ArrowGlyphIcon color={glyphColor} />
    <p data-testid="train-line-stepper-title">{title}{mark != null && <span data-testid="train-line-stepper-mark">...</span>}</p>
    <span data-testid="train-line-stepper-quality"><MoveQualityIcon quality={toDisplayQuality(box.quality)} /></span>
    <span data-testid="train-line-stepper-eval">{evalLabel}</span>
  </CardHeader>
  <CardBody>
    <TrainLineStepper /* header props removed */ />
  </CardBody>
</Card>
```
Keep the exact `data-testid` strings named in RESEARCH.md (`train-line-stepper-title`/`-mark`/`-quality`/`-eval`) even though they move file — `TrainLineStepper.test.tsx`/`TrainReveal.test.tsx` assert on these testids, not on which component renders them.

**Analog for the exploration swap-in card shell:** `frontend/src/pages/Analysis.tsx` lines ~3550-3587 — the exact `Card`/`CardHeader`/`CardBody` + conditional-render pattern (`engineLoading ? <EngineLinesSkeleton/> : !engineEnabled ? <off state/> : <EngineLines .../>`) already used to host `EngineLines`. Reuse this three-way conditional shape for the exploration engine card instead of inventing a new loading/off/analyzing tri-state.

---

### `frontend/src/components/train/TrainSolveScreen.tsx` — second `useStockfishEngine` instance

**Analog:** `frontend/src/pages/Analysis.tsx:644-647`:
```typescript
const engine = useStockfishEngine({
  fen: engineEnabled ? position : null,
  enabled: engineEnabled,
});
```
Copy this exact `{ fen, enabled }` call shape for the exploration instance, substituting `isExploring` for `engineEnabled` and `explorationFen` for `position`:
```typescript
const explorationEngine = useStockfishEngine({
  fen: explorationFen,
  enabled: isExploring,
});
```
No new hook needed — `useStockfishEngine` is imported a second time in a different component instance, exactly as Analysis.tsx's own single instance is already imported/used elsewhere (the hook itself requires no changes).

**`handlePieceDrop` guard-order analog:** the existing function itself (`TrainSolveScreen.tsx:361-382`, quoted fully in RESEARCH.md) is the analog to extend — add the new branch strictly AFTER the existing `if (moveApplied) return false;` early-return, gated on `verdict !== null`, to avoid the double-grading regression RESEARCH.md's Pitfall 3 names.

---

### `frontend/src/components/train/TrainExplorationLine.tsx` (NEW)

**Analog for interaction shape (copy):** `frontend/src/components/train/TrainLineStepper.tsx` — the prev/next chevron buttons and clickable SAN token row (`TrainLineStepper.tsx:308-313` active-token styling: `bg-brand-brown`/`text-white`). Copy this rendering pattern (button elements, `data-testid="btn-..."` naming, active-token highlight class) for the exploration move list's own token row.

**Anti-pattern (do NOT copy):** `TrainLineStepper.tsx:182-184`'s reset effect:
```typescript
useEffect(() => setIndex(0), [movesKey, startFen, resetNonce]);
```
This must NOT be replicated for the exploration list — build a dedicated `{ moves: string[], index: number }` state pair with explicit `playMove(uci)` (truncate at `index`, append, advance) and `jumpTo(i)` (navigate without truncating) functions, per RESEARCH.md's "Exploration engine" section. No `useEffect`-driven reset tied to array-content identity.

**`replayLine`/FEN-from-UCI-chain analog:** `TrainLineStepper.tsx:134-150`'s `replayLine` function (`chess.js` replay from a start FEN through an ordered UCI list) is the pattern to copy for `explorationFen`'s derivation and for computing SAN labels for the token row — same `new Chess(startFen)` + `.move({...})` loop idiom used in `handlePieceDrop` itself.

---

### `useIsDesktop` breakpoint gate (mobile tap vs desktop hover, D-06/D-08)

**Analog:** `frontend/src/pages/Bots.tsx:101-113` (quoted in full in RESEARCH.md) — the `matchMedia`-based hook. Copy this pattern verbatim, but use `1024` (Tailwind's default `lg`) as the threshold instead of Bots.tsx's page-specific `DESKTOP_BREAKPOINT_PX = 800`, so the JS gate agrees with the `lg:` CSS breakpoint already driving `TrainSolveScreen.tsx`'s desktop/mobile layout split (`lg:flex-row lg:items-start lg:justify-center lg:gap-8`, `TrainSolveScreen.tsx:581`).

## Shared Patterns

### Theme colors — never hard-code
**Source:** `frontend/src/lib/theme.ts` (`BEST_MOVE_ARROW` L401, `NEXT_MOVE_ARROW` L426, `MOVE_QUALITY_GOOD` L478, `MOVE_QUALITY_INACCURACY` L479, `MOVE_QUALITY_MISTAKE` L480, `MOVE_QUALITY_BLUNDER` L481, `TRAIN_BEST_MOVE_ARROW` L559) and `frontend/src/lib/arrowColor.ts` (`DARK_GREEN` L30).
**Apply to:** `trainArrows.ts` (all recolor sites), `ArrowGlyphIcon` (color prop values), `TrainReveal.tsx` (spotlight ring color — use an existing Tailwind brand token, e.g. `ring-brand-brown`, not a new hex).
**Rule:** CLAUDE.md — "Never hard-code color values that have semantic meaning... directly in components." Every glyph/arrow color in this phase must resolve to one of the constants above, imported, never a literal.

### `Card`/`CardHeader`/`CardBody` shell
**Source:** `frontend/src/components/ui/card.tsx`, used by `TrainStatsCard.tsx`, `TrainStreakCard.tsx`, `TrainScheduleSettings.tsx`, and `Analysis.tsx`'s engine card.
**Apply to:** the three reveal line boxes (D-01) and the exploration engine-card swap-in (D-10).

### `data-testid` + `aria-label` on every interactive element
**Source:** CLAUDE.md Frontend section; existing convention e.g. `data-testid="train-line-stepper-title"`, `data-testid="btn-analysis-engine-toggle"`, `ariaLabel="Toggle Stockfish engine"` (`Analysis.tsx:3561`).
**Apply to:** the hoverable/focusable `Card` per line box (`data-testid="train-reveal-card-your|best|game"`), the mobile tap-target glyph (`data-testid="train-reveal-glyph-your"` etc., needs `aria-label` since it's icon-only), PV-move click spans in the exploration engine card (already covered by `EngineLines`'s existing testids — verify, don't re-invent), and every new button in `TrainExplorationLine` (`data-testid="btn-exploration-prev"`, `"btn-exploration-next"`).

### Mobile parity
**Source:** CLAUDE.md — "Always apply changes to mobile too."
**Apply to:** LEGEND-06/EXPLORE-07 — the same `TrainReveal.tsx` swap must render correctly inside `TrainSolveScreen.tsx`'s existing mobile below-board layout (the `lg:flex-row` container split), not just the desktop sidebar. D-08's glyph-only tap target is itself the mobile-specific interaction variant of D-06's hover.

### `noUncheckedIndexedAccess` narrowing
**Source:** CLAUDE.md — enabled project-wide.
**Apply to:** any array indexing in `TrainExplorationLine`'s `moves[index]` access, `squaresFromUci`/`activeSquarePairs` filtering in `applyTrainSpotlight` — narrow with a local `const` + `if` check or `.filter((s): s is T => s !== null)` (already the pattern used in RESEARCH.md's `applyTrainSpotlight` draft).

### `useTrainGradingEngine` — do NOT repurpose
**Source:** `frontend/src/hooks/useTrainGradingEngine.ts:207-246` (public API: `startGrading`, `abortGrading`, `restartEngine`, `gradeMove`, `startGameMoveSearch` — all one-shot, generation-keyed).
**Apply to:** exploration must use a SECOND, independent `useStockfishEngine` instance (see above), never extend or share this hook's Worker/queue. This is the phase's single most important "don't hand-roll" constraint per RESEARCH.md.

## No Analog Found

None — every file in scope has at least a role-match analog in the existing codebase (see table above). The genuinely new pieces (`ArrowGlyphIcon`, `TrainExplorationLine`) are new *files* but are built entirely from existing, cited building blocks (`arrowGeometry.ts`, `TrainLineStepper.tsx`'s interaction shape, `chess.js` replay idiom).

## Metadata

**Analog search scope:** `frontend/src/lib/`, `frontend/src/components/train/`, `frontend/src/components/analysis/`, `frontend/src/components/icons/`, `frontend/src/components/board/`, `frontend/src/pages/Analysis.tsx`, `frontend/src/pages/Bots.tsx`, `frontend/src/hooks/`
**Files scanned:** ~15 (all already cited with line numbers in RESEARCH.md; this pass added `MoveQualityIcon.tsx`, `TrainStatsCard.tsx`/`TrainStreakCard.tsx` Card idiom, `Analysis.tsx` engine-card block, `Bots.tsx` `useIsDesktop`, and `trainArrows.test.ts`'s test-shape convention)
**Pattern extraction date:** 2026-08-01
