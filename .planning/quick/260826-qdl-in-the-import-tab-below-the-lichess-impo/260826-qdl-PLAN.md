---
phase: quick-260826-qdl
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - frontend/src/lib/pastedGameHandoff.ts
  - frontend/src/lib/analysisUrl.ts
  - frontend/src/pages/Import.tsx
  - frontend/src/pages/Analysis.tsx
  - frontend/src/lib/__tests__/pastedGameHandoff.test.ts
  - frontend/src/pages/__tests__/Import.pasteHandoff.test.tsx
  - frontend/src/pages/__tests__/Analysis.test.tsx
  - CHANGELOG.md
autonomous: true
requirements: [QDL-01]

estimate:
  tokens: 55000
  raw_tokens: 55000
  tasks: 3
  confidence: low

must_haves:
  truths:
    - "The Import tab renders an `Import Single Game (PGN/FEN)` button directly below the lichess platform card."
    - "Clicking it opens the SAME `PasteModal` component the analysis board's `PGN/FEN` button opens — same testids (`paste-modal`, `paste-textarea`, `btn-paste-load`, `btn-paste-analyze`), same four-state sniff behavior, same copy. No duplicate modal component exists."
    - "Pressing Load on a valid FEN from the Import tab navigates to `/analysis` and the analysis board opens at that exact position."
    - "Pressing Load on a valid PGN from the Import tab navigates to `/analysis` and the analysis board opens with the full mainline in the move list, the parsed White/Black header line in the player bars, and the board oriented to the side the user selected."
    - "Pressing `Analyze full game` from the Import tab navigates to `/analysis?game_id=N` for the saved game — the identical destination the on-board modal already reaches."
    - "The handoff is one-shot: a second read after a consume returns null, so a browser Back-then-Forward to `/analysis` does NOT resurrect the pasted game."
    - "A corrupt, absent, or wrong-shaped handoff payload degrades to a bare free-play start position and never throws."
    - "No backend change is made — the modal's `Analyze full game` path already POSTs `/imports/paste` through `useSavePastedGame`."
    - "No `data-umami-event` attribute is added anywhere in this change."
  artifacts:
    - frontend/src/lib/pastedGameHandoff.ts
    - frontend/src/lib/__tests__/pastedGameHandoff.test.ts
    - frontend/src/pages/__tests__/Import.pasteHandoff.test.tsx
    - CHANGELOG.md
  key_links:
    - "`Analysis.tsx::handlePasteLoad` (currently ~L2627) is the SINGLE apply-a-paste-to-the-board function. The new consume effect must call it verbatim — that is what guarantees the Import-tab path behaves identically to the on-board path (loadMainLine + setPastedHeaders + setBoardFlipped) without re-deriving any of it."
    - "`Analysis.tsx::seededKey` ref (~L926) arbitrates the game_id > fen > line seeding effects. The consume effect must set `seededKey.current = 'paste'` before calling `handlePasteLoad`, or a stray `?line=`/`?fen=` on the destination URL could seed over the pasted game."
    - "`takePastedGameHandoff()` must be DESTRUCTIVE (read-and-clear) — that single property is what makes the one-shot truth structural instead of convention-enforced."
    - "`PasteModal` needs a real `QueryClientProvider` ancestor (`useSavePastedGame` → `useMutation`). The existing Import test harness mocks `useQueryClient` to a stub; the new Import test must NOT copy that mock or `useMutation` breaks."
---

<objective>
Add an `Import Single Game (PGN/FEN)` button to the Import tab, below the lichess card,
that opens the existing analysis-board paste modal and, on a successful load or save,
lands the user on the analysis board with that game/position already loaded.

Purpose: today the only way to paste a one-off game is to already be on the analysis
board. The Import tab is where a user goes to get games in, so the paste entry point
belongs there too.

Output: a small sessionStorage handoff module, a button + modal mount on the Import tab,
a one-shot consume effect on the analysis page, tests, and a changelog entry.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@frontend/CLAUDE.md

@frontend/src/components/analysis/PasteModal.tsx
@frontend/src/lib/pastedGame.ts
@frontend/src/lib/analysisUrl.ts
@frontend/src/lib/trainRevealCache.ts
@frontend/src/pages/Import.tsx
</context>

