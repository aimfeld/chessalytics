import axios from 'axios';
import { queryClient } from '@/lib/queryClient';
import type {
  PositionBookmarkResponse, PositionBookmarkCreate, PositionBookmarkUpdate,
  PositionBookmarkReorderRequest, TimeSeriesRequest, TimeSeriesResponse,
  MatchSideUpdateRequest
} from '@/types/position_bookmarks';
import type {
  RatingHistoryResponse,
  GlobalStatsResponse,
  MostPlayedOpeningsResponse,
  BookmarkPhaseEntryRequest,
  BookmarkPhaseEntryResponse,
} from '@/types/stats';
import type { EndgameGamesResponse, EndgameOverviewResponse } from '@/types/endgames';
import type { GameFlawCard, LibraryGamesResponse, FlawStatsResponse, LibraryFlawsResponse, FlawComparisonResponse, TacticComparisonResponse, TacticLinesResponse } from '@/types/library';
import type { OpponentStrengthRange } from '@/types/api';
import { rangeToQueryParams } from '@/lib/opponentStrength';
import type { FeedbackRequest, FeedbackResponse } from '@/types/feedback';
import type { StoreBotGameRequest, StoreBotGameResponse, PersonaWinsResponse } from '@/types/bots';
import type {
  TrainSessionResponse,
  SolveRequest,
  SolveResponse,
  PuzzleRevealResponse,
  TrainSettingsResponse,
  TrainSettingsUpdate,
} from '@/types/train';

/**
 * Central Axios instance.
 *
 * Uses relative URLs so the Vite dev-server proxy forwards requests to the
 * FastAPI backend at http://localhost:8000.  In production the same relative
 * paths work because the frontend is served from the same origin as the API.
 */
export const apiClient = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
  // FastAPI expects repeated keys for array params (e.g. time_control=blitz&time_control=rapid),
  // not bracket notation (time_control[]=blitz) which is axios's default.
  // Bug fix: without this, array query params like time_control and platform were silently
  // ignored by the backend, causing filters to have no effect on GET endpoints.
  paramsSerializer: {
    indexes: null,
  },
});

// ─── Request interceptor: attach Bearer token ─────────────────────────────

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// ─── Response interceptor: handle 401 ────────────────────────────────────

