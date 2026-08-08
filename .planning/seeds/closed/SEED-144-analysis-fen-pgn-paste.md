---
id: SEED-144
status: active
planted: 2026-08-08
planted_during: /gsd-explore — "implement PGN and FEN import"
trigger_when: next milestone that touches the /analysis surface, or any time a small
  self-contained frontend+backend slice is wanted
scope: small-to-medium (one modal, one parse helper, one normalization variant, one
  platform value added to an existing exclusion tuple, one nav item — no migration,
  no new eval infra)
---

# SEED-144: Paste a FEN or PGN on /analysis to load a position or a game

## Why This Matters

`/analysis` can only be reached with a position someone else constructed: `?line=` from the
Openings explorer, `?fen=` from the calibration harness, `?game_id=` from the Library. There
is no way to bring an arbitrary position or game in from outside — a puzzle FEN from a
book, a game from a tournament broadcast, a PGN a friend sent. The board, the engines, the
variation tree and the eval pipeline are all already built; the only thing missing is a door.

The expensive half of "PGN import" (bulk multi-game files on the Import page) was explored
and **rejected** — see Rejected Alternatives. This seed is the cheap half, which is also the
half that gets used.

## Locked Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D-01 | Input is a **button + modal** on `/analysis`, one textarea, format sniffed | Discoverable, out of the way, easy to give a `data-testid`. Sniffing is reliable: a bare FEN passed to `loadPgn()` throws a *distinguishable* parse error (`Expected NAG, brace comment, end of input, game termination`), so one box handles both without a format toggle |
| D-02 | **Mainline + headers only.** Comments and variations dropped | chess.js silently drops RAVs anyway; keeping them means hand-rolling a RAV parser. Headers feed the PlayerBar (names, ratings, result, date) for free |
| D-03 | **Ephemeral** — no `?fen=`/`?line=` write-back | A refresh returns to the start position. Keeps the documented `fen > line` precedence in `analysisUrl.ts` untouched; a `[SetUp]`-rooted PGN would otherwise need fen+line to compose |
| D-04 | Persist **only** on an explicit "Analyze full game" action | Paste-and-look leaves no DB rows. Two flows, but avoids accumulating throwaway rows the user must clean up |
| D-05 | `platform='pgn'`, added to `DEFAULT_EXCLUDED_PLATFORMS`. **Always** excluded, no per-game opt-in | One rule, no flag, no ambiguity. Consequence accepted: a pasted game *of your own* also does not count toward your Openings WDL / Endgames / Insights — if you want it in your stats, import it from the platform where you played it |
| D-06 | **Side selector in the modal** sets `user_color` (parsed White/Black header names, defaults to White) | `games.user_color` is `NOT NULL` but in a pasted game neither player need be the user. Drives board orientation and which side's flaws read as "yours". `game_flaws` stores both players regardless, so no data is lost either way |
| D-07 | Untimed: no clocks, no TC bucket | Pasted PGNs rarely carry `[%clk]` or `TimeControl`. They drop out of TC-filtered views and time-management stats. Accept the holes rather than prompting for a per-paste time control |
| D-08 | Analysis via the existing `POST /imports/eval/tier1` explicit enqueue | Not the background lottery. Tier-1 is already open to guests for their own games (QUEUE-08 gate opened for tier-1 only), so guests get this too, with no new eval infrastructure |
| D-09 | **`/analysis` gets a main nav item** — added to `NAV_ITEMS` only, NOT to `BOTTOM_NAV_ITEMS` | Desktop header + mobile More drawer, mobile bottom bar untouched. Without this the paste modal is unreachable: `/analysis` is deep-link-only today. See "Navigation" below for why touching one array achieves both surfaces |
| D-10 | **`/analysis` added to `IMPORT_EXEMPT_ROUTES`** — clickable with zero games | The route is already ungated and guest-friendly by design; a locked nav entry pointing at an open route is incoherent, and it would lock out exactly the audience paste serves. Same rationale as `/bots` (D-17: "free bot play, whose audience IS guests and zero-game users"). Accepted cost: a brand-new user now sees two unlocked items competing with the Library import CTA that onboarding funnels toward |

A bare **FEN** paste is always ephemeral — no moves means no game to analyze, so D-04/D-05/D-06/D-08
simply do not apply to it. It seeds a free-play root, exactly as `?fen=` does today.

## Reuse Anchors

Almost all of this exists. The work is wiring, not building.

