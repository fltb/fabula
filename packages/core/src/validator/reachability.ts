// ============================================================================
// ReachabilityValidator — Branch reachability, thread completion, foreshadow recovery, deadlocks
// ============================================================================

import type {
  PreRenderInput,
  PostRenderInput,
  Validator,
  ValidationIssue,
} from '../types/index.js';
import { makeIssue } from './base.js';

export class ReachabilityValidator implements Validator {
  name = 'reachability';
  category = 'timeline_plot' as const;

  validatePre(input: PreRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const event = input.event;

    // 1. Thread completion: check if threads are on track
    const allThreads = input.worldState.threads;
    for (const [threadId, threadData] of Object.entries(allThreads)) {
      if (
        threadData.progress < threadData.total &&
        input.chapter > event.narrativeOrder
      ) {
        const behind = threadData.total - threadData.progress;
        if (behind > 2 && input.chapter > 5) {
          issues.push(makeIssue(
            this.name, event.id, threadId, 'warning',
            `Thread "${threadId}" is behind: ${threadData.progress}/${threadData.total} (${behind} remaining) at chapter ${input.chapter}`,
            'Add events that advance this thread, or adjust the progress target.',
            'change_value',
            'thread_progress',
          ));
        }
      }
    }

    // 2. Foreshadow recovery: check for dangling foreshadows
    const allEvents = input.events;
    const allForeshadows = allEvents.flatMap((e) =>
      e.foreshadowing.map((f) => ({ ...f, eventId: e.id, chapter: Math.ceil(e.narrativeOrder / 3) })),
    );

    for (const f of allForeshadows) {
      if (f.targetRevealChapter > 0 && input.chapter > f.targetRevealChapter + 3) {
        issues.push(makeIssue(
          this.name, f.eventId, f.id, 'error',
          `Foreshadow "${f.id}" planted in ${f.eventId} (target: chapter ${f.targetRevealChapter}) is unrevealed at chapter ${input.chapter}`,
          'Resolve this foreshadow in an upcoming scene or mark it as intentionally abandoned.',
          'change_value',
          'target_reveal_chapter',
        ));
      }
    }

    // 3. Precondition deadlock: are there events whose preconditions can never be satisfied?
    const allFactIds = new Set<string>();
    // Include initialFacts from world state (applied by compileStoryBoundaries)
    for (const [entityId, attrs] of Object.entries(input.worldState.entities)) {
      for (const attr of Object.keys(attrs)) {
        allFactIds.add(`${entityId}.${attr}`);
      }
    }
    for (const e of allEvents) {
      for (const pc of e.postconditions) {
        allFactIds.add(`${pc.entityId}.${pc.attribute}`);
      }
    }

    for (const e of allEvents) {
      if (e.narrativeOrder > event.narrativeOrder) continue;
      for (const pc of e.preconditions) {
        const factKey = `${pc.entityId}.${pc.attribute}`;
        if (!allFactIds.has(factKey)) {
          issues.push(makeIssue(
            this.name, e.id, pc.entityId, 'warning',
            `Precondition "${pc.entityId}.${pc.attribute}" in event ${e.id} is never established by any postcondition`,
            'Add an event that establishes this precondition, or remove it.',
            'add_precondition',
            pc.attribute,
          ));
        }
      }
    }

    return issues;
  }

  validatePost(input: PostRenderInput): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const event = input.event;
    const prose = input.prose;
    const state = input.worldState;
    const proseLower = prose.toLowerCase();

    // ── 1. Precondition consistency in prose ──
    // Check that the prose acknowledges or is consistent with preconditions
    for (const pc of event.preconditions) {
      const entityState = state.entities[pc.entityId];
      if (!entityState) continue;

      const entityNameParts = pc.entityId.split(/[_-]/);
      const entityNamePat = new RegExp(`\\b${entityNameParts.join('|')}\\b`, 'i');

      // Only check if the entity is actually mentioned in the prose
      if (!entityNamePat.test(prose)) continue;

      // narrativeHint facts have no deterministic value to match in prose;
      // skip string-based precondition consistency checks (deferred to Pass 2)
      if (pc.value === undefined) continue;

      const expectedValue = String(pc.value).toLowerCase();

      // Location precondition: prose should mention the location
      if (pc.attribute === 'location' && !proseLower.includes(expectedValue)) {
        issues.push(makeIssue(
          this.name, event.id, pc.entityId, 'warning',
          `Precondition says "${pc.entityId}" is at "${pc.value}" but prose does not mention this location`,
          `Establish that ${pc.entityId} is at ${pc.value} before the event action.`,
          'edit_file',
          pc.attribute,
        ));
      }

      // Status = alive precondition: prose should not describe the character as dead
      if (pc.attribute === 'status' && expectedValue === 'alive') {
        const deathWords = /\b(died|dead|death|killed|slain|corpse|lifeless)\b/i;
        // Only flag if death words appear near the character's name
        const sentences = prose.split(/[.!?]+/);
        for (const sentence of sentences) {
          if (entityNamePat.test(sentence) && deathWords.test(sentence)) {
            const negated = /\bnot\s+(dead|died|killed)\b|\bsurvived\b|\balive\b/i.test(sentence);
            if (!negated) {
              issues.push(makeIssue(
                this.name, event.id, pc.entityId, 'error',
                `Prose contradicts precondition: "${pc.entityId}" should be ${pc.value} but sentence implies death`,
                `Ensure prose does not describe ${pc.entityId} as dead when preconditions state they are alive.`,
                'edit_file',
                pc.attribute,
              ));
              break;
            }
          }
        }
      }
    }

