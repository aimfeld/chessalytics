import type { Dispatch, ReactElement, ReactNode, SetStateAction } from 'react';
import { ArrowLeftRight, ChartNoAxesColumn, ChessKnight, ClipboardPaste, Cpu, User } from 'lucide-react';
import { Card, CardHeader, CardBody } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { InfoPopover } from '@/components/ui/info-popover';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { VariationTree } from '@/components/analysis/VariationTree';
import type { VariationTreeProps } from '@/components/analysis/VariationTree';
import { BoardControls as BoardControlsBase } from '@/components/board/BoardControls';
import { EngineToggleHeader } from '@/components/analysis/EngineToggleHeader';
import { EngineLines, EngineLinesSkeleton, LINES_MIN_HEIGHT } from '@/components/analysis/EngineLines';
import { FlawChessEngineLines } from '@/components/analysis/FlawChessEngineLines';
import { FlawChessAgreementVerdict } from '@/components/analysis/FlawChessAgreementVerdict';
import { MaiaHumanPanel } from '@/components/analysis/MaiaHumanPanel';
import { EloSelector } from '@/components/analysis/EloSelector';
import { TemperatureSelector } from '@/components/analysis/TemperatureSelector';
import type { HoveredQualityMove } from '@/components/analysis/MaiaMoveQualityBar';
import type { MoveQualityEval, EngineLine } from '@/components/analysis/MovesByRatingChart';
import { AnalysisTagsPanel } from '@/components/analysis/AnalysisTagsPanel';
import { EvalChart } from '@/components/library/EvalChart';
import { AnalysisPendingPill } from '@/components/library/AnalysisPendingPill';
import { STOCKFISH_ACCENT, MAIA_ACCENT, FLAWCHESS_ENGINE_ACCENT } from '@/lib/theme';
import { sideToMoveFromFen, type MoverColor } from '@/lib/liveFlaw';
import { forkPlyForOrientation, flawKey } from '@/lib/analysisTactics';
import type { RankedLine } from '@/lib/engine/types';
import type { PvLine } from '@/hooks/uciParser';
import type { NodeId } from '@/hooks/useAnalysisBoard';
import type { UseMaiaEngineState } from '@/hooks/useMaiaEngine';
import type { GameFlawCard } from '@/types/library';

/**
 * AnalysisTabs — the mobile/mid tabbed panel (Moves | Eval | Maia | FlawChess |
 * Stats) and the shared render fragments it composes, extracted from
 * `Analysis.tsx`'s `variationTree`/`boardControls`/`evalChart`/`tagsPanel`/
 * `eloSelector`/`renderFlawChessCard`/`humanTab`/`flawChessTab`/
 * `mobileEngineLines`/`evalTab`/`moveListHeaderContent`/`movesTab`/`statsTab`/
 * `analysisTabs` render helpers (215-06).
 *
 * Several of these fragments (`VariationTreePanel`, `BoardControls`,
 * `EvalChartPanel`, `TagsPanel`, `EloSelectorPanel`, `FlawChessCard`,
 * `MoveListHeaderContent`) are also consumed by the desktop board-stage/cards
 * components 215-06 extracts to `AnalysisBoardStage.tsx`/
 * `AnalysisDesktopCards.tsx` — they import from here rather than duplicating.
 */

/**
 * Header info tooltip for the FlawChess Engine card. Private duplicate of
 * Analysis.tsx's own module-level `FlawChessInfoTooltip` (this file's `FlawChessCard`
 * is its only NEW reader; `stockfishCard`, the other pre-existing reader of
 * `EngineToggleHeader`, does not read this one).
 */
function FlawChessInfoTooltip(): ReactElement {
  return (
    <InfoPopover ariaLabel="About the FlawChess Engine" testId="flawchess-info-popover">
      <div className="max-w-xs space-y-2">
        <p>
          Stockfish shows the objectively best move, assuming perfect play. The FlawChess
          Engine instead favors moves you can realistically pull off: ones that are easier
          for a player at your level to find (along with their follow-ups), and that pay off
          against an opponent who defends imperfectly, the way real players do.
        </p>
        <p>
          It blends Stockfish's objective quality with Maia's model of how humans at a given
          rating really play, treating both sides as fallible. So it can rank a trap above
          the textbook best move, showing both numbers: "objectively +3.0, but practically
          +0.9 for you."
        </p>
      </div>
    </InfoPopover>
  );
}

