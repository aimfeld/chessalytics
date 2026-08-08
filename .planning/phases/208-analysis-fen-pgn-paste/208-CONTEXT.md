# Phase 208: Paste a FEN or PGN on /analysis - Context

**Gathered:** 2026-08-08
**Status:** Ready for planning

<domain>
## Phase Boundary

A door into `/analysis` from outside. Today the page can only be reached with a position
someone else constructed (`?line=` from Openings, `?fen=` from the calibration harness,
`?game_id=` from the Library). This phase adds one button, one modal, one textarea whose
format is sniffed, so a user can bring in an arbitrary position or game — a puzzle FEN from
a book, a game from a broadcast, a PGN a friend sent.

Paste-and-look persists nothing. An explicit "Analyze full game" saves the game as
`platform='pgn'` (always excluded from analytics) and enqueues it through the existing
tier-1 eval path. `/analysis` also gains the main nav item it has never had, without which
the modal is unreachable.

Frontend + backend. **No migration. No new eval infrastructure.**

Scope is fixed by ROADMAP.md Phase 208 and SEED-144's ten locked decisions (D-01..D-10).
This discussion resolved only the two open questions the roadmap carried forward plus two
implementation gray areas found during codebase scout. It did not re-open anything locked.

</domain>

<decisions>
## Implementation Decisions

The seed's D-01..D-10 remain in force verbatim and are NOT restated here — read
`.planning/seeds/SEED-144-analysis-fen-pgn-paste.md` § Locked Decisions. The decisions
below are numbered D-11 onward to avoid collision, and resolve what the seed left open.

### Library visibility (resolves ROADMAP.md Open Question 1)

- **D-11: Pasted games are hidden from BOTH Library tabs by default, and visible only
  when an explicit "Pasted" platform filter chip is set.** This is opt-in, not opt-out.
  Rationale (user, verbatim intent): users paste games that are **not theirs** — a
  broadcast game, a friend's PGN, an opponent they are scouting. Those must not pollute
  their stats or their game history. This makes the Library consistent with D-05 rather
  than an exception to it: `platform='pgn'` is excluded everywhere by default, full stop.

  **This is the opposite of how `flawchess` bot games were handled** (Phase 167 D-03 opted
  them back INTO the Library by substituting a three-platform list at
  `app/services/library_service.py:868`). Do NOT copy that pattern. `library_platform` must
  **not** gain `"pgn"`.
  — **Reversibility:** reversible — a one-token change to the substitution list either way.

- **D-12: No backend change is needed to hide pasted games.** Verified during scout:
  `get_library_games` is the *only* function performing the default-platform substitution;
  the Flaws tab goes straight through `apply_game_filters`, where `DEFAULT_EXCLUDED_PLATFORMS`
  already excludes `'pgn'` once it is added there per D-05. Passing an explicit
  `platform=['pgn']` from the chip flows through the existing seam on both tabs with no new
  plumbing. The work is entirely the chip that opts them back in.

- **D-13: A "Pasted" badge renders top-right of the Library game card**, in the slot at
  `frontend/src/components/results/LibraryGameCard.tsx:818` where the platform icon and
  external link would go. For a pasted game that slot renders empty today — `PlatformIcon`
  returns `null` for unknown platforms (`frontend/src/components/icons/PlatformIcon.tsx:42`)
  and `gameUrl` is null with no `platform_url` — so the badge needs no layout change.
  A text badge, not an icon: it must read as "this is not a game you played", which an icon
  cannot say.
  — **Reversibility:** reversible.

- **D-14: The "Pasted" chip is Library-scoped only.** It must NOT appear on Openings,
  Endgames, or GlobalStats. Those three share the same `FilterPanel`, whose `visibleFilters`
  prop is **section**-level, not chip-level, and whose `PLATFORMS` constant is hardcoded at
  `frontend/src/components/filters/FilterPanel.tsx:181`. Locked constraint 4 keeps pasted
  games out of those surfaces unconditionally, so a chip there would be a dead control that
  always returns nothing. Planning must introduce a per-surface platform list (or equivalent
  prop), not widen the shared constant.
  — **Reversibility:** costly — `Platform` (`frontend/src/types/api.ts:165`) is shared by
  four FilterPanel consumers plus `FilterState`; widening it globally and retracting later
  means touching every consumer.

