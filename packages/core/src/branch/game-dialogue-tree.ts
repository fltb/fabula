import { ConfigError } from '../errors.ts';
import { factIdFrom, parseStoryTimestamp, resolveTimestampToDay } from '../entity/timestamp.ts';
import type {
  BranchPath,
  BranchSet,
  EventFile,
  Fact,
  GameDialogueChoice,
  NarrativeEvent,
} from '../types/index.ts';

export interface CompiledGameDialogueTree {
  leafPaths: readonly BranchPath[];
  eventScopes: ReadonlyMap<string, BranchSet>;
  representativePathByEventId: ReadonlyMap<string, BranchPath>;
  transitionEvents: readonly NarrativeEvent[];
  choicesByEventId: ReadonlyMap<string, readonly GameDialogueChoice[]>;
}

interface TreeNode {
  event: EventFile;
  children: readonly TreeNode[];
}

function transitionEventId(eventId: string, choiceId: string): string {
  return `system:branch-choice:${eventId}:${choiceId}`;
}

function validateStrictlyLater(
  source: EventFile,
  target: EventFile,
  timeAnchors: Map<string, number>,
): void {
  let sourceDay: number;
  let targetDay: number;
  try {
    sourceDay = resolveTimestampToDay(parseStoryTimestamp(source.storyTime), timeAnchors);
    targetDay = resolveTimestampToDay(parseStoryTimestamp(target.storyTime), timeAnchors);
  } catch {
    throw new ConfigError(
      `Choice target '${target.event}' must use a storyTime comparable to '${source.event}'`,
      { eventId: source.event, phase: 'game_dialogue_tree' },
    );
  }
  if (targetDay <= sourceDay) {
    throw new ConfigError(
      `Choice target '${target.event}' must have storyTime later than '${source.event}'`,
      { eventId: source.event, phase: 'game_dialogue_tree' },
    );
  }
}

function makeTransitionEvent(
  source: EventFile,
  choice: GameDialogueChoice,
  choiceScope: BranchSet,
): NarrativeEvent {
  const storyTime = parseStoryTimestamp(source.storyTime);
  const postconditions: Fact[] = choice.effects.map((effect) => ({
    id: factIdFrom(effect.entity, effect.attribute),
    entityId: effect.entity,
    attribute: effect.attribute,
    value: effect.value,
    operation: effect.operation,
    confidence: effect.confidence ?? 1,
    narrativeHint: effect.narrativeHint,
    validity: {
      temporal: { start: storyTime, end: null },
      branches: choiceScope,
    },
  }));

  return {
    id: transitionEventId(source.event, choice.id),
    event: transitionEventId(source.event, choice.id),
    narrativeOrder: source.narrativeOrder + 0.5,
    title: `Choice ${choice.id} after ${source.event}`,
    storyTime,
    sceneType: 'linear',
    pov: { character: 'system', type: 'omniscient' },
    sceneBrief: `Apply choice ${choice.id}`,
    preconditions: [],
    postconditions,
    threadProgress: [],
    foreshadowing: [],
    relationshipEffects: [],
    ruleEffects: [],
    source: 'branch_point',
    branchExistence: choiceScope,
    participants: { entities: [] },
    causalPredecessors: [source.event],
  };
}

/**
 * Compiles EventFile-local choices into a rooted tree with exact leaf-path
 * scopes. A null result preserves the ordinary linear rendering path.
 */