// ─── VariationTreePanel ─────────────────────────────────────────────────────────

export type VariationTreePanelProps = Omit<
  VariationTreeProps,
  'initialPly' | 'pvNodeIds' | 'onPvChipClick' | 'activePvKeys' | 'pvFetchPending' | 'pvFetchError'
> & {
  /**
   * Gates the six game-mode-only VariationTree props below (initialAlignPly,
   * pvNodeIds, onPvChipClick, activePvKeys, pvFetchPending/Error) — computed
   * INSIDE this component rather than at each call site, so the ternary lives
   * in VariationTreePanel's own complexity count, not Analysis()'s (the same
   * seam BoardHeaderRow uses for its showPlayerBars branch, 215-06 Task 1).
   */
  isGameMode: boolean;
  initialAlignPly: VariationTreeProps['initialPly'];
  pvNodeIds: NonNullable<VariationTreeProps['pvNodeIds']>;
  onPvChipClick: NonNullable<VariationTreeProps['onPvChipClick']>;
  activePvKeys: NonNullable<VariationTreeProps['activePvKeys']>;
  pvFetchPending: NonNullable<VariationTreeProps['pvFetchPending']>;
  pvFetchError: NonNullable<VariationTreeProps['pvFetchError']>;
};

// VariationTree props — shared between the desktop side panel and the mobile Moves
// tab. The mobile tab passes variant="vertical" to fill the space; props are
// otherwise identical.
export function VariationTreePanel({
  isGameMode,
  initialAlignPly,
  pvNodeIds,
  onPvChipClick,
  activePvKeys,
  pvFetchPending,
  pvFetchError,
  ...rest
}: VariationTreePanelProps): ReactElement {
  return (
    <VariationTree
      {...rest}
      initialPly={isGameMode ? initialAlignPly : undefined}
      pvNodeIds={isGameMode ? pvNodeIds : undefined}
      onPvChipClick={isGameMode ? onPvChipClick : undefined}
      activePvKeys={isGameMode ? activePvKeys : undefined}
      pvFetchPending={isGameMode ? pvFetchPending : undefined}
      pvFetchError={isGameMode ? pvFetchError : undefined}
    />
  );
}

// ─── BoardControls ──────────────────────────────────────────────────────────────

export type BoardControlsProps = {
  flat?: boolean;
  size?: 'sm' | 'md' | 'lg';
  onBack: () => void;
  onForward: () => void;
  onReset: () => void;
  onFlip: () => void;
  canGoBack: boolean;
  canReset: boolean;
  canGoForward: boolean;
  /**
   * Fast-forward is game-mode only; this component owns the `isGameMode` gate
   * itself (rather than a caller-computed `isGameMode ? fastForward.start :
   * undefined`) so the ternary lives in BoardControls's own complexity count,
   * not Analysis()'s — same seam as VariationTreePanel's `isGameMode` prop.
   */
  isGameMode: boolean;
  onFastForwardStart: () => void;
  canFastForward: boolean;
};

// Board controls — shared. The desktop panel sits in the move-list card's darker
// footer band (flat, compact sm icons evenly spread); the mobile footer passes flat
// with no size so the buttons fill the width like the main nav (Quick 260628-dgv).
export function BoardControls({
  flat = false,
  size,
  onBack,
  onForward,
  onReset,
  onFlip,
  canGoBack,
  canReset,
  canGoForward,
  isGameMode,
  onFastForwardStart,
  canFastForward,
}: BoardControlsProps): ReactElement {
  return (
    <BoardControlsBase
      onBack={onBack}
      onForward={onForward}
      onReset={onReset}
      onFlip={onFlip}
      canGoBack={canGoBack}
      canReset={canReset}
      canGoForward={canGoForward}
      onFastForward={isGameMode ? onFastForwardStart : undefined}
      canFastForward={canFastForward}
      flat={flat}
      size={size}
    />
  );
}