| Need | Existing code |
|------|---------------|
| Load a SAN mainline with a possibly non-standard root | `useAnalysisBoard.loadMainLine(sans, newRootFen)` — `frontend/src/hooks/useAnalysisBoard.ts:85` |
| Validate a pasted FEN | `parseAnalysisFenParam` — `frontend/src/lib/analysisUrl.ts` (already chess.js-validated, degrades malformed input to null) |
| Normalize arbitrary PGN text into a `Game` row | `normalize_flawchess_game()` — `app/services/normalization.py:590`. Handles `[SetUp]`/`[FEN]` including Black-to-move starts (WR-02), derives result / termination / ECO / TC. **The one gate to drop:** its `[%clk]`-for-both-colors requirement (STORE-02/D-15), which no pasted PGN will satisfy |
| Compute `ply_count`, `result_fen`, Zobrist `game_positions` | `_flush_batch` Stage 5 (`_collect_position_rows` → `process_game_pgn`) — already runs for every newly inserted game |
| Keep the games out of default analytics | `DEFAULT_EXCLUDED_PLATFORMS` — `app/repositories/query_utils.py:30`. Phase 167 D-02 built this exact seam for bot games; the comment there explicitly says it is the ONE central seam and not to scatter per-router platform checks |
| Explicit per-game analysis | `POST /imports/eval/tier1` — `app/routers/imports.py:380` (IDOR-guarded, 404-never-403) |
| Precedent for a non-API platform value | `store_bot_game_service.py:29` — `platform='flawchess'` bot games |

## Navigation (D-09 / D-10)

`/analysis` is currently reachable only by deep link — from the Openings explorer (`?line=`),
the Library (`?game_id=`), a finished bot game, or the calibration harness (`?fen=`). There is
no nav entry, which is why a paste modal alone would not be discoverable. Notably
`ROUTE_TITLES` at `frontend/src/App.tsx:106` *already* carries `'/analysis': 'Analysis'`, so the
mobile header title exists; only the nav item is missing.

**The one-array trick.** `NAV_ITEMS` (`App.tsx:77`) and `BOTTOM_NAV_ITEMS` (`App.tsx:85`) are
byte-identical duplicate arrays today, but they feed different surfaces:

| Array | Consumed by | Surface |
|-------|-------------|---------|
| `NAV_ITEMS` | `NavHeader` (`:174`), `MobileMoreDrawer` (`:467`) | desktop header + mobile More drawer |
| `BOTTOM_NAV_ITEMS` | `MobileBottomBar` (`:383`) | mobile bottom bar |

So adding Analysis to `NAV_ITEMS` **only** yields exactly the requested placement — desktop nav
item, mobile inside More, bottom bar unchanged — and makes the two arrays diverge for the first
time. That is what the split is for, but add a comment saying so: WR-07 (`App.tsx:113-119`)
records this codebase already shipping a bug from nav surfaces silently disagreeing
(`MobileBottomBar`'s copy of the lock gate omitted `/admin`, and Phase 171 then had to patch
all three surfaces to add `/bots`). A reader who assumes the arrays are meant to stay in sync
will "fix" the divergence.

Checklist for whoever implements it:

- [ ] Append `{ to: '/analysis', label: 'Analysis', Icon: … }` to `NAV_ITEMS` (`App.tsx:77`) — **not** `BOTTOM_NAV_ITEMS`
- [ ] Add a comment on both arrays explaining the intentional divergence (WR-07 lesson)
- [ ] Add `'/analysis'` to `IMPORT_EXEMPT_ROUTES` (`App.tsx:120`) — D-10
- [ ] Add an `isActive` clause (`App.tsx:130`): the helper is an explicit `if (to === '/x') return pathname.startsWith('/x')` chain, so a missing line means the item never highlights
- [ ] `ROUTE_TITLES` already has the entry — no change needed
- [ ] `data-testid`: the drawer link derives its testid as `drawer-nav-${to.slice(1)}` → `drawer-nav-analysis`, automatic. Verify the desktop header does the same
- [ ] `App.test.tsx:576` already asserts on `mobile-nav-more`; check whether existing nav tests enumerate the item lists and need updating

**Watch for:** the analysis page takes over the mobile shell (`App.tsx:331`, `:537-540`) — a
back-button header replaces the normal chrome and `isAnalysisRoute` suppresses the bottom bar.
Confirm that navigating *to* `/analysis` from the More drawer lands correctly and that the
back button behaves sanely when the user arrived from the drawer rather than from a deep link.

## chess.js 1.4 `loadPgn()` capability matrix (measured, not assumed)

