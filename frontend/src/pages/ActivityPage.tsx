import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';

import { apiClient } from '@/api/client';
import { LoadError } from '@/components/ui/load-error';
import type { ActivityStatsPayload } from '@/types/activity';

// Order matters and is load-bearing: charts.js publishes window.__fc, which
// app.js binds when its mount() runs. The stylesheet is scoped under
// .activity-dash (see dashboard/static/styles.css) so importing it here cannot
// restyle the rest of the SPA. boot.js is deliberately NOT imported — it is the
// standalone page's fetch/poll driver, and leaving it out is what keeps "the
// hosted page never polls" structural rather than a convention (D-6).
import '@activity-dash/styles.css';
import '@activity-dash/charts.js';
import '@activity-dash/app.js';

/**
 * Globals published by the shared dashboard scripts above. `charts.js` sets
 * `window.__fc` (the SVG chart toolkit) and `app.js` sets `window.__fcApp` (the
 * render layer). React never calls `__fc` directly — only app.js does — so it
 * is typed as `unknown`: it just has to exist.
 *
 * Declared here rather than in a standalone .d.ts because knip reports an
 * ambient declaration file that nothing imports as dead code.
 */
declare global {
  interface Window {
    __fc?: unknown;
    __fcApp?: {
      mount(): {
        update(payload: ActivityStatsPayload): void;
        destroy(): void;
      };
    };
    /** Set by app.js's apply(); read by charts.js to mark the launch date. */
    __LAUNCH?: string;
  }
}

const FONTS_LINK_ID = 'activity-dashboard-fonts';
const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Source+Sans+3:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap';

async function fetchActivityStats(refresh: boolean): Promise<ActivityStatsPayload> {
  const { data } = await apiClient.get<ActivityStatsPayload>('/admin/activity/stats', {
    params: refresh ? { refresh: 1 } : undefined,
  });
  return data;
}

/**
 * Loads the dashboard's own three Google faces for as long as this page is
 * mounted, then removes them.
 *
 * Not a cosmetic choice: check_layout.mjs measures text width via
 * MONO_CHAR_RATIO / SANS_CHAR_RATIO, calibrated against IBM Plex Mono and
 * Source Sans 3. Substituting the app's font stack would silently invalidate
 * every fit assertion the harness makes about these charts. Injecting on mount
 * rather than from index.html keeps the cost off every other page.
 */
function useDashboardFonts() {
  useEffect(() => {
    if (document.getElementById(FONTS_LINK_ID)) return;
    const link = document.createElement('link');
    link.id = FONTS_LINK_ID;
    link.rel = 'stylesheet';
    link.href = FONTS_HREF;
    document.head.appendChild(link);
    return () => {
      document.getElementById(FONTS_LINK_ID)?.remove();
    };
  }, []);
}

/**
 * Superuser-only Activity Pulse page (Quick 260824-qaz).
 *
 * The markup below is a JSX port of dashboard/static/index.html's body. Every
 * `id` is byte-identical to that file on purpose: app.js and charts.js address
 * the DOM by id (#c-actives, #t-funnel, #conv-big, #tip, ...), so renaming one
 * silently drops a chart. The rendering itself is done imperatively by the
 * shared app.js — React owns only the static shell, the data fetch, and the
 * Refresh button.
 *
 * Deliberately NOT wrapped in a padded or max-width container: ProtectedLayout's
 * `<main className="pb-16 sm:pb-0">` is unpadded, and the dashboard's own .wrap
 * chain (plus check_layout.mjs's width model) depends on that staying true.
 */