// ─── EvalChartPanel ─────────────────────────────────────────────────────────────

export type EvalChartPanelProps = {
  heightClass: string;
  highlightedPlies?: Set<number> | null;
  evalChartReady: boolean;
  evalPending: boolean;
  gameId: number | null;
  gameData: GameFlawCard | undefined;
  initialPly: number | null;
  onHoverPlyChange: (ply: number | null) => void;
  evalChartPly: number | null;
  tagCommandedPly: number | null;
  tagCommandSeq: number;
};

// The eval-chart element (game mode only) — placed below the board on desktop,
// inside the Eval tab on mobile. Renders the eval chart when ready, the
// pending/leased pill while analysis is in flight, or null otherwise (free play,
// or a card with no active job).
export function EvalChartPanel({
  heightClass,
  highlightedPlies,
  evalChartReady,
  evalPending,
  gameId,
  gameData,
  initialPly,
  onHoverPlyChange,
  evalChartPly,
  tagCommandedPly,
  tagCommandSeq,
}: EvalChartPanelProps): ReactElement | null {
  if (
    evalChartReady &&
    gameId != null &&
    gameData?.eval_series != null &&
    gameData.flaw_markers != null &&
    gameData.phase_transitions != null &&
    gameData.moves != null
  ) {
    return (
      <EvalChart
        gameId={gameId}
        evalSeries={gameData.eval_series}
        flawMarkers={gameData.flaw_markers}
        phaseTransitions={gameData.phase_transitions}
        moves={gameData.moves}
        heightClass={heightClass}
        initialPly={initialPly}
        flipped={gameData.user_color === 'black'}
        // User-scope the gem/great dot layer (Plan 06 fix): best_move_tier is
        // position-scoped, so pass user_color to exclude the opponent's gems/greats.
        userColor={
          gameData.user_color === 'white' || gameData.user_color === 'black'
            ? gameData.user_color
            : undefined
        }
        sliderTestId="analysis-eval-chart-slider"
        disableHoverScrub
        onHoverPlyChange={onHoverPlyChange}
        syncPly={evalChartPly}
        commandedPly={tagCommandedPly}
        commandSeq={tagCommandSeq}
        highlightedPlies={highlightedPlies}
      />
    );
  }
  if (evalPending && gameId != null) {
    return <AnalysisPendingPill gameId={gameId} leased={gameData?.active_eval_status === 'leased'} />;
  }
  return null;
}

// ─── TagsPanel ──────────────────────────────────────────────────────────────────

export type TagsPanelProps = {
  withHighlight?: boolean;
  section?: 'panel' | 'stats' | 'tags';
  evalChartReady: boolean;
  gameData: GameFlawCard | undefined;
  mainLine: readonly NodeId[];
  openLines: Map<string, { rootNodeId: NodeId; ply: number; orientation: 'missed' | 'allowed' }>;
  goToNode: (id: NodeId) => void;
  onPvChipClick: (nodeId: NodeId, flaw: { ply: number; orientation: 'missed' | 'allowed' }) => void;
  setMoveListTopAlignSeq: Dispatch<SetStateAction<number>>;
  setTagCommandedPly: Dispatch<SetStateAction<number | null>>;
  setTagCommandSeq: Dispatch<SetStateAction<number>>;
  setTagsHighlightedPlies?: Dispatch<SetStateAction<Set<number> | null>>;
};