<investigation_findings>
Read this before touching anything — it is the result of the pre-plan investigation and
removes the need for the executor to re-derive it.

**The modal is already reusable. No extraction or refactor is required.**
`frontend/src/components/analysis/PasteModal.tsx` is a self-contained, fully
prop-driven component: `{ open, onOpenChange, onLoad, onSaved }`. It owns its own
textarea/sniff/side-selector state, its own `useSavePastedGame` mutation, and its own
close-clears-draft behavior. Mounting a second instance on the Import tab is safe
(Radix `Dialog` portals its content). Do NOT copy, fork, or generalize it.

**Analysis board wiring today** (`frontend/src/pages/Analysis.tsx`):
- `pasteModalOpen` state at ~L628; trigger button `data-testid="analysis-btn-paste"` in
  `moveListHeaderContent` (~L3585); `<PasteModal>` mounted via `pasteModalNode` (~L3810).
- `handlePasteLoad(result, userColor)` (~L2627): `kind: 'fen'` → `loadMainLine([], result.fen)`
  + `setPastedHeaders(null)`; `kind: 'pgn'` → `loadMainLine(result.sans, result.rootFen)` +
  `setPastedHeaders({ headers, userColor })` + `setBoardFlipped(userColor === 'black')`.
- `handlePasteSaved(gameId)` (~L2651): `setPastedHeaders(null)` + `navigate(buildGameAnalysisUrl(gameId))`.
- Seeding effects (~L966-1005) all bail when `!isGameMode && rootFenSeed === null &&
  lineSans.length === 0`, which is exactly the state of a bare `/analysis` URL. The
  `seededKey` ref (~L926) is the shared arbiter.
- There is no early `return` in the component before ~L3830, so a hook may be added
  immediately after `handlePasteSaved`.

**Handoff mechanism — decided: sessionStorage, one module, both kinds.**
- `onSaved` needs nothing new: `navigate(buildGameAnalysisUrl(gameId))` works from any page.
- `onLoad` does need a carrier. `?line=` cannot express it (`parseAnalysisLineParam`
  replays UCI from the STANDARD START, so a `[SetUp]`/custom-root PGN is unrepresentable,
  and the parsed White/Black/Elo headers that drive the player bars would be lost).
  `?fen=` could carry the `kind: 'fen'` case only.
- Rejected: two mechanisms (`?fen=` for FEN, storage for PGN) — needless divergence.
- Rejected: react-router `navigate(url, { state })` — zero precedent in this codebase
  (grep confirms), and the state sticks to the history entry so Back/Forward re-applies it.
- Chosen: ONE sessionStorage carrier for both kinds, consumed by calling the existing
  `handlePasteLoad` verbatim. Precedent to mirror exactly: `frontend/src/lib/trainRevealCache.ts`
  (save / read / clear, shape validation, try-catch-degrades-to-null, never throws).

**Conventions that apply** (from `frontend/CLAUDE.md`):
- Secondary button = `variant="brand-outline"`. Never hand-roll button colors.
- `data-testid` on every interactive element, `btn-{action}` for action buttons.
- Minimum font size `text-sm`.
- Umami: imports must NOT be duplicated as events, and internal navigation must never
  carry `data-umami-event`. This change adds NO tracking attribute.
- Knip runs in CI: every new export must be imported by something.
- TanStack Query errors are captured globally in `queryClient.ts` — add no `Sentry.captureException`.

**Backend: no change.** `/imports/paste` already exists and is already called by
`useSavePastedGame`, which `PasteModal` already owns.
</investigation_findings>

<tasks>

