# Phase 208: Paste a FEN or PGN on /analysis - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-08
**Phase:** 208-analysis-fen-pgn-paste
**Areas discussed:** Library visibility + route back, platform_game_id + re-paste, Entry point + discoverability, Malformed / partial-parse errors

Areas were offered against SEED-144's ten already-locked decisions (D-01..D-10) and the two
open questions ROADMAP.md carried forward. Nothing locked was re-opened.

---

## Library visibility + route back

### Q1: Should saved pasted games appear in the Library Games tab?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, alongside everything else | Add "pgn" to `library_service.py:868`'s opt-in list, same as flawchess bot games. Durable route back. Cost: Games tab mixes played and pasted games; no chip to separate them. | (initially) |
| Yes, but only via an explicit filter | Not in the default view; visible only under a "Pasted" chip. Default tab keeps meaning "games you played". Cost: route back is two clicks and only findable if you know the chip exists. | ✓ (final) |
| No — keep them out entirely | Invisible everywhere; only route back is the browser URL. Cost: analysis effectively lost after navigating away. | |

**User's choice:** Opt-in only via a "Pasted" chip — **revised from the initially-selected
"alongside everything else"** when the user clarified.

**Notes:** The user interrupted the follow-up question to restate the rule: *"we should
probably filter out pasted games from the library by default and make sure they are not
used for any cross-game stats. Only if a 'Pasted' filter is set in the filter panel should
we show it in the games/flaws tab. Users might paste games which are not theirs, and this
would pollute their stats and game history."*

Two things this added beyond the offered option: it covers the **Flaws tab** as well as
Games, and it supplies the motive — pasted games are frequently *other people's* games,
which is why the exclusion is default-on rather than a preference. The revised answer is
more consistent with D-05 than the original was: `platform='pgn'` is excluded everywhere by
default, Library included, with no exception.

Scout finding that made the revision cheap: only `get_library_games` performs the
default-platform substitution. The Flaws tab already inherits `DEFAULT_EXCLUDED_PLATFORMS`
via `apply_game_filters`, so hiding pasted games needs **no** backend change — the work is
only the chip that opts them back in.

### Q2: After "Analyze full game" saves the row, what should the page do?

| Option | Description | Selected |
|--------|-------------|----------|
| Switch to `?game_id=N` | Navigate to the saved game's normal analysis URL. Survives refresh, real game-mode experience, URL becomes the route back. D-03 only bars `?fen=`/`?line=`, so `fen > line` precedence untouched. Cost: visible remount and refetch mid-flow. | ✓ |
| Stay ephemeral, show progress in place | Board unchanged; a pill or toast reports the eval job. Cost: refresh still loses everything, and the page shows a position that DOES have a DB row while behaving as if it doesn't. | |
| You decide | Let planning pick from how the game-mode/free-play split behaves. | |

**User's choice:** Switch to `?game_id=N`.

**Notes:** Combines with Q1 — since the Library no longer offers a default route back, the
URL carries that role. Also makes the D-17 silent-reuse behavior read naturally: a re-paste
just lands on the existing analysis.

### Q3: Do pasted games need a visual marker in the Library list?

| Option | Description | Selected |
|--------|-------------|----------|
| "Pasted" badge | Text badge on the card. Scales to future platforms, no new SVG. | ✓ |
| Clipboard icon in `PlatformIcon` | Register a `'pgn'` entry so the icon slot fills instead of rendering null. Cost: an icon can't say "excluded from your stats". | |
| No marker | Consistent with how flawchess bot games are treated. Cost: a pasted broadcast game sits next to your own with nothing distinguishing it. | |

**User's choice:** A "Pasted" badge, placed *"top right of the game card where the platform
link would be."*

**Notes:** This question was asked and then re-asked — the first attempt bundled it with the
filter-chip question and was interrupted for the clarification above. Placement verified as
free: `LibraryGameCard.tsx:818` renders an `ml-auto shrink-0` span that is entirely empty for
a pasted game, since `PlatformIcon` returns null for unregistered platforms and the external
link is conditional on a `platform_url` that a pasted game does not have.

