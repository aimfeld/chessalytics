import type { UseMutationResult } from '@tanstack/react-query';
import { BarChart3, BookOpen, Lightbulb, ListChecks, Loader2, Sparkles, Target, UserCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { DEFAULT_FILTERS, type FilterState } from '@/components/filters/FilterPanel';
import { derivePreset } from '@/lib/opponentStrength';
import { useActiveJobs } from '@/hooks/useImport';
import { useUserProfile } from '@/hooks/useUserProfile';
import { useUserFlag, setUserFlag } from '@/hooks/useUserFlag';
import type {
  EndgameInsightsResponse,
  InsightsAxiosError,
} from '@/types/insights';

const FLAG_INSIGHTS_USED = 'insights_used';

// Curated endgame study resource (GM Noël Studer), shown as a static link in the
// Recommendations card. Kept out of the LLM payload so the URL is always correct
// and clickable rather than emitted as dead plain text by the model.
const ENDGAME_STUDY_URL = 'https://lichess.org/study/mtiahamI';

// Lichess endgame puzzle trainer, shown alongside the study link for hands-on
// practice. Kept out of the LLM payload for the same reason as the study URL.
const ENDGAME_PUZZLES_URL = 'https://lichess.org/training/endgame';

/**
 * Top-of-tab Insights card.
 *
 * Parent owns the mutation + rendered state and only passes `rendered` when
 * the cached report matches current filters, so this component never has to
 * reason about "outdated" reports. When filters drift away from what the
 * report was generated against, the parent clears it and we fall back to the
 * hero state with a single "Generate Insights" CTA.
 *
 * Button gating: the Generate Insights button is disabled whenever any
 * non-default filter other than opponent_strength is set, or an import is
 * running. The tooltip surfaces the first-blocking reason.
 */
export interface EndgameInsightsBlockProps {
  appliedFilters: FilterState;
  rendered: EndgameInsightsResponse | null;
  mutation: UseMutationResult<EndgameInsightsResponse, InsightsAxiosError, FilterState>;
  onGenerate: () => void;
}

/**
 * Returns the first-blocking reason that prevents generating an insights
 * report, or null when the button should be enabled. opponent_strength is
 * intentionally allowed (it's a valid cross-section the prompt scopes to).
 */
function getBlockedReason(
  filters: FilterState,
  hasActiveImport: boolean,
): string | null {
  if (hasActiveImport) return 'Wait for import to finish';
  if (
    filters.recency !== DEFAULT_FILTERS.recency ||
    filters.timeControls !== DEFAULT_FILTERS.timeControls ||
    filters.platforms !== DEFAULT_FILTERS.platforms ||
    filters.rated !== DEFAULT_FILTERS.rated ||
    filters.opponentType !== DEFAULT_FILTERS.opponentType ||
    filters.matchSide !== DEFAULT_FILTERS.matchSide
  ) {
    return 'Reset the filters before generating insights';
  }
  // Insights only support the four opponent-strength presets. A custom slider
  // range (not matching any preset) is rejected by the router.
  if (derivePreset(filters.opponentStrength) === null) {
    return 'Snap opponent strength to a preset (Any / Stronger / Similar / Weaker)';
  }
  return null;
}

export function EndgameInsightsBlock({
  appliedFilters,
  rendered,
  mutation,
  onGenerate,
}: EndgameInsightsBlockProps) {
  const { data: activeJobs } = useActiveJobs(true);
  const { data: profile } = useUserProfile();
  const insightsUsed = useUserFlag(FLAG_INSIGHTS_USED, profile?.email);

  const isPending = mutation.isPending;
  const isError = mutation.isError;
  const hasRendered = rendered !== null;

  const hasActiveImport = (activeJobs?.length ?? 0) > 0;
  const blockedReason = getBlockedReason(appliedFilters, hasActiveImport);

  const handleGenerateClick = () => {
    if (profile?.email) setUserFlag(FLAG_INSIGHTS_USED, profile.email);
    onGenerate();
  };

  return (
    <Accordion type="single" collapsible defaultValue="insights">
      <AccordionItem
        value="insights"
        data-testid="insights-block"
        className="charcoal-texture rounded-md overflow-hidden border-none"
      >
        <AccordionTrigger
          data-testid="insights-block-trigger"
          band
        >
          <span className="flex items-center gap-2 flex-1">
            <span className="insight-lightbulb" aria-hidden="true">
              <Lightbulb className="size-5" />
            </span>
            <h2 className="text-base font-semibold text-foreground">Insights</h2>
          </span>
        </AccordionTrigger>
        <AccordionContent className="p-4">
          {isError ? (
            <ErrorState
              onRetry={handleGenerateClick}
            />
          ) : isPending && !hasRendered ? (
            <SkeletonBlock />
          ) : hasRendered ? (
            <RenderedState
              response={rendered}
              isPending={isPending}
              blockedReason={blockedReason}
              onRegenerate={handleGenerateClick}
            />
          ) : (
            <HeroState
              isPending={isPending}
              blockedReason={blockedReason}
              showDot={!insightsUsed}
              onGenerate={handleGenerateClick}
            />
          )}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

// ─── State components ──────────────────────────────────────────────────

/** Wrap a disabled button in a Tooltip that explains the blocking reason. */
function MaybeBlockedTooltip({
  reason,
  children,
}: {
  reason: string | null;
  children: React.ReactNode;
}) {
  if (reason === null) return <>{children}</>;
  return (
    <Tooltip content={reason} delayDuration={0}>
      <span className="inline-block">{children}</span>
    </Tooltip>
  );
}

function HeroState({
  isPending,
  blockedReason,
  showDot,
  onGenerate,
}: {
  isPending: boolean;
  blockedReason: string | null;
  showDot: boolean;
  onGenerate: () => void;
}) {
  const disabled = isPending || blockedReason !== null;
  return (
    <>
      <p
        className="text-sm italic text-muted-foreground mb-3"
        data-testid="endgame-insights-tip"
      >
        <span className="font-semibold text-foreground/80">Tip:</span> Generate a player profile, endgame data analysis, and recommendations using an LLM.
      </p>
      <MaybeBlockedTooltip reason={blockedReason}>
        <Button
          variant="brand-outline"
          onClick={onGenerate}
          disabled={disabled}
          data-testid="btn-generate-insights"
          className="relative"
        >
          <Sparkles className="h-4 w-4" />
          Generate Insights
          {showDot && !disabled && (
            <span
              className="absolute -top-1 -right-1 flex h-2.5 w-2.5"
              data-testid="generate-insights-notification-dot"
            >
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
          )}
        </Button>
      </MaybeBlockedTooltip>
    </>
  );
}

function SkeletonBlock() {
  return (
    <div data-testid="insights-skeleton">
      <div
        className="flex items-center gap-2 text-sm text-muted-foreground mb-3"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        <span>Generating insights may take around 30 seconds...</span>
      </div>
      <div className="animate-pulse">
        <div className="h-4 w-full bg-muted/30 rounded mb-2" />
        <div className="h-4 w-11/12 bg-muted/30 rounded mb-2" />
        <div className="h-4 w-3/4 bg-muted/30 rounded mb-3" />
        <div className="h-8 w-32 bg-muted/30 rounded" />
      </div>
    </div>
  );
}

function RenderedState({
  response,
  isPending,
  blockedReason,
  onRegenerate,
}: {
  response: EndgameInsightsResponse;
  isPending: boolean;
  blockedReason: string | null;
  onRegenerate: () => void;
}) {
  const { player_profile: playerProfile, overview, recommendations } = response.report;
  const showOverview = overview !== '';
  const showPlayerProfile = playerProfile !== '';
  const showRecommendations = recommendations.length > 0;

  const disabled = isPending || blockedReason !== null;

  return (
    <>
      <div className="space-y-5 mb-3">
        {showPlayerProfile && (
          <InsightsSection
            testId="insights-player-profile"
            title="Player Profile"
            icon={UserCircle2}
          >
            <div className="text-sm text-muted-foreground leading-relaxed space-y-3">
              {playerProfile.split(/\n\n+/).map((paragraph, idx) => (
                <p key={idx}>{paragraph}</p>
              ))}
            </div>
          </InsightsSection>
        )}
        {showOverview && (
          <InsightsSection
            testId="insights-overview"
            title="Data Analysis"
            icon={BarChart3}
          >
            <div className="text-sm text-muted-foreground leading-relaxed space-y-3">
              {overview.split(/\n\n+/).map((paragraph, idx) => (
                <p key={idx}>{paragraph}</p>
              ))}
            </div>
          </InsightsSection>
        )}
        {showRecommendations && (
          <InsightsSection
            testId="insights-recommendations"
            title="Recommendations"
            icon={ListChecks}
          >
            <ul className="text-sm text-muted-foreground leading-relaxed list-disc pl-5 space-y-1">
              {recommendations.map((rec, idx) => (
                <li key={idx}>{rec}</li>
              ))}
            </ul>
            <div className="mt-3 space-y-2 border-t border-border/60 pt-3 text-sm text-muted-foreground">
              <div className="flex items-start gap-2">
                <BookOpen className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  Study endgame technique by level (Basic to Advanced):{' '}
                  <a
                    href={ENDGAME_STUDY_URL}
                    data-umami-event="outbound-endgame-study"
                    className="text-primary underline-offset-4 hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="insights-rec-endgame-study-link"
                  >
                    GM Noël Studer's endgame study
                  </a>
                </span>
              </div>
              <div className="flex items-start gap-2">
                <Target className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  Practice endgame puzzles:{' '}
                  <a
                    href={ENDGAME_PUZZLES_URL}
                    data-umami-event="outbound-endgame-puzzles"
                    className="text-primary underline-offset-4 hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="insights-rec-endgame-puzzles-link"
                  >
                    Lichess endgame puzzles
                  </a>
                </span>
              </div>
            </div>
          </InsightsSection>
        )}
      </div>
      <div className="flex items-center gap-2">
        <MaybeBlockedTooltip reason={blockedReason}>
          <Button
            variant="brand-outline"
            onClick={onRegenerate}
            disabled={disabled}
            aria-busy={isPending}
            data-testid="btn-generate-insights"
          >
            <Sparkles className="h-4 w-4" />
            Generate Insights
          </Button>
        </MaybeBlockedTooltip>
        {isPending && (
          <div
            className="flex items-center gap-2 text-sm text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            <span>Generating insights may take around 30 seconds...</span>
          </div>
        )}
      </div>
    </>
  );
}

function InsightsSection({
  testId,
  title,
  icon: Icon,
  children,
}: {
  testId: string;
  title: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId}>
      <h3 className="flex items-center gap-2 text-base font-semibold text-foreground mb-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        {title}
      </h3>
      {children}
    </div>
  );
}

function ErrorState({
  onRetry,
}: {
  onRetry: () => void;
}) {
  return (
    <div data-testid="insights-error" role="alert">
      <p className="mb-2 text-base font-medium text-foreground">
        {"Couldn't generate insights."}
      </p>
      <p className="text-sm text-muted-foreground">
        Please try again in a moment.
      </p>
      <Button
        variant="brand-outline"
        onClick={onRetry}
        data-testid="btn-insights-retry"
        className="mt-3"
      >
        Try again
      </Button>
    </div>
  );
}
