import { ConfigError } from '../errors.ts';
import { compareStoryCoordinates, factIdFrom } from '../entity/timestamp.ts';
import type { TemporalContext } from '../entity/timestamp.ts';
import type {
  BranchPath,
  BranchSet,
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
  event: NarrativeEvent;
  children: readonly TreeNode[];
}

function transitionEventId(eventId: string, choiceId: string): string {
  return `system:branch-choice:${eventId}:${choiceId}`;
}

function makeTransitionEvent(
  source: NarrativeEvent,
  choice: GameDialogueChoice,
  choiceScope: BranchSet,
): NarrativeEvent {
  const postconditions: Fact[] = choice.effects.map((effect) => ({
    id: factIdFrom(effect.entity, effect.attribute),
    entityId: effect.entity,
    attribute: effect.attribute,
    value: effect.value,
    operation: effect.operation,
    confidence: effect.confidence ?? 1,
    narrativeHint: effect.narrativeHint,
    validity: {
      temporal: { start: source.storyTime, end: null },
      branches: choiceScope,
    },
  }));

  return {
    kind: 'event',
    id: transitionEventId(source.id, choice.id),
    event: transitionEventId(source.id, choice.id),
    narrativeOrder: source.narrativeOrder + 0.5,
    title: `Choice ${choice.id} after ${source.event}`,
    storyTime: source.storyTime,
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
    causalPredecessors: [source.id],
  };
}

/**
 * Compiles EventFile-local choices into a rooted tree with exact leaf-path
 * scopes. A null result preserves the ordinary linear rendering path.
 */
export function compileGameDialogueTree(
  events: readonly NarrativeEvent[],
  temporalContext: TemporalContext,
): CompiledGameDialogueTree | null {
  if (!events.some((event) => event.choices !== undefined)) return null;

  const eventById = new Map<string, NarrativeEvent>();
  for (const event of events) {
    if (eventById.has(event.id)) {
      throw new ConfigError(`Duplicate event id '${event.id}' in game dialogue tree`, {
        eventId: event.id,
        phase: 'game_dialogue_tree',
      });
    }
    eventById.set(event.id, event);
  }

  const incomingByEventId = new Map<string, string>();
  const childIdsByEventId = new Map<string, string[]>();
  for (const event of events) {
    const childIds: string[] = [];
    for (const choice of event.choices ?? []) {
      const target = eventById.get(choice.targetEvent);
      if (!target) {
        throw new ConfigError(
          `Choice '${choice.id}' in '${event.id}' targets missing event '${choice.targetEvent}'`,
          { eventId: event.id, phase: 'game_dialogue_tree' },
        );
      }
      if (target.id === event.id) {
        throw new ConfigError(`Choice '${choice.id}' in '${event.id}' cannot target itself`, {
          eventId: event.id,
          phase: 'game_dialogue_tree',
        });
      }

      // Reject only when target is provably earlier on the same clock.
      // equal, unlocated, and cross-clock transitions are all permitted.
      const sourceCoord = temporalContext.coordinatesByEventId.get(event.id);
      const targetCoord = temporalContext.coordinatesByEventId.get(target.id);
      if (sourceCoord && targetCoord) {
        const order = compareStoryCoordinates(sourceCoord, targetCoord);
        if (order === 'after') {
          throw new ConfigError(
            `Choice target '${target.id}' must not have storyTime earlier than '${event.id}'`,
            { eventId: event.id, phase: 'game_dialogue_tree' },
          );
        }
      }

      const existingParent = incomingByEventId.get(target.id);
      if (existingParent) {
        throw new ConfigError(
          `Event '${target.id}' has multiple incoming choices ('${existingParent}' and '${event.id}')`,
          { eventId: target.id, phase: 'game_dialogue_tree' },
        );
      }
      incomingByEventId.set(target.id, event.id);
      childIds.push(target.id);
    }
    childIdsByEventId.set(event.id, childIds);
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
  for (const event of events) validateAcyclic(event.id);

  const roots = events.filter((event) => !incomingByEventId.has(event.id));
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
  const rootNode = buildNode(root.id);

  const reachable = new Set<string>();
  const markReachable = (node: TreeNode): void => {
    reachable.add(node.event.id);
    for (const child of node.children) markReachable(child);
  };
  markReachable(rootNode);
  if (reachable.size !== events.length) {
    const unreachable = events.find((event) => !reachable.has(event.id))!;
    throw new ConfigError(`Game dialogue event '${unreachable.id}' is unreachable from '${root.id}'`, {
      eventId: unreachable.id,
      phase: 'game_dialogue_tree',
    });
  }

  const leafPaths: BranchPath[] = [];
  const descendantPathsByEventId = new Map<string, BranchPath[]>();
  const representativePathByEventId = new Map<string, BranchPath>();
  const visitLeaves = (node: TreeNode, path: BranchPath): BranchPath[] => {
    if (node.children.length === 0) {
      leafPaths.push(path);
      descendantPathsByEventId.set(node.event.id, [path]);
      representativePathByEventId.set(node.event.id, path);
      return [path];
    }

    const descendantPaths: BranchPath[] = [];
    for (const [index, child] of node.children.entries()) {
      const choice = node.event.choices![index]!;
      const choicePath: BranchPath = {
        decisions: [
          ...path.decisions,
          {
            atEventId: node.event.id,
            choiceId: choice.id,
            narrativeOrder: node.event.narrativeOrder,
          },
        ],
      };
      descendantPaths.push(...visitLeaves(child, choicePath));
    }
    descendantPathsByEventId.set(node.event.id, descendantPaths);
    representativePathByEventId.set(node.event.id, descendantPaths[0]!);
    return descendantPaths;
  };
  visitLeaves(rootNode, { decisions: [] });

  const eventScopes = new Map<string, BranchSet>();
  for (const event of events) {
    eventScopes.set(
      event.id,
      event.id === root.id
        ? { type: 'all' }
        : { type: 'paths', paths: descendantPathsByEventId.get(event.id)! },
    );
  }

  const choicesByEventId = new Map<string, readonly GameDialogueChoice[]>();
  const transitionEvents: NarrativeEvent[] = [];
  const emitTransitions = (node: TreeNode): void => {
    const choices = node.event.choices;
    if (!choices) return;
    choicesByEventId.set(node.event.id, choices);
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
