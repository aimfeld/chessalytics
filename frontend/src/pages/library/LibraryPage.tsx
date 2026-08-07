import { useNavigate, useLocation, Navigate } from 'react-router';
import { BarChart2, Swords, DownloadIcon, AlertTriangle } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useUserProfile } from '@/hooks/useUserProfile';
import { ImportTab } from '@/pages/library/ImportTab';
import { StatsTab } from '@/pages/library/StatsTab';
import { GamesTab } from '@/pages/library/GamesTab';
import { FlawsTab } from '@/pages/library/FlawsTab';
import type { ImportPageProps } from '@/pages/Import';

export function LibraryPage({
  onImportStarted,
  activeJobIds,
  onJobDismissed,
}: ImportPageProps) {
  const { data: profile } = useUserProfile();
  const location = useLocation();
  const navigate = useNavigate();

  const totalGames =
    profile != null
      ? profile.chess_com_game_count + profile.lichess_game_count
      : 0;
  const noGames = profile != null && totalGames === 0;

  // State-dependent default subtab redirect (D-06): only redirect once profile is loaded
  // (profile != null), mirroring how Openings/Endgames gate their page-level Navigate.
  if (
    (location.pathname === '/library' || location.pathname === '/library/') &&
    profile != null
  ) {
    // Returning users with games land on the Games browser; new users go to Import.
    // Bug fix: previously sent returning users to /openings (outside the Library page).
    return (
      <Navigate to={noGames ? '/library/import' : '/library/games'} replace />
    );
  }

  const activeTab = location.pathname.includes('/import')
    ? 'import'
    : location.pathname.includes('/games')
      ? 'games'
      : location.pathname.includes('/flaws')
        ? 'flaws'
        : 'stats';

  return (
    <div data-testid="library-page" className="flex min-h-0 flex-1 flex-col bg-background">
      {/* Wrapper is a <div>, not <main>: ImportPage still renders its own <main>
          (narrower max-w-2xl import form), and App already wraps routes in a <main>.
          A <main> here would produce nested <main> landmarks (invalid HTML, LIB-09).
          The Stats subtab (GlobalStatsPage) deliberately renders NO own <main>/max-w
          wrapper so it spans the same width as the Games/Flaws subtabs. */}
      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-2 md:py-6 md:px-6">

        {/* Desktop: Tabs above content */}
        <div className="hidden md:block">
          <Tabs value={activeTab} onValueChange={(val) => navigate(`/library/${val}`)}>
            <TabsList variant="brand" className="w-full" data-testid="library-tabs">
              <TabsTrigger value="import" data-testid="tab-import" className="flex-1">
                <DownloadIcon className="mr-1.5 h-4 w-4" />
                Import
              </TabsTrigger>
              <TabsTrigger value="games" data-testid="tab-games" className="flex-1">
                <Swords className="mr-1.5 h-4 w-4" />
                Games
              </TabsTrigger>
              <TabsTrigger value="flaws" data-testid="tab-flaws" className="flex-1">
                <AlertTriangle className="mr-1.5 h-4 w-4" />
                Flaws
              </TabsTrigger>
              <TabsTrigger value="stats" data-testid="tab-stats" className="flex-1">
                <BarChart2 className="mr-1.5 h-4 w-4" />
                Stats
              </TabsTrigger>
            </TabsList>
            <TabsContent value="import" className="mt-4">
              <ImportTab
                onImportStarted={onImportStarted}
                activeJobIds={activeJobIds}
                onJobDismissed={onJobDismissed}
              />
            </TabsContent>
            <TabsContent value="games" className="mt-4">
              <GamesTab />
            </TabsContent>
            <TabsContent value="flaws" className="mt-4">
              <FlawsTab />
            </TabsContent>
            <TabsContent value="stats" className="mt-4">
              <StatsTab />
            </TabsContent>
          </Tabs>
        </div>

        {/* Mobile: sticky subnav row + content */}
        <div className="md:hidden flex flex-col min-w-0">
          <Tabs
            value={activeTab}
            onValueChange={(val) => {
              navigate(`/library/${val}`);
              window.scrollTo({ top: 0 });
            }}
          >
            <div
              className="flex items-center gap-2 h-[40px] rounded-md"
              data-testid="library-mobile-control-row"
            >
              <TabsList
                variant="brand"
                className="flex-1 !h-full !p-0"
                data-testid="library-tabs-mobile"
              >
                <TabsTrigger
                  value="import"
                  className="flex-1"
                  data-testid="tab-import-mobile"
                >
                  <DownloadIcon className="h-4 w-4" />
                  Import
                </TabsTrigger>
                <TabsTrigger
                  value="games"
                  className="flex-1"
                  data-testid="tab-games-mobile"
                >
                  <Swords className="h-4 w-4" />
                  Games
                </TabsTrigger>
                <TabsTrigger
                  value="flaws"
                  className="flex-1"
                  data-testid="tab-flaws-mobile"
                >
                  <AlertTriangle className="h-4 w-4" />
                  Flaws
                </TabsTrigger>
                <TabsTrigger
                  value="stats"
                  className="flex-1"
                  data-testid="tab-stats-mobile"
                >
                  <BarChart2 className="h-4 w-4" />
                  Stats
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="import" className="mt-4">
              <ImportTab
                onImportStarted={onImportStarted}
                activeJobIds={activeJobIds}
                onJobDismissed={onJobDismissed}
              />
            </TabsContent>
            <TabsContent value="games" className="mt-1">
              <GamesTab />
            </TabsContent>
            <TabsContent value="flaws" className="mt-1">
              <FlawsTab />
            </TabsContent>
            <TabsContent value="stats" className="mt-1">
              <StatsTab />
            </TabsContent>
          </Tabs>
        </div>

      </div>
    </div>
  );
}
