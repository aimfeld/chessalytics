// @vitest-environment jsdom
/**
 * PasteModal.test.tsx — modal state-machine, testid, and a11y coverage
 * (Phase 208 Plan 01 Task 3 + Plan 03 Task 2). PasteModal now uses
 * useSavePastedGame (TanStack Query), so every render needs a
 * QueryClientProvider ancestor (mirrors FeedbackModal.test.tsx's precedent
 * — the load-only coverage below never triggers a network call, so
 * apiClient itself is not mocked here; usePasteGame.test.tsx covers the
 * request/response contract directly).
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PasteModal } from '../PasteModal';
import type { PasteParseResult } from '@/lib/pastedGame';

const VALID_MOVETEXT = '1. e4 e5 2. Nf3 Nc6';
const BARE_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const GARBAGE_TEXT = 'hello world this is not chess';
const PARSE_ERROR_MESSAGE = "Couldn't read that as a FEN or PGN.";

function renderWithQueryClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Stateful test harness: PasteModal's `open` prop must be genuinely
 *  controlled by a real onOpenChange round-trip for the draft-clear-on-close
 *  behavior to be observable — a parent that just re-renders a new `open`
 *  literal without wiring onOpenChange never exercises PasteModal's own
 *  handleOpenChange (Radix does not call onOpenChange from an externally
 *  changed `open` prop). */
function ControlledPasteModal({ onLoad = vi.fn() }: { onLoad?: (result: PasteParseResult, userColor: 'white' | 'black') => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button data-testid="test-reopen" onClick={() => setOpen(true)}>
        Reopen
      </button>
      <PasteModal open={open} onOpenChange={setOpen} onLoad={onLoad} onSaved={vi.fn()} />
    </>
  );
}