// The flaw-tags panel (game mode only, quick-260702-nm8) — MoveStats card + Missed |
// Allowed | Context tags. Cycling a cell/chip reuses the exact goToNode pattern the
// move list uses — a single call auto-syncs board + move list + eval-chart crosshair.
export function TagsPanel({
  withHighlight = false,
  section = 'panel',
  evalChartReady,
  gameData,
  mainLine,
  openLines,
  goToNode,
  onPvChipClick,
  setMoveListTopAlignSeq,
  setTagCommandedPly,
  setTagCommandSeq,
  setTagsHighlightedPlies,
}: TagsPanelProps): ReactElement | null {
  if (!evalChartReady || !gameData) return null;
  return (
    <AnalysisTagsPanel
      game={gameData}
      section={section}
      onCyclePly={(ply, orientation) => {
        // T-140-02b: L-8 guard for noUncheckedIndexedAccess.
        const nodeId = mainLine[ply];
        // The ply the board should rest on: a missed line forks at ply-1 (the decision
        // board), an allowed line at ply; context tags / Move Stats cells navigate to the
        // flaw ply itself.
        const restPly = orientation !== undefined ? forkPlyForOrientation(ply, orientation) : ply;
        if (orientation !== undefined && nodeId !== undefined) {
          // Missed/allowed tactic badge: unfold its sideline AND navigate to the decision
          // fork (ply-1 for missed, flaw ply for allowed). Unlike the move-list chip, the
          // tags-card badge NEVER folds an already-open line (UAT): if the sideline is
          // already unfolded, just navigate to the fork instead of toggling it shut.
          const key = flawKey({ ply, orientation });
          if (openLines.has(key)) {
            const forkNodeId = mainLine[restPly];
            if (forkNodeId !== undefined) goToNode(forkNodeId);
          } else {
            onPvChipClick(nodeId, { ply, orientation });
          }
        } else if (nodeId !== undefined) {
          goToNode(nodeId);
        }
        // Top-align the navigated move so a downward jump lands at the TOP of the move
        // list (with an unfolded sideline visible below), not clipped at the bottom.
        setMoveListTopAlignSeq((s) => s + 1);
        // Surface the eval-chart tooltip on the board's RESTING ply (the fork for a missed
        // line), NOT the raw flaw ply: the command's onHoverPlyChange re-navigates the
        // board, so commanding the flaw ply would yank the cursor one move past a missed
        // line's decision fork on a repeat click.
        setTagCommandedPly(restPly);
        setTagCommandSeq((s) => s + 1);
      }}
      onHighlightChange={withHighlight ? setTagsHighlightedPlies : undefined}
    />
  );
}

// ─── EloSelectorPanel ───────────────────────────────────────────────────────────

export type EloSelectorPanelProps = {
  value: number;
  onChange: (elo: number) => void;
  defaultElo: number;
  onReset: () => void;
};

// Shared ELO slider: drives BOTH the FlawChess and Maia engines, so on desktop it
// sits BETWEEN the two cards (164 UAT); each mobile tab (FlawChess / Maia) renders
// its own copy since they're separate screens. The reset control snaps back to the
// players' rating once the user has dragged off it (164 UAT).
export function EloSelectorPanel({ value, onChange, defaultElo, onReset }: EloSelectorPanelProps): ReactElement {
  return (
    <div className="px-2 flex flex-col gap-2" data-testid="analysis-elo-selector-row">
      <EloSelector value={value} onChange={onChange} defaultElo={defaultElo} onReset={onReset} />
    </div>
  );
}

// ─── FlawChessCard ──────────────────────────────────────────────────────────────

export type FlawChessCardProps = {
  footer?: ReactNode;
  flawChessEnabled: boolean;
  setFlawChessEnabled: (enabled: boolean) => void;
  selectedElo: number;
  flawChessLoading: boolean;
  reconciledRankedLines: RankedLine[];
  flawChessIsSearching: boolean;
  position: string;
  currentPly: number;
  boardFlipped: boolean;
  flawChessTerminalOutcome: 'checkmate' | 'draw' | null;
  onMoveClick: (uciMoves: string[]) => void;
  reconciledStockfishLine: PvLine | null;
  enginePvLines: PvLine[];
  flawChessRankedLinesForVerdict: RankedLine[];
  engineEnabled: boolean;
  rawProbBySan: Record<string, number>;
  shownSans: string[];
  onHoverMovesChange: (moves: HoveredQualityMove[] | null) => void;
  onPlayMove: (san: string) => void;
  temperature: number;
  setTemperature: (temperature: number) => void;
};

