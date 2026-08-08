import { describe, expect, it } from 'vitest';
import { requiresSetup } from '../../src/client/runtime-client';

describe('requiresSetup startup gate', () => {
  it('shows setup while no configuration file has been applied', () => {
    expect(requiresSetup({ configurationPresent: false, ownerCreated: true })).toBe(true);
    expect(requiresSetup({ configurationPresent: false, ownerCreated: false })).toBe(true);
  });

  it('shows setup when the owner account does not exist', () => {
    expect(requiresSetup({ configurationPresent: true, ownerCreated: false })).toBe(true);
  });

  it('enters the workspace once finish applied a config, even with no project or provider', () => {
    // The author creates the first project from the (empty) workspace UI.
    expect(requiresSetup({ configurationPresent: true, ownerCreated: true })).toBe(false);
  });
});
