import { lazy, Suspense, useState, useCallback, useEffect, useRef } from 'react';
import { Navigate, Outlet, Route, BrowserRouter as Router, Routes, useLocation, useNavigate, useSearchParams } from 'react-router';
import * as Sentry from "@sentry/react";
import { Link } from 'react-router';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ArrowLeft, BookOpenIcon, MenuIcon, LogOutIcon, TrophyIcon, DoorOpen, Shield, FolderOpen, Bot, Dumbbell, Search } from 'lucide-react';
import {
  Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerClose,
} from '@/components/ui/drawer';

import { apiClient } from '@/api/client';
import { usePlayActive } from '@/lib/playActive';
import { useMobileBoardControls } from '@/lib/mobileBoardControls';
import { BoardControls } from '@/components/board/BoardControls';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { InstallPromptBanner } from '@/components/install/InstallPromptBanner';
import { FeedbackButton } from '@/components/feedback/FeedbackButton';
import { ImpersonationPill } from '@/components/admin/ImpersonationPill';
import { useUserProfile } from '@/hooks/useUserProfile';
import { AuthPage } from '@/pages/Auth';
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage';
import { ResetPasswordPage } from '@/pages/ResetPasswordPage';
import { HomePage } from '@/pages/Home';
import { LibraryPage } from '@/pages/library/LibraryPage';
import { OAuthCallbackPage } from '@/pages/OAuthCallbackPage';
import { OpeningsPage } from '@/pages/Openings';
import { EndgamesPage } from '@/pages/Endgames';
import { AdminPage } from '@/pages/Admin';
import { PrivacyPage } from '@/pages/Privacy';
import { WelcomePage } from '@/pages/Welcome';
import { useImportPolling, useActiveJobs } from '@/hooks/useImport';
import { useUserFlag, setUserFlag } from '@/hooks/useUserFlag';
import { useReadiness } from '@/hooks/useReadiness';
import { useTrainProgress } from '@/hooks/useTrainProgress';
import { useReminderResurfaceRedirect } from '@/hooks/useReminderResurface';
import { useDevicePushResync } from '@/hooks/useDevicePushResync';
import { captureHandoffMarker } from '@/lib/handoffMarker';

// First React.lazy boundary in the app — keeps the Stockfish JS/WASM bundle off
// every other route (ROUTE-01 / D-07). Analysis.tsx uses export default (Pitfall 1).
const AnalysisPage = lazy(() => import('./pages/Analysis'));
// Phase 169 D-14: lazy-loaded, unlinked-from-nav /bots route. Bots.tsx also
// uses export default (mirrors AnalysisPage's Pitfall 1 divergence).
const BotsPage = lazy(() => import('./pages/Bots'));
// Phase 190 Plan 01: lazy-loaded because it pulls the Stockfish WASM grading
// worker. Train.tsx also uses export default (mirrors Analysis/Bots).
const TrainPage = lazy(() => import('./pages/Train'));

const FLAG_OPENINGS_VISITED = 'openings_visited';
const FLAG_ENDGAMES_VISITED = 'endgames_visited';
const IMPORT_REQUIRED_MESSAGE = 'Import your games first to unlock this feature.';
// SCHD-02/D-06/D-07: waiting-count badge display cap — anything above this
// renders as `${NAV_BADGE_MAX_DISPLAY}+` rather than the exact count.
const NAV_BADGE_MAX_DISPLAY = 99;

// ─── Non-visual job completion watcher ────────────────────────────────────────

function ImportJobWatcher({ jobId, onDone }: { jobId: string; onDone: (jobId: string) => void }) {
  const { data } = useImportPolling(jobId);

  useEffect(() => {
    if (data?.status === 'completed' || data?.status === 'failed') {
      onDone(jobId);
    }
  }, [data?.status, jobId, onDone]);

  return null;
}

// ─── Nav items ────────────────────────────────────────────────────────────────

// Phase 208 (PASTE-08): NAV_ITEMS and BOTTOM_NAV_ITEMS are now INTENTIONALLY
// different — NAV_ITEMS feeds NavHeader (desktop) and MobileMoreDrawer
// (mobile "More"), while BOTTOM_NAV_ITEMS feeds MobileBottomBar only.
// /analysis is deliberately absent from BOTTOM_NAV_ITEMS (D-09): it has no
// bottom-bar slot and reaching it via the More drawer is the intended path.
// This divergence must NOT be "fixed" into a single shared array — see WR-07
// below, the shipped bug from nav surfaces silently disagreeing with each
// other, which is exactly the failure mode a well-meaning unification would
// reintroduce.
const NAV_ITEMS = [
  { to: '/library', label: 'Library', Icon: FolderOpen },
  { to: '/train', label: 'Train', Icon: Dumbbell },
  { to: '/bots', label: 'Bots', Icon: Bot },
  { to: '/openings', label: 'Opening', Icon: BookOpenIcon },
  { to: '/endgames', label: 'Endgame', Icon: TrophyIcon },
  { to: '/analysis', label: 'Analysis', Icon: Search },
] as const;

