import { Navigate, useNavigate } from 'react-router';
import { isWelcomeDismissed } from '@/lib/welcomeDismissal';
import { Link } from 'react-router';
import * as Sentry from '@sentry/react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { apiClient } from '@/api/client';
import type { UserProfile } from '@/types/users';
import { PublicHeader } from '@/components/layout/PublicHeader';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { cn } from '@/lib/utils';
import { FLAWCHESS_ENGINE_ACCENT } from '@/lib/theme';
import { Search, Scale, Dumbbell, TrophyIcon, Timer, Compass, Loader2, UserPlus, DoorOpen, ChessKnight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Feature sections — the first entry is rendered in the hero (desktop right column +
// mobile standalone section); the rest alternate image left/right below.
// All screenshots are landscape orientation with a 2fr/3fr text/image ratio.
const FEATURES: {
  slug: string;
  icon: LucideIcon;
  heading: string;
  desc: string | string[];
  screenshot: { src: string; alt: string };
  imagePosition: 'left' | 'right';
}[] = [
  {
    slug: 'flawchess-engine',
    icon: ChessKnight,
    heading: 'Your Best Practical Move',
    desc: [
        'The FlawChess Engine shows your best practical move, not just the objective one: every move is scored by how likely you are to find and execute it, including the follow-ups.',
        'Judged against a typical human opponent, not perfect defense: each move is scored against the replies a player at their level would realistically pick, so the practical best can differ from the Stockfish best.',
        'Tuned to your level: powered by Stockfish + Maia, with a “Play style” dial that shifts from human-realistic to engine-precise.',
        'Play games against human-like bots with different playstyles, then analyze the result with Stockfish, Maia, and the FlawChess Engine.',
    ],
    screenshot: { src: '/screenshots/flawchess-engine.png', alt: 'FlawChess Engine board view showing the practical score and objective Stockfish evaluation for each candidate move' },
    imagePosition: 'right',
  },
  {
    slug: 'game-analysis',
    icon: Search,
    heading: 'Game and Tactic Analysis',
    desc: [
        'Run Stockfish over your entire chess.com and lichess history.',
        'Understand, replay, and learn from your blunders: mistakes are tagged with the tactic behind them (fork, pin, skewer, and 20+ motifs).',
        'Track your blunder rate over time, and see how often you fall for each tactic versus your opponents.',
        'Discover gem moves: the only good move in a position that most players at your rating would miss.',
        'Filter your whole game history by tactic, depth, and severity.',
    ],
    screenshot: { src: '/screenshots/game-card.png', alt: 'Library game card showing Stockfish eval chart, board with best-move and move-played arrows, and missed/allowed tactic chips (fork, pin)' },
    imagePosition: 'left',
  },
  {
    slug: 'train',
    icon: Dumbbell,
    heading: 'Personalized Puzzle Training',
    desc: [
        'Every puzzle is built from your own blunders, not a generic puzzle set.',
        'One critical move, or several fine moves? Commit before you play. Quiet positions are mixed in, so there isn\'t always a tactic waiting.',
        'Spaced repetition brings each position back next session, then after three days, then ten, until you\'ve solved it three times.',
        'Pick your training days and build a session streak.',
    ],
    screenshot: { src: '/screenshots/train.png', alt: 'Train session reveal screen showing the guess verdict, the move played, the best move, and the blunder from the original game' },
    imagePosition: 'right',
  },
  {
    slug: 'opening-explorer',
    icon: Compass,
    heading: 'Opening Explorer & Insights',
    desc: [
        'Get a detailed statistical analysis for every move you’ve played.',
        'Compare your win/draw/loss rate to the Stockfish evaluation at the end of the opening.',
        'Scan the first 8 moves of all your games to surface opening strengths and weaknesses.',
        'Scout your opponent\'s repertoire before a match.',
    ],
    screenshot: { src: '/screenshots/opening-explorer.png', alt: 'Board with move explorer showing win/draw/loss rate and stockfish evaluation per candidate move' },
    imagePosition: 'left',
  },
  {
    slug: 'endgame-analytics',
    icon: TrophyIcon,
    heading: 'Endgame Analytics',
    desc: [
      'Measure how well you convert winning endgames and recover from losing ones.',
      'Track your Endgame ELO over time by platform and time control.',
      'Get personalized feedback on what your stats mean.',
    ],
    screenshot: { src: '/screenshots/endgame-metrics-and-elo-llm-badge.png', alt: 'Endgame metrics and Endgame ELO timeline over time' },
    imagePosition: 'right',
  },
  {
    slug: 'time-management',
    icon: Timer,
    heading: 'Time Management Stats',
    desc: [
        'See your average time advantage or deficit when entering the endgame.',
        'Find out if you crack under time pressure more than your opponents.',
        'Compare your flag rate to your opponents\' per time control.',
    ],
    screenshot: { src: '/screenshots/time-management-stats.png', alt: 'Average clock difference over time and time-pressure-vs-performance charts' },
    imagePosition: 'left',
  },
  {
    slug: 'opening-comparison',
    icon: Scale,
    heading: 'Opening Comparison and Tracking',
    desc: [
        'Bookmark your favorite openings and compare their performance.',
        'See how your opening study impacts your win rate over time.',
        'Filter by time control to find which openings work best where.',
    ],
    screenshot: { src: '/screenshots/opening-comparison.png', alt: 'Win rate trends over time for multiple openings' },
    imagePosition: 'right',
  },
];

// ─── FAQ ──────────────────────────────────────────────────────────────────────

// Single source for both the rendered accordion and the JSON-LD FAQPage schema.
//
// Why the schema is needed at all: Radix's AccordionContent is not rendered while
// collapsed, so the prerendered HTML (vite-prerender-plugin, see src/prerender.tsx)
// contains only the questions — every answer body is invisible to crawlers. The
// JSON-LD block below is what actually gets the answers indexed, and it makes the
// page eligible for FAQ rich results.
//
// `answer` is plain text and is ALWAYS the schema source of truth. `richAnswer` is
// only for the few entries that need inline links; when present it supersedes
// `answer` in the UI, so its prose must mirror `answer` or the two will drift.
const FAQ_ITEMS: {
  value: string;
  question: string;
  answer: string;
  richAnswer?: React.ReactNode;
}[] = [
  {
    value: 'improve',
    question: 'How can I improve my chess with FlawChess?',
    answer:
      'In three ways. First, analysis finds the flaws: Stockfish runs over your whole chess.com and lichess history and tags mistakes with missed and allowed tactics. Second, training helps you fix them: your own blunders come back as puzzles on a spaced-repetition schedule, mixed with quiet positions where several moves are fine, until the patterns stick. Third, you can practise against human-like bots powered by the FlawChess Engine: 24 named opponents with different ELO ratings and playing style. Every game you finish becomes an analyzable game in your library like any other.',
  },
  {
    value: 'flawchess-engine',
    question: 'How does the FlawChess Engine work?',
    answer:
      'It combines Stockfish with Maia, a human-like neural network, to score each move by how likely you are to find it and convert the resulting position against an opponent at your level, instead of assuming perfect play from both sides. Read the full deep-dive in "FlawChess Engine explained" on GitHub.',
    richAnswer: (
      <>
        It combines Stockfish with Maia, a human-like neural network, to score each move by how
        likely you are to find it and convert the resulting position against an opponent at your
        level, instead of assuming perfect play from both sides. Read the full deep-dive in{' '}
        <a
          href="https://github.com/flawchess/flawchess/blob/main/docs/flawchess-engine-explained-2026-07-06.md"
          data-umami-event="outbound-engine-explainer"
          className="text-primary underline-offset-4 hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          FlawChess Engine explained
        </a>
        .
      </>
    ),
  },
  {
    value: 'data',
    question: 'What data do you access from my chess.com or lichess account?',
    answer:
      'Only your games — no passwords or personal information. Your games are publicly accessible via their APIs, and FlawChess reads them just like any other analysis tool.',
  },
  {
    value: 'free',
    question: 'Is it free?',
    answer: 'Yes, FlawChess is completely free to use.',
  },
  {
    value: 'mobile',
    question: 'Can I use it on mobile?',
    answer:
      'Yes. FlawChess is a Progressive Web App — install it from your browser for a native-like experience on iPhone and Android.',
  },
  {
    value: 'endgames',
    question: 'What endgame analytics does FlawChess offer?',
    answer:
      'FlawChess tracks your win/draw/loss rates by Endgame Type (rook, minor piece, pawn, queen, and more), plus conversion rates when you enter the endgame ahead and recovery rates when you enter behind, scored against Stockfish evaluation. All statistics are filterable by time control, color, and recency.',
  },
  {
    value: 'requests',
    question: 'Where can I make feature requests?',
    answer:
      'Open an issue on GitHub (https://github.com/flawchess/flawchess). Contributions and feedback are welcome.',
    richAnswer: (
      <>
        Open an issue on{' '}
        <a
          href="https://github.com/flawchess/flawchess"
          data-umami-event="outbound-github"
          className="text-primary underline-offset-4 hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
        . Contributions and feedback are welcome.
      </>
    ),
  },
  {
    value: 'who',
    question: 'Who develops FlawChess?',
    answer:
      'FlawChess is an open source project developed independently. Find the code on GitHub (https://github.com/flawchess/flawchess), contribute, or reach out at support@flawchess.com.',
    richAnswer: (
      <>
        FlawChess is an open source project developed independently. Find the code on{' '}
        <a
          href="https://github.com/flawchess/flawchess"
          data-umami-event="outbound-github"
          className="text-primary underline-offset-4 hover:underline"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
        , contribute, or reach out at{' '}
        <a
          href="mailto:support@flawchess.com"
          data-umami-event="outbound-support-email"
          className="text-primary underline-offset-4 hover:underline"
        >
          support@flawchess.com
        </a>
        .
      </>
    ),
  },
];

// schema.org FAQPage. `<` is escaped so a future answer containing "</script>"
// cannot break out of the inline script tag.
const FAQ_JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ_ITEMS.map(({ question, answer }) => ({
    '@type': 'Question',
    name: question,
    acceptedAnswer: { '@type': 'Answer', text: answer },
  })),
}).replace(/</g, '\\u003c');

