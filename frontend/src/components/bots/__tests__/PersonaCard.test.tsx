// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { PersonaCard } from '../PersonaCard';
import { PERSONA_REGISTRY } from '@/lib/personas/personaRegistry';

afterEach(() => {
  cleanup();
});

const PERSONA = PERSONA_REGISTRY['attacker-800'];

describe('PersonaCard', () => {
  it('renders the persona name, calibrated ELO label, and an avatar node', () => {
    render(<PersonaCard persona={PERSONA} onSelect={vi.fn()} />);

    const card = screen.getByTestId(`bots-persona-card-${PERSONA.id}`);
    expect(card.textContent).toContain(PERSONA.name);
    expect(card.textContent).toContain(PERSONA.calibratedLabel);
    // The avatar node renders inside the card: either the real-art <img>
    // (when the persona's webp asset exists) or the emoji placeholder — both
    // live in the one aria-hidden avatar circle.
    expect(card.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(1);
  });

  it('renders the calibrated label, not the raw rung, when they differ (CAL-05)', () => {
    const personaWithDistinctLabel = { ...PERSONA, calibratedLabel: '~1050' };
    render(<PersonaCard persona={personaWithDistinctLabel} onSelect={vi.fn()} />);

    const card = screen.getByTestId(`bots-persona-card-${personaWithDistinctLabel.id}`);
    expect(card.textContent).toContain('~1050');
    expect(card.textContent).not.toContain(`~${PERSONA.rung}`);
    expect(card.getAttribute('aria-label')).toContain('~1050');
  });

  it('is a semantic button with an aria-label naming the persona', () => {
    render(<PersonaCard persona={PERSONA} onSelect={vi.fn()} />);

    const card = screen.getByTestId(`bots-persona-card-${PERSONA.id}`);
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute('aria-label')).toContain(PERSONA.name);
  });

  it('calls onSelect with the persona when tapped', () => {
    const onSelect = vi.fn();
    render(<PersonaCard persona={PERSONA} onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId(`bots-persona-card-${PERSONA.id}`));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(PERSONA);
  });

  it('never uses sub-text-sm font-size utilities on card text', () => {
    render(<PersonaCard persona={PERSONA} onSelect={vi.fn()} />);

    const card = screen.getByTestId(`bots-persona-card-${PERSONA.id}`);
    expect(card.innerHTML).not.toContain('text-xs');
  });

  it('backstop: falls back to the emoji when no real art resolves', () => {
    // An id the assets glob cannot match — forces resolveAvatarSrc to
    // undefined regardless of which webp files exist on disk, so the D-18
    // emoji placeholder branch stays covered now that real art has landed.
    const personaNoArt = {
      ...PERSONA,
      id: 'no-such-persona' as typeof PERSONA.id,
      avatarSrc: undefined,
    };
    render(<PersonaCard persona={personaNoArt} onSelect={vi.fn()} />);

    const card = screen.getByTestId(`bots-persona-card-${personaNoArt.id}`);
    expect(card.querySelector('img')).toBeNull();
    expect(card.textContent).toContain(PERSONA.avatarEmoji);
  });

  it('backstop: renders the real-art image instead of the emoji when avatarSrc is present (D-17 forward-compat seam)', () => {
    const personaWithArt = { ...PERSONA, avatarSrc: '/personas/attacker-800.webp' };
    render(<PersonaCard persona={personaWithArt} onSelect={vi.fn()} />);

    const card = screen.getByTestId(`bots-persona-card-${personaWithArt.id}`);
    const img = card.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(personaWithArt.avatarSrc);
  });

  it('lazy-loads the real-art avatar image (213-02, D-18)', () => {
    // A persona whose webp exists in the assets glob renders the real-art
    // <img>, which must carry loading="lazy" so the /bots grid does not
    // eagerly fetch every persona's avatar on mount.
    const personaWithArt = { ...PERSONA, avatarSrc: '/personas/attacker-800.webp' };
    render(<PersonaCard persona={personaWithArt} onSelect={vi.fn()} />);

    const card = screen.getByTestId(`bots-persona-card-${personaWithArt.id}`);
    const img = card.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('loading')).toBe('lazy');
  });
});