// Phase 208 (PASTE-08): see the comment on NAV_ITEMS above — this array stays
// at its original 5 entries by design; /analysis is NOT added here.
const BOTTOM_NAV_ITEMS = [
  { to: '/library', label: 'Library', Icon: FolderOpen },
  { to: '/train', label: 'Train', Icon: Dumbbell },
  { to: '/bots', label: 'Bots', Icon: Bot },
  { to: '/openings', label: 'Opening', Icon: BookOpenIcon },
  { to: '/endgames', label: 'Endgame', Icon: TrophyIcon },
] as const;

// D-16: Admin nav item appended at render time when profile.is_superuser === true.
// Kept out of the `as const` NAV_ITEMS tuple so the conditional spread below does
// not widen the type; declared here so both NavHeader and MobileMoreDrawer share
// the same object literal and icon.
const ADMIN_NAV_ITEM = { to: '/admin', label: 'Admin', Icon: Shield } as const;

const ROUTE_TITLES: Record<string, string> = {
  '/library': 'Library',
  '/train': 'Train',
  '/bots': 'Bots',
  '/openings': 'Opening',
  '/endgames': 'Endgame',
  '/admin': 'Admin',
  '/analysis': 'Analysis',
};

// ─── Nav lock helper ──────────────────────────────────────────────────────────

/**
 * Routes reachable regardless of import state:
 * - `/library` — where you GO to import, so it can never be import-gated.
 * - `/admin` — superuser-only, gated by SuperuserRoute instead.
 * - `/bots` — D-17: free bot play, whose audience IS guests and zero-game users.
 * - `/analysis` — Phase 208 D-10: the paste-a-FEN-or-PGN entry point is already
 *   ungated and guest-friendly (SEED-144 Integration Point 2 — a pasted game
 *   contributes to neither chess_com_game_count nor lichess_game_count, so it
 *   cannot accidentally unlock the import-gated nav either). A locked nav
 *   entry pointing at an open route would be incoherent.
 *
 * WR-07: this gate used to be copy-pasted into all three nav surfaces with
 * DIVERGENT clause lists (MobileBottomBar's copy omitted `/admin`), and Phase
 * 171 had to patch every one of them to add `/bots`. One definition now, so the
 * next exempt route is a one-line edit and the surfaces cannot disagree.
 */
const IMPORT_EXEMPT_ROUTES: ReadonlySet<string> = new Set(['/library', '/admin', '/bots', '/analysis']);

function isNavLocked(to: string, navUnlocked: boolean): boolean {
  return !IMPORT_EXEMPT_ROUTES.has(to) && !navUnlocked;
}

// ─── Active route helper ───────────────────────────────────────────────────────

function isActive(to: string, pathname: string): boolean {
  if (to === '/library') return pathname.startsWith('/library');
  if (to === '/train') return pathname.startsWith('/train');
  if (to === '/bots') return pathname.startsWith('/bots');
  if (to === '/openings') return pathname.startsWith('/openings');
  if (to === '/endgames') return pathname.startsWith('/endgames');
  if (to === '/analysis') return pathname.startsWith('/analysis');
  return pathname === to;
}

// ─── Nav header (desktop) ─────────────────────────────────────────────────────

