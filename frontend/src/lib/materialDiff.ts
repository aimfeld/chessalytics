/**
 * materialDiff.ts (Quick 260809-jzz) — lichess-style net material difference,
 * computed client-side from a FEN string via chess.js. Compares piece counts
 * PER TYPE (D-01) so trades cancel out and promotions are counted correctly
 * (e.g. two queens vs one nets a queen surplus of 1, not a raw-count miscount).
 * Pure and React-free — consumed by MaterialDisplay via useMemo.
 */
import { Chess, type PieceSymbol } from 'chess.js';

/** The five non-king piece types that can carry a material surplus. */
export type MaterialPieceType = Exclude<PieceSymbol, 'k'>;

export interface MaterialSurplusEntry {
  type: MaterialPieceType;
  count: number;
}

export interface MaterialSideDiff {
  /** Ascending piece-value order (pawn, knight, bishop, rook, queen — D-01). */
  surplus: MaterialSurplusEntry[];
  /**
   * Net point total this side is ahead by. Zero unless this side is strictly
   * ahead on points — the `+N` number appears only next to the leading side
   * (D-06), even when the other side also carries a non-empty surplus list.
   */
  points: number;
}

export interface MaterialDiff {
  white: MaterialSideDiff;
  black: MaterialSideDiff;
}

/** Standard piece values (D-06). No bare numerals in the tally loop below. */
const PIECE_VALUES: Record<MaterialPieceType, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
};

/** Lichess surplus ordering: pawn, knight, bishop, rook, queen (D-01). */
const PIECE_ORDER: MaterialPieceType[] = ['p', 'n', 'b', 'r', 'q'];

const ZERO_DIFF: MaterialDiff = {
  white: { surplus: [], points: 0 },
  black: { surplus: [], points: 0 },
};

function emptyCounts(): Record<MaterialPieceType, number> {
  return { p: 0, n: 0, b: 0, r: 0, q: 0 };
}

/**
 * Compute the net material surplus (per piece type) and point totals for
 * both sides at the given FEN.
 */
export function computeMaterialDiff(fen: string): MaterialDiff {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    // The Analysis board can be fed a user-pasted (possibly malformed) FEN;
    // `new Chess(fen)` throws on an unparseable string, which would otherwise
    // unmount the Analysis tree. Fail closed to the zeroed display instead
    // (T-260809-jzz-01).
    return ZERO_DIFF;
  }

  const whiteCounts = emptyCounts();
  const blackCounts = emptyCounts();

  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece || piece.type === 'k') continue;
      const counts = piece.color === 'w' ? whiteCounts : blackCounts;
      counts[piece.type as MaterialPieceType] += 1;
    }
  }

  const whiteSurplus: MaterialSurplusEntry[] = [];
  const blackSurplus: MaterialSurplusEntry[] = [];
  let netPoints = 0;

  for (const type of PIECE_ORDER) {
    const delta = whiteCounts[type] - blackCounts[type];
    if (delta > 0) {
      whiteSurplus.push({ type, count: delta });
    } else if (delta < 0) {
      blackSurplus.push({ type, count: -delta });
    }
    netPoints += delta * PIECE_VALUES[type];
  }

  return {
    white: { surplus: whiteSurplus, points: netPoints > 0 ? netPoints : 0 },
    black: { surplus: blackSurplus, points: netPoints < 0 ? -netPoints : 0 },
  };
}