// FlawChess Engine card (D-01, DISPLAY-04) — a fixed-height charcoal Card stacked
// directly above MaiaHumanPanel, reused verbatim in BOTH the desktop human column
// and the mobile "FlawChess" tab (mobile-parity). `footer` (164 UAT): mobile passes
// the ELO slider so it sits inside the card; desktop omits it (the slider is a
// standalone row between the two cards there).
export function FlawChessCard({
  footer,
  flawChessEnabled,
  setFlawChessEnabled,
  selectedElo,
  flawChessLoading,
  reconciledRankedLines,
  flawChessIsSearching,
  position,
  currentPly,
  boardFlipped,
  flawChessTerminalOutcome,
  onMoveClick,
  reconciledStockfishLine,
  enginePvLines,
  flawChessRankedLinesForVerdict,
  engineEnabled,
  rawProbBySan,
  shownSans,
  onHoverMovesChange,
  onPlayMove,
  temperature,
  setTemperature,
}: FlawChessCardProps): ReactElement {
  return (
    <Card data-testid="analysis-flawchess-panel">
      <CardHeader size="compact" data-testid="analysis-flawchess-info" className="font-normal text-muted-foreground">
        <EngineToggleHeader
          checked={flawChessEnabled}
          onCheckedChange={setFlawChessEnabled}
          accent={FLAWCHESS_ENGINE_ACCENT}
          testId="btn-analysis-flawchess-toggle"
          ariaLabel="Toggle FlawChess Engine"
          icon={ChessKnight}
        >
          {/* ELO in parens = the mover's rating (or the slider override), the
              strength the engine is playing at (155 UAT). */}
          FlawChess Engine ({selectedElo} ELO)
        </EngineToggleHeader>
        <FlawChessInfoTooltip />
      </CardHeader>
      <CardBody className={`${LINES_MIN_HEIGHT} p-2`}>
        {flawChessLoading ? (
          <EngineLinesSkeleton testId="analysis-flawchess-loading" rows={2} />
        ) : !flawChessEnabled ? (
          <div className="flex h-full items-center px-2 text-sm text-muted-foreground">
            FlawChess Engine off
          </div>
        ) : (
          <>
            <FlawChessEngineLines
              rankedLines={reconciledRankedLines}
              isSearching={flawChessIsSearching}
              baseFen={position}
              startPly={currentPly}
              flipped={boardFlipped}
              terminalOutcome={flawChessTerminalOutcome}
              onMoveClick={onMoveClick}
            />
            {/* Agreement verdict (Phase 157-02, REVIEW-02; Phase 158 SEED-087 SC4;
                Phase 162 SEED-090 D-13): the Stockfish side is the TRUE global
                reconciled argmax, falling back to enginePvLines[0] pre-grading so
                first paint still resolves. Hidden in a terminal position (quick
                260709): the terminal badge above says it all. */}
            {flawChessTerminalOutcome == null && (
              <FlawChessAgreementVerdict
                flawChessLine={reconciledRankedLines[0] ?? null}
                stockfishLine={reconciledStockfishLine ?? (enginePvLines[0] ?? null)}
                flawChessRankedLines={flawChessRankedLinesForVerdict}
                engineEnabled={engineEnabled}
                elo={selectedElo}
                baseFen={position}
                rawProbBySan={rawProbBySan}
                shownSans={shownSans}
                onHoverMovesChange={onHoverMovesChange}
                onPlayMove={onPlayMove}
              />
            )}
            {/* Phase 159 D-08: the Human <-> Stockfish play-style slider lives at the
                bottom of the FlawChess Engine card (it only reshapes this engine's
                policy). */}
            <div className="mt-2 px-2">
              <TemperatureSelector value={temperature} onChange={setTemperature} />
            </div>
          </>
        )}
        {/* Mobile-only ELO slider inside the card (164 UAT); always shown, even when
            the engine is off, since it also drives the Maia surfaces. */}
        {footer !== undefined && <div className="mt-2">{footer}</div>}
      </CardBody>
    </Card>
  );
}

// ─── MoveListHeaderContent ──────────────────────────────────────────────────────

export type MoveListHeaderContentProps = {
  onOpenPasteModal: () => void;
};