    // ── 2. Narrative flow check ──
    // The POV character's known location should be established early in the prose
    const povChar = event.pov.character;
    const povState = state.entities[povChar];

    if (povState) {
      const knownLocation = povState.location as string | undefined;
      if (knownLocation && prose.length > 30) {
        const firstSentence = prose.split(/[.!?]/)[0].toLowerCase();
        if (!firstSentence.includes(knownLocation.toLowerCase())) {
          issues.push(makeIssue(
            this.name, event.id, povChar, 'info',
            `POV character "${povChar}" is at "${knownLocation}" but the opening sentence does not establish the setting`,
            'Consider opening by establishing the POV character\'s location for narrative continuity.',
            'edit_file',
            'location',
          ));
        }
      }

      // Check emotional/logical continuity: if the character has a known emotional state,
      // the prose tone should roughly match
      const knownMood = povState.mood as string | undefined;
      if (knownMood) {
        const moodLower = knownMood.toLowerCase();
        const sadWords = /\b(sad|grief|mourn|weep|cry|tears|despair|sorrow)\b/i;
        const happyWords = /\b(happy|joy|delight|smile|laugh|cheer|elated)\b/i;
        const angryWords = /\b(angry|fury|rage|fume|seethe|irate|furious)\b/i;

        if (/sad|grief|despair|sorrow/i.test(moodLower)) {
          if (happyWords.test(prose) && !/not|no|without/i.test(prose)) {
            issues.push(makeIssue(
              this.name, event.id, povChar, 'warning',
              `Character "${povChar}" mood is "${knownMood}" but prose contains happy/joyful language`,
              'Align the prose tone with the character\'s known emotional state.',
              'edit_file',
              'mood',
            ));
          }
        } else if (/angry|furious|irate/i.test(moodLower)) {
          if (sadWords.test(prose) && !angryWords.test(prose)) {
            issues.push(makeIssue(
              this.name, event.id, povChar, 'info',
              `Character "${povChar}" mood is "${knownMood}" but prose tone seems more sorrowful than angry`,
              'Consider adjusting the prose to reflect anger rather than sadness.',
              'edit_file',
              'mood',
            ));
          }
        }
      }
    }

    // ── 3. Dead character action check ──
    // If the world state says a character is dead, the prose shouldn't have them acting
    for (const [entityId, entityState] of Object.entries(state.entities)) {
      const status = entityState.status as string | undefined;
      if (status !== 'dead' && status !== 'deceased') continue;

      const nameParts = entityId.split(/[_-]/);
      const namePat = new RegExp(`\\b(${nameParts.join('|')})\\b`, 'i');
      if (!namePat.test(prose)) continue;

      // Check if the dead character is described performing actions
      const actionVerbs = /\b(spoke|said|walked|ran|thought|felt|decided|nodded|smiled|frowned|looked|grabbed|stepped|sat|stood|replied|asked|whispered|shouted|moved)\b/i;
      const sentences = prose.split(/[.!?]+/);
      for (const sentence of sentences) {
        if (namePat.test(sentence) && actionVerbs.test(sentence)) {
          // Allow if the sentence is explicitly a flashback or memory
          const isFlashback = /\b(remembered|recalled|flashback|memory|thought back|imagined)\b/i.test(sentence);
          if (!isFlashback) {
            issues.push(makeIssue(
              this.name, event.id, entityId, 'error',
              `"${entityId}" is ${status} per world state but prose describes them performing actions`,
              'Remove actions attributed to this character or mark the segment as a flashback/memory.',
              'edit_file',
              'status',
            ));
            break;
          }
        }
      }
    }

    return issues;
  }

  getAnalysisRequirements() {
    return []; // No Pass 2 analysis needed
  }
}