### Post-save navigation

- **D-15: After "Analyze full game" persists the row, navigate to `?game_id=N`** — the
  saved game's normal analysis URL. It survives refresh, hands the user the real game-mode
  experience the rest of the app already builds for (PlayerBar, eval chart, flaw markers),
  and the URL itself becomes the route back that D-11's default-hidden Library no longer
  provides on its own.

  **This does not violate D-03.** D-03 bars `?fen=`/`?line=` write-back specifically to
  avoid disturbing the documented `fen > line` precedence in
  `frontend/src/lib/analysisUrl.ts`. `?game_id=` is a separate param on a separate code
  path and leaves that precedence untouched.
  — **Reversibility:** reversible.

### platform_game_id synthesis (resolves ROADMAP.md Open Question 2)

- **D-16: `platform_game_id` = a deterministic hash of normalized mainline SAN + root FEN.**
  Headers are deliberately **excluded**. They are the unreliable input — the seed's corpus
  evidence records one player spelled twelve ways (case, diacritics, comma placement, token
  order, title/rating/federation prefixes), so any header-inclusive hash means the same game
  re-pasted from a different source produces a *second* row, defeating the entire point.
  Root FEN is **included** so a `[SetUp]`-rooted paste cannot collide with a from-start paste
  that happens to share a SAN sequence.

  **Accepted residual collision:** two genuinely different short games with identical moves
  from identical roots (e.g. a four-move mate) map to one row. Judged acceptable.

  `games.platform_game_id` is `String(100)` and the constraint is
  `uq_games_user_platform_game_id` on `(user_id, platform, platform_game_id)` — so a SHA-256
  hex digest (64 chars) fits, and the per-user scoping means two users pasting the same game
  never collide with each other.

  **No precedent to copy:** `normalize_flawchess_game` takes a client-minted UUID
  (`app/services/normalization.py:689`), which is not deterministic and cannot be reused here.
  — **Reversibility:** costly — the hash input set is baked into every persisted row's
  identity. Changing it later does not corrupt anything, but every previously-pasted game
  stops deduping against a re-paste, silently accumulating duplicates.

- **D-17: On a hash hit, silently reuse the existing row and open it.** No toast, no
  re-enqueue of tier-1. Combined with D-15, a re-paste simply lands the user on their
  existing analysis, which reads as the feature working rather than as a special case.

- **D-18: `user_color` is NOT part of the hash. Re-pasting the same game with the other
  side selected updates `user_color` on the existing row in place.** It is the user's row
  and their call which side they are studying. `game_flaws` stores both players' flaws
  regardless, so nothing is lost and nothing needs recomputation — only board orientation
  and which side reads as "yours" change. Rejected: making `user_color` part of the hash,
  which would mean two rows and two tier-1 eval jobs for one game — double the engine work
  for what is effectively a view toggle.

### Paste entry point

- **D-19: The paste trigger lives in the move-list card header**
  (`analysis-movelist-header`, `frontend/src/pages/Analysis.tsx:3607`), a `size="compact"`
  CardHeader currently holding only an icon and the word "Moves" — room for a right-aligned
  trigger.

  Rejected: a fifth button in `BoardControls`
  (`frontend/src/components/board/BoardControls.tsx`). It is semantically board *navigation*
  (reset/back/forward/flip), paste is not, and on mobile it renders `flat` with no size so
  the buttons fill the width "like the main nav" — a fifth button compresses that row at
  375px, where SC-9 requires the whole flow to work.

  **Mobile reachability verified:** `Tabs defaultValue="moves"` (`Analysis.tsx:3501`), so the
  Moves tab is the default and the header is visible the moment the user lands — no tab
  switch needed.
  — **Reversibility:** reversible.

- **D-20: The trigger is visible in every mode, including `?game_id=` game mode.** One
  consistent affordance; a user can paste a new game without navigating away first. This
  also avoids the trap in the alternative: because D-15 navigates to `?game_id=N` after a
  save, a free-play-only trigger would vanish the instant it was used successfully.