// Move-list header row content (Phase 208, D-19/D-20): shared between the
// mobile/mid movesTab header and the desktop movesCard CardHeader — the Paste
// trigger reaches every layout, not just desktop (SC-9 requires the whole flow to
// work at 375px). Rendered unconditionally, including ?game_id= game mode (D-20).
export function MoveListHeaderContent({ onOpenPasteModal }: MoveListHeaderContentProps): ReactElement {
  return (
    <>
      <ArrowLeftRight className="h-4 w-4" aria-hidden />
      Moves
      <Button
        variant="ghost"
        size="default"
        className="ml-auto gap-1"
        data-testid="analysis-btn-paste"
        onClick={onOpenPasteModal}
      >
        <ClipboardPaste className="h-4 w-4" aria-hidden="true" />
        PGN/FEN
      </Button>
    </>
  );
}

// ─── HumanTab ───────────────────────────────────────────────────────────────────

export type HumanTabProps = {
  selectedElo: number;
  maiaPerElo: UseMaiaEngineState['perElo'];
  playedSan: string | null;
  reconciledBestSan: string | null;
  bestSan: string | null;
  shownSans: string[];
  qualityBySanWithGem: Map<string, MoveQualityEval>;
  position: string;
  engineTopLines: EngineLine[];
  onHoverMovesChange: (moves: HoveredQualityMove[] | null) => void;
  isOpponentToMove: boolean;
  onPlayMove: (san: string) => void;
  maiaEnabled: boolean;
  setMaiaEnabled: (enabled: boolean) => void;
  eloSelector: ReactNode;
};

// The mobile "Maia" tab content (D-03, LIC-02) — shared across every mobile tab
// layout, so this JSX isn't duplicated. The FlawChess card lives in its own
// adjacent tab (FlawChessTab) rather than here; the ELO slider sits inside the
// Maia card (as its footer) on mobile since it drives both engines (164 UAT).
export function HumanTab({
  selectedElo,
  maiaPerElo,
  playedSan,
  reconciledBestSan,
  bestSan,
  shownSans,
  qualityBySanWithGem,
  position,
  engineTopLines,
  onHoverMovesChange,
  isOpponentToMove,
  onPlayMove,
  maiaEnabled,
  setMaiaEnabled,
  eloSelector,
}: HumanTabProps): ReactElement {
  return (
    <TabsContent value="human" className="min-h-0 overflow-y-auto thin-scrollbar">
      <div className="flex flex-col gap-3 px-3">
        <MaiaHumanPanel
          selectedElo={selectedElo}
          perElo={maiaPerElo}
          playedSan={playedSan}
          // 162-REVIEW WR-02: the chart's emphasized stroke follows the SAME
          // reconciled Best the quality color/label/verdict designate, not the
          // raw free-run pick (raw bestSan still feeds selectCandidatesByMass
          // above so the free-run pick stays plotted).
          bestSan={reconciledBestSan ?? bestSan}
          shownSans={shownSans}
          qualityBySan={qualityBySanWithGem}
          mover={sideToMoveFromFen(position) as MoverColor}
          engineTopLines={engineTopLines}
          onHoverMovesChange={onHoverMovesChange}
          isOpponentToMove={isOpponentToMove}
          onPlayMove={onPlayMove}
          enabled={maiaEnabled}
          onToggleEnabled={setMaiaEnabled}
          compact
          footer={eloSelector}
        />
      </div>
    </TabsContent>
  );
}

// ─── FlawChessTab ───────────────────────────────────────────────────────────────

export type FlawChessTabProps = {
  flawChessCard: ReactNode;
};

// The mobile "FlawChess" tab content — the FlawChess Engine card, in its own tab to
// the right of the Maia tab. The ELO slider sits inside the card (as its footer) on
// mobile (164 UAT), since this is a separate screen from the Maia tab.
export function FlawChessTab({ flawChessCard }: FlawChessTabProps): ReactElement {
  return (
    <TabsContent value="flawchess" className="min-h-0 overflow-y-auto thin-scrollbar">
      <div className="flex flex-col gap-3 px-3">{flawChessCard}</div>
    </TabsContent>
  );
}