// Exported (additive) so App.test.tsx can render each nav surface directly —
// a full <App /> render owns its own BrowserRouter/AuthProvider/QueryClientProvider,
// which makes route control and hook mocking impractical from the outside.
export function NavHeader() {
  const location = useLocation();
  const { logout } = useAuth();
  const { data: profile } = useUserProfile();
  const totalGames = profile != null ? profile.chess_com_game_count + profile.lichess_game_count : 0;
  const noGames = profile != null && totalGames === 0;
  // Nav unlocks only once the user has games AND import phase 1 (Tier 1) is
  // complete — matching the "Explore Openings" button. tier1 alone is true for a
  // fresh zero-game account (no job in-flight), and games alone appear mid-import
  // before phase 1 finishes; both gates together avoid unlocking too early.
  const { tier1 } = useReadiness();
  const navUnlocked = totalGames > 0 && tier1;
  const openingsVisited = useUserFlag(FLAG_OPENINGS_VISITED, profile?.email);
  const endgamesVisited = useUserFlag(FLAG_ENDGAMES_VISITED, profile?.email);
  const showOpeningsDot = navUnlocked && !openingsVisited;
  // Endgames dot is gated behind the Openings dot — we want users to discover
  // Openings first, then Endgames after that dot is cleared.
  const showEndgamesDot = navUnlocked && openingsVisited && !endgamesVisited;
  // SCHD-02/D-06/D-07/D-08: numeric waiting-puzzles badge replaces the old
  // first-visit Train dot. Gated off for guests and locked-nav accounts so the
  // global QueryCache.onError Sentry reporter never sees an expected 403
  // (T-191-21) — a guest or zero-game account never issues this request.
  const trainProgressQuery = useTrainProgress({ enabled: navUnlocked && profile != null && !profile.is_guest });
  const trainWaitingCount = trainProgressQuery.data?.waiting_count ?? 0;
  // Phase 193 D-09/D-10: server-computed badge visibility (scheduled-day gating,
  // with an open-unfinished-session carve-out) — fails closed (undefined data
  // while pending/errored, or a payload missing the field) rather than guessing.
  // No client-side schedule-mask/timezone math is performed here.
  const trainBadgeVisible = trainProgressQuery.data?.badge_visible ?? false;
  // D-16: Admin tab rightmost for superusers, absent otherwise.
  const navItems = profile?.is_superuser ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;

  return (
    <header className="hidden sm:block bg-background border-b border-border px-6 overflow-hidden">
      <div className="mx-auto flex max-w-7xl items-stretch justify-between">
        <div className="flex items-center">
          <Link to="/openings" className="flex items-center gap-1 mr-3" data-testid="nav-home">
            <img src="/icons/logo-128.png" alt="" className="h-11 w-11 self-end -mb-1" aria-hidden="true" />
            <span className="text-lg tracking-tight text-foreground font-brand">FlawChess</span>
          </Link>
          <nav aria-label="Main navigation" className="flex items-stretch h-full">
            {navItems.map(({ to, label, Icon }) => {
              const locked = isNavLocked(to, navUnlocked);
              return (
              <Link
                key={to}
                to={to}
                data-testid={`nav-${to.slice(1)}`}
                aria-disabled={locked || undefined}
                title={locked ? IMPORT_REQUIRED_MESSAGE : undefined}
                onClick={locked ? (e) => e.preventDefault() : undefined}
                className={cn(
                  'relative flex items-center gap-1.5 px-3 text-sm transition-colors',
                  locked && 'opacity-40 cursor-not-allowed',
                  isActive(to, location.pathname)
                    ? 'font-medium bg-white/10 text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {label}
                {to === '/library' && noGames && (
                  <span
                    className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
                    data-testid="library-notification-dot"
                    aria-hidden="true"
                  >
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                  </span>
                )}
                {to === '/openings' && showOpeningsDot && (
                  <span
                    className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
                    data-testid="openings-notification-dot"
                  >
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                  </span>
                )}
                {to === '/endgames' && showEndgamesDot && (
                  <span
                    className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
                    data-testid="endgames-notification-dot"
                  >
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                  </span>
                )}
                {to === '/train' && trainWaitingCount > 0 && trainBadgeVisible && (
                  <span
                    // UAT bug fix (191-06): the desktop `<header>` has
                    // `overflow-hidden` (line ~167); the old `-top-1` offset
                    // pushed the badge above the stretched Link's top edge —
                    // i.e. above the header's own content box — where it got
                    // clipped. `top-0` keeps it inside those bounds ("a bit
                    // lower"); the smaller h-3.5/min-w-3.5/px-0.5 footprint
                    // ("a bit smaller") is a size-only reduction — `text-sm`
                    // is unchanged (CLAUDE.md's font-size floor). Mobile's
                    // badge (MobileBottomBar below) is unaffected: it was
                    // reported fine and sits inside a differently-shaped
                    // column item with no clipping ancestor.
                    // `leading-none` is required for the digit to sit centered:
                    // the default line-height overflowed the 14px circle, so the
                    // glyph rode high. Collapsing the line box to the font size
                    // lets `items-center` actually centre it. `text-xs` is a
                    // deliberate exception to CLAUDE.md's text-sm floor — the
                    // digit has to fit a 14px counter badge.
                    // `pt-0.5` is an optical nudge: digits sit above the em box's
                    // vertical middle (the descender space is unused), so exact
                    // box-centering still reads high.
                    className="absolute top-0 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 pt-0.5 text-xs leading-none font-semibold text-white"
                    data-testid="train-notification-badge"
                  >
                    {trainWaitingCount > NAV_BADGE_MAX_DISPLAY ? `${NAV_BADGE_MAX_DISPLAY}+` : trainWaitingCount}
                  </span>
                )}
              </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          {profile?.is_guest && (
            <Badge
              className="bg-amber-500/15 text-amber-500 border-amber-500/30 text-xs"
              data-testid="nav-guest-badge"
              aria-label="Guest session"
            >
              <DoorOpen className="h-3 w-3 mr-1" />
              Guest
            </Badge>
          )}
          {profile?.impersonation && (
            <ImpersonationPill impersonation={profile.impersonation} />
          )}
          <Button variant="ghost" size="sm" onClick={logout} data-testid="nav-logout">
            Logout
          </Button>
        </div>
      </div>
    </header>
  );
}

// ─── Mobile header ────────────────────────────────────────────────────────────

export function MobileHeader() {
  const location = useLocation();
  const { data: profile } = useUserProfile();
  const pageTitle = Object.entries(ROUTE_TITLES).find(
    ([path]) => location.pathname.startsWith(path),
  )?.[1] ?? '';

  return (
    <header
      data-testid="mobile-header"
      className="block sm:hidden pt-safe flex items-center justify-between px-4 py-1 bg-background border-b border-border overflow-hidden"
    >
      <Link
        to="/openings"
        data-testid="nav-home-mobile"
        className="flex items-center gap-1.5 text-xl tracking-tight text-foreground font-brand"
      >
        <img src="/icons/logo-128.png" alt="" className="h-11 w-11 self-end -mb-1" aria-hidden="true" />
        FlawChess
      </Link>
      <div className="flex items-center gap-2 min-w-0">
        {profile?.impersonation && (
          <ImpersonationPill
            impersonation={profile.impersonation}
            emailMaxWidthClass="max-w-[8rem]"
          />
        )}
        <span
          data-testid="mobile-header-page-title"
          className="text-sm text-muted-foreground"
        >
          {pageTitle}
        </span>
      </div>
    </header>
  );
}

// ─── Analysis mobile header ───────────────────────────────────────────────────

// The analysis page takes over the mobile shell: a back button (browser back) replaces
// the logo, and the board controls replace the bottom nav bar (rendered by the page).
function AnalysisMobileHeader() {
  const navigate = useNavigate();
  return (
    <header
      data-testid="analysis-mobile-header"
      className="block sm:hidden shrink-0 pt-safe flex items-center gap-2 px-2 py-1 bg-background border-b border-border overflow-hidden"
    >
      {/* Quick 260628-cjp: wider tap target (w-16) so the back button matches the
          generous board-control footer buttons (flat flex-1 h-12), not a 48px square. */}
      <Button
        variant="ghost"
        size="icon"
        className="h-12 w-16 -ml-1"
        onClick={() => navigate(-1)}
        aria-label="Go back"
        data-testid="btn-analysis-back"
      >
        <ArrowLeft className="h-6 w-6" />
      </Button>
      <span className="text-sm font-medium text-foreground">Analysis</span>
    </header>
  );
}

// ─── Mobile bottom bar ────────────────────────────────────────────────────────

// Shared by both MobileBottomBar branches (main nav / board controls) so the
// fixed positioning, breakpoint, and border/background stay byte-identical.
const MOBILE_BOTTOM_BAR_CLASSES =
  'fixed bottom-0 inset-x-0 flex sm:hidden z-40 bg-background border-t border-border pb-safe';

export function MobileBottomBar({ onMoreClick }: { onMoreClick: () => void }) {
  // Quick 260809-g0n: a Train puzzle in free-move mode takes over the bar the
  // way the /analysis route takes over the whole mobile shell — while a
  // payload is published, board controls replace the main nav buttons.
  const boardControls = useMobileBoardControls();
  const location = useLocation();
  const { data: profile } = useUserProfile();
  const totalGames = profile != null ? profile.chess_com_game_count + profile.lichess_game_count : 0;
  const noGames = profile != null && totalGames === 0;
  // See NavHeader — unlock only once games exist AND import phase 1 is complete.
  const { tier1 } = useReadiness();
  const navUnlocked = totalGames > 0 && tier1;
  const openingsVisited = useUserFlag(FLAG_OPENINGS_VISITED, profile?.email);
  const endgamesVisited = useUserFlag(FLAG_ENDGAMES_VISITED, profile?.email);
  const showOpeningsDot = navUnlocked && !openingsVisited;
  const showEndgamesDot = navUnlocked && openingsVisited && !endgamesVisited;
  // SCHD-02/D-06/D-07/D-08 — see NavHeader for the gating rationale.
  const trainProgressQuery = useTrainProgress({ enabled: navUnlocked && profile != null && !profile.is_guest });
  const trainWaitingCount = trainProgressQuery.data?.waiting_count ?? 0;
  // Phase 193 D-09/D-10 — see NavHeader for the fail-closed badge_visible rationale.
  const trainBadgeVisible = trainProgressQuery.data?.badge_visible ?? false;

  if (boardControls != null) {
    return (
      <div
        data-testid="mobile-board-controls-bar"
        className={cn(MOBILE_BOTTOM_BAR_CLASSES, 'items-center px-2 py-2')}
      >
        <BoardControls
          onBack={boardControls.onBack}
          onForward={boardControls.onForward}
          onReset={boardControls.onReset}
          onFlip={boardControls.onFlip}
          canGoBack={boardControls.canGoBack}
          canGoForward={boardControls.canGoForward}
          canReset={boardControls.canReset}
          flat
        />
      </div>
    );
  }

  return (
    <nav
      aria-label="Mobile navigation"
      data-testid="mobile-bottom-bar"
      className={MOBILE_BOTTOM_BAR_CLASSES}
    >
      {BOTTOM_NAV_ITEMS.map(({ to, label, Icon }) => {
        const locked = isNavLocked(to, navUnlocked);
        return (
        <Link
          key={to}
          to={to}
          data-testid={`mobile-nav-${to.slice(1)}`}
          aria-disabled={locked || undefined}
          title={locked ? IMPORT_REQUIRED_MESSAGE : undefined}
          onClick={locked ? (e) => e.preventDefault() : undefined}
          className={cn(
            'relative flex flex-1 flex-col items-center gap-1 py-2',
            locked && 'opacity-40 cursor-not-allowed',
            isActive(to, location.pathname) ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
          <span className="text-xs">{label}</span>
          {to === '/library' && noGames && (
            <span
              className="absolute top-1.5 right-[30%] flex h-2 w-2"
              data-testid="library-notification-dot-mobile"
              aria-hidden="true"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
          )}
          {to === '/openings' && showOpeningsDot && (
            <span
              className="absolute top-1.5 right-[30%] flex h-2 w-2"
              data-testid="openings-notification-dot-mobile"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
          )}
          {to === '/endgames' && showEndgamesDot && (
            <span
              className="absolute top-1.5 right-[30%] flex h-2 w-2"
              data-testid="endgames-notification-dot-mobile"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
          )}
          {to === '/train' && trainWaitingCount > 0 && trainBadgeVisible && (
            <span
              // `leading-none` + `text-xs` for the same centering/fit reason as
              // the desktop badge above.
              className="absolute top-1.5 right-[30%] flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 pt-0.5 text-xs leading-none font-semibold text-white"
              data-testid="train-notification-badge-mobile"
            >
              {trainWaitingCount > NAV_BADGE_MAX_DISPLAY ? `${NAV_BADGE_MAX_DISPLAY}+` : trainWaitingCount}
            </span>
          )}
        </Link>
        );
      })}
      <button
        onClick={onMoreClick}
        data-testid="mobile-nav-more"
        aria-label="More navigation options"
        className="flex flex-1 flex-col items-center gap-1 py-2 text-muted-foreground"
      >
        <MenuIcon className="h-5 w-5" aria-hidden="true" />
        <span className="text-xs">More</span>
      </button>
    </nav>
  );
}

// ─── Mobile more drawer ───────────────────────────────────────────────────────

export function MobileMoreDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const location = useLocation();
  const { logout } = useAuth();
  const { data: profile } = useUserProfile();
  const totalGames = profile != null ? profile.chess_com_game_count + profile.lichess_game_count : 0;
  const noGames = profile != null && totalGames === 0;
  // See NavHeader — unlock only once games exist AND import phase 1 is complete.
  const { tier1 } = useReadiness();
  const navUnlocked = totalGames > 0 && tier1;
  // D-17: Admin entry surfaced in the More drawer (not the bottom bar) for superusers.
  const navItems = profile?.is_superuser ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="bottom">
      <DrawerContent data-testid="mobile-more-drawer">
        <DrawerHeader>
          <DrawerTitle className="text-sm font-medium text-foreground">
            {profile?.is_guest ? 'Guest session' : (profile?.email ?? 'Account')}
          </DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-4">
          <nav className="flex flex-col gap-1">
            {navItems.map(({ to, label }) => {
              const locked = isNavLocked(to, navUnlocked);
              return (
              <DrawerClose key={to} asChild>
                <Link
                  to={to}
                  data-testid={`drawer-nav-${to.slice(1)}`}
                  aria-disabled={locked || undefined}
                  title={locked ? IMPORT_REQUIRED_MESSAGE : undefined}
                  onClick={locked ? (e) => e.preventDefault() : undefined}
                  className={cn(
                    'relative rounded-md px-3 py-2 text-base',
                    locked && 'opacity-40 cursor-not-allowed',
                    isActive(to, location.pathname) ? 'text-primary font-medium' : 'text-foreground',
                  )}
                >
                  {label}
                  {to === '/library' && noGames && (
                    <span
                      className="absolute top-0.5 right-0.5 flex h-2.5 w-2.5"
                      data-testid="library-notification-dot-drawer"
                      aria-hidden="true"
                    >
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                    </span>
                  )}
                </Link>
              </DrawerClose>
              );
            })}
          </nav>
          <div className="my-2 border-t border-border" />
          <DrawerClose asChild>
            <button
              onClick={logout}
              data-testid="drawer-logout"
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-base text-destructive"
            >
              <LogOutIcon className="h-4 w-4" />
              Logout
            </button>
          </DrawerClose>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

// ─── Layout (protected pages) ─────────────────────────────────────────────────

function ProtectedLayout() {
  const { token, refreshAuthToken } = useAuth();
  const { data: profile } = useUserProfile();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const isOpeningsRoute = location.pathname.startsWith('/openings');
  const isEndgamesRoute = location.pathname.startsWith('/endgames');
  // The analysis page takes over the mobile shell (back-button header + board-controls
  // footer owned by the page), so it gets a full-height flex chain on mobile and the
  // standard mobile header / bottom nav are suppressed. Desktop (sm+) is unaffected.
  const isAnalysisRoute = location.pathname.startsWith('/analysis');
  // A mounted immersive board screen (bot game, Train solve loop) suppresses
  // the mobile header (NavHeader is desktop-only and unaffected) — the board
  // needs the vertical space on small screens. Set by BotsGame and
  // TrainSolveScreen via useMarkPlayActive().
  const playActive = usePlayActive();
  const refreshedRef = useRef(false);

  // OFFER-05/D-16: the standalone launch's active route push to /train. The
  // manifest start_url is '/', so a qualifying standalone launch (iOS
  // install intent recorded, no push subscription on this device yet) never
  // lands on Train by itself — see useReminderResurface.ts for the fail-safe
  // decision and the once-per-mount navigate guard.
  //
  // CR-01 FIX (203-REVIEW.md): this runs on EVERY protected route for EVERY
  // account. Gate its underlying GET /train/settings off for guests (and
  // while `profile` hasn't resolved yet) — guests get a guaranteed 403 from
  // `_reject_guest` that the global QueryCache.onError reporter was
  // capturing to Sentry on every page view and window refocus, mirroring
  // the same fix `useTrainProgress`'s `enabled` option applies at the nav
  // badge call sites (T-191-21).
  useReminderResurfaceRedirect({ enabled: profile != null && !profile.is_guest });
  // Phase 204 D-07: a device whose push_subscriptions row was pruned
  // re-registers itself on the next app load, with no user gesture.
  useDevicePushResync({ enabled: profile != null && !profile.is_guest });

  useEffect(() => {
    if (isOpeningsRoute && profile?.email) {
      setUserFlag(FLAG_OPENINGS_VISITED, profile.email);
    }
  }, [isOpeningsRoute, profile?.email]);

  useEffect(() => {
    if (isEndgamesRoute && profile?.email) {
      setUserFlag(FLAG_ENDGAMES_VISITED, profile.email);
    }
  }, [isEndgamesRoute, profile?.email]);

  // Show deferred toast from OAuth callback — checked here because ProtectedLayout
  // is the stable destination after the redirect chain (callback → / → /openings).
  useEffect(() => {
    const msg = sessionStorage.getItem('pending_toast');
    if (msg) {
      sessionStorage.removeItem('pending_toast');
      toast.success(msg);
    }
  }, []);

  // HANDOFF-02/D-12: capture the desktop→phone QR handoff marker as early as
  // possible on first load, mirroring how googleAuth.ts's promote_intent is
  // captured before its own SSO hop — ProtectedLayout is the stable mount
  // point that sees the raw URL on arrival, before Google's redirect chain
  // strips the query string.
  useEffect(() => {
    captureHandoffMarker(window.location.search);
  }, []);

  // GUEST-05: Refresh guest JWT on each visit, resetting the 30-day expiry.
  // Uses refreshAuthToken (not loginWithToken) to avoid clearing the query cache
  // on the same user — otherwise useUserProfile refetches mid-keystroke on the
  // Import page and the focused username input loses focus after the first char.
  useEffect(() => {
    if (profile?.is_guest && !refreshedRef.current) {
      refreshedRef.current = true;
      apiClient.post<{ access_token: string }>('/auth/guest/refresh')
        .then((res) => refreshAuthToken(res.data.access_token))
        .catch(() => { /* token still valid, refresh is best-effort */ });
    }
  }, [profile?.is_guest, refreshAuthToken]);

  if (!token) {
    return <Navigate to="/login" replace />;
  }
  if (isAnalysisRoute) {
    return (
      <>
        {/* Phase 161 (SEED-088), D-01/D-05/D-06/D-09: the shell is LOCKED
            (h-[100dvh]) by default. This covers both the mobile tab-takeover UI
            (Analysis renders it below MOBILE_BREAKPOINT_PX = 768px — its tab
            content relies on this to fill the space above the in-flow
            board-controls footer, per D-05) AND the desktop 3-column grid
            (>=desk3col, D-01/D-07) so its move list / board+chart column scroll
            internally instead of the page.
            Two range-scoped variants UNLOCK it: `md:max-desk3col:` (the
            768-desk3col two-column band — that layout is a scrolling page) and
            `short:` (<560px tall, D-09, a safety-valve override at ANY width).
            The unlock lower bound (`md:` = 768px) MUST track MOBILE_BREAKPOINT_PX
            in Analysis.tsx: below it the mobile takeover renders and needs the
            lock; at/above it the two-column layout scrolls. Applied at this shell
            level only — the min-h-0 chain further down does not repeat it
            (RESEARCH.md Pattern 4).
            A compound range variant (`md:max-desk3col:`) is used rather than a
            bare `md:` because `desk3col:` (a custom @theme breakpoint) compiles
            to an EARLIER media block than the built-in `md:` in this Tailwind
            build, so a bare `md:h-auto` would win the cascade at >=1200px and
            silently keep desktop unlocked. Scoping to the explicit [768,1200)
            range sidesteps that ordering dependency entirely (see
            161-01-SUMMARY.md). */}
        <div className="flex flex-col h-[100dvh] md:max-desk3col:h-auto md:max-desk3col:block short:h-auto short:block">
          <NavHeader />
          <AnalysisMobileHeader />
          <main className="flex-1 min-h-0 flex flex-col md:max-desk3col:block md:max-desk3col:flex-none short:block short:flex-none">
            <Outlet />
          </main>
        </div>
        <InstallPromptBanner />
        {/* 164 UAT: the floating feedback button overlaps the analysis tab content
            (e.g. the ELO slider) in the mobile takeover, so it's hidden across that
            range (below md = MOBILE_BREAKPOINT_PX) on this route; shown at/above md
            (two-column + desktop layouts) where there's room. */}
        <div className="hidden md:block">
          <FeedbackButton />
        </div>
      </>
    );
  }

  return (
    <>
      <NavHeader />
      {!isOpeningsRoute && !playActive && (
        <>
          <MobileHeader />
        </>
      )}
      <main className="pb-16 sm:pb-0">
        <Outlet />
      </main>
      <MobileBottomBar onMoreClick={() => setMoreOpen(true)} />
      <MobileMoreDrawer open={moreOpen} onOpenChange={setMoreOpen} />
      <InstallPromptBanner />
      {/* The floating feedback bubble sits over the board's bottom right corner
          and the result dialog's actions, so it's hidden on both immersive
          board screens (`playActive`: a live bot game, the Train solve loop). */}
      {!playActive && <FeedbackButton />}
    </>
  );
}

// ─── Import-required route guard ──────────────────────────────────────────────

/**
 * Locks non-Import pages until the user has imported games AND import phase 1
 * (Tier 1) is complete — the same gate as the nav links and the "Explore
 * Openings" button. This keeps a fresh zero-game account out (no games) and an
 * in-progress import out (tier1=false), and re-locks after deleting all games.
 * The isLoading guard prevents a redirect flash while the first fetches resolve.
 */
function ImportRequiredRoute({ children }: { children: React.ReactNode }) {
  const { data: profile, isLoading: profileLoading } = useUserProfile();
  const { tier1, isLoading: readinessLoading } = useReadiness();
  const isLoading = profileLoading || readinessLoading;
  const hasGames = profile != null && profile.chess_com_game_count + profile.lichess_game_count > 0;
  const shouldRedirect = !isLoading && profile != null && !(hasGames && tier1);

  useEffect(() => {
    if (shouldRedirect) {
      toast.info(IMPORT_REQUIRED_MESSAGE);
    }
  }, [shouldRedirect]);

  if (isLoading) {
    return <div className="p-6 text-muted-foreground" data-testid="import-required-loading">Loading...</div>;
  }
  if (shouldRedirect) {
    return <Navigate to="/library/import" replace />;
  }
  return <>{children}</>;
}

// ─── Superuser route guard ────────────────────────────────────────────────────

/**
 * Redirects non-superusers to /openings (D-18). Profile query loading flicker
 * falls through to an explicit loading state so we do not briefly show /admin
 * to someone whose profile has not resolved yet.
 */
function SuperuserRoute({ children }: { children: React.ReactNode }) {
  const { data: profile, isLoading } = useUserProfile();
  if (isLoading) {
    return <div className="p-6 text-muted-foreground" data-testid="superuser-route-loading">Loading...</div>;
  }
  if (!profile?.is_superuser) {
    return <Navigate to="/openings" replace />;
  }
  return <>{children}</>;
}

// ─── Analysis route wrapper ───────────────────────────────────────────────────

/**
 * Thin wrapper that reads the `?line=` search param and keys AnalysisPage by it,
 * so a second entry-point navigation to /analysis?line=Y remounts the page and
 * re-seeds the free-play opening main line (the loadMainLine effect's
 * hasLoadedMainLine ref is reset by the remount — Pitfall 2).
 *
 * useSearchParams is not in scope at the <Routes> site, so a scoped wrapper
 * keeps the param-driven re-render off all other routes (RESEARCH Pattern A).
 *
 * Not wrapped in ImportRequiredRoute — free-play is valid for zero-game users
 * (D-05 / RESEARCH A2). Not wrapped in SuperuserRoute.
 */
function AnalysisRoute() {
  const [params] = useSearchParams();
  return (
    <Suspense
      fallback={
        <div
          className="p-6 text-sm text-muted-foreground"
          data-testid="analysis-loading"
        >
          Loading analysis board…
        </div>
      }
    >
      <AnalysisPage key={params.get('line') ?? 'start'} />
    </Suspense>
  );
}

// ─── Router ───────────────────────────────────────────────────────────────────

function AppRoutes() {
  const [activeJobIds, setActiveJobIds] = useState<string[]>([]);
  const [completedJobIds, setCompletedJobIds] = useState<Set<string>>(new Set());
  const queryClient = useQueryClient();
  const { token } = useAuth();

  // Restore active jobs from server on mount (and after re-login when token changes)
  const hasRestoredRef = useRef(false);
  // Track which token restoration has been performed for — reset guard on re-login
  const restoredForTokenRef = useRef<string | null>(null);

  // eslint-disable-next-line react-hooks/refs -- intentional: reset restoration guard on token change
  if (restoredForTokenRef.current !== token) {
    restoredForTokenRef.current = token; // eslint-disable-line react-hooks/refs
    hasRestoredRef.current = false; // eslint-disable-line react-hooks/refs
    // Phase 62: an admin who impersonates swaps their token — their in-flight job
    // ids belong to the admin, not the target. Drop them so we do not poll 404s.
    setActiveJobIds([]);
    setCompletedJobIds(new Set());
  }

  const activeJobsQuery = useActiveJobs(!!token);
  useEffect(() => {
    if (hasRestoredRef.current) return;
    if (!activeJobsQuery.data) return;
    hasRestoredRef.current = true;
    const serverJobIds = activeJobsQuery.data.map((j) => j.job_id);
    setActiveJobIds((ids) => {
      const existing = new Set(ids);
      const newIds = serverJobIds.filter((id) => !existing.has(id));
      if (newIds.length === 0) return ids;
      return [...ids, ...newIds];
    });
  }, [activeJobsQuery.data]);

  const handleImportStarted = useCallback((jobId: string) => {
    setActiveJobIds((ids) => [...ids, jobId]);
  }, []);

  // Called when a job finishes (completed or failed) — invalidate queries but keep in list
  const handleJobDone = useCallback((jobId: string) => {
    setCompletedJobIds((prev) => {
      if (prev.has(jobId)) return prev;
      const next = new Set(prev);
      next.add(jobId);
      return next;
    });
    queryClient.invalidateQueries({ queryKey: ['games'] });
    queryClient.invalidateQueries({ queryKey: ['gameCount'] });
    queryClient.invalidateQueries({ queryKey: ['userProfile'] });
    // Bug fix (quick 260611): the Library tab queries use 5-minute staleTime
    // with refetchOnWindowFocus disabled, so without invalidation newly
    // imported games only appeared after a hard page reload.
    queryClient.invalidateQueries({ queryKey: ['library-games'] });
    queryClient.invalidateQueries({ queryKey: ['library-game'] });
    queryClient.invalidateQueries({ queryKey: ['library-flaws'] });
    queryClient.invalidateQueries({ queryKey: ['library-flaw-stats'] });
    // Bug fix (Phase 94.1-11): the percentile background tasks (Stage A on
    // import-complete, Stage B on eval-drain) write to user_benchmark_percentiles
    // asynchronously after the job completes. Without invalidating endgameOverview
    // here, the 30s queryClient staleTime serves the stale pre-import response and
    // percentile badges only appear on /endgames after a hard refresh. Partial-match
    // on ['endgameOverview'] invalidates every cached (params, window) variant.
    queryClient.invalidateQueries({ queryKey: ['endgameOverview'] });
  }, [queryClient]);

  // Called when user dismisses a completed progress bar
  const handleJobDismissed = useCallback((jobId: string) => {
    setActiveJobIds((ids) => ids.filter((id) => id !== jobId));
    setCompletedJobIds((prev) => {
      const next = new Set(prev);
      next.delete(jobId);
      return next;
    });
  }, []);

  // Only watch jobs that haven't completed yet
  const watchableJobIds = activeJobIds.filter((id) => !completedJobIds.has(id));

  return (
    <>
      <Routes>
        {/* Public routes */}
        <Route path="/" element={<HomePage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/login" element={<AuthPage />} />
        {/* Self-serve password reset (Phase 207) — public, a user is by
            definition logged out (or resetting from a second device). */}
        <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
        {/* Google OAuth callback — reads token from URL fragment */}
        <Route path="/auth/callback" element={<OAuthCallbackPage />} />
        {/* Protected layout wraps all authenticated pages */}
        <Route element={<ProtectedLayout />}>
          <Route path="/library/*" element={<LibraryPage onImportStarted={handleImportStarted} activeJobIds={activeJobIds} onJobDismissed={handleJobDismissed} />} />
          <Route path="/import" element={<Navigate to="/library/import" replace />} />
          <Route path="/overview" element={<Navigate to="/library/stats" replace />} />
          <Route path="/rating" element={<Navigate to="/library/stats" replace />} />
          <Route path="/global-stats" element={<Navigate to="/library/stats" replace />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/openings/*" element={<ImportRequiredRoute><OpeningsPage /></ImportRequiredRoute>} />
          <Route path="/endgames/*" element={<ImportRequiredRoute><EndgamesPage /></ImportRequiredRoute>} />
          {/* Phase 190 Plan 01: gated like Openings/Endgames (NAV-02) — NOT added
              to IMPORT_EXEMPT_ROUTES. Nav wiring (NAV-01) is Plan 03's. */}
          <Route
            path="/train/*"
            element={
              <ImportRequiredRoute>
                <Suspense
                  fallback={
                    <div className="p-6 text-sm text-muted-foreground" data-testid="train-loading">
                      Loading your training session…
                    </div>
                  }
                >
                  <TrainPage />
                </Suspense>
              </ImportRequiredRoute>
            }
          />
          <Route path="/admin" element={<SuperuserRoute><AdminPage /></SuperuserRoute>} />
          <Route path="/analysis" element={<AnalysisRoute />} />
          {/* Phase 169 D-14: real /bots route, lazy-loaded, UNLINKED from nav this
              phase (Phase 171 adds the nav entry). Not wrapped in ImportRequiredRoute
              or SuperuserRoute — same guest-friendly access posture as /analysis, since
              free bot play is valid for zero-game/guest users this milestone. */}
          <Route
            path="/bots"
            element={
              <Suspense
                fallback={
                  <div className="p-6 text-sm text-muted-foreground" data-testid="bots-loading">
                    Loading bot game…
                  </div>
                }
              >
                <BotsPage />
              </Suspense>
            }
          />
        </Route>
        {/* Catch-all redirects to homepage */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {watchableJobIds.map((id) => (
        <ImportJobWatcher key={id} jobId={id} onDone={handleJobDone} />
      ))}
    </>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router>
        <AuthProvider>
          <TooltipProvider>
          <Sentry.ErrorBoundary
            fallback={
              <div className="flex flex-col items-center justify-center min-h-screen gap-4">
                <p className="text-lg font-medium text-destructive">Something went wrong.</p>
                <button
                  onClick={() => window.location.reload()}
                  className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
                  data-testid="btn-error-reload"
                >
                  Reload page
                </button>
              </div>
            }
          >
            <AppRoutes />
            <Toaster richColors />
          </Sentry.ErrorBoundary>
          </TooltipProvider>
        </AuthProvider>
      </Router>
    </QueryClientProvider>
  );
}

export default App;
