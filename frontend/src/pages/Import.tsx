import { useState, useEffect, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import { X, DoorOpen, Infinity as InfinityIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Card, CardHeader, CardBody } from '@/components/ui/card';
import { PlatformIcon } from '@/components/icons/PlatformIcon';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useImportTrigger, useImportPolling } from '@/hooks/useImport';
import { useImportSettings, IMPORT_SETTINGS_QUERY_KEY, type ImportSettings } from '@/hooks/useImportSettings';
import { ImportFilterCard, TIME_CONTROLS, TIME_CONTROL_LABELS, isTcActive } from '@/components/filters/ImportFilterCard';
import { TimeControlIcon } from '@/components/icons/TimeControlIcon';
import { EvalCoverageHeader } from '@/components/EvalCoverageHeader';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useAuth } from '@/hooks/useAuth';
import { useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/api/client';


// Refresh cadence for the eval-coverage ("Quick Scan") banner and readiness
// queries while an import is active. Matched to the eval-coverage self-poll (3s)
// so the banner's rescue invalidation fires at the same cadence — the self-poll
// can briefly stop when pct_complete momentarily hits 100 (helper workers keep
// evals in lockstep), and this is the backstop that resumes it. Lowered from 5s
// (quick 260616-rm6) to halve the worst-case Quick Scan stall window.
const GAME_COUNT_REFRESH_INTERVAL_MS = 3000;
const MIN_GAMES_FOR_RELIABLE_STATS = 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function formatLastSync(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Math.max(0, Date.now() - then);
  if (diffMs < HOUR_MS) {
    const minutes = Math.max(1, Math.floor(diffMs / (60 * 1000)));
    return `last sync: ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  }
  if (diffMs < DAY_MS) {
    const hours = Math.max(1, Math.floor(diffMs / HOUR_MS));
    return `last sync: ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  const days = Math.floor(diffMs / DAY_MS);
  return `last sync: ${days} ${days === 1 ? 'day' : 'days'} ago`;
}

/**
 * Per-(platform, TC) chip row (D-11/D-12): one chip per currently-selected TC,
 * showing "{icon} {count}" where count is the total imported games in that TC (UAT
 * follow-up to Plan 03 — the chips now read as an honest breakdown of the header's
 * total game count, not just the cap-eligible pre-signup backlog, which silently
 * omitted post-signup games). Icon instead of label, no cap denominator — compact
 * mobile display; the cap itself stays visible in the Import filters card. Deselected
 * TCs render no chip at all — no dimmed placeholder. A chip at or over the cap uses
 * text-foreground/font-semibold (reads as "well-populated", never destructive/red);
 * a chip below the cap uses text-muted-foreground. The count can exceed the cap (a
 * grandfathered account keeps games imported before the cap existed). The TC name is
 * kept as sr-only text so the icon-only chip stays screen-reader legible.
 *
 * Untimed games (clock-less chess.com bot/coach games, D-15) always import and
 * count against no budget, so they get a trailing infinity chip — shown only
 * when the count is nonzero — so the chips still sum to the header's total.
 */
function BudgetChipRow({
  platform,
  platformSlug,
  settings,
}: {
  platform: 'chess.com' | 'lichess';
  platformSlug: string;
  settings: ImportSettings;
}) {
  const activeTcs = TIME_CONTROLS.filter((tc) => isTcActive(settings, tc));
  if (activeTcs.length === 0) return null;

  const untimedCount = settings.imported_counts[platform]?.untimed ?? 0;

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm" data-testid={`import-budget-chip-row-${platformSlug}`}>
      {activeTcs.map((tc) => {
        const count = settings.imported_counts[platform]?.[tc] ?? 0;
        const isFull = count >= settings.game_cap;
        return (
          <span
            key={tc}
            data-testid={`import-budget-chip-${platformSlug}-${tc}`}
            className={`inline-flex items-center gap-1 ${isFull ? 'text-foreground font-semibold' : 'text-muted-foreground'}`}
          >
            <TimeControlIcon timeControl={tc} className="h-3.5 w-3.5" />
            <span className="sr-only">{TIME_CONTROL_LABELS[tc]} </span>
            {count}
          </span>
        );
      })}
      {untimedCount > 0 && (
        <span
          data-testid={`import-budget-chip-${platformSlug}-untimed`}
          className="inline-flex items-center gap-1 text-muted-foreground"
        >
          <InfinityIcon className="h-3.5 w-3.5" aria-label="untimed" />
          <span className="sr-only">Untimed </span>
          {untimedCount}
        </span>
      )}
    </div>
  );
}

export interface ImportPageProps {
  onImportStarted: (jobId: string) => void;
  activeJobIds: string[];
  onJobDismissed: (jobId: string) => void;
}

function ImportProgressBar({ jobId, onDismiss, platformFilter, onProgress }: { jobId: string; onDismiss: (jobId: string) => void; platformFilter?: 'chess.com' | 'lichess'; onProgress?: (platform: string, gamesImported: number) => void }) {
  const { data } = useImportPolling(jobId);
  const queryClient = useQueryClient();

  const isDone = data?.status === 'completed';
  const isError = data?.status === 'failed';
  const isActive = !!data && !isDone && !isError;

  // Report live games_imported up to the page so the per-platform header count
  // climbs in lockstep with "saved" during an active import, instead of lagging
  // behind the 5-minute-staleTime userProfile COUNT(*). Runs before the
  // platformFilter early-return below; the parent dedupes by max-seen value.
  const importedCount = data?.games_imported;
  const platform = data?.platform;
  useEffect(() => {
    if (isActive && platform != null && importedCount != null) {
      onProgress?.(platform, importedCount);
    }
  }, [isActive, platform, importedCount, onProgress]);

  // Periodically refresh game counts while import is active.
  // Also invalidates the Stockfish eval-coverage query — its own 3s poll in
  // useEvalCoverage can stall during heavy concurrent imports (the user then
  // has to tab away and back to trigger refetchOnWindowFocus). Piggy-backing
  // on the import-active interval (which we know fires reliably because the
  // progress bars are visibly updating) guarantees the header appears soon
  // after the first game is imported.
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['userProfile'] });
      queryClient.invalidateQueries({ queryKey: ['gameCount'] });
      // Live-refresh the per-(platform, TC) chip counts during import. Backed by
      // a cheap indexed GROUP BY on games (count_imported_by_platform_and_tc) —
      // no new backend infra — so it's fine to piggy-back on the 3s import tick.
      queryClient.invalidateQueries({ queryKey: IMPORT_SETTINGS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['imports', 'eval-coverage'] });
      // Phase 96: also invalidate the readiness query so the import page reacts
      // to tier transitions (Tier 1 CTA and analyzing-endgames state) alongside
      // eval-coverage and endgameOverview.
      queryClient.invalidateQueries({ queryKey: ['imports', 'readiness'] });
      // Bug fix (Phase 94.1-11): the percentile background tasks (Stage A on
      // import-complete, Stage B on eval-drain) write to user_benchmark_percentiles
      // asynchronously. Without invalidating the endgame overview the 30s
      // queryClient staleTime serves the stale pre-import response and the
      // percentile badges only appear after a hard refresh.
      queryClient.invalidateQueries({ queryKey: ['endgameOverview'] });
    }, GAME_COUNT_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isActive, queryClient]);

  // Refresh the per-(platform, TC) chip counts once the import finishes. The
  // periodic interval above stops the moment isActive flips false, so its last
  // tick can miss the final batch of saved games; this final invalidation makes
  // the chips settle on the true count without a page reload.
  useEffect(() => {
    if (isDone) {
      queryClient.invalidateQueries({ queryKey: IMPORT_SETTINGS_QUERY_KEY });
    }
  }, [isDone, queryClient]);

  if (!data) return null;
  if (platformFilter && data.platform !== platformFilter) return null;

  const canDismiss = isDone || isError;

  // Phase 96 Constraint 3: the hot-import "done" copy must not over-claim completion
  // by saying "Imported N games" — Stockfish eval and percentile computation still
  // run after the import job finishes. Use a neutral status message instead.
  const progressText = isDone
    ? (data.games_imported === 0 ? 'No new games found since last sync' : `${data.games_imported} games imported.`)
    : isError
      ? `Import failed: ${data.error ?? 'Unknown error'}`
      : `Importing ${data.username} (${data.platform})... ${data.games_fetched} fetched, ${data.games_imported} saved`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className={`flex items-center gap-1.5 text-sm ${isError ? 'text-destructive' : isDone ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}>
          <span>{progressText}</span>
        </div>
        {canDismiss && (
          <Tooltip content="Dismiss">
            <button
              onClick={() => onDismiss(jobId)}
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
              data-testid={`btn-dismiss-progress-${jobId}`}
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        {isActive ? (
          <div className="h-full w-full origin-left animate-progress-indeterminate rounded-full bg-primary" />
        ) : isDone ? (
          <div className="h-full w-full rounded-full bg-green-600 dark:bg-green-500 transition-all duration-500" />
        ) : (
          <div className="h-full w-full rounded-full bg-destructive" />
        )}
      </div>
      {data.other_importers > 0 && (
        <Alert variant="info" className="mt-3" data-testid="import-concurrent-notice">
          {data.other_importers} other {data.other_importers === 1 ? 'user is' : 'users are'} also importing from {data.platform} — progress may be slower than usual.
        </Alert>
      )}
    </div>
  );
}

export function ImportPage({ onImportStarted, activeJobIds, onJobDismissed }: ImportPageProps) {
  const { logoutForPromotion } = useAuth();
  const { data: profile, isLoading: profileLoading } = useUserProfile();
  // ImportFilterCard (mounted below) surfaces the CLAUDE.md-mandated isError copy
  // for this same query — only need the data here, for the per-platform budget chips.
  const { data: importSettings } = useImportSettings();
  const trigger = useImportTrigger();
  const queryClient = useQueryClient();

  // Username state — always editable, synced from profile on first load only
  const [chessComUsername, setChessComUsername] = useState('');
  const [lichessUsername, setLichessUsername] = useState('');
  // Track whether username fields have been initialized from profile.
  // Without this guard, periodic profile refetches (game count refresh during import)
  // would overwrite whatever the user was typing in the other platform's input.
  const [initialized, setInitialized] = useState(false);

  // Per-platform error state
  const [chessComError, setChessComError] = useState<string | null>(null);
  const [lichessError, setLichessError] = useState<string | null>(null);

  // Track jobId→platform for active imports — disables sync button while running
  const [jobPlatforms, setJobPlatforms] = useState<Map<string, string>>(new Map());

  // Live per-platform games_imported reported by the active progress bars. Drives
  // the header "N games" count so it tracks "saved" during an import instead of
  // lagging the slower userProfile COUNT(*). Keyed by platform; stores max-seen.
  const [liveImported, setLiveImported] = useState<Record<string, number>>({});
  const handleProgress = useCallback((platform: string, gamesImported: number) => {
    setLiveImported((prev) =>
      (prev[platform] ?? 0) >= gamesImported ? prev : { ...prev, [platform]: gamesImported },
    );
  }, []);
  // Prefer the live import-job count while it exceeds the (slower) profile COUNT.
  // Math.max keeps incremental syncs correct: the full library count dominates a
  // small new-games delta, while a first import shows the live-climbing counter.
  const chessComGameCount = profile ? Math.max(profile.chess_com_game_count, liveImported['chess.com'] ?? 0) : 0;
  const lichessGameCount = profile ? Math.max(profile.lichess_game_count, liveImported['lichess'] ?? 0) : 0;

  // Sync usernames from profile only on first load, not on every refetch
  if (profile && !initialized) {
    setInitialized(true);
    setChessComUsername(profile.chess_com_username ?? '');
    setLichessUsername(profile.lichess_username ?? '');
  }

  // Delete all games dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // ── Sync handler ────────────────────────────────────────────────────────────

  const handleSync = async (platform: 'chess.com' | 'lichess') => {
    const username = platform === 'chess.com' ? chessComUsername.trim() : lichessUsername.trim();
    if (!username) return;

    // Clear previous error for this platform
    if (platform === 'chess.com') setChessComError(null);
    else setLichessError(null);

    try {
      const result = await trigger.mutateAsync({ platform, username });
      onImportStarted(result.job_id);
      setJobPlatforms((prev) => new Map(prev).set(result.job_id, platform));
      // Kick the eval-coverage header to refetch right away so it shows
      // pending as soon as the first batch of games lands, instead of
      // waiting for the next refresh tick.
      queryClient.invalidateQueries({ queryKey: ['imports', 'eval-coverage'] });
      // Refetch readiness immediately so the Explore buttons disable as soon as
      // the new job is in-flight. After a prior import reached Tier 2, the
      // readiness poll stops (refetchInterval returns false at tier2), so the
      // cached tier1/tier2=true would otherwise keep the buttons enabled until
      // a remount. Invalidating forces a refetch (tier1=false) and resumes polling.
      queryClient.invalidateQueries({ queryKey: ['imports', 'readiness'] });
    } catch (err) {
      Sentry.captureException(err, {
        tags: { source: 'import' },
        extra: { platform },
      });
      const message = err instanceof Error ? err.message : 'Import failed. Please check the username and try again.';
      if (platform === 'chess.com') setChessComError(message);
      else setLichessError(message);
    }
  };

  // ── Delete All Games ──────────────────────────────────────────────────────

  const handleDeleteAllGames = async () => {
    setIsDeleting(true);
    try {
      await apiClient.delete('/imports/games');
      setDeleteDialogOpen(false);
      // Bug fix: the header count is Math.max(profile count, liveImported), so a
      // same-session import's live counter would keep the old number on screen
      // after delete-all even once the profile refetches 0. Clear it first.
      setLiveImported({});
      queryClient.invalidateQueries({ queryKey: ['games'] });
      queryClient.invalidateQueries({ queryKey: ['gameCount'] });
      queryClient.invalidateQueries({ queryKey: ['userProfile'] });
      // Bug fix: the per-(platform, TC) chip counts live in imported_counts on
      // the import-settings query — invalidate so the chips drop to 0 without
      // a page reload.
      queryClient.invalidateQueries({ queryKey: IMPORT_SETTINGS_QUERY_KEY });
      // Bug fix (quick 260611): Library queries cache for 5 minutes — drop
      // them so the Games/Flaws tabs empty out immediately after delete-all.
      queryClient.invalidateQueries({ queryKey: ['library-games'] });
      queryClient.invalidateQueries({ queryKey: ['library-game'] });
      queryClient.invalidateQueries({ queryKey: ['library-flaws'] });
      queryClient.invalidateQueries({ queryKey: ['library-flaw-stats'] });
      // Bug fix (Phase 94.1-11): delete-all-games leaves the percentile rows
      // until the next import, but the endgame overview must drop the chip
      // immediately. Invalidate so the FE refetches and renders the empty state.
      queryClient.invalidateQueries({ queryKey: ['endgameOverview'] });
    } catch (err) {
      Sentry.captureException(err, {
        tags: { source: 'import' },
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // Derive which platforms have a non-dismissed active job
  const activePlatforms = new Set(jobPlatforms.values());

  const handleDismiss = (jobId: string) => {
    setJobPlatforms((prev) => { const next = new Map(prev); next.delete(jobId); return next; });
    onJobDismissed(jobId);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main data-testid="import-page" className="mx-auto w-full max-w-2xl px-4 py-6 md:px-6 space-y-8">
      <EvalCoverageHeader />
      {profile?.is_guest && (
        <Alert variant="info" icon={DoorOpen} data-testid="import-guest-promo-info" className="mb-4">
          <p className="text-sm">
            <button
              onClick={() => { logoutForPromotion(); window.location.href = '/login?tab=register'; }}
              className="font-medium underline underline-offset-2"
              data-testid="import-guest-promo-link"
            >
              Sign up free
            </button>{' '}
            to use FlawChess on any device and unlock automatic Stockfish analysis of your games.
          </p>
        </Alert>
      )}

      {profileLoading ? (
        <p className="text-sm text-muted-foreground">Loading profile...</p>
      ) : (
        <>
          {/* Tighten the gap above this card on mobile only. Tailwind v4 space-y-8
              puts the 2rem as margin-bottom on the PRECEDING element, so we pull
              the card up with a negative top margin; desktop keeps the full gap. */}
          <div className="-mt-6 sm:mt-0">
            <ImportFilterCard />
          </div>
          <div className="space-y-4">
          {/* chess.com platform card */}
          <Card data-testid="import-platform-chess-com">
            <CardHeader size="compact" className="gap-x-2">
              <PlatformIcon platform="chess.com" className="h-4 w-4" />
              <Label htmlFor="chess-com-username" className="font-semibold">chess.com</Label>
            </CardHeader>
            <CardBody className="space-y-2 p-3">
              {profile && (
                <p className="text-xs text-muted-foreground" data-testid="import-game-count-chess-com">
                  {chessComGameCount} games
                  {formatLastSync(profile.chess_com_last_sync_at) && (
                    <> ({formatLastSync(profile.chess_com_last_sync_at)})</>
                  )}
                </p>
              )}
              <div className="flex items-center gap-3">
                <div className="flex-1 space-y-1">
                  {importSettings && (
                    <BudgetChipRow platform="chess.com" platformSlug="chess-com" settings={importSettings} />
                  )}
                  <Input
                    id="chess-com-username"
                    type="text"
                    placeholder="chess.com username"
                    value={chessComUsername}
                    onChange={(e) => { setChessComUsername(e.target.value); setChessComError(null); }}
                    onKeyDown={(e) => e.key === 'Enter' && handleSync('chess.com')}
                    autoComplete="off"
                    className="h-8 text-sm"
                    data-testid="import-username-chess-com"
                  />
                </div>
                <Button
                  onClick={() => handleSync('chess.com')}
                  disabled={trigger.isPending || !chessComUsername.trim() || activePlatforms.has('chess.com')}
                  data-testid="btn-sync-chess-com"
                  className="self-end"
                >
                  Sync
                </Button>
              </div>
              {chessComError && (
                <p className="text-sm text-destructive" data-testid="import-error-chess-com">{chessComError}</p>
              )}
              {activeJobIds.map((id) => (
                <ImportProgressBar key={id} jobId={id} onDismiss={handleDismiss} platformFilter="chess.com" onProgress={handleProgress} />
              ))}
            </CardBody>
          </Card>

          {/* lichess platform card */}
          <Card data-testid="import-platform-lichess">
            <CardHeader size="compact" className="gap-x-2">
              <PlatformIcon platform="lichess" className="h-4 w-4" />
              <Label htmlFor="lichess-username" className="font-semibold">lichess</Label>
            </CardHeader>
            <CardBody className="space-y-2 p-3">
              {profile && (
                <p className="text-xs text-muted-foreground" data-testid="import-game-count-lichess">
                  {lichessGameCount} games
                  {formatLastSync(profile.lichess_last_sync_at) && (
                    <> ({formatLastSync(profile.lichess_last_sync_at)})</>
                  )}
                </p>
              )}
              <div className="flex items-center gap-3">
                <div className="flex-1 space-y-1">
                  {importSettings && (
                    <BudgetChipRow platform="lichess" platformSlug="lichess" settings={importSettings} />
                  )}
                  <Input
                    id="lichess-username"
                    type="text"
                    placeholder="lichess username"
                    value={lichessUsername}
                    onChange={(e) => { setLichessUsername(e.target.value); setLichessError(null); }}
                    onKeyDown={(e) => e.key === 'Enter' && handleSync('lichess')}
                    autoComplete="off"
                    className="h-8 text-sm"
                    data-testid="import-username-lichess"
                  />
                </div>
                <Button
                  onClick={() => handleSync('lichess')}
                  disabled={trigger.isPending || !lichessUsername.trim() || activePlatforms.has('lichess')}
                  data-testid="btn-sync-lichess"
                  className="self-end"
                >
                  Sync
                </Button>
              </div>
              {lichessError && (
                <p className="text-sm text-destructive" data-testid="import-error-lichess">{lichessError}</p>
              )}
              {activeJobIds.map((id) => (
                <ImportProgressBar key={id} jobId={id} onDismiss={handleDismiss} platformFilter="lichess" onProgress={handleProgress} />
              ))}
            </CardBody>
          </Card>
          </div>
        </>
      )}

      <Alert variant="info" data-testid="import-info">
        {profile && (profile.chess_com_last_sync_at || profile.lichess_last_sync_at) &&
          (profile.chess_com_game_count + profile.lichess_game_count) < MIN_GAMES_FOR_RELIABLE_STATS && (
            <p data-testid="import-low-game-count-info">
              <strong className="text-foreground">Low game count:</strong> Many features and statistics are useful with fewer than {MIN_GAMES_FOR_RELIABLE_STATS.toLocaleString()} games, but they
              become more reliable, complete, and interesting with more games.
            </p>
        )}
        <p>
          {/* Bug fix (WR-01, code-review 186): Phase 186 made the first sync's
              pre-signup backlog capped (see Import filters above), so "imports
              all your games" is no longer accurate for any account whose real
              history exceeds the cap or excludes a deselected time control. */}
          <strong className="text-foreground">First Sync:</strong> imports your recent games, plus a bounded amount of older history (see Import filters above). Later syncs only fetch new games since the last import.
        </p>
      </Alert>

      {/* Delete All Games */}
      <div data-testid="import-data-management">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setDeleteDialogOpen(true)}
          disabled={activeJobIds.length > 0}
          data-testid="btn-delete-games"
        >
          Delete All Games
        </Button>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent data-testid="delete-games-modal">
          <DialogHeader>
            <DialogTitle>Delete All Games</DialogTitle>
            <DialogDescription>
              This will delete all your imported games. You can import them again anytime. This
              also resets your Train progress.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              data-testid="btn-delete-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteAllGames}
              disabled={isDeleting}
              data-testid="btn-delete-confirm"
            >
              {isDeleting ? 'Deleting...' : 'Delete All Games'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
