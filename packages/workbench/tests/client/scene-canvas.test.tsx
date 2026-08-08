import { cleanup, render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SceneCanvas } from '../../src/client/scene-canvas';

afterEach(() => cleanup());

const candidate = {
  version: 1 as const,
  eventId: 'E7',
  revisionId: '00000000-0000-4000-8000-000000000007',
  proseHash: 'a'.repeat(64),
  released: true,
  disclosure: 'accepted generated prose will enter the authoring manifest' as const,
};

describe('SceneCanvas adoption disclosure', () => {
  it('states that generated prose is non-authoring and requires explicit adoption', async () => {
    const request = vi.fn();
    const user = userEvent.setup();
    render(() => <SceneCanvas adoption={candidate} onRequestAdoption={request} />);

    expect(screen.getByText('Generated prose is not authoring source yet')).toBeInTheDocument();
    expect(screen.getByText(/will enter the authoring manifest/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '收下这版' }));
    expect(request).toHaveBeenCalledWith(candidate);
  });

  it('does not offer an adoption action without a released revision', () => {
    render(() => <SceneCanvas adoption={null} />);
    expect(screen.getByText('No released scene revision')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '收下这版' })).not.toBeInTheDocument();
  });
});