### Q4: Should the Library filter panel get a platform chip for pasted games?

Not asked as a separate question — the user's clarification made it a given (the chip is the
sole visibility mechanism). What *was* resolved during scout is its scope: the chip must be
Library-only. `FilterPanel`'s `visibleFilters` prop is section-level, not chip-level, and
`PLATFORMS` is hardcoded at `FilterPanel.tsx:181` while Openings, Endgames and GlobalStats
share the same component — a chip there would be a dead control, since locked constraint 4
keeps pasted games out of those surfaces unconditionally.

---

## platform_game_id + re-paste

### Q1: What goes into the deterministic hash?

| Option | Description | Selected |
|--------|-------------|----------|
| Mainline SAN + root FEN | Headers excluded as the unreliable part (seed corpus: one player spelled twelve ways, so header-inclusive hashing means the same game from a different source creates a duplicate). Root FEN in so a `[SetUp]` paste can't collide with a from-start paste sharing a SAN list. Residual: two different short games with identical moves from identical roots collide. | ✓ |
| Mainline SAN only | Simplest. Cost: a puzzle position and a full game sharing a SAN sequence collide; a `[SetUp]` paste can silently open a different position's row. | |
| SAN + root FEN + White/Black/Date/Result headers | Maximum distinguishing power. Cost: that is exactly the fragile input — any header difference between two sources produces a second row, so re-pasting usually does NOT dedupe, defeating the purpose. | |

**User's choice:** Mainline SAN + root FEN (the recommended option).

**Notes:** Grounded in the constraint shape — `platform_game_id` is `String(100)` and unique
on `(user_id, platform, platform_game_id)`, so a SHA-256 hex digest fits and two users
pasting the same game never collide with each other. No precedent to copy: the bot-game path
uses a client-minted UUID (`normalization.py:689`), which is not deterministic.

### Q2: What happens when "Analyze full game" hits an existing row?

| Option | Description | Selected |
|--------|-------------|----------|
| Silently reuse and open it | Look up the row, navigate to `?game_id=N`. Reads as the feature working, not a special case. Cost: no signal it was a repeat. | ✓ |
| Reuse, with a brief toast | Same behavior plus "You've already analyzed this game". Cost: one more UI string. | |
| Reuse and re-enqueue tier-1 | Only sensible if the previous run was incomplete. Cost: burns engine capacity re-analyzing finished games. | |

**User's choice:** Silently reuse and open it.

### Q3: Re-pasting the same game with the OTHER side selected?

| Option | Description | Selected |
|--------|-------------|----------|
| Update `user_color` on the existing row | Your row, your call. `game_flaws` stores both players' flaws, so nothing is lost or recomputed — only orientation and which side reads as "yours" change. Cost: the row mutates under a re-paste. | ✓ |
| Keep the original `user_color` | First paste wins; immutable rows. Cost: no way to flip perspective, and the modal's side selector visibly does nothing — reads as a bug. | |
| Make `user_color` part of the hash | Both perspectives coexist. Cost: two rows and two tier-1 eval jobs for one game — double engine work for a view toggle, and it contradicts idempotent re-pasting. | |

**User's choice:** Update `user_color` on the existing row.

---

## Entry point + discoverability

### Q1: Where should the paste trigger live?

| Option | Description | Selected |
|--------|-------------|----------|
| Move-list card header | Compact button in the existing `analysis-movelist-header` band, present in every mode. Leaves `BoardControls` 4-wide. Cost: on mobile the move list is inside a tab. | ✓ |
| Fifth button in `BoardControls` | Always visible, no tab switching. Cost: semantically board navigation, and turns the 4-wide mobile footer into 5-wide at 375px where SC-9 requires the flow to work. | |
| Both: empty-state CTA + persistent button | Best discoverability. Cost: two entry points to build, style and test. | |

**User's choice:** Move-list card header.