describe('PasteModal', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders with the paste-modal and paste-form testids, and the form testid differs from the DialogContent testid', () => {
    renderWithQueryClient(
      <PasteModal open={true} onOpenChange={vi.fn()} onLoad={vi.fn()} onSaved={vi.fn()} />,
    );

    const modal = screen.getByTestId('paste-modal');
    const form = screen.getByTestId('paste-form');
    expect(modal).toBeTruthy();
    expect(form).toBeTruthy();
    expect(form).not.toBe(modal);
    expect(form.tagName).toBe('FORM');
  });

  it('empty textarea: Load disabled, no error node, no side selector', () => {
    renderWithQueryClient(
      <PasteModal open={true} onOpenChange={vi.fn()} onLoad={vi.fn()} onSaved={vi.fn()} />,
    );

    expect((screen.getByTestId('btn-paste-load') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('paste-error')).toBeNull();
    expect(screen.queryByTestId('paste-side-selector')).toBeNull();
    expect(screen.queryByTestId('btn-paste-analyze')).toBeNull();
  });

  it('valid FEN: Load enabled, still no side selector and no secondary button', () => {
    renderWithQueryClient(
      <PasteModal open={true} onOpenChange={vi.fn()} onLoad={vi.fn()} onSaved={vi.fn()} />,
    );

    fireEvent.change(screen.getByTestId('paste-textarea'), { target: { value: BARE_FEN } });

    expect((screen.getByTestId('btn-paste-load') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('paste-error')).toBeNull();
    expect(screen.queryByTestId('paste-side-selector')).toBeNull();
    expect(screen.queryByTestId('btn-paste-analyze')).toBeNull();
  });

  it('valid PGN: side selector defaults to White, both footer buttons render', () => {
    renderWithQueryClient(
      <PasteModal open={true} onOpenChange={vi.fn()} onLoad={vi.fn()} onSaved={vi.fn()} />,
    );

    fireEvent.change(screen.getByTestId('paste-textarea'), { target: { value: VALID_MOVETEXT } });

    expect((screen.getByTestId('btn-paste-load') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('paste-side-selector')).toBeTruthy();
    expect(screen.getByTestId('btn-paste-analyze')).toBeTruthy();
    // D-06: default selection is White.
    expect(screen.getByTestId('paste-side-white').getAttribute('data-state')).toBe('on');
    expect(screen.getByTestId('paste-side-black').getAttribute('data-state')).toBe('off');
  });

  it('malformed input: Load disabled, the exact locked error literal renders with role="alert"', () => {
    renderWithQueryClient(
      <PasteModal open={true} onOpenChange={vi.fn()} onLoad={vi.fn()} onSaved={vi.fn()} />,
    );

    fireEvent.change(screen.getByTestId('paste-textarea'), { target: { value: GARBAGE_TEXT } });

    expect((screen.getByTestId('btn-paste-load') as HTMLButtonElement).disabled).toBe(true);
    const error = screen.getByTestId('paste-error');
    expect(error.textContent).toBe(PARSE_ERROR_MESSAGE);
    expect(error.getAttribute('role')).toBe('alert');
  });

  it('closing (via the X close button) and reopening clears the textarea, side selection, and error', () => {
    renderWithQueryClient(<ControlledPasteModal />);

    fireEvent.change(screen.getByTestId('paste-textarea'), { target: { value: VALID_MOVETEXT } });
    fireEvent.click(screen.getByTestId('paste-side-black'));
    expect(screen.getByTestId('paste-side-black').getAttribute('data-state')).toBe('on');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('paste-modal')).toBeNull();

    fireEvent.click(screen.getByTestId('test-reopen'));
    const textarea = screen.getByTestId('paste-textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    expect((screen.getByTestId('btn-paste-load') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('paste-side-selector')).toBeNull();
  });

  it('accented Latin and CJK player names reach the meta line unmangled', () => {
    renderWithQueryClient(
      <PasteModal open={true} onOpenChange={vi.fn()} onLoad={vi.fn()} onSaved={vi.fn()} />,
    );

    const pgn = '[Event "Test"]\n[White "José García"]\n[Black "王祥"]\n\n1. e4 e5 *';
    fireEvent.change(screen.getByTestId('paste-textarea'), { target: { value: pgn } });

    const meta = screen.getByTestId('paste-header-meta');
    expect(meta.textContent).toContain('José García');
    expect(meta.textContent).toContain('王祥');
  });

  it('a PGN missing WhiteElo renders no empty parentheses and no literal "undefined"', () => {
    renderWithQueryClient(
      <PasteModal open={true} onOpenChange={vi.fn()} onLoad={vi.fn()} onSaved={vi.fn()} />,
    );

    const pgn = '[Event "Test"]\n[White "A"]\n[Black "B"]\n[BlackElo "1500"]\n\n1. e4 e5 *';
    fireEvent.change(screen.getByTestId('paste-textarea'), { target: { value: pgn } });

    const meta = screen.getByTestId('paste-header-meta');
    expect(meta.textContent).not.toMatch(/undefined/);
    expect(meta.textContent).not.toMatch(/\(\)/);
    expect(meta.textContent).toContain('White: A');
    expect(meta.textContent).toContain('Black: B (1500)');
  });

  it('submitting a valid FEN calls onLoad with the sniffed result and closes the modal', () => {
    const onLoad = vi.fn();
    const onOpenChange = vi.fn();
    renderWithQueryClient(
      <PasteModal open={true} onOpenChange={onOpenChange} onLoad={onLoad} onSaved={vi.fn()} />,
    );

    fireEvent.change(screen.getByTestId('paste-textarea'), { target: { value: BARE_FEN } });
    fireEvent.click(screen.getByTestId('btn-paste-load'));

    expect(onLoad).toHaveBeenCalledWith({ kind: 'fen', fen: BARE_FEN }, 'white');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('submitting a valid PGN with Black selected passes userColor: "black" to onLoad', () => {
    const onLoad = vi.fn();
    renderWithQueryClient(
      <PasteModal open={true} onOpenChange={vi.fn()} onLoad={onLoad} onSaved={vi.fn()} />,
    );

    fireEvent.change(screen.getByTestId('paste-textarea'), { target: { value: VALID_MOVETEXT } });
    fireEvent.click(screen.getByTestId('paste-side-black'));
    fireEvent.click(screen.getByTestId('btn-paste-load'));

    expect(onLoad).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pgn' }), 'black');
  });
});