// ─── MobileEngineLines ──────────────────────────────────────────────────────────

export type MobileEngineLinesProps = {
  engineLoading: boolean;
  engineEnabled: boolean;
  reconciledPvLines: PvLine[];
  isAnalyzing: boolean;
  currentPly: number;
  position: string;
  boardFlipped: boolean;
  onMoveClick: (uciMoves: string[]) => void;
};

// Mobile Stockfish PV lines, without the info-card header. Mirrors the desktop
// `analysis-engine-card` body's loading -> off -> lines branches. Shown at the top
// of the Eval tab in every mobile layout.
export function MobileEngineLines({
  engineLoading,
  engineEnabled,
  reconciledPvLines,
  isAnalyzing,
  currentPly,
  position,
  boardFlipped,
  onMoveClick,
}: MobileEngineLinesProps): ReactElement {
  return (
    <div className="shrink-0 px-2" data-testid="analysis-engine-lines-mobile">
      {engineLoading ? (
        <EngineLinesSkeleton testId="analysis-engine-loading" compact />
      ) : !engineEnabled ? (
        <div className="flex h-full items-center px-2 text-sm text-muted-foreground">Engine off</div>
      ) : (
        // 162 UAT: reconciled top-2 over the full grading union, mobile parity
        // with the desktop card (CLAUDE.md mobile-parity rule).
        <EngineLines
          pvLines={reconciledPvLines}
          isAnalyzing={isAnalyzing}
          startPly={currentPly}
          baseFen={position}
          flipped={boardFlipped}
          onMoveClick={onMoveClick}
          compact
        />
      )}
    </div>
  );
}

// ─── EvalTab ────────────────────────────────────────────────────────────────────

export type EvalTabProps = {
  mobileEngineLines: ReactNode;
  evalChartReady: boolean;
  evalPending: boolean;
  evalChartPanel: ReactNode;
  tagsPanel: ReactNode;
};

// The mobile "Eval" tab content — Stockfish PV lines on top, the eval chart below,
// then the tactics card at the bottom. All game-mode only; evalChartPanel returns
// null in free play / before the game loads, and the tags section only renders once
// analysis lands (evalChartReady), leaving just the engine lines otherwise.
export function EvalTab({
  mobileEngineLines,
  evalChartReady,
  evalPending,
  evalChartPanel,
  tagsPanel,
}: EvalTabProps): ReactElement {
  return (
    <TabsContent value="eval" className="min-h-0 overflow-x-hidden overflow-y-auto thin-scrollbar">
      <div className="flex flex-col gap-2 pt-1">
        {mobileEngineLines}
        {(evalChartReady || evalPending) && <div className="px-3">{evalChartPanel}</div>}
        {evalChartReady && <div className="px-3">{tagsPanel}</div>}
      </div>
    </TabsContent>
  );
}

// ─── MovesTab ───────────────────────────────────────────────────────────────────

export type MovesTabProps = {
  moveListKey: string;
  moveListHeaderContent: ReactNode;
  variationTree: ReactNode;
};

// The mobile "Moves" tab content — a CardHeader (Phase 208: carrying the Paste
// trigger) over the vertical variation tree in a charcoal container, matching the
// surrounding tab surfaces. Shared across the mobile tab layouts and the mid-range
// right column.
//
// Bug fix (bot-game live analysis): when the live poll lands analysis on a game the
// user is viewing on the Moves tab, the move-quality icons did NOT appear in place
// on mobile — only switching tabs (a Radix unmount/remount) surfaced them. Keying
// the subtree on the analysis-ready transition (moveListKey) reproduces that
// remount exactly when analysis lands, so the icons show without a manual tab
// switch.
export function MovesTab({ moveListKey, moveListHeaderContent, variationTree }: MovesTabProps): ReactElement {
  return (
    <TabsContent value="moves" className="flex min-h-0 flex-1 flex-col pb-2">
      <div key={moveListKey} className="charcoal-texture flex min-h-0 flex-1 flex-col rounded-md">
        <CardHeader size="compact" data-testid="analysis-movelist-header" className="rounded-t-md">
          {moveListHeaderContent}
        </CardHeader>
        {variationTree}
      </div>
    </TabsContent>
  );
}

