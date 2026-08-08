/**
 * Author-facing LLM provider presets, derived dynamically from pi-ai's
 * built-in provider catalog. Only providers whose first model speaks the
 * OpenAI-completions API (the runtime's supported channel) with a non-empty
 * baseUrl are offered; anthropic/bedrock/google-style providers are excluded
 * because the workbench runtime cannot drive them.
 *
 * The dynamic import keeps the 40-provider catalog out of the main bundle
 * (vite code-splits it into a lazy chunk loaded on first Settings open).
 */
export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly modelHint: string | null;
}

export async function providerPresets(): Promise<ProviderPreset[]> {
  const { getBuiltinModels, getBuiltinProviders } = await import(
    '@earendil-works/pi-ai/providers/all'
  );
  const presets: ProviderPreset[] = [];
  for (const id of getBuiltinProviders()) {
    const models = getBuiltinModels(id);
    const first = models?.find((m) => m.api === 'openai-completions' && m.baseUrl);
    if (first === undefined) continue;
    presets.push({ id, label: id, baseUrl: first.baseUrl, modelHint: first.id ?? null });
  }
  return presets.sort((a, b) => a.label.localeCompare(b.label));
}