**Notes:** The stated cost turned out not to apply — `Tabs defaultValue="moves"`
(`Analysis.tsx:3501`), so the Moves tab is the default and the header is on-screen the moment
a user lands on mobile. No tab switch needed. The header is currently only an icon plus the
word "Moves" in a `size="compact"` CardHeader, leaving room for a right-aligned trigger.

### Q2: Should the trigger appear in `?game_id=` game mode?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — always visible | One consistent affordance; paste a new game without navigating away. Cost: pasting while viewing a saved game replaces what you're looking at. | ✓ |
| Free play only | Cleaner separation. Cost: after the post-save navigation you're in game mode, so the trigger vanishes the moment you use it. | |
| You decide | Let planning judge from the mode split. | |

**User's choice:** Yes — always visible.

---

## Malformed / partial-parse errors

Both questions in this area were preceded by direct measurement of the project's installed
`chess.js` rather than relying on the seed's matrix. Three findings changed the option set:
`loadPgn` **retains the valid prefix on the instance after throwing**; the two error classes
(syntax vs semantic) do not separate "broken real game" from "not a game at all", because
plain garbage produces the semantic class; and `[SetUp]`/`[FEN]` roots are honored including
Black-to-move.

### Q1: A PGN whose mainline breaks partway?

| Option | Description | Selected |
|--------|-------------|----------|
| Reject the whole paste | Inline error, load nothing. No chance of silently analyzing a truncated game — truncation produces real-looking but wrong flaws and a wrong result. Cost: one bad move late in a long game makes it unusable. | ✓ |
| Load what parsed, warn explicitly | Salvages long games with one bad token. Cost: the warning must survive into the save path or a truncated game gets persisted with a wrong result header. | |
| Load what parsed, but block saving | Salvage value with truncated rows structurally impossible. Cost: a third state to build and test. | |

**User's choice:** Reject the whole paste.

**Notes:** This makes the retained-prefix measurement a landmine rather than a feature — a
naive catch-and-read implementation would silently load a truncated game, the exact SC-3
failure. Recorded in CONTEXT.md D-21: the instance must be discarded on throw.

### Q2: How specific should the error message be?

| Option | Description | Selected |
|--------|-------------|----------|
| Plain-language, format-aware | Distinguish FEN-invalid vs PGN-broken vs neither. Cost: several strings, and garbage vs broken-PGN can't be told apart (both semantic class). | |
| One generic message | "Couldn't read that as a FEN or PGN." One string, no false precision about a case the error classes can't distinguish. Cost: no hint where a nearly-good PGN broke. | ✓ |
| Surface the chess.js message | Maximally precise. Cost: a mistyped FEN produces `Expected NAG, brace comment, end of input, game termination marker, …` — unreadable to a chess player. | |

**User's choice:** One generic message.

---

## Claude's Discretion

The user did not select "You decide" on any question. Discretion recorded in CONTEXT.md was
scoped by Claude from the decisions themselves:

- Exact error-copy wording (D-22), subject to the `text-sm` floor and popover/copy
  minimalism conventions.
- Badge visual treatment for D-13 within `theme.ts` conventions.
- The mechanism for per-surface platform lists in D-14 (new prop vs. per-caller constant).
- SAN normalization details feeding the D-16 hash, as long as it stays deterministic and
  header-independent.

## Deferred Ideas

No scope creep occurred — the discussion stayed inside the phase boundary throughout.

Three gray areas were offered in the closing question and the user judged them resolvable by
research and planning without further input. They are recorded in CONTEXT.md `<deferred>` so
planning knows they were surfaced deliberately rather than missed:

1. Side-selector pre-fill when neither parsed header name is the user (D-06 defaults to White).
2. PlayerBar rendering for an unsaved pasted game — SC-2 requires header data to reach it,
   but `gameData` is null in ephemeral mode and the PlayerBar is gated on
   `isGameMode && gameData` (`Analysis.tsx:3180`).
3. The mechanism for marking a saved-but-never-analyzed pasted game eval-ineligible (SC-7).