// ─── StatsTab ───────────────────────────────────────────────────────────────────

export type StatsTabProps = {
  evalChartReady: boolean;
  tagsPanel: ReactNode;
  evalPending: boolean;
  gameId: number | null;
  leased: boolean;
};

// The mobile "Stats" tab content — the MoveStats / accuracy card (game mode only).
// While analysis is still in flight the tab shows the SAME Analyzing pill the Eval
// tab uses, then swaps to the panel once evals land — so the tab is present the
// whole time instead of only popping into existence once evals arrive.
export function StatsTab({ evalChartReady, tagsPanel, evalPending, gameId, leased }: StatsTabProps): ReactElement {
  return (
    <TabsContent value="stats" className="min-h-0 overflow-y-auto thin-scrollbar">
      <div className="px-2 pt-1">
        {evalChartReady ? (
          tagsPanel
        ) : evalPending && gameId != null ? (
          <AnalysisPendingPill gameId={gameId} leased={leased} />
        ) : null}
      </div>
    </TabsContent>
  );
}

// ─── AnalysisTabs (container) ───────────────────────────────────────────────────

export type AnalysisTabsProps = {
  evalChartReady: boolean;
  evalPending: boolean;
  movesTab: ReactNode;
  evalTab: ReactNode;
  humanTab: ReactNode;
  flawChessTab: ReactNode;
  statsTab: ReactNode;
};

// The full tabbed panel (Moves | Eval | Maia | FlawChess [| Stats]) — the mobile
// takeover's whole body AND the mid-range layout's right column (both reuse it
// verbatim; only one layout tree renders at a time, so the Tabs mount exactly
// once). Needs a height-bounded flex parent so each tab's internal scroller
// resolves. The Stats trigger/content render whenever the game is analyzed OR
// still being analyzed (evalChartReady || evalPending) — present with an
// Analyzing pill during analysis, then the panel once evals land; free play / idle
// unanalyzed games omit them, and the Tabs subtree never remounts across the
// transition (no cursor/variation-tree loss).
export function AnalysisTabs({
  evalChartReady,
  evalPending,
  movesTab,
  evalTab,
  humanTab,
  flawChessTab,
  statsTab,
}: AnalysisTabsProps): ReactElement {
  return (
    <Tabs defaultValue="moves" className="flex min-h-0 flex-1 flex-col gap-2 px-2 pt-2">
      <TabsList variant="underline" className="w-full shrink-0">
        <TabsTrigger value="moves" data-testid="analysis-tab-moves" className="gap-1 px-1">
          <ArrowLeftRight aria-hidden="true" />
          Moves
        </TabsTrigger>
        {/* Engine-colored tab nav: Eval = Stockfish blue, Maia = violet, FlawChess =
            gold — matching each surface's accent (theme.ts). */}
        <TabsTrigger value="eval" data-testid="analysis-tab-eval" className="gap-1 px-1" style={{ color: STOCKFISH_ACCENT }}>
          <Cpu aria-hidden="true" />
          Eval
        </TabsTrigger>
        <TabsTrigger value="human" data-testid="analysis-tab-human" className="gap-1 px-1" style={{ color: MAIA_ACCENT }}>
          <User aria-hidden="true" />
          Maia
        </TabsTrigger>
        <TabsTrigger
          value="flawchess"
          data-testid="analysis-tab-flawchess"
          className="gap-1 px-1"
          style={{ color: FLAWCHESS_ENGINE_ACCENT }}
        >
          <ChessKnight aria-hidden="true" />
          FlawChess
        </TabsTrigger>
        {(evalChartReady || evalPending) && (
          <TabsTrigger value="stats" data-testid="analysis-tab-stats" className="gap-1 px-1">
            <ChartNoAxesColumn aria-hidden="true" />
            Stats
          </TabsTrigger>
        )}
      </TabsList>
      {movesTab}
      {evalTab}
      {humanTab}
      {flawChessTab}
      {(evalChartReady || evalPending) && statsTab}
    </Tabs>
  );
}