<task type="tracer">
  <name>Task 1: End-to-end "paste on the Import tab, land on the analysis board" — one path wired through every layer</name>
  <files>
    frontend/src/lib/pastedGameHandoff.ts,
    frontend/src/lib/analysisUrl.ts,
    frontend/src/pages/Import.tsx,
    frontend/src/pages/Analysis.tsx,
    frontend/src/pages/__tests__/Import.pasteHandoff.test.tsx
  </files>
  <behavior>
    - Rendering the Import tab shows a button with the accessible name `Import Single Game (PGN/FEN)` and testid `btn-import-single-game`.
    - Clicking that button reveals the shared modal (testid `paste-modal`).
    - Typing a valid FEN into `paste-textarea` and clicking `btn-paste-load` writes a handoff payload and navigates to `/analysis`.
    - Typing a valid PGN, choosing Black on `paste-side-black`, and clicking `btn-paste-load` writes a handoff carrying the parsed sans, root FEN, headers, and `userColor: 'black'`, then navigates to `/analysis`.
    - Garbage text leaves `btn-paste-load` disabled and performs no navigation.
  </behavior>
  <action>
Create `frontend/src/lib/pastedGameHandoff.ts`, modelled line-for-line on
`frontend/src/lib/trainRevealCache.ts` (read that file first). Module surface, and
nothing more (knip):

  - `export interface PastedGameHandoff { result: PasteParseResult; userColor: 'white' | 'black' }`
    where `PasteParseResult` is imported as a type from `@/lib/pastedGame`.
  - `export function savePastedGameHandoff(handoff: PastedGameHandoff): void`
  - `export function takePastedGameHandoff(): PastedGameHandoff | null`

Use a module-private `const STORAGE_KEY = 'pasted_game_handoff'` (do not export it —
knip would flag a test-only export). `savePastedGameHandoff` JSON-stringifies into
`sessionStorage` inside a try/catch that degrades silently (quota / Safari private mode),
exactly as `saveTrainRevealCache` does. `takePastedGameHandoff` is DESTRUCTIVE: it reads,
removes the key, then validates and returns — remove the key even when the payload turns
out to be malformed, so a corrupt entry cannot wedge every future analysis-page mount.
Validate the shape with a private type guard that accepts only `result.kind === 'fen'`
(with a string `fen`) or `result.kind === 'pgn'` (with an array `sans`, a string `rootFen`,
an object `headers`, and a string `pgn`), plus `userColor` being exactly `'white'` or
`'black'`; anything else, plus any throw or `JSON.parse` failure, returns `null`. Guard
`typeof sessionStorage === 'undefined'` for the prerender path. Head the module with a
doc comment stating that it exists because `?line=` cannot represent a custom-root PGN or
the parsed headers, that it is deliberately tab-scoped and one-shot, and that it must
never touch persistent per-origin storage (the auth token lives there).

In `frontend/src/lib/analysisUrl.ts`, add `export` to the existing module-private
`ANALYSIS_PATH` const so callers navigating to bare free play do not hand-write the route
string. Change nothing else in that file.

In `frontend/src/pages/Import.tsx`:
  - Add imports: `useNavigate` from `react-router`, `ClipboardPaste` from `lucide-react`
    (add it to the existing lucide import), `PasteModal` from `@/components/analysis/PasteModal`,
    `type PasteParseResult` from `@/lib/pastedGame`, `savePastedGameHandoff` from
    `@/lib/pastedGameHandoff`, and `ANALYSIS_PATH` + `buildGameAnalysisUrl` from `@/lib/analysisUrl`.
  - Inside `ImportPage`, add `const navigate = useNavigate();` and
    `const [pasteModalOpen, setPasteModalOpen] = useState(false);` alongside the existing
    state declarations.
  - Add two handlers. `handlePasteLoad(result: PasteParseResult, userColor: 'white' | 'black')`:
    return early unless `result.kind` is `'fen'` or `'pgn'`, then `savePastedGameHandoff({ result, userColor })`
    and `navigate(ANALYSIS_PATH)`. `handlePasteSaved(gameId: number)`:
    `navigate(buildGameAnalysisUrl(gameId))` — the same destination `Analysis.tsx::handlePasteSaved`
    already uses, so the saved-game path needs no handoff at all.
  - Render the trigger immediately after the closing `</Card>` of the lichess platform card
    (`data-testid="import-platform-lichess"`) and still inside the enclosing
    `<div className="space-y-4">`, so it inherits the same vertical rhythm as the two
    platform cards:

      a `Button` with `variant="brand-outline"`, `className="w-full"`,
      `data-testid="btn-import-single-game"`, `onClick={() => setPasteModalOpen(true)}`,
      containing a `<ClipboardPaste className="h-4 w-4" aria-hidden="true" />` followed by
      the visible text `Import Single Game (PGN/FEN)`.

    Do not add `data-umami-event` (frontend/CLAUDE.md: imports are already in the DB and
    must not be duplicated as events).
  - Mount `<PasteModal open={pasteModalOpen} onOpenChange={setPasteModalOpen} onLoad={handlePasteLoad} onSaved={handlePasteSaved} />`
    once, as a sibling of the `main`'s other children (place it next to the existing
    delete-games `Dialog` near the end of the return). Mount it OUTSIDE the
    `profileLoading ? ... : ...` ternary so a mid-flight profile refetch cannot unmount an
    open modal.