### Error handling

- **D-21: Any parse failure rejects the whole paste.** Inline error, nothing loaded, board
  left as it was. No partial load, no "load what parsed and warn". Truncation is the
  dangerous failure mode here — a game silently cut short at move 12 produces real-looking
  but wrong flaws and a wrong result, which is exactly the "silently wrong position" SC-3
  forbids.

  **LANDMINE (measured, must be respected by the implementation):** `chess.js`'s `loadPgn`
  **retains the moves that parsed on the instance after throwing.** On
  `1. e4 e5 2. Nf3 Nc6 3. Nh6 d6` it throws `Invalid move in PGN: Nh6`, yet `history()` still
  returns `["e4","e5","Nf3","Nc6"]`. A naive catch-and-read implementation therefore loads a
  truncated game *silently* — the precise SC-3 failure. **The instance must be discarded on
  throw** (construct a fresh `Chess()` for the successful path, or verify the instance is
  unused after a caught error).
  — **Reversibility:** reversible.

- **D-22: One generic error message.** "Couldn't read that as a FEN or PGN" (exact copy at
  planning's discretion). No format-specific variants, no raw library text.

  Rationale grounded in measurement: the two `chess.js` error classes do **not** split the
  way a format-aware message would need. Syntax errors read
  `Expected NAG, brace comment, … but "X" found`; semantic errors read
  `Invalid move in PGN: X`. But plain garbage (`hello world this is not chess`) produces the
  **semantic** class, identical in shape to a real game with one bad move — so the message
  cannot reliably distinguish "nearly-good PGN" from "not a game at all", and a
  format-specific message would be confidently wrong some of the time. Raw library text is
  also unusable: a mistyped FEN produces the `Expected NAG, brace comment, end of input,
  game termination marker, …` string, which is meaningless to a chess player.

### Claude's Discretion

- Exact error-copy wording (D-22), subject to the `text-sm` floor and the project's
  popover/copy minimalism conventions.
- Badge visual treatment for D-13 (variant, color) within `theme.ts` conventions.
- The specific mechanism for per-surface platform lists in D-14 (new prop vs. per-caller
  constant) — the constraint is only that the shared `Platform` type and `FilterPanel`'s
  hardcoded `PLATFORMS` must not gain a chip that renders on Openings/Endgames/GlobalStats.
- SAN normalization details feeding the D-16 hash (whitespace, move-number handling), as
  long as it is deterministic and header-independent.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase source of truth
- `.planning/seeds/SEED-144-analysis-fen-pgn-paste.md` — the ten locked decisions
  (D-01..D-10), the measured chess.js 1.4 `loadPgn()` capability matrix, the seven-row
  reuse-anchor table with file:line, the Navigation (D-09/D-10) implementation checklist,
  and the fully reasoned rejection of bulk multi-game PGN import. **Do not re-derive the
  bulk-import rejection, the ephemeral-vs-persist split, or the nav-array analysis.**
- `.planning/ROADMAP.md` § Phase 208 — goal, scope, six locked constraints, nine Success
  Criteria (PASTE-01..PASTE-09 are minted at planning, one per Success Criterion in order),
  and non-goals.

### Backend seams this phase touches
- `app/repositories/query_utils.py:30` — `DEFAULT_EXCLUDED_PLATFORMS`, the ONE central
  analytics-exclusion seam. Its comment explicitly forbids scattering per-router platform
  checks. Add `'pgn'` here (D-05).
- `app/services/normalization.py:590` — `normalize_flawchess_game()`, the function a PGN
  variant is derived from. The gate to drop is its `[%clk]`-for-both-colors requirement
  (STORE-02/D-15, visible at ~`:620`), which no pasted PGN will satisfy. Note WR-02 there:
  starting side-to-move is derived from `game.board().turn`, not assumed White.
- `app/services/library_service.py:868` — `library_platform` substitution. **Counter-example,
  not a template**: this is where `flawchess` opted back into the Library; `pgn` must not
  (D-11).
- `app/services/store_bot_game_service.py` — precedent for a non-API `platform` value and
  for the `normalize → _flush_batch → post-insert lookup → single commit` orchestration
  shape. Note `_flush_batch` never commits (WR-05); the service owns the transaction.
- `app/routers/imports.py:380` — `POST /imports/eval/tier1`, IDOR-guarded, 404-never-403.
  The enqueue path (D-08).
- `app/models/game.py:47-50,127` — `uq_games_user_platform_game_id` on
  `(user_id, platform, platform_game_id)`; `platform_game_id` is `String(100)`.

### Frontend seams this phase touches
- `frontend/src/App.tsx:77` (`NAV_ITEMS`), `:85` (`BOTTOM_NAV_ITEMS`), `:113-119` (the WR-07
  comment recording a shipped bug from nav surfaces silently disagreeing), `:120`
  (`IMPORT_EXEMPT_ROUTES`), `:130` (`isActive`). See the seed's Navigation checklist.
- `frontend/src/hooks/useAnalysisBoard.ts:85` — `loadMainLine(sans, newRootFen)`, the PGN
  load path.
- `frontend/src/lib/analysisUrl.ts` — `parseAnalysisFenParam` (already chess.js-validated,
  degrades malformed input to null) and the documented `fen > line` precedence D-03 protects.
- `frontend/src/pages/Analysis.tsx` — 3875 lines. `:3607` movelist header (D-19 trigger
  site), `:3501` mobile tabs, `:3180` PlayerBar gating on `isGameMode && gameData`, `:2540`
  bare-free-play reset, `:567` `isGameMode = gameId != null`.
- `frontend/src/components/results/LibraryGameCard.tsx:818` — the badge slot (D-13).
- `frontend/src/components/filters/FilterPanel.tsx:181` — `PLATFORMS`/`PLATFORM_LABELS`
  (D-14), and `:428` the `show('platform')` section gate.
- `frontend/src/types/api.ts:165` — `export type Platform = 'chess.com' | 'lichess'`.

### Project conventions that bind this phase
- `CLAUDE.md` § Frontend — `data-testid` on every interactive element, semantic HTML
  (the modal is a `<form>`), `text-sm` minimum font size, mobile-first, apply changes to
  both desktop and mobile surfaces, `brand-outline` for secondary buttons.
- `CLAUDE.md` § Error Handling & Sentry — backend `capture_exception` in non-trivial
  `except` blocks, but skip expected `ValueError`-shaped user-input failures (a malformed
  paste is expected, not a bug); frontend TanStack Query errors are already captured
  globally in `queryClient.ts`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

Almost all of this exists — see the seed's seven-row reuse-anchor table. Additions found
during this discussion's scout:

- **`LibraryGameCard`'s platform slot is already empty for pasted games.** `PlatformIcon`
  returns `null` for any platform not in `PLATFORM_ICONS` (only `chess.com` and `lichess`
  are registered), and the external link renders conditionally on `gameUrl`. A pasted game
  with no `platform_url` therefore renders an empty `ml-auto shrink-0` span — D-13's badge
  drops straight in.
- **The Flaws tab needs no exclusion work.** Only `get_library_games` substitutes a default
  platform list; every other library query reaches `apply_game_filters` directly and
  inherits `DEFAULT_EXCLUDED_PLATFORMS`.
- **`Tabs defaultValue="moves"`** means the D-19 trigger is on-screen at mobile landing.

### Established Patterns

- **`DEFAULT_EXCLUDED_PLATFORMS` is the one central exclusion seam** (Phase 167 D-02). Its
  own comment forbids per-router platform checks. Both D-05 and D-11/D-12 depend on this
  holding.
- **`BoardControls` is board navigation only** — four buttons, `flat`/`size` variants,
  mobile renders full-width "like the main nav" (`Analysis.tsx:3029`). D-19 keeps it at four.
- **`FilterPanel`'s `visibleFilters` is section-level granularity.** There is no existing
  per-chip scoping mechanism; D-14 requires introducing one.

### Integration Points

Two facts verified during scout that **close potential gray areas before planning**:

1. **A pasted game cannot accidentally unlock the import-gated nav.**
   `navUnlocked = totalGames > 0 && tier1` where
   `totalGames = profile.chess_com_game_count + profile.lichess_game_count`
   (`frontend/src/App.tsx:148`). A `platform='pgn'` row contributes to neither count, so
   D-10's `IMPORT_EXEMPT_ROUTES` addition is the only gating change needed and there is no
   risk of a paste silently unlocking Openings/Endgames/Train for a zero-import user.

2. **Anonymous users do not exist on `/analysis`; guests are already covered.**
   `App.tsx:610` redirects tokenless visitors to `/login`, so every `/analysis` visitor
   carries an identity (real account or guest). D-08's "guests get this too" needs no
   account-bootstrapping work — tier-1 is already open to guests for their own games via
   the QUEUE-08 carve-out.

### Measured chess.js 1.4 behavior (this discussion, extending the seed's matrix)

Run against the project's installed `chess.js`. These are measurements, not assumptions:

| Input | Result |
|---|---|
| Bare FEN | THROWS `Expected NAG, brace comment, … but "/" found` (syntax class) — this is what makes D-01's one-box sniffing safe |
| Valid movetext | OK |
| Well-formed SAN, illegal in position (`3. Nh6`) | THROWS `Invalid move in PGN: Nh6` (semantic class) |
| Syntactically broken (`3. Qh9`) | THROWS syntax class |
| Plain garbage (`hello world this is not chess`) | THROWS **semantic** class — same shape as a real game with one bad move |
| Empty string | OK, 0 moves |
| Headers only, no movetext | OK, 0 moves |
| `[SetUp]`+`[FEN]` root | **Honored** — board adopts header FEN |
| `[SetUp]`+`[FEN]` with **Black to move** (`1... Ke7 2. e4`) | **Honored, correct** |
| **State after a throw** | **Valid prefix RETAINED on the instance** — `history()` returns the moves that parsed |

The last row is D-21's landmine and the most important line in this table. The
garbage-produces-semantic-class row is D-22's rationale.

Two consequences for planning:
- Empty-string and headers-only input both parse *successfully* with zero moves. They must
  be rejected explicitly (there is no game to load or save) — the throw-based error path
  will never fire for them.
- The sniffing order that follows from the table: attempt `loadPgn`; on any throw, attempt
  `parseAnalysisFenParam`; if that yields a valid FEN take the FEN path, otherwise show the
  D-22 generic error.

</code_context>

<specifics>
## Specific Ideas

- **The Library rule in the user's own framing:** "we should probably filter out pasted
  games from the library by default and make sure they are not used for any cross-game
  stats. Only if a 'Pasted' filter is set in the filter panel should we show it in the
  games/flaws tab. Users might paste games which are not theirs, and this would pollute
  their stats and game history."

  Note this explicitly covers **both** the games tab and the flaws tab, and the stated
  motive — pasted games are frequently *other people's* games — is the reason the exclusion
  is default-on rather than a preference. It generalizes: if a future surface asks "should
  pasted games appear here?", the answer is no unless the user explicitly asked for them.

- **Badge placement was specified precisely:** "top right of the game card where the
  platform link would be."

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

Three gray areas were identified but the user judged them resolvable by research and
planning without further input. Recording them so planning knows they were surfaced
deliberately, not missed:

1. **Side-selector pre-fill when neither header name is the user.** D-06 defaults to White;
   how the parsed White/Black header names are presented when neither matches the user's
   known usernames is a planning detail.
2. **PlayerBar rendering for an unsaved pasted game.** SC-2 requires names/ratings/result/date
   to reach the PlayerBar, but `gameData` is null in ephemeral mode and the PlayerBar is
   gated on `isGameMode && gameData` (`Analysis.tsx:3180`). Planning must find a shape for
   header-sourced player data that does not fake a `gameData` object.
3. **Marking a saved-but-never-analyzed pasted game eval-ineligible (SC-7).** The seed's
   "Notes for whoever plans this" flags `ix_games_user_evals_pending` and the
   `users_with_zero_pending` gate. D-04 + D-08 largely dissolve this, but the explicit
   ineligibility marking still needs a mechanism.

</deferred>

---

*Phase: 208-analysis-fen-pgn-paste*
*Context gathered: 2026-08-08*
