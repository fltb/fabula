// ============================================================================
// AI Prompts — Thread Status
// ============================================================================

import type { Message } from '../types.ts';

export interface ThreadStatusInput {
  threads: Array<{
    id: string;
    name: string;
    progress: number;
    lastEvent: string;
  }>;
  currentChapter: number;
  currentEvent: string;
}

export function buildThreadStatusPrompt(input: ThreadStatusInput): Message[] {
  const sys = [
    'You are a narrative continuity analyst. Given a snapshot of the active story threads, write a concise status report and suggest 1-3 immediate next narrative actions.',
    'Output as plain text with short bullet points. Be specific and grounded in the data.',
  ].join('\n');

  const user = [
    '## Thread Snapshot',
    `Current chapter: ${input.currentChapter}`,
    `Current event: ${input.currentEvent}`,
    '',
    ...input.threads.map(
      (t) =>
        `- [${t.id}] ${t.name} — progress ${(t.progress * 100).toFixed(0)}% — last event: ${t.lastEvent}`,
    ),
    '',
    '## Task',
    '1. Identify any thread that is stalled or at risk',
    '2. Suggest 1-3 concrete next actions for the current event or the next one',
    '3. Flag any internal consistency concerns',
  ].join('\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}