In `frontend/src/pages/Analysis.tsx`:
  - Import `takePastedGameHandoff` from `@/lib/pastedGameHandoff`.
  - Next to the existing `seededKey` / `navigatedInitialPlyKey` refs (~L926), add
    `const pasteHandoffConsumed = useRef(false);`.
  - Immediately AFTER the existing `handlePasteSaved` definition (~L2655) — it must come
    after `handlePasteLoad` is declared, and it is safely above every early return — add a
    mount-once effect with an empty dependency array and the file's usual
    `// eslint-disable-next-line react-hooks/exhaustive-deps` above the closing bracket:
    bail if `pasteHandoffConsumed.current`, set it true, call `takePastedGameHandoff()`,
    return when it yields `null` or when `isGameMode` is true (a `?game_id=` URL always
    wins, and the destructive take has already discarded the stale payload), otherwise set
    `seededKey.current = 'paste'` and call `handlePasteLoad(handoff.result, handoff.userColor)`.
    Comment it with: why the ref guard exists (StrictMode double-invokes effects and the
    take is destructive), why `seededKey` is claimed (the `?line=`/`?fen=` seeding effects
    share that arbiter), and that reusing `handlePasteLoad` verbatim is what makes the
    Import-tab path behave identically to the on-board path.

Create `frontend/src/pages/__tests__/Import.pasteHandoff.test.tsx` as this task's
end-to-end proof. Copy the `vi.mock` block for `useReadiness`, `useUserProfile`, `useAuth`,
`useImport`, `useImportSettings`, `useEvalCoverage`, `react-router` (the `mockNavigate`
form), and `@/api/client` from `frontend/src/pages/__tests__/Import.queuedState.test.tsx`.
Two deliberate divergences from that harness, both load-bearing: extend the `@/api/client`
mock to `{ delete: vi.fn(), post: vi.fn() }`, and do NOT copy its `@tanstack/react-query`
`useQueryClient` mock — wrap the render in a real `QueryClientProvider` (with
`defaultOptions: { queries: { retry: false } }`) instead, because `PasteModal`'s
`useSavePastedGame` calls `useMutation`, which needs a genuine client. Keep the
`MemoryRouter` + `TooltipProvider` wrappers. Cover the five behaviors listed above, using
`fireEvent.change` on `paste-textarea` (the modal sniffs on every keystroke) and reading
the written payload back with `takePastedGameHandoff()`.
  </action>
  <verify>
    <automated>cd frontend &amp;&amp; npx vitest run src/pages/__tests__/Import.pasteHandoff.test.tsx &amp;&amp; npm run build</automated>
  </verify>
  <done>
    From the Import tab, a pasted FEN and a pasted PGN each write a well-formed handoff and
    navigate to `/analysis`; `Analyze full game` navigates to `/analysis?game_id=N`; the
    analysis page consumes the handoff through the existing `handlePasteLoad`; `tsc -b`
    passes.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Harden the handoff — one-shot, corrupt-input, and analysis-side consume coverage</name>
  <files>
    frontend/src/lib/__tests__/pastedGameHandoff.test.ts,
    frontend/src/pages/__tests__/Analysis.test.tsx
  </files>
  <behavior>
    Handoff module (`pastedGameHandoff.test.ts`, `// @vitest-environment jsdom`):
    - Round-trip: a `kind: 'fen'` payload saved then taken returns deep-equal.
    - Round-trip: a `kind: 'pgn'` payload (sans, rootFen, headers, pgn, `userColor: 'black'`) returns deep-equal.
    - One-shot: a second `takePastedGameHandoff()` after a consume returns `null`.
    - Empty store: `takePastedGameHandoff()` with nothing stored returns `null` and does not throw.
    - Corrupt JSON written directly to the key returns `null`, does not throw, AND clears the key (a third call still returns `null` with no stored value left).
    - Wrong shape (`{ result: { kind: 'error' }, userColor: 'white' }`, and `{ result: { kind: 'fen', fen: 'x' }, userColor: 'purple' }`) returns `null`.

    Analysis page (added to the existing `Analysis.test.tsx`, in its own `describe`):
    - A `kind: 'pgn'` handoff written before `renderAnalysis('/analysis')` seeds the mainline — at least one `Nf3` node appears in the move list (mirror the existing `?line=` assertion at ~L409).
    - The same handoff with `userColor: 'black'` renders the parsed White/Black header line in the player bars.
    - A `kind: 'fen'` handoff renders without throwing and leaves `analysis-page` present.
    - A handoff present alongside `?game_id=` does NOT seed the pasted game (game mode wins).
    - Rendering `/analysis` twice with only one handoff written seeds it the first time and starts bare the second (one-shot, proving Back/Forward cannot resurrect it).
  </behavior>
  <action>
