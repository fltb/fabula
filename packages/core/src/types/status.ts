// ============================================================================
// Novalistically — Status Report Types (MCP)
// ============================================================================

import type { ISSSnapshot } from './iss.js';
import type { ValidationIssue } from './validator.js';

// ——— Status Report ———

export interface StatusReport {
  project: string;
  timestamp: string;
  iss: ISSSnapshot;
  validation: {
    lastRun: string;
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
  };
  threads: ThreadSnapshot[];
  render: {
    ready: string[];
    blocked: string[];
    waiting: string[];
    completed: string[];
  };
  blockers: Blocker[];
  nextActions: NextAction[];
  guidance: string;
}

export interface ThreadSnapshot {
  id: string;
  name: string;
  progress: string;
  lastAdvancedIn: string;
  targetChapter: number;
  currentChapter: number;
  onTrack: boolean;
  risk: 'on_track' | 'behind' | 'critical' | 'stalled';
}

export interface Blocker {
  event: string;
  reason: string;
  missingPreconditions: Array<{
    entity: string;
    attribute: string;
    expectedValue: unknown;
    currentValue: unknown | null;
    providedBy?: string;
  }>;
}

export interface NextAction {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: 'iss' | 'validation' | 'thread' | 'rendering';
  action: string;
  targetFile?: string;
  template?: string;
  fixAction?: string;
}