export default function ActivityPage() {
  useDashboardFonts();

  // D-6: the hosted page never polls. queryFn reads this ref instead of a
  // second variable in the query key, so "Refresh now" can force a server-side
  // cache bypass (?refresh=1) via the SAME refetch() call TanStack Query
  // already exposes, rather than a parallel fetch path.
  const forceRefreshRef = useRef(false);
  const handleRef = useRef<ReturnType<NonNullable<Window['__fcApp']>['mount']> | null>(null);

  const { data, isPending, isError, refetch, isFetching } = useQuery({
    queryKey: ['activity-stats'],
    queryFn: () => {
      const refresh = forceRefreshRef.current;
      forceRefreshRef.current = false;
      return fetchActivityStats(refresh);
    },
    // Pinned explicitly (not left to queryClient's 30s default) so a future
    // change to those defaults can never reintroduce a poll on this page —
    // data is fetched once on mount and again only on an explicit click.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });

  // Mount the shared renderer once. destroy() is what makes React 19
  // StrictMode's double-mount in dev safe — without it the first mount's
  // resize listener keeps re-rendering into a detached DOM.
  useEffect(() => {
    const handle = window.__fcApp?.mount() ?? null;
    handleRef.current = handle;
    return () => {
      handle?.destroy();
      handleRef.current = null;
    };
  }, []);

  // Feed each successful payload to the renderer. Separate from the mount
  // effect so a refetch re-renders the charts without tearing down listeners.
  useEffect(() => {
    if (data) handleRef.current?.update(data);
  }, [data]);

  const handleRefresh = () => {
    forceRefreshRef.current = true;
    void refetch();
  };

  const setAudience = (aud: 'all' | 'reg' | 'guest') => () => {
    // Intentionally a no-op handler: app.js's mount() binds its own click
    // listener on these buttons and owns their aria-pressed state. React must
    // not also write that attribute — dual ownership of one attribute is the
    // bug this seam avoids. The handler exists only so the element is a real
    // button with a testid for automation.
    void aud;
  };

  return (
    <main data-testid="activity-page" className="activity-dash">
      <header className="mast">
        <div className="mast-inner">
          <div>
            <div className="rulebar" aria-hidden="true"></div>
            <div className="eyebrow">FlawChess</div>
            <h1>Activity Pulse</h1>
            <p className="sub">
              Who shows up, how often they come back, and what they do once they are here. Built
              from the <span className="mono">user_activity</span> calendar plus the
              bot-game, Train, import and signup tables.
            </p>
          </div>
          <div className="window">
            <b className="mono" id="w-range">
              &nbsp;
            </b>
            <span id="w-days">{isPending ? 'loading…' : ''}</span>
            <div className="live" id="live">
              <span className="dot" id="live-dot" aria-hidden="true"></span>
              <span id="live-text">
                {isFetching
                  ? 'refreshing…'
                  : data
                    ? `updated ${new Date(data.generated_at).toLocaleTimeString()}`
                    : 'no data'}
              </span>
              <button
                type="button"
                id="btn-refresh"
                data-testid="btn-refresh"
                onClick={handleRefresh}
                disabled={isFetching}
              >
                Refresh now
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="wrap">
        {isError && (
          <div className="banner" role="alert">
            <LoadError resource="activity stats" />
          </div>
        )}

        <div className="controls">
          <div className="seg" role="group" aria-label="Audience filter">
            <button
              type="button"
              data-aud="all"
              aria-pressed="true"
              data-testid="filter-audience-all"
              onClick={setAudience('all')}
            >
              All users
            </button>
            <button
              type="button"
              data-aud="reg"
              aria-pressed="false"
              data-testid="filter-audience-reg"
              onClick={setAudience('reg')}
            >
              Registered
            </button>
            <button
              type="button"
              data-aud="guest"
              aria-pressed="false"
              data-testid="filter-audience-guest"
              onClick={setAudience('guest')}
            >
              Guests
            </button>
          </div>
          <span className="hint">
            Filters the active-user and engagement-depth charts. The retention chart always
            compares both cohorts.
          </span>
        </div>

        <div className="tiles" id="tiles"></div>

        <section>
          <div className="sec-head">
            <h2>Active users</h2>
            <p>
              DAU, WAU and MAU are rolling distinct-user counts ending on each day — 1, 7 and 30
              day windows.
            </p>
          </div>
          <div className="card">
            <h3 id="au-title">Rolling active users</h3>
            <p className="note">
              A user counts as active on a day if the API saw them at least once. The 23 July
              launch is marked on every time chart.
            </p>
            <div className="legend" id="au-legend"></div>
            <div className="chart" id="c-actives"></div>
            <details className="data">
              <summary data-testid="activity-details-actives">Show the numbers</summary>
              <div className="tblwrap" id="t-actives"></div>
            </details>
          </div>
          <div className="grid2">
            <div className="card">
              <h3>Engagement depth</h3>
              <p className="note">
                Active hours per day, summed across users. The writer is throttled to one row per
                user per hour, so this counts distinct hours of real use.
              </p>
              <div className="chart" id="c-hours"></div>
            </div>
            <div className="card">
              <h3>New accounts per day</h3>
              <p className="note">Registered signups and guest sessions created, stacked.</p>
              <div className="legend" id="su-legend"></div>
              <div className="chart" id="c-signups"></div>
            </div>
          </div>
          <div className="card">
            <h3>Do they come back?</h3>
            <p className="note">
              Share of users seen again within N days of their first tracked day. Only users whose
              first day leaves room for the full window are counted, so the tail is not deflated by
              recency.
            </p>
            <div className="legend" id="ret-legend"></div>
            <div className="chart" id="c-retention"></div>
          </div>
        </section>

        <section>
          <div className="sec-head">
            <h2>Signup → import</h2>
            <p>
              An account is worth nothing until games are in it. This is where new accounts fall out
              on the way there — and which guests decide to stay.
            </p>
          </div>
          <div className="card">
            <h3>Conversion funnel</h3>
            <p className="note">
              Every account created since tracking began, followed through to a real game library.
              Linking a chess.com or lichess username is the gate: once it is linked, the import
              fires within seconds and almost never fails.
            </p>
            <div className="grid2" id="funnels">
              <div>
                <div className="eyebrow" style={{ marginBottom: '10px' }}>
                  Registered accounts
                </div>
                <div className="chart" id="c-funnel-reg"></div>
              </div>
              <div>
                <div className="eyebrow" style={{ marginBottom: '10px' }}>
                  Guest sessions
                </div>
                <div className="chart" id="c-funnel-guest"></div>
              </div>
            </div>
            <details className="data">
              <summary data-testid="activity-details-funnel">Show the numbers</summary>
              <div className="tblwrap" id="t-funnel"></div>
            </details>
          </div>
          <div className="grid2">
            <div className="card">
              <h3>How long until the first import?</h3>
              <p className="note">
                Time from account creation to the first import job, as a share of each cohort. The
                decision is made in the first minutes or not at all.
              </p>
              <div className="legend" id="tti-legend"></div>
              <div className="chart" id="c-tti"></div>
            </div>
            <div className="card">
              <h3>Does importing make them stick?</h3>
              <p className="note">
                Share of each group seen on a second, separate day. Importing nearly doubles the
                return rate for registered accounts and does nothing for guests.
              </p>
              <div className="legend" id="stick-legend"></div>
              <div className="chart" id="c-stick"></div>
            </div>
          </div>
          <div className="card">
            <h3>Guest → registered</h3>
            <p className="note">
              A guest who signs up is promoted in place: the same row keeps its games, its imports
              and its original creation date, and simply stops being a guest. That makes converters
              countable, for the reason under the chart.
            </p>
            <div className="split">
              <div className="hero">
                <span className="cap">Guest → registered</span>
                <span className="big" id="conv-big"></span>
                <span className="exp" id="conv-exp"></span>
              </div>
              <div>
                <div className="legend" id="conv-legend"></div>
                <div className="chart" id="c-conv"></div>
              </div>
            </div>
            <p className="note" style={{ marginTop: '12px' }}>
              Both promotion paths have been counted since <span id="cav-promoted">—</span>: the
              account row is stamped with a promotion timestamp when a guest signs up with either
              Google or an email and password. Before that date only the Google path left a
              detectable mark, and the recovered rows are stamped with their signup date rather than
              their true promotion date — so the earlier part of the series is a floor, not the true
              rate, and any conversion-timing chart is only meaningful from that date forward.
            </p>
          </div>
        </section>

        <section>
          <div className="sec-head">
            <h2>Bot games</h2>
            <p>
              <span id="bot-blurb">Games played against the FlawChess bot.</span>
            </p>
          </div>
          <div className="card">
            <h3>Games per day</h3>
            <p className="note">
              Result is from the human&apos;s side. Bot play is bursty: a handful of users play long
              sets in one sitting.
            </p>
            <div className="legend" id="bot-legend"></div>
            <div className="chart" id="c-bot"></div>
            <details className="data">
              <summary data-testid="activity-details-bot">Show the numbers</summary>
              <div className="tblwrap" id="t-bot"></div>
            </details>
          </div>
          <div className="grid2">
            <div className="card">
              <h3>Which opponent do they pick?</h3>
              <p className="note">
                Games by persona style, with the share of distinct users who tried each.
              </p>
              <div className="chart" id="c-persona"></div>
            </div>
            <div className="card">
              <h3>Human score by bot rating</h3>
              <p className="note">
                Score = win + ½ draw. Ratings with fewer than 10 games are dropped. The ladder holds
                except at 1700, where only 16 games have been played.
              </p>
              <div className="chart" id="c-elo"></div>
            </div>
          </div>
        </section>

        <section>
          <div className="sec-head">
            <h2>Train sessions</h2>
            <p>
              Drill sessions are composed per calendar day and expire when the next scheduled
              session day starts, so completion rate is the metric that matters.
            </p>
          </div>
          <div className="card">
            <h3>Sessions per day by outcome</h3>
            <div className="legend" id="tr-legend"></div>
            <div className="chart" id="c-train"></div>
            <details className="data">
              <summary data-testid="activity-details-train">Show the numbers</summary>
              <div className="tblwrap" id="t-train"></div>
            </details>
          </div>
          <div className="grid2">
            <div className="card">
              <h3>Puzzles solved per day</h3>
              <p className="note">Individual drill positions attempted.</p>
              <div className="chart" id="c-solves"></div>
            </div>
            <div className="card">
              <h3>Accuracy on solved puzzles</h3>
              <p className="note">
                Share correct, 7-day rolling. Move = played the right move; guess = called the
                position&apos;s verdict correctly.
              </p>
              <div className="legend" id="acc-legend"></div>
              <div className="chart" id="c-acc"></div>
            </div>
          </div>
        </section>

        <section>
          <div className="sec-head">
            <h2>Imports</h2>
            <p>
              Game imports are the first thing a new user does, so import volume tracks acquisition
              rather than habit.
            </p>
          </div>
          <div className="grid2">
            <div className="card">
              <h3>Games imported per day</h3>
              <p className="note">
                Log-scaled — launch day alone pulled in 136k games, three orders of magnitude above
                a quiet day.
              </p>
              <div className="chart" id="c-imports"></div>
            </div>
            <div className="card">
              <h3>Importing users per day</h3>
              <p className="note">Distinct users who ran at least one import job.</p>
              <div className="chart" id="c-impusers"></div>
            </div>
          </div>
        </section>

        <footer>
          <div className="eyebrow">Reading this correctly</div>
          <ul className="caveats">
            <li>
              <b>
                Activity tracking starts <span id="cav-start">—</span>.
              </b>{' '}
              Nothing before that date exists in <span className="mono">user_activity</span>, so MAU
              is still filling its first window at the left edge of every chart.
            </li>
            <li>
              <b>
                <span id="cav-partial">Today</span> is a partial day
              </b>{' '}
              — the last bar in every daily series is incomplete.
            </li>
            <li>
              <b>Guests are real sessions, not bots.</b> A guest row is created when someone tries
              the app without signing up; they can convert later, and the same person may appear as
              two rows.
            </li>
            <li>
              <b>
                The <span id="cav-launch">launch</span> spike is a launch event
              </b>
              , not organic growth — <span id="cav-launch-detail"></span>.
            </li>
            <li>
              <b>A converted guest counts as a registered account in the funnel</b>, dated to when
              the guest session started — promotion happens in place, so there is no second account
              and no second creation date.
            </li>
            <li>
              <b>
                The funnel counts accounts created on or after <span id="cav-funnel">—</span>
              </b>{' '}
              — earlier accounts are excluded, so it measures the launch cohort rather than the whole
              user base. Train is registered-only, which is why no guest ever reaches it.
            </li>
            <li>
              <b>Bot games and Train sessions arrived later</b> — <span id="cav-features"></span>,
              both after activity tracking began.
            </li>
          </ul>
        </footer>
      </div>
      <div className="tip" id="tip" role="status" aria-live="polite"></div>
    </main>
  );
}