Write the tests listed in `<behavior>` above. Write each assertion BEFORE reaching for the
implementation; if any of them fails, fix the implementation from Task 1 rather than
loosening the assertion.

Create `frontend/src/lib/__tests__/pastedGameHandoff.test.ts` with a
`// @vitest-environment jsdom` pragma (sessionStorage is a jsdom global) and an
`afterEach` that clears `sessionStorage`. For the corrupt-JSON and wrong-shape cases,
write directly to the `'pasted_game_handoff'` key with `sessionStorage.setItem` — the key
is intentionally not exported, so use the literal here and note in a comment that it is
pinned to the module's private constant.

Extend `frontend/src/pages/__tests__/Analysis.test.tsx` with a new `describe` block. Reuse
the file's existing `renderAnalysis(initialPath)` helper and its already-mocked engine
stack — add no new page-level mocks. Write the handoff with the real
`savePastedGameHandoff` (not a hand-rolled `sessionStorage.setItem`) so the test exercises
the same serializer production uses, and clear `sessionStorage` in the block's `afterEach`
so a leaked handoff cannot contaminate the file's other 9 render tests.

Build the PGN payload for these tests by running the real `sniffPastedInput` from
`@/lib/pastedGame` over a short movetext (`1. e4 e5 2. Nf3 Nc6`) and narrowing on
`kind === 'pgn'` — hand-constructing the payload would let the test pass against a shape
production never produces.
  </action>
  <verify>
    <automated>cd frontend &amp;&amp; npx vitest run src/lib/__tests__/pastedGameHandoff.test.ts src/pages/__tests__/Analysis.test.tsx</automated>
  </verify>
  <done>
    All handoff and analysis-consume cases above pass, including the one-shot and
    corrupt-payload cases; the pre-existing tests in `Analysis.test.tsx` still pass.
  </done>
</task>

<task type="auto">
  <name>Task 3: Changelog entry and full frontend gate</name>
  <files>CHANGELOG.md</files>
  <action>
Append one user-facing bullet under the existing `### Added` heading inside
`## [Unreleased]` in `CHANGELOG.md`, describing the new Import-tab entry point in product
terms (a single game can now be pasted as PGN or FEN from the Import tab and opens
straight on the analysis board). Follow the surrounding entries' voice: user-visible
outcome first, no file names, no phase or plan identifiers, em-dashes sparingly.