// ─── Homepage content (unauthenticated) ───────────────────────────────────────

// Hero shows the first feature in its right column (desktop) and as a standalone
// charcoal section (mobile). The remaining features render in the alternating
// screenshots grid below.
const heroFeature = FEATURES[0]!;
const featureSections = FEATURES.slice(1);
const HeroIcon = heroFeature.icon;
const heroDescItems = Array.isArray(heroFeature.desc) ? heroFeature.desc : [heroFeature.desc];

// Highlight the product name "FlawChess Engine" in gold wherever it appears in a hero
// bullet (only the first hero bullet contains it), matching the gold hero title/icon.
const ENGINE_NAME = 'FlawChess Engine';
function renderHeroBullet(item: string) {
  const idx = item.indexOf(ENGINE_NAME);
  if (idx === -1) return item;
  return (
    <>
      {item.slice(0, idx)}
      <span style={{ color: FLAWCHESS_ENGINE_ACCENT }}>{ENGINE_NAME}</span>
      {item.slice(idx + ENGINE_NAME.length)}
    </>
  );
}

export function HomePageContent() {
  const { loginAsGuest, isLoading } = useAuth();
  const navigate = useNavigate();

  const handleGuestLogin = async () => {
    try {
      await loginAsGuest();
      navigate('/');
    } catch (error) {
      Sentry.captureException(error, { tags: { source: 'guest-login-home' } });
      toast.error('Failed to start guest session. Please try again.');
    }
  };

  return (
    <>
      <PublicHeader />

      {/* Hero — radial bronze glow is centered on just the hero content (not the
          stacked Opening Explorer below, which has its own charcoal section) */}
      <div className="bg-[radial-gradient(ellipse_at_center,rgba(205,127,50,0.12),transparent_65%)]">
      <section data-testid="hero-section" className="max-w-6xl mx-auto px-4 py-8 lg:py-12">
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-8 lg:gap-12 items-center">
          {/* Left column: existing hero content — centered at all breakpoints. */}
          <div className="text-center" data-testid="hero-left-column">
            <img
              src="/icons/logo-384.png"
              alt="FlawChess logo"
              className="mx-auto mb-2 h-32 w-32 lg:h-36 lg:w-36"
            />
            <h1 className="text-3xl lg:text-4xl font-bold leading-tight font-brand">
              Engines are flawless, humans play{' '}
              <span className="bg-gradient-to-r from-brand-brown-light to-brand-brown bg-clip-text text-transparent">
                FlawChess
              </span>
            </h1>
            {/* Decorative light-burst divider — golden bronze glow matching the hero radial. Desktop only. */}
            <div
              aria-hidden="true"
              className="relative mx-auto mt-6 hidden h-10 w-full max-w-lg lg:block"
              data-testid="hero-divider"
            >
              {/* Thin line, transparent → bronze → bright center → bronze → transparent */}
              <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[linear-gradient(to_right,transparent,rgba(205,127,50,0.85)_25%,#FFE9B8_50%,rgba(205,127,50,0.85)_75%,transparent)]" />
              {/* Outer wide soft halo */}
              <div className="absolute left-1/2 top-1/2 h-10 w-72 -translate-x-1/2 -translate-y-1/2 bg-[radial-gradient(ellipse_at_center,rgba(205,127,50,0.35),transparent_70%)] blur-md" />
            </div>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">
              Find and fix the flaws in your game. Free full-game analysis of every chess.com and lichess game: tactics, openings, endgames, and time management.
            </p>
            <div className="mt-8 flex flex-row items-center justify-center gap-3">
              <Button
                size="lg"
                asChild
                className="min-h-11 min-w-40"
                data-testid="hero-cta-signup"
              >
                <Link to="/login?tab=register">
                  <UserPlus className="mr-1.5 h-4 w-4" />
                  Sign up free
                </Link>
              </Button>
              <Button
                size="lg"
                variant="brand-outline"
                className="min-h-11 min-w-40"
                data-testid="btn-guest"
                onClick={handleGuestLogin}
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <DoorOpen className="mr-1.5 h-4 w-4" />
                    Use as Guest
                  </>
                )}
              </Button>
            </div>
            {/* Callout pills — desktop only (hidden on mobile / small desktop) */}
            <div className="mt-10 hidden lg:flex flex-wrap justify-center gap-2">
              <span className="bg-muted text-muted-foreground w-44 rounded-full px-4 py-1 text-center text-sm">
                All features free
              </span>
              <span className="bg-muted text-muted-foreground w-44 rounded-full px-4 py-1 text-center text-sm">
                No signup required
              </span>
            </div>
          </div>

          {/* Right column: hero feature preview — lg and up only.
              Title → image → bullets stacking matches the feature sections below.
              Below lg the preview renders as a standalone charcoal section further down. */}
          <div data-testid="hero-feature-preview" className="hidden lg:block">
            <div className="flex items-center gap-4 mb-4">
              <HeroIcon className="h-7 w-7 lg:h-10 lg:w-10 shrink-0" strokeWidth={1.5} style={{ color: FLAWCHESS_ENGINE_ACCENT }} />
              <h2 className="text-xl lg:text-2xl font-bold" style={{ color: FLAWCHESS_ENGINE_ACCENT }}>{heroFeature.heading}</h2>
            </div>
            <img
              src={heroFeature.screenshot.src}
              alt={heroFeature.screenshot.alt}
              className="rounded-lg border border-[rgba(205,127,50,0.85)] shadow-[0_0_24px_rgba(205,127,50,0.35)] w-full mb-4"
            />
            <ul className="list-disc pl-5 space-y-1 text-base leading-relaxed text-muted-foreground">
              {heroDescItems.map((item, i) => <li key={i}>{renderHeroBullet(item)}</li>)}
            </ul>
          </div>
        </div>
      </section>
      </div>

      {/* Hero feature — standalone section (mobile / small desktop only).
          Title → image → bullets, matching the feature sections below. Hidden on lg+
          because the hero's right column already shows the same content there. */}
      <section
        data-testid={`feature-${heroFeature.slug}-mobile`}
        className="lg:hidden bg-[#1a1a1a] py-12"
      >
        <div className="max-w-5xl mx-auto px-4 flex flex-col gap-6">
          <div className="flex items-center gap-4">
            <HeroIcon className="h-7 w-7 lg:h-10 lg:w-10 shrink-0" strokeWidth={1.5} style={{ color: FLAWCHESS_ENGINE_ACCENT }} />
            <h2 className="text-xl lg:text-2xl font-bold" style={{ color: FLAWCHESS_ENGINE_ACCENT }}>{heroFeature.heading}</h2>
          </div>
          <img
            src={heroFeature.screenshot.src}
            alt={heroFeature.screenshot.alt}
            className="rounded-lg border border-[rgba(205,127,50,0.85)] shadow-[0_0_24px_rgba(205,127,50,0.35)] w-full"
          />
          <ul className="list-disc pl-5 space-y-1 text-base leading-relaxed text-muted-foreground">
            {heroDescItems.map((item, i) => <li key={i}>{renderHeroBullet(item)}</li>)}
          </ul>
        </div>
      </section>

      {/* Feature sections — alternating image left/right (skips the hero feature) */}
      <div id="features" data-testid="screenshots-section" className="scroll-mt-16">
        {featureSections.map(({ slug, icon: Icon, heading, desc, screenshot, imagePosition }, index) => {
          // On desktop, even-indexed features get charcoal bg. On mobile the Interactive
          // Opening Explorer (charcoal) sits in front of the feature list, so the mobile
          // alternation is flipped: odd-indexed features get charcoal on mobile to avoid
          // two consecutive charcoal bands at the top of the stack.
          const bgClass = index % 2 === 0
            ? 'lg:bg-[#1a1a1a]'
            : 'max-lg:bg-[#1a1a1a]';
          const gridCols = imagePosition === 'left'
            ? 'lg:grid-cols-[3fr_2fr]'
            : 'lg:grid-cols-[2fr_3fr]';

          const titleBlock = (
            <div className="flex items-center gap-4">
              <Icon className="h-7 w-7 lg:h-10 lg:w-10 text-muted-foreground shrink-0" strokeWidth={1.5} />
              <h2 className="text-xl lg:text-2xl font-bold">{heading}</h2>
            </div>
          );
          const bulletsBlock = Array.isArray(desc) ? (
            <ul className="list-disc pl-5 space-y-1 text-base leading-relaxed text-muted-foreground">
              {desc.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          ) : (
            <p className="text-base leading-relaxed text-muted-foreground">{desc}</p>
          );
          const imageBlock = (
            <img
              src={screenshot.src}
              alt={screenshot.alt}
              className="rounded-lg border border-[rgba(205,127,50,0.85)] shadow-[0_0_24px_rgba(205,127,50,0.35)] w-full"
            />
          );
          const desktopTextCol = (
            <div>
              {titleBlock}
              <div className="mt-3">{bulletsBlock}</div>
            </div>
          );
          return (
            <section
              key={slug}
              data-testid={`feature-${slug}`}
              className={cn('py-12 lg:py-16', bgClass)}
            >
              {/* Mobile layout: title → image → bullets stacked in a single column. */}
              <div className="lg:hidden max-w-5xl mx-auto px-4 flex flex-col gap-6">
                {titleBlock}
                {imageBlock}
                {bulletsBlock}
              </div>
              {/* Desktop layout: 2-col grid alternating image left/right, text column
                  stacks title above bullets. */}
              <div className={cn('hidden lg:grid max-w-5xl mx-auto px-4 gap-12 items-center', gridCols)}>
                {imagePosition === 'left' ? (
                  <>
                    {imageBlock}
                    {desktopTextCol}
                  </>
                ) : (
                  <>
                    {desktopTextCol}
                    {imageBlock}
                  </>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {/* Development banner */}
      <div className="max-w-2xl mx-auto px-4 pt-12">
        <p
          className="mx-auto max-w-lg rounded-lg border border-[rgba(205,127,50,0.85)] shadow-[0_0_24px_rgba(205,127,50,0.35)] px-4 py-3 text-sm text-muted-foreground text-center"
          data-testid="beta-badge"
        >
          🏗️ Under active development. Bug
          reports and feature requests are welcome on{' '}
          <a
            href="https://github.com/flawchess/flawchess"
            data-umami-event="outbound-github"
            className="text-primary underline-offset-4 hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>{' '}
          or via{' '}
          <a
            href="mailto:support@flawchess.com"
            data-umami-event="outbound-support-email"
            className="text-primary underline-offset-4 hover:underline"
          >
            support@flawchess.com
          </a>.
        </p>
      </div>

      {/* FAQ */}
      <section id="faq" className="max-w-2xl mx-auto px-4 py-12 scroll-mt-16">
        <h2 className="text-xl font-bold mb-6">Frequently asked questions</h2>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: FAQ_JSON_LD }} />
        <Accordion type="single" collapsible data-testid="faq-accordion">
          {FAQ_ITEMS.map(({ value, question, answer, richAnswer }) => (
            <AccordionItem key={value} value={value} data-testid={`faq-item-${value}`}>
              <AccordionTrigger>{question}</AccordionTrigger>
              <AccordionContent>{richAnswer ?? answer}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>

      {/* Acknowledgements */}
      <section data-testid="acknowledgements-section" className="max-w-2xl mx-auto px-4 py-12">
        <h2 className="text-xl font-bold mb-6">Acknowledgements</h2>
        <p className="text-base text-muted-foreground leading-relaxed mb-4">
          FlawChess is built with and inspired by these projects:
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-base text-muted-foreground">
          <li>
            <a
              href="https://lichess.org"
              data-umami-event="outbound-acknowledgement"
              data-umami-event-target="lichess"
              className="text-primary underline-offset-4 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Lichess
            </a>{' '}
            &mdash; open-source chess platform and game data API
          </li>
          <li>
            <a
              href="https://chess.com"
              data-umami-event="outbound-acknowledgement"
              data-umami-event-target="chess-com"
              className="text-primary underline-offset-4 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Chess.com
            </a>{' '}
            &mdash; chess platform and game data API
          </li>
          <li>
            <a
              href="https://www.openingtree.com"
              data-umami-event="outbound-acknowledgement"
              data-umami-event-target="openingtree"
              className="text-primary underline-offset-4 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              OpeningTree.com
            </a>{' '}
            &mdash; inspiration for position-based opening analysis
          </li>
          <li>
            <a
              href="https://chessgoals.com/rating-comparison"
              data-umami-event="outbound-acknowledgement"
              data-umami-event-target="chessgoals"
              className="text-primary underline-offset-4 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              ChessGoals
            </a>{' '}
            &mdash; cross-platform rating comparison data
          </li>
          <li>
            <a
              href="https://python-chess.readthedocs.io"
              data-umami-event="outbound-acknowledgement"
              data-umami-event-target="python-chess"
              className="text-primary underline-offset-4 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              python-chess
            </a>{' '}
            &mdash; chess logic, move generation, and Zobrist hashing
          </li>
          <li>
            <a
              href="https://stockfishchess.org"
              data-umami-event="outbound-acknowledgement"
              data-umami-event-target="stockfish"
              className="text-primary underline-offset-4 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Stockfish
            </a>{' '}
            &mdash; open-source chess engine for position evaluation
          </li>
          <li>
            <a
              href="https://maiachess.com"
              data-umami-event="outbound-acknowledgement"
              data-umami-event-target="maia"
              className="text-primary underline-offset-4 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Maia Chess
            </a>{' '}
            &mdash; human-like neural model powering the move-probability predictions
          </li>
          <li>
            <a
              href="https://fastapi.tiangolo.com"
              data-umami-event="outbound-acknowledgement"
              data-umami-event-target="fastapi"
              className="text-primary underline-offset-4 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              FastAPI
            </a>{' '}
            &mdash; async Python web framework
          </li>
          <li>
            <a
              href="https://github.com/jhlywa/chess.js"
              data-umami-event="outbound-acknowledgement"
              data-umami-event-target="chess-js"
              className="text-primary underline-offset-4 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              chess.js
            </a>{' '}
            &mdash; chess move validation and game state
          </li>
          <li>
            <a
              href="https://github.com/Clariity/react-chessboard"
              data-umami-event="outbound-acknowledgement"
              data-umami-event-target="react-chessboard"
              className="text-primary underline-offset-4 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              react-chessboard
            </a>{' '}
            &mdash; interactive chessboard component
          </li>
          <li>
            <a
              href="https://recharts.org"
              data-umami-event="outbound-acknowledgement"
              data-umami-event-target="recharts"
              className="text-primary underline-offset-4 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Recharts
            </a>{' '}
            &mdash; composable chart library
          </li>
        </ul>
      </section>

      {/* Footer CTA */}
      <section className="text-center py-16" data-testid="footer-cta">
        <p className="text-muted-foreground mb-4">Free to use. No credit card required.</p>
        <div className="flex flex-row items-center justify-center gap-3">
          <Button
            size="lg"
            asChild
            className="min-h-11 min-w-40"
            data-testid="footer-cta-signup"
          >
            <Link to="/login?tab=register">
              <UserPlus className="mr-1.5 h-4 w-4" />
              Sign up free
            </Link>
          </Button>
          <Button
            size="lg"
            variant="brand-outline"
            className="min-h-11 min-w-40"
            data-testid="footer-btn-guest"
            onClick={handleGuestLogin}
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <DoorOpen className="mr-1.5 h-4 w-4" />
                Use as Guest
              </>
            )}
          </Button>
        </div>
      </section>

      {/* Page footer */}
      <footer
        className="text-sm text-muted-foreground text-center py-6 border-t border-border"
        data-testid="page-footer"
      >
        &copy; {new Date().getFullYear()} FlawChess
        <Link to="/privacy" className="ml-4 text-primary underline-offset-4 hover:underline">
          Privacy Policy
        </Link>
      </footer>
    </>
  );
}

// ─── Public export ────────────────────────────────────────────────────────────

export function HomePage() {
  const { token } = useAuth();
  // Only fetch profile when authenticated to avoid a 401 that would trigger
  // the response interceptor's redirect-to-login on the public homepage.
  const { data: profile, isLoading } = useQuery<UserProfile>({
    queryKey: ['userProfile'],
    queryFn: async () => {
      const res = await apiClient.get<UserProfile>('/users/me/profile');
      return res.data;
    },
    enabled: !!token,
    staleTime: 300_000,
  });

  if (token) {
    // Wait for profile to load to avoid flashing the wrong page. For returning
    // users the cache is warm (staleTime 5 min) so this is near-instant.
    if (isLoading) {
      return (
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );
    }
    // Returning users with imported games land on their games library.
    // First-time guests (0 games, welcome not dismissed) see the Welcome explainer.
    // Dismissed guests and non-guests with 0 games go straight to /library/import.
    const hasGames =
      (profile?.chess_com_game_count ?? 0) + (profile?.lichess_game_count ?? 0) > 0;
    if (!hasGames && profile?.is_guest && !isWelcomeDismissed()) {
      return <Navigate to="/welcome" replace />;
    }
    return <Navigate to={hasGames ? '/library/games' : '/library/import'} replace />;
  }

  return <HomePageContent />;
}