| PGN feature | Behavior |
|---|---|
| Headers (White/Black/Result/Date/Elo/TimeControl) | preserved via `getHeaders()` |
| Mainline SAN | correct, even on ChessBase-annotated input |
| `[SetUp "1"]` + `[FEN "..."]` start position | **honored** — board adopts the header FEN |
| `{comments}` | preserved with FEN anchors via `getComments()` |
| Variations / RAVs `(7. Nf3)` | **silently dropped** |
| NAGs (`$146`) | silently dropped |
| Headerless movetext (`1. e4 e5 …`) | parses fine |
| A bare FEN string | throws a **distinct** parse error — this is what makes one-box format sniffing safe |

## Open Questions

1. **Do pasted games appear in the Library list?** Without it there is no route back to a
   game you analyzed once you navigate away. `library_service.py:868` builds
   `library_platform = platform if platform is not None else ["chess.com", "lichess", "flawchess"]`
   — adding `"pgn"` is a one-token change, so this is a product call, not a cost question.
   If yes, consider whether they need a visual marker distinguishing them from played games.
2. **How is `platform_game_id` synthesized?** The `uq_games_user_platform_game_id` constraint
   needs a value, and PGN carries no game ID. A deterministic hash of the movetext (plus
   date/players) makes re-pasting the same game idempotent for free rather than creating a
   duplicate row on every re-analysis.

## Rejected Alternatives

### Bulk multi-PGN import on the Import page — REJECTED

The original ask included uploading multi-game PGN files (e.g. a 1,887-game archive) on the
Import page. Explored, then cut as "barely used, messy, and too much complexity." The corpus
evidence from the two sample files is worth keeping so this is not re-litigated:

| | `naroditsky-all.pgn` | `Games Noël.pgn` |
|---|---|---|
| Games | 1,887 | 982 |
| Carry a `TimeControl` header | 17 (0.9%) | 44 (4.5%) |
| Carry `[%clk]` clock data | 0 | 0 |
| Extras | plain movetext | ChessBase: RAVs, NAGs, `{comments}`, `[%mdl]` |

The blocking problem was **subject-player identification**. `games.user_color` is `NOT NULL`,
so every imported game needs a determinate subject, and getting it wrong silently *inverts*
the W/D/L — corrupting the exact thing the product measures. `Games Noël.pgn` spells one
player twelve ways: `Noël, Studer` / `studer, noel` / `studer , noel` / `studer noel` /
`Studer, Noël` / `studer, Noel` / `IM Studer Noel 2438 (SUI)` and more — varying in case,
comma placement, diacritics, **token order**, and title/rating/federation prefixes. Tractable
via normalize-and-token-set-compare plus a confirmation preview, but that is a real subsystem
for a feature whose population largely reaches us anyway: strong players archive to lichess,
from which the existing importer already works.

Also rejected along the way, with reasons:

- **Separate guest account as the "scouting library" mechanism.** Superficially free (guest
  infra exists, 30-day auto-purge suits throwaway scouting), but: guests are excluded from
  the entire eval pipeline by QUEUE-08 (`eval_queue_service.py` JOINs `users` and filters
  `NOT is_guest` on every claim path), so the scouting account gets no flaws / endgames /
  insights; and the guest JWT *replaces* `localStorage.auth_token`, making it an account
  **switch**, not a side collection — you would have to log out of your real account and
  build account-switching UX, which is more new surface than the separation itself.
  `DEFAULT_EXCLUDED_PLATFORMS` achieves the same separation as a filter, in the same account.
- **Per-game "count this in my stats" opt-in** (D-05). Needs a second platform value or a
  boolean column plus filter plumbing through `apply_game_filters()`. Not worth it for the
  one case it serves.
- **URL write-back for pasted games** (D-03). Would require making `?fen=` and `?line=`
  compose, changing a documented precedence rule, to gain shareability nobody asked for.
- **Full-fidelity PGN with variations grafted as sidelines** (D-02). `useAnalysisBoard`
  supports sidelines via `insertPvLine`, so it is possible, but it means writing a RAV parser
  chess.js does not provide. Expensive by a wide margin relative to the rest of this seed.

## Notes for whoever plans this

- Watch `evals_completed_at`. Rows saved with it left `NULL` forever would feed
  `ix_games_user_evals_pending` — a partial index the `Game` model comments describe as
  "near-zero size at steady state" — and the `users_with_zero_pending` gate. D-04 + D-08
  largely dissolve this (few rows, and tier-1 completes them), but a pasted game that is
  saved and then never analyzed should still be marked ineligible rather than left pending.
- Frontend rules that apply: `data-testid` on the trigger button, modal, textarea, side
  selector and load/analyze buttons; `data-testid` on the modal container itself; the modal
  is a `<form>`; minimum font size is `text-sm`; the paste modal must work at 375px.