Then run the frontend half of the pre-merge gate and resolve everything it reports. If
`eslint --fix` or any tooling modifies files, commit that separately with a `style(...)`
or `chore(...)` prefix. Also run `npm run knip` — this change adds new exports and CI
fails on unused ones.
  </action>
  <verify>
    <automated>cd frontend &amp;&amp; npm run lint &amp;&amp; npm test -- --run &amp;&amp; npm run build &amp;&amp; npm run knip</automated>
  </verify>
  <done>
    `CHANGELOG.md` carries the new bullet under `## [Unreleased]` / `### Added`; eslint, the
    full vitest suite, `tsc -b` + vite build, and knip are all clean.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| user clipboard → PasteModal textarea | Untrusted arbitrary text enters the client. Already bounded by `MAX_PASTED_INPUT_LENGTH` (100k) and parsed only by chess.js inside `sniffPastedInput`. Unchanged by this plan. |
| Import tab → sessionStorage → Analysis page | New. A serialized parse result crosses a page boundary through tab-scoped browser storage. |
| PasteModal → `POST /imports/paste` | Pre-existing, unchanged — the modal already owns this call via `useSavePastedGame`. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-qdl-01 | Tampering | `takePastedGameHandoff` | medium | mitigate | A hand-edited or corrupt sessionStorage value must not reach `loadMainLine`. The private type guard admits only `kind: 'fen' \| 'pgn'` with correctly typed fields and a `'white' \| 'black'` userColor; every other value, plus any parse throw, returns `null`. Covered by the corrupt-JSON and wrong-shape cases in Task 2. |
| T-qdl-02 | Information disclosure | `pastedGameHandoff.ts` storage choice | medium | mitigate | The module reaches only for `sessionStorage` (tab-scoped, dies with the tab) and never `localStorage`, where the Bearer auth token lives. Stated in the module doc comment, mirroring `handoffMarker.ts`'s precedent. |
| T-qdl-03 | Denial of service | `takePastedGameHandoff` | low | mitigate | A corrupt payload that were merely rejected-but-retained would fail every subsequent analysis-page mount. The take is destructive on ALL paths, including the malformed one, so a bad entry self-heals after one mount. |
| T-qdl-04 | Denial of service | `savePastedGameHandoff` | low | accept | A `QuotaExceededError` (Safari private mode) degrades to a silent no-op, so the user lands on a bare analysis board instead of their pasted game. Same accepted degradation as `saveTrainRevealCache`; a 100k-capped payload in a fresh tab makes it near-unreachable. |
| T-qdl-05 | Elevation of privilege | `POST /imports/paste` | low | accept | No new endpoint, no new caller shape — the identical `useSavePastedGame` mutation the analysis board already issues, now reachable from a second authenticated page. Server-side authz is unchanged. |
| T-qdl-SC | Tampering | npm/pip/cargo installs | high | accept | No package is added, removed, or upgraded by this plan. Every import used (`react-router`, `lucide-react`, `@tanstack/react-query`, `chess.js`) is already a direct dependency. |
</threat_model>

<verification>
1. `cd frontend && npm run lint && npm test -- --run && npm run build && npm run knip` — all clean.
2. Manual (developer, optional): on `/library/import`, the new button sits directly below
   the lichess card at both 375px and desktop widths; pasting a PGN, picking Black, and
   pressing Load opens `/analysis` with the game in the move list, the header names in the
   player bars, and the board black-side-up.
3. `grep -rn "data-umami-event" frontend/src/pages/Import.tsx` shows only the pre-existing
   `signup-cta` attributes on the guest-promo link — none on the new button.
</verification>

<success_criteria>
- The Import tab's new `btn-import-single-game` button opens the shared `PasteModal`; no
  second modal component exists anywhere in `frontend/src`.
- Load (FEN and PGN) and `Analyze full game` from the Import tab both land on the analysis
  board with the content already loaded.
- The handoff is destructive-read and shape-validated; corrupt input degrades to a bare
  start position without throwing.
- Zero backend files changed.
- `CHANGELOG.md` has a matching `## [Unreleased]` bullet.
- eslint, vitest, `tsc -b` + vite build, and knip are all green.
</success_criteria>

<output>
Create `.planning/quick/260826-qdl-in-the-import-tab-below-the-lichess-impo/260826-qdl-SUMMARY.md` when done
</output>
