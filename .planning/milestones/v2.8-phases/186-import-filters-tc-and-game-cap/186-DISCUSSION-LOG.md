# Phase 186: Import Filters — Time Controls + Game Cap - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-24
**Phase:** 186-import-filters-tc-and-game-cap
**Areas discussed:** Filter change → backfill trigger, Import tab layout & save semantics, At-cap & progress display, TC bucket edge cases, Fetch order (user-raised)

---

## Filter change → backfill trigger

| Option | Description | Selected |
|--------|-------------|----------|
| On next Sync click | Settings persist; Sync = forward sync + backfill | ✓ |
| Auto-start on change | Save triggers backfill jobs immediately | |
| Separate 'Backfill' button | Dedicated button when history is available | |

**User's choice:** On next Sync click.

| Option | Description | Selected |
|--------|-------------|----------|
| Editable, applies next sync | Running job keeps its start-time settings | ✓ |
| Lock during active job | Disable controls while a job runs | |

**User's choice:** Editable, applies next sync.

| Option | Description | Selected |
|--------|-------------|----------|
| One job, both directions | Forward sync then backward backfill, one progress bar | ✓ |
| Two visible phases | Same job, phase-labeled progress UI | |
| Separate backfill job type | Own job type + status row | |

**User's choice:** One job, both directions.

---

## Import tab layout & save semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Shared section above platforms | One 'Import filters' card above both platform cards | ✓ |
| Shared section below platforms | Filters as secondary block below | |
| Inside each platform card | Duplicated controls per card | |

**User's choice:** Shared section above platforms.

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-save on toggle | Immediate PATCH, no Save button | ✓ |
| Explicit Save button | Staged changes + dirty state | |

**User's choice:** Auto-save on toggle.

| Option | Description | Selected |
|--------|-------------|----------|
| One line + info popover | Short inline line + HelpCircle popover with full rule | ✓ |
| Inline explainer only | 2-3 sentence paragraph, no popover | |
| Minimal labels only | No explanation | |

**User's choice:** One line + info popover.

---

## At-cap & progress display

| Option | Description | Selected |
|--------|-------------|----------|
| In each platform card | Per-platform counter near game count | ✓ (with note) |
| In the shared filter card | Both platforms' usage under the cap selector | |
| Both places | Counter in cards + summary in filter card | |

**User's choice:** In each platform card — **with a free-text note challenging the seed's cap model:** "the cap is per time-control/platform, not by platform alone. Should we just multiply the cap by the number of time-controls selected?"

**Follow-up (seed conflict surfaced explicitly):**

| Option | Description | Selected |
|--------|-------------|----------|
| Per (platform, TC) budgets | Each selected TC gets its own `cap` budget per platform | ✓ |
| Total per platform (seed) | Keep SEED-117 decision #3 | |
| Cap × #TCs, pooled | Multiplied cap counted as one pool | |

**User's choice:** Per (platform, TC) budgets — SEED-117 decision #3 overridden.

| Option | Description | Selected |
|--------|-------------|----------|
| Per-TC chips | 'Blitz 1000/1000 · Rapid 640/1000' rows per platform card | ✓ |
| Aggregate + popover detail | Summed line + breakdown popover | |
| Only show when at cap | Notice only when a budget is full | |

**User's choice:** Per-TC chips.

| Option | Description | Selected |
|--------|-------------|----------|
| Actual count, 'full' style | 'Blitz 8000/5000', honest over-cap display | ✓ |
| Clamp to cap | Display '5000/5000' | |
| Hide ratio when over | Count without denominator | |

**User's choice:** Actual count, 'full' style.

---

## TC bucket edge cases

| Option | Description | Selected |
|--------|-------------|----------|
| Classical toggle covers them | Correspondence stays under classical (status quo bucketing) | ✓ |
| Own 5th toggle | 'Daily' toggle | |
| Stop importing them | Exclude correspondence going forward | |

**User's choice:** Classical toggle covers them.

| Option | Description | Selected |
|--------|-------------|----------|
| Same UI as registered | Guests get identical controls and defaults | ✓ |
| Fixed defaults, no UI | Hidden/disabled for guests | |

**User's choice:** Same UI as registered.

| Option | Description | Selected |
|--------|-------------|----------|
| Always import, no budget | NULL-bucket games bypass filter and budgets | ✓ |
| Skip them | Don't import unbucketable games | |
| Count under classical | Treat NULL as classical | |

**User's choice:** Always import, no budget.

---

## Fetch order (user-raised at wrap-up)

User: "We might also change the platform import pipelines to import more recent games first, if that's not the case already. So the pipeline knows when to stop importing, without processing the oldest games."

| Option | Description | Selected |
|--------|-------------|----------|
| Newest-first + early stop | All backlog fetching newest-first; stop when selected budgets full | ✓ |
| Keep oldest-first for first import | Current forward walk fills budgets with oldest games | |

**User's choice:** Newest-first + early stop, with the explicit clarification: "Make sure the pipelines don't stop until all tc caps are filled" — stop condition is ALL selected TC budgets full (or history exhausted), never just one.

## Claude's Discretion

- Settings storage shape (table vs columns), API endpoint shape, migration details.
- Chip styling/copy, mobile layout of the filter card, backfill progress copy.
- Oldest-imported boundary persistence and interrupted-backfill resume.

## Deferred Ideas

- None; two keyword-matched todos (bitboard storage, 172 review findings) reviewed and not folded — unrelated to imports.