apiClient.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 401
    ) {
      const onLoginPage = window.location.pathname === '/login';
      const isAuthRoute = (error.config?.url ?? '').startsWith('/api/auth/');

      if (!onLoginPage && !isAuthRoute) {
        queryClient.clear();
        localStorage.removeItem('auth_token');
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

// ─── Filter Params Builder ────────────────────────────────────────────────────

/** Build query params object from standard filter parameters, omitting empty/default values. */
export function buildFilterParams(params: {
  time_control?: string[] | null;
  platform?: string[] | null;
  from_date?: string | null;
  to_date?: string | null;
  rated?: boolean | null;
  opponent_type?: string;
  opponent_strength?: OpponentStrengthRange;
  window?: number;
  color?: string | null;
}): Record<string, string | string[] | number | boolean> {
  const result: Record<string, string | string[] | number | boolean> = {};
  if (params.time_control) result.time_control = params.time_control;
  if (params.platform) result.platform = params.platform;
  if (params.from_date) result.from_date = params.from_date;
  if (params.to_date) result.to_date = params.to_date;
  if (params.rated !== null && params.rated !== undefined) result.rated = params.rated;
  if (params.opponent_type && params.opponent_type !== 'all') result.opponent_type = params.opponent_type;
  if (params.opponent_strength) {
    const gap = rangeToQueryParams(params.opponent_strength);
    if (gap.opponent_gap_min !== undefined) result.opponent_gap_min = gap.opponent_gap_min;
    if (gap.opponent_gap_max !== undefined) result.opponent_gap_max = gap.opponent_gap_max;
  }
  if (params.window) result.window = params.window;
  if (params.color) result.color = params.color;
  return result;
}

// ─── Position Bookmarks API ───────────────────────────────────────────────────

export const positionBookmarksApi = {
  list: () =>
    apiClient.get<PositionBookmarkResponse[]>('/position-bookmarks').then(r => r.data),
  create: (data: PositionBookmarkCreate) =>
    apiClient.post<PositionBookmarkResponse>('/position-bookmarks', data).then(r => r.data),
  updateLabel: (id: number, data: PositionBookmarkUpdate) =>
    apiClient.put<PositionBookmarkResponse>(`/position-bookmarks/${id}`, data).then(r => r.data),
  remove: (id: number) =>
    apiClient.delete(`/position-bookmarks/${id}`),
  reorder: (req: PositionBookmarkReorderRequest) =>
    apiClient.put<PositionBookmarkResponse[]>('/position-bookmarks/reorder', req).then(r => r.data),
  updateMatchSide: (id: number, data: MatchSideUpdateRequest) =>
    apiClient.patch<PositionBookmarkResponse>(`/position-bookmarks/${id}/match-side`, data).then(r => r.data),
};

// ─── Time Series API ──────────────────────────────────────────────────────────

export const timeSeriesApi = {
  fetch: (req: TimeSeriesRequest) =>
    apiClient.post<TimeSeriesResponse>('/openings/time-series', req).then(r => r.data),
};

// ─── Stats API ────────────────────────────────────────────────────────────────

export const statsApi = {
  getRatingHistory: (
    dateParams: { from_date?: string; to_date?: string },
    platform: string | null,
    opponentType: string,
    opponentStrength: OpponentStrengthRange,
  ) =>
    apiClient.get<RatingHistoryResponse>('/stats/rating-history', {
      params: buildFilterParams({
        ...dateParams,
        platform: platform ? [platform] : null,
        opponent_type: opponentType,
        opponent_strength: opponentStrength,
      }),
    }).then(r => r.data),

  getGlobalStats: (
    dateParams: { from_date?: string; to_date?: string },
    platform: string | null,
    opponentType: string,
    opponentStrength: OpponentStrengthRange,
    color: string | null = null,
  ) =>
    apiClient.get<GlobalStatsResponse>('/stats/global', {
      params: buildFilterParams({
        ...dateParams,
        platform: platform ? [platform] : null,
        opponent_type: opponentType,
        opponent_strength: opponentStrength,
        color,
      }),
    }).then(r => r.data),

  getMostPlayedOpenings: (params?: {
    from_date?: string | null;
    to_date?: string | null;
    time_control?: string[] | null;
    platform?: string[] | null;
    rated?: boolean | null;
    opponent_type?: string;
    opponent_strength?: OpponentStrengthRange;
  }) =>
    apiClient.get<MostPlayedOpeningsResponse>('/stats/most-played-openings', {
      params: buildFilterParams(params ?? {}),
    }).then(r => r.data),

  getBookmarkPhaseEntryMetrics: (req: BookmarkPhaseEntryRequest) =>
    apiClient.post<BookmarkPhaseEntryResponse>('/stats/bookmark-phase-entry-metrics', req).then(r => r.data),
};

// ─── Endgame Analytics API ────────────────────────────────────────────────────

// No color parameter passed — endgame stats are color-agnostic per D-02.
export const endgameApi = {
  getOverview: (params: {
    time_control?: string[] | null;
    platform?: string[] | null;
    from_date?: string | null;
    to_date?: string | null;
    rated?: boolean | null;
    opponent_type?: string;
    opponent_strength?: OpponentStrengthRange;
    window?: number;
  }) =>
    apiClient.get<EndgameOverviewResponse>('/endgames/overview', {
      params: buildFilterParams(params),
    }).then(r => r.data),

  getGames: (params: {
    endgame_class: string;
    time_control?: string[] | null;
    platform?: string[] | null;
    from_date?: string | null;
    to_date?: string | null;
    rated?: boolean | null;
    opponent_type?: string;
    opponent_strength?: OpponentStrengthRange;
    offset?: number;
    limit?: number;
  }) =>
    apiClient.get<EndgameGamesResponse>('/endgames/games', {
      params: {
        endgame_class: params.endgame_class,
        ...buildFilterParams(params),
        offset: params.offset ?? 0,
        limit: params.limit ?? 20,
      },
    }).then(r => r.data),
};

// ─── Feedback API ─────────────────────────────────────────────────────────────

export const feedbackApi = {
  submit: (data: FeedbackRequest) =>
    apiClient.post<FeedbackResponse>('/feedback', data).then(r => r.data),
};

// ─── Bots API ─────────────────────────────────────────────────────────────────

export const botsApi = {
  storeGame: (data: StoreBotGameRequest) =>
    apiClient.post<StoreBotGameResponse>('/bots/games', data).then(r => r.data),
  getPersonaWins: () =>
    apiClient.get<PersonaWinsResponse>('/bots/persona-wins').then(r => r.data),
};

// ─── Train API ────────────────────────────────────────────────────────────────

export const trainApi = {
  composeOrResumeSession: () =>
    apiClient.post<TrainSessionResponse>('/train/sessions').then(r => r.data),
  solvePuzzle: (sessionId: number, data: SolveRequest) =>
    apiClient.post<SolveResponse>(`/train/sessions/${sessionId}/solve`, data).then(r => r.data),
  revealPuzzle: (sessionId: number, position: number) =>
    apiClient
      .get<PuzzleRevealResponse>(`/train/sessions/${sessionId}/puzzles/${position}/reveal`)
      .then(r => r.data),
  getSettings: () =>
    apiClient.get<TrainSettingsResponse>('/train/settings').then(r => r.data),
  updateSettings: (data: TrainSettingsUpdate) =>
    apiClient.put<TrainSettingsResponse>('/train/settings', data).then(r => r.data),
};

// ─── Library API ──────────────────────────────────────────────────────────────

export const libraryApi = {
  getGames: (params: {
    time_control?: string[] | null;
    platform?: string[] | null;
    from_date?: string | null;
    to_date?: string | null;
    rated?: boolean | null;
    opponent_type?: string;
    opponent_strength?: OpponentStrengthRange;
    color?: string | null;
    // severity and tag are multi-value: serialized as severity=blunder&severity=mistake
    // (paramsSerializer indexes:null on apiClient ensures no bracket notation)
    severity?: ('blunder' | 'mistake')[];
    tag?: string[];
    // Quick 260620-pza: tactic filters on the Games tab (mirrors getFlaws). The
    // tactic family tag group is repeated as tactic_family=fork&...; orientation is
    // omitted when 'either'; depth bounds are sent when present (the backend EXISTS
    // ignores all three unless ≥1 tactic_family is selected).
    tactic_family?: string[];
    tactic_orientation?: string;
    min_tactic_depth?: number;
    max_tactic_depth?: number;
    // FILT-01 (Phase 175): "has gem" / "has great" Library filter toggles, each
    // independent (union at the backend when both are true); omitted when false.
    has_gem?: boolean;
    has_great?: boolean;
    offset?: number;
    limit?: number;
  }) =>
    apiClient.get<LibraryGamesResponse>('/library/games', {
      params: {
        ...buildFilterParams(params),
        ...(params.severity && params.severity.length > 0 ? { severity: params.severity } : {}),
        ...(params.tag && params.tag.length > 0 ? { tag: params.tag } : {}),
        ...(params.tactic_family && params.tactic_family.length > 0
          ? { tactic_family: params.tactic_family }
          : {}),
        ...(params.tactic_orientation && params.tactic_orientation !== 'either'
          ? { tactic_orientation: params.tactic_orientation }
          : {}),
        ...(params.min_tactic_depth != null ? { min_tactic_depth: params.min_tactic_depth } : {}),
        ...(params.max_tactic_depth != null ? { max_tactic_depth: params.max_tactic_depth } : {}),
        ...(params.has_gem ? { has_gem: true } : {}),
        ...(params.has_great ? { has_great: true } : {}),
        offset: params.offset ?? 0,
        limit: params.limit ?? 20,
      },
    }).then(r => r.data),

  getFlawStats: (params: {
    time_control?: string[] | null;
    platform?: string[] | null;
    from_date?: string | null;
    to_date?: string | null;
    rated?: boolean | null;
    opponent_type?: string;
    opponent_strength?: OpponentStrengthRange;
    color?: string | null;
    severity?: ('blunder' | 'mistake')[];
  }) =>
    apiClient.get<FlawStatsResponse>('/library/flaw-stats', {
      params: {
        ...buildFilterParams(params),
        ...(params.severity && params.severity.length > 0 ? { severity: params.severity } : {}),
      },
    }).then(r => r.data),

  getFlawComparison: (params: {
    time_control?: string[] | null;
    platform?: string[] | null;
    from_date?: string | null;
    to_date?: string | null;
    rated?: boolean | null;
    opponent_type?: string;
    opponent_strength?: OpponentStrengthRange;
    color?: string | null;
    severity?: ('blunder' | 'mistake')[];
  }) =>
    apiClient.get<FlawComparisonResponse>('/library/flaw-comparison', {
      params: {
        ...buildFilterParams(params),
        ...(params.severity && params.severity.length > 0 ? { severity: params.severity } : {}),
      },
    }).then(r => r.data),

  getTacticComparison: (params: {
    time_control?: string[] | null;
    platform?: string[] | null;
    from_date?: string | null;
    to_date?: string | null;
    rated?: boolean | null;
    opponent_type?: string;
    opponent_strength?: OpponentStrengthRange;
    color?: string | null;
    severity?: ('blunder' | 'mistake')[];
    tactic_families?: string[];
  }) =>
    apiClient.get<TacticComparisonResponse>('/library/tactic-comparison', {
      params: {
        ...buildFilterParams(params),
        ...(params.severity && params.severity.length > 0 ? { severity: params.severity } : {}),
        ...(params.tactic_families && params.tactic_families.length > 0
          ? { tactic_families: params.tactic_families }
          : {}),
      },
    }).then(r => r.data),

  getFlaws: (params: {
    time_control?: string[] | null;
    platform?: string[] | null;
    from_date?: string | null;
    to_date?: string | null;
    rated?: boolean | null;
    opponent_type?: string;
    opponent_strength?: OpponentStrengthRange;
    color?: string | null;
    // severity and tag are multi-value: serialized as severity=blunder&severity=mistake
    // (paramsSerializer indexes:null on apiClient ensures no bracket notation)
    severity?: ('blunder' | 'mistake')[];
    tag?: string[];
    // Phase 126: flaw-level tactic motif family filter, repeated as tactic_family=fork&...
    tactic_family?: string[];
    // Phase 129: orientation filter ('either'|'missed'|'allowed'); omit when 'either'.
    tactic_orientation?: string;
    // Quick 260620-l5k: inclusive tactic-depth range bounds (0-based ply, 0..11).
    min_tactic_depth?: number;
    max_tactic_depth?: number;
    offset?: number;
    limit?: number;
  }) =>
    apiClient.get<LibraryFlawsResponse>('/library/flaws', {
      params: {
        ...buildFilterParams(params),
        ...(params.severity && params.severity.length > 0 ? { severity: params.severity } : {}),
        ...(params.tag && params.tag.length > 0 ? { tag: params.tag } : {}),
        ...(params.tactic_family && params.tactic_family.length > 0
          ? { tactic_family: params.tactic_family }
          : {}),
        // Phase 129: orientation — omit when 'either' (default, no param needed)
        ...(params.tactic_orientation && params.tactic_orientation !== 'either'
          ? { tactic_orientation: params.tactic_orientation }
          : {}),
        // Quick 260620-l5k: depth range — both bounds sent when present (0 is valid).
        ...(params.min_tactic_depth != null ? { min_tactic_depth: params.min_tactic_depth } : {}),
        ...(params.max_tactic_depth != null ? { max_tactic_depth: params.max_tactic_depth } : {}),
        offset: params.offset ?? 0,
        limit: params.limit ?? 20,
      },
    }).then(r => r.data),

  getTacticLines: (gameId: number, ply: number) =>
    apiClient
      .get<TacticLinesResponse>(`/library/flaws/${gameId}/${ply}/tactic-lines`)
      .then(r => r.data),

  // Quick 260702-mnd (D-3): the backend endpoint no longer accepts severity/tactic
  // filter params (they only drove now-removed per-slot pruning) — no query params.
  getGame: (gameId: number) =>
    apiClient.get<GameFlawCard>(`/library/games/${gameId}`).then(r => r.data),
};