export function compileGameDialogueTree(
  events: readonly EventFile[],
  timeAnchors: Map<string, number> = new Map(),
): CompiledGameDialogueTree | null {
  if (!events.some((event) => event.choices !== undefined)) return null;

  const eventById = new Map<string, EventFile>();
  for (const event of events) {
    if (eventById.has(event.event)) {
      throw new ConfigError(`Duplicate event id '${event.event}' in game dialogue tree`, {
        eventId: event.event,
        phase: 'game_dialogue_tree',
      });
    }
    eventById.set(event.event, event);
  }

  const incomingByEventId = new Map<string, string>();
  const childIdsByEventId = new Map<string, string[]>();
  for (const event of events) {
    const childIds: string[] = [];
    for (const choice of event.choices ?? []) {
      const target = eventById.get(choice.targetEvent);
      if (!target) {
        throw new ConfigError(
          `Choice '${choice.id}' in '${event.event}' targets missing event '${choice.targetEvent}'`,
          { eventId: event.event, phase: 'game_dialogue_tree' },
        );
      }
      if (target.event === event.event) {
        throw new ConfigError(`Choice '${choice.id}' in '${event.event}' cannot target itself`, {
          eventId: event.event,
          phase: 'game_dialogue_tree',
        });
      }
      validateStrictlyLater(event, target, timeAnchors);
      const existingParent = incomingByEventId.get(target.event);
      if (existingParent) {
        throw new ConfigError(
          `Event '${target.event}' has multiple incoming choices ('${existingParent}' and '${event.event}')`,
          { eventId: target.event, phase: 'game_dialogue_tree' },
        );
      }
      incomingByEventId.set(target.event, event.event);
      childIds.push(target.event);
    }
    childIdsByEventId.set(event.event, childIds);
  }

  const visitState = new Map<string, 'visiting' | 'visited'>();
  const validateAcyclic = (eventId: string): void => {
    const state = visitState.get(eventId);
    if (state === 'visiting') {
      throw new ConfigError(`Game dialogue choices contain a cycle at '${eventId}'`, {
        eventId,
        phase: 'game_dialogue_tree',
      });
    }
    if (state === 'visited') return;
    visitState.set(eventId, 'visiting');
    for (const childId of childIdsByEventId.get(eventId) ?? []) validateAcyclic(childId);
    visitState.set(eventId, 'visited');
  };
  for (const event of events) validateAcyclic(event.event);

  const roots = events.filter((event) => !incomingByEventId.has(event.event));
  if (roots.length !== 1) {
    throw new ConfigError(`Game dialogue tree requires exactly one root; found ${roots.length}`, {
      phase: 'game_dialogue_tree',
    });
  }
  const root = roots[0]!;

  const buildNode = (eventId: string): TreeNode => {
    const event = eventById.get(eventId)!;
    return {
      event,
      children: (childIdsByEventId.get(eventId) ?? []).map(buildNode),
    };
  };
  const rootNode = buildNode(root.event);

  const reachable = new Set<string>();
  const markReachable = (node: TreeNode): void => {
    reachable.add(node.event.event);
    for (const child of node.children) markReachable(child);
  };
  markReachable(rootNode);
  if (reachable.size !== events.length) {
    const unreachable = events.find((event) => !reachable.has(event.event))!;
    throw new ConfigError(`Game dialogue event '${unreachable.event}' is unreachable from '${root.event}'`, {
      eventId: unreachable.event,
      phase: 'game_dialogue_tree',
    });
  }

  const leafPaths: BranchPath[] = [];
  const descendantPathsByEventId = new Map<string, BranchPath[]>();
  const representativePathByEventId = new Map<string, BranchPath>();
  const visitLeaves = (node: TreeNode, path: BranchPath): BranchPath[] => {
    if (node.children.length === 0) {
      leafPaths.push(path);
      descendantPathsByEventId.set(node.event.event, [path]);
      representativePathByEventId.set(node.event.event, path);
      return [path];
    }

    const descendantPaths: BranchPath[] = [];
    for (const [index, child] of node.children.entries()) {
      const choice = node.event.choices![index]!;
      const choicePath: BranchPath = {
        decisions: [
          ...path.decisions,
          {
            atEventId: node.event.event,
            choiceId: choice.id,
            narrativeOrder: node.event.narrativeOrder,
          },
        ],
      };
      descendantPaths.push(...visitLeaves(child, choicePath));
    }
    descendantPathsByEventId.set(node.event.event, descendantPaths);
    representativePathByEventId.set(node.event.event, descendantPaths[0]!);
    return descendantPaths;
  };
  visitLeaves(rootNode, { decisions: [] });

  const eventScopes = new Map<string, BranchSet>();
  for (const event of events) {
    eventScopes.set(
      event.event,
      event.event === root.event
        ? { type: 'all' }
        : { type: 'paths', paths: descendantPathsByEventId.get(event.event)! },
    );
  }

  const choicesByEventId = new Map<string, readonly GameDialogueChoice[]>();
  const transitionEvents: NarrativeEvent[] = [];
  const emitTransitions = (node: TreeNode): void => {
    const choices = node.event.choices;
    if (!choices) return;
    choicesByEventId.set(node.event.event, choices);
    for (const choice of choices) {
      const targetScope = eventScopes.get(choice.targetEvent)!;
      transitionEvents.push(makeTransitionEvent(node.event, choice, targetScope));
    }
    for (const child of node.children) emitTransitions(child);
  };
  emitTransitions(rootNode);

  return {
    leafPaths,
    eventScopes,
    representativePathByEventId,
    transitionEvents,
    choicesByEventId,
  };
}