describe('PersonaCard win-stars row (Phase 185)', () => {
  function starsRow(): HTMLElement {
    const card = screen.getByTestId(`bots-persona-card-${PERSONA.id}`);
    const row = card.querySelector('[aria-label$="win"], [aria-label$="wins"]');
    if (row === null) throw new Error('stars row not found');
    return row as HTMLElement;
  }

  it('caps at 3 gold filled stars when winsForPersona is 5 (overflow)', () => {
    render(<PersonaCard persona={PERSONA} onSelect={vi.fn()} winsForPersona={5} />);

    const stars = starsRow().querySelectorAll('svg');
    expect(stars).toHaveLength(3);
    stars.forEach((star) => {
      expect(star.getAttribute('fill')).not.toBe('none');
    });
  });

  it('renders 1 filled + 2 outline stars when winsForPersona is 1', () => {
    render(<PersonaCard persona={PERSONA} onSelect={vi.fn()} winsForPersona={1} />);

    const stars = Array.from(starsRow().querySelectorAll('svg'));
    expect(stars).toHaveLength(3);
    expect(stars[0]?.getAttribute('fill')).not.toBe('none');
    expect(stars[1]?.getAttribute('fill')).toBe('none');
    expect(stars[2]?.getAttribute('fill')).toBe('none');
  });

  it('renders 3 grey-outline stars and no "0 wins" visible text when winsForPersona is 0', () => {
    render(<PersonaCard persona={PERSONA} onSelect={vi.fn()} winsForPersona={0} />);

    const card = screen.getByTestId(`bots-persona-card-${PERSONA.id}`);
    const stars = starsRow().querySelectorAll('svg');
    expect(stars).toHaveLength(3);
    stars.forEach((star) => {
      expect(star.getAttribute('fill')).toBe('none');
    });
    expect(card.textContent).not.toContain('0 wins');
    expect(card.textContent).not.toContain('win');
  });

  it('renders identically (3 outline) when winsForPersona is undefined, and stays clickable', () => {
    const onSelect = vi.fn();
    render(<PersonaCard persona={PERSONA} onSelect={onSelect} winsForPersona={undefined} />);

    const stars = starsRow().querySelectorAll('svg');
    expect(stars).toHaveLength(3);
    stars.forEach((star) => {
      expect(star.getAttribute('fill')).toBe('none');
    });
    expect(starsRow().getAttribute('aria-label')).toBe('0 wins');

    fireEvent.click(screen.getByTestId(`bots-persona-card-${PERSONA.id}`));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('carries a separate stars-row aria-label from the card button aria-label', () => {
    render(<PersonaCard persona={PERSONA} onSelect={vi.fn()} winsForPersona={2} />);

    const card = screen.getByTestId(`bots-persona-card-${PERSONA.id}`);
    expect(card.getAttribute('aria-label')).not.toContain('win');
    expect(starsRow().getAttribute('aria-label')).toBe('2 wins');
  });

  it('uses a singular "1 win" aria-label (not "1 wins")', () => {
    render(<PersonaCard persona={PERSONA} onSelect={vi.fn()} winsForPersona={1} />);

    expect(starsRow().getAttribute('aria-label')).toBe('1 win');
  });

  it('mutation check: reverting the Math.min cap would make the wins>=4 assertion fail', () => {
    // This test documents the cap behavior tested above (winsForPersona=5 -> 3
    // filled stars) is load-bearing: MAX_DISPLAY_STARS caps the filled count.
    render(<PersonaCard persona={PERSONA} onSelect={vi.fn()} winsForPersona={4} />);
    const stars = starsRow().querySelectorAll('svg');
    expect(stars).toHaveLength(3);
    stars.forEach((star) => {
      expect(star.getAttribute('fill')).not.toBe('none');
    });
  });
});
