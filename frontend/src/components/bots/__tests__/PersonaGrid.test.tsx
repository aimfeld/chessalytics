// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { PersonaGrid } from '../PersonaGrid';
import {
  STYLE_SECTION_ORDER,
  RUNGS,
  personasForSection,
  personasForRung,
} from '@/lib/personas/personaRegistry';
import { ATTACKER_ACCENT, TRICKSTER_ACCENT, GRINDER_ACCENT, WALL_ACCENT } from '@/lib/theme';

afterEach(() => {
  cleanup();
});

// jsdom normalizes oklch trailing zeros ('0.50' -> '0.5') when reading
// element.style.color back. Compare on a normalized form so the assertions
// are robust to jsdom's cosmetic rewrite without weakening the contract.
function normalizeColor(value: string): string {
  return value.replace(/(\d+)\.(\d*?)0+(?=\D|$)/g, (match, intPart: string, frac: string) => {
    if (frac === '') return `${intPart}`;
    return `${intPart}.${frac}`;
  });
}

describe('PersonaGrid', () => {
  it('renders exactly 24 persona cards, in rung-major DOM order (rung 800 top -> 1800 bottom, 4 styles per row)', () => {
    render(<PersonaGrid onSelectPersona={vi.fn()} onSelectCustom={vi.fn()} currentStrength={null} />);

    const container = screen.getByTestId('bots-persona-grid');
    const cards = container.querySelectorAll('[data-testid^="bots-persona-card-"]');
    expect(cards.length).toBe(24);

    // Expected ids, in the exact DOM order the transposed grid should
    // produce: rung rows ascending (800 -> 1800), each row's 4 personas in
    // STYLE_SECTION_ORDER (personasForRung) — rung-major, not style-major.
    const expectedIds = RUNGS.flatMap((rung) => personasForRung(rung).map((persona) => persona.id));
    const actualIds = Array.from(cards).map((card) => card.getAttribute('data-testid'));
    expect(actualIds).toEqual(expectedIds.map((id) => `bots-persona-card-${id}`));
  });

  it('renders one header row of 4 style-name cells with the STYLE_ACCENT colors', () => {
    render(<PersonaGrid onSelectPersona={vi.fn()} onSelectCustom={vi.fn()} currentStrength={null} />);

    const expectedAccent: Record<string, string> = {
      Attacker: ATTACKER_ACCENT,
      Trickster: TRICKSTER_ACCENT,
      Grinder: GRINDER_ACCENT,
      Wall: WALL_ACCENT,
    };
    for (const style of STYLE_SECTION_ORDER) {
      const header = screen.getByTestId(`bots-persona-header-${style.toLowerCase()}`);
      expect(header.textContent).toBe(style);
      expect(normalizeColor(header.style.color)).toBe(normalizeColor(expectedAccent[style]));
    }
    // No leftover per-style section wrappers from the pre-transpose layout.
    expect(screen.queryByTestId('bots-persona-section-attacker')).toBeNull();
  });

  it('each card shows a non-empty name, a tilde-formatted ELO label, and an avatar', () => {
    render(<PersonaGrid onSelectPersona={vi.fn()} onSelectCustom={vi.fn()} currentStrength={null} />);

    const attackerPersonas = personasForSection('Attacker');
    for (const persona of attackerPersonas) {
      const card = screen.getByTestId(`bots-persona-card-${persona.id}`);
      expect(card.textContent).toContain(persona.name);
      expect(card.textContent).toMatch(/~\d+/);
      // Avatar node: real-art <img> or emoji placeholder — both live in the
      // one aria-hidden avatar circle.
      expect(card.querySelectorAll('span[aria-hidden="true"]').length).toBe(1);
    }
  });

  it('renders a Custom entry that invokes onSelectCustom on click', () => {
    const onSelectCustom = vi.fn();
    render(<PersonaGrid onSelectPersona={vi.fn()} onSelectCustom={onSelectCustom} currentStrength={null} />);

    const customEntry = screen.getByTestId('bots-persona-custom');
    expect(customEntry).toBeTruthy();

    fireEvent.click(customEntry);
    expect(onSelectCustom).toHaveBeenCalledTimes(1);
  });

  it('a persona card tap fires onSelectPersona with the tapped persona', () => {
    const onSelectPersona = vi.fn();
    render(<PersonaGrid onSelectPersona={onSelectPersona} onSelectCustom={vi.fn()} currentStrength={null} />);

    const firstAttacker = personasForSection('Attacker')[0];
    if (firstAttacker === undefined) throw new Error('expected at least one Attacker persona');
    fireEvent.click(screen.getByTestId(`bots-persona-card-${firstAttacker.id}`));

    expect(onSelectPersona).toHaveBeenCalledTimes(1);
    expect(onSelectPersona).toHaveBeenCalledWith(firstAttacker);
  });

  it('shows the player rating reference line for a rung-sourced estimate', () => {
    render(
      <PersonaGrid
        onSelectPersona={vi.fn()}
        onSelectCustom={vi.fn()}
        currentStrength={{
          rating: 1642,
          source: 'recent_games',
          rung: {
            platform: 'lichess',
            time_control_bucket: 'blitz',
            n_games: 40,
            window_days: 90,
            converted: false,
          },
        }}
      />,
    );

    const line = screen.getByTestId('bots-player-rating');
    expect(line.textContent).toContain('~1642');
    expect(screen.getByTestId('bots-player-rating-info')).toBeTruthy();
  });

  it('shows the player rating reference line for an anchor-sourced estimate too (a null rung must not suppress it)', () => {
    render(
      <PersonaGrid
        onSelectPersona={vi.fn()}
        onSelectCustom={vi.fn()}
        currentStrength={{ rating: 1370, source: 'rating_anchor', rung: null }}
      />,
    );

    const line = screen.getByTestId('bots-player-rating');
    expect(line.textContent).toContain('~1370');
    expect(screen.getByTestId('bots-player-rating-info')).toBeTruthy();
  });

  it('omits the player rating reference line entirely when there is no anchor', () => {
    render(<PersonaGrid onSelectPersona={vi.fn()} onSelectCustom={vi.fn()} currentStrength={null} />);

    expect(screen.queryByTestId('bots-player-rating')).toBeNull();
    expect(screen.queryByTestId('bots-player-rating-info')).toBeNull();
  });

  it('never uses sub-text-sm font-size utilities anywhere in the grid', () => {
    render(<PersonaGrid onSelectPersona={vi.fn()} onSelectCustom={vi.fn()} currentStrength={null} />);

    const container = screen.getByTestId('bots-persona-grid');
    expect(container.innerHTML).not.toContain('text-xs');
  });
});
