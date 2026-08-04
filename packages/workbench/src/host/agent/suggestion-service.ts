/**
 * Host-only Agent suggestion service: proposal-only, revision-bound diff
 * suggestions composed from editor context (logical document identifier,
 * selection, and the stable working-layer state vector).
 *
 * The pipeline is strictly two-phase:
 *
 *  1. `generate` reads nothing but the working layer (human-presence check,
 *     state-vector CAS against the editor's base vector), runs the provider
 *     task, and parses the response into a strict, reviewable span-edit list.
 *     The result is a PROPOSAL only — no document, file, Core, or Git state
 *     is ever written, and the suggestion is bound to the exact base vector
 *     and base-text hash it was composed against.
 *
 *  2. `applySuggestion` is the explicit human apply path. It re-verifies the
 *     suggestion's integrity (hash binding), re-verifies the caller's text
 *     against the base-text hash, materializes the edits through an injected
 *     Yjs update builder, and then delegates ENTIRELY to
 *     {@link AgentCommandService.applyEffect}, which re-validates the
 *     capability grant and applies with atomic human-presence and vector CAS
 *     semantics. Pause and stale-vector stay typed outcomes at every stage.
 *
 * This service never writes source files, Core accepted source, or Git, and
 * never touches tokens, keys, or absolute paths. All document mechanics are
 * injected (document port, task provider, presence port, update
 * materializer), so the integration owner wires the real Yjs adapter exactly
 * once.
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentCommandService,
  AgentDocumentPort,
  AgentEditEffectResult,
  AgentPresencePort,
} from './edit-service.js';
import {
  type AgentTaskRequest,
  type AgentTaskService,
  errorCodeOf,
  errorMessageOf,
} from './task-service.js';

/** Version of the suggestion contract. */
export const AGENT_SUGGESTION_CONTRACT_VERSION = 1 as const;

/** Default cap on the document text a suggestion may address (fail closed beyond). */
export const AGENT_SUGGESTION_MAX_DOCUMENT_CHARACTERS = 64_000;
/** Default cap on the instruction length. */
export const AGENT_SUGGESTION_MAX_INSTRUCTION_CHARACTERS = 4_000;
/** Default cap on one change's replacement text. */
export const AGENT_SUGGESTION_MAX_CHANGE_TEXT_CHARACTERS = 8_192;
/** Default cap on the number of changes in one suggestion. */
export const AGENT_SUGGESTION_MAX_CHANGES = 256;
/** Default deterministic-ish sampling temperature for suggestion tasks. */
export const AGENT_SUGGESTION_DEFAULT_TEMPERATURE = 0.2;

/** Zero-based character selection in the working document text at the base vector. */
export interface AgentTextSelectionV1 {
  readonly from: number;
  readonly to: number;
}

/**
 * One strict, reviewable span replacement in the working document text at the
 * base vector. `text` empty deletes the span; `length` 0 inserts `text` at
 * `from`. Changes are sorted by `from` ascending and never overlap, so a
 * review UI can render them as a block diff and the materializer can walk
 * them deterministically.
 */
export interface AgentSuggestionChangeV1 {
  readonly from: number;
  readonly length: number;
  readonly text: string;
}

/**
 * One revision-bound proposal. The suggestion is self-verifying: the
 * `suggestionHash` binds the identity, the base vector, and the exact
 * document text (via `baseTextHash`) the offsets address, so a stale or
 * tampered proposal cannot be applied against different content.
 */
export interface AgentSuggestionV1 {
  readonly version: typeof AGENT_SUGGESTION_CONTRACT_VERSION;
  readonly suggestionId: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly sceneId?: string;
  /** Working-layer state vector the suggestion was composed against (read-time truth). */
  readonly baseVector: Uint8Array;
  /** SHA-256 hex of the exact document text the change offsets address. */
  readonly baseTextHash: string;
  readonly selection: AgentTextSelectionV1;
  readonly changes: readonly AgentSuggestionChangeV1[];
  readonly generatedAt: string;
  /** SHA-256 hex over the stable suggestion serialization (integrity binding). */
  readonly suggestionHash: string;
}

/** Editor context for one suggestion request. */
export interface AgentSuggestionInput {
  readonly projectId: string;
  readonly documentId: string;
  readonly sceneId?: string;
  /** The working document text at `baseVector`; change offsets are relative to it. */
  readonly documentText: string;
  /** The stable working-layer state vector the editor read (read-time truth). */
  readonly baseVector: Uint8Array;
  readonly selection: AgentTextSelectionV1;
  readonly instruction: string;
}

/** Typed outcome of a suggestion generation. Proposals are review-only. */
export type AgentSuggestionResult =
  | { readonly status: 'proposal'; readonly suggestion: AgentSuggestionV1 }
  | {
      readonly status: 'paused';
      readonly reason: 'human-presence';
      readonly projectId: string;
      readonly documentId: string;
      readonly sceneId?: string;
      /** Live document state vector to replan against; null when the document has no state yet. */
      readonly liveStateVector: Uint8Array | null;
      readonly replanRequired: true;
    }
  | {
      readonly status: 'stale';
      readonly reason: 'stale-vector';
      readonly projectId: string;
      readonly documentId: string;
      readonly liveStateVector: Uint8Array;
    }
  | { readonly status: 'failed'; readonly errorCode: string; readonly message: string };

/** Explicit human apply of one proposal; the effect surface is the existing AgentCommandService. */
export interface AgentSuggestionApplyInput {
  readonly suggestion: AgentSuggestionV1;
  /** The working document text at the suggestion's base vector; must match `baseTextHash`. */
  readonly documentText: string;
  /** Opaque server-side grant id; actor and scope truth come from the persisted grant. */
  readonly capabilityId: string;
  /** Capability scope required for this effect; validated against the grant before running. */
  readonly scope: readonly string[];
  /** Version binding; a persisted grant version different from this fails the gate. */
  readonly expectedVersion?: number;
  /**
   * Materializes the strict changes into the scoped Yjs update the document
   * port applies. The implementation owns the Yjs mechanics; this service
   * only ever sees opaque bytes.
   */
  readonly materialize: (input: {
    readonly projectId: string;
    readonly documentId: string;
    readonly baseText: string;
    readonly changes: readonly AgentSuggestionChangeV1[];
  }) => Uint8Array | Promise<Uint8Array>;
}

/** Assembles a strict provider task from suggestion context; injectable for excerpt-based flows. */
export interface AgentSuggestionPromptPort {
  build(input: {
    readonly projectId: string;
    readonly documentId: string;
    readonly sceneId?: string;
    readonly documentText: string;
    readonly selection: AgentTextSelectionV1;
    readonly instruction: string;
  }): AgentTaskRequest;
}

export interface DefaultSuggestionPromptOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export interface AgentSuggestionServiceOptions {
  /** Working-layer document reads (state vectors); never a mutation surface here. */
  readonly documents: AgentDocumentPort;
  /** Strict provider execution boundary. */
  readonly tasks: AgentTaskService;
  /** The existing capability/presence/vector-gated effect service; the ONLY apply path. */
  readonly command: AgentCommandService;
  /** Document/scene-scoped human-presence resolution; required so generation pauses fail closed. */
  readonly presence: AgentPresencePort;
  /** Prompt assembler; defaults to the strict diff-format assembler. */
  readonly prompt?: AgentSuggestionPromptPort;
  /** Suggestion id source; defaults to a fresh random id per proposal. */
  readonly newSuggestionId?: () => string;
  readonly maxDocumentCharacters?: number;
  readonly maxInstructionCharacters?: number;
}

/** Malformed caller input (unknown fields, bad shapes); no provider call or effect was produced. */
export class AgentSuggestionInputError extends Error {
  override readonly name = 'AgentSuggestionInputError';
}

const GENERATE_FIELDS = [
  'projectId',
  'documentId',
  'sceneId',
  'documentText',
  'baseVector',
  'selection',
  'instruction',
] as const;
const APPLY_FIELDS = [
  'suggestion',
  'documentText',
  'capabilityId',
  'scope',
  'expectedVersion',
  'materialize',
] as const;

const SYSTEM_PROMPT = `You are an expert editor working on a Fabula narrative project document (YAML or prose).
Propose ONLY minimal, surgical text edits. Your entire response must be a single JSON array where every
element is an object with exactly the fields:
- "from": integer, zero-based character offset into the provided document text
- "length": integer >= 0, number of characters to remove starting at "from"
- "text": string, replacement text for the removed span (empty string deletes the span)
An insertion is length 0 with non-empty text; a deletion is length > 0 with empty text.
Rules:
- offsets must never exceed the document length (from + length <= document length)
- list edits in ascending "from" order and never overlap
- never invent structure the document does not support; preserve surrounding content
- respond with the JSON array only: no prose, no markdown, no code fences`;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Stable canonical serialization hash for one suggestion. Recomputable from
 * any suggestion value, so `applySuggestion` can verify the proposal was not
 * mutated between review and apply.
 */
export function suggestionHashOf(suggestion: {
  readonly suggestionId: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly baseVector: Uint8Array;
  readonly baseTextHash: string;
  readonly selection: AgentTextSelectionV1;
  readonly changes: readonly AgentSuggestionChangeV1[];
}): string {
  const canonical = JSON.stringify({
    version: AGENT_SUGGESTION_CONTRACT_VERSION,
    suggestionId: suggestion.suggestionId,
    projectId: suggestion.projectId,
    documentId: suggestion.documentId,
    baseVectorHex: Buffer.from(suggestion.baseVector).toString('hex'),
    baseTextHash: suggestion.baseTextHash,
    selection: { from: suggestion.selection.from, to: suggestion.selection.to },
    changes: suggestion.changes.map((change) => ({
      from: change.from,
      length: change.length,
      text: change.text,
    })),
  });
  return sha256Hex(canonical);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseChange(
  value: unknown,
  maxChangeTextCharacters: number,
): AgentSuggestionChangeV1 | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes('from') ||
    !keys.includes('length') ||
    !keys.includes('text')
  ) {
    return null;
  }
  const from = value.from;
  const length = value.length;
  const text = value.text;
  if (
    typeof from !== 'number' ||
    !Number.isInteger(from) ||
    from < 0 ||
    typeof length !== 'number' ||
    !Number.isInteger(length) ||
    length < 0 ||
    typeof text !== 'string' ||
    text.length > maxChangeTextCharacters
  ) {
    return null;
  }
  return { from, length, text };
}

/**
 * Strict parser for a provider diff response. Accepts a plain JSON array of
 * `{from, length, text}` objects (optionally wrapped in one code fence) and
 * enforces exact fields, integer bounds, per-change text caps, a change
 * count cap, ascending `from` order, and non-overlapping spans. Returns null
 * on any deviation — never a partial suggestion.
 */
export function parseSuggestionChanges(
  text: string,
  options: { readonly maxChangeTextCharacters?: number; readonly maxChanges?: number } = {},
): AgentSuggestionChangeV1[] | null {
  const maxChangeText =
    options.maxChangeTextCharacters ?? AGENT_SUGGESTION_MAX_CHANGE_TEXT_CHARACTERS;
  const maxChanges = options.maxChanges ?? AGENT_SUGGESTION_MAX_CHANGES;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  const candidate = fenced === null ? trimmed : fenced[1];
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > maxChanges) return null;
  const changes: AgentSuggestionChangeV1[] = [];
  let previousFrom = -1;
  let previousEnd = -1;
  for (const element of parsed) {
    const change = parseChange(element, maxChangeText);
    if (change === null) return null;
    // Strictly ascending `from` (equal offsets are ambiguous) and non-overlap.
    if (change.from <= previousFrom || change.from < previousEnd) return null;
    previousFrom = change.from;
    previousEnd = change.from + change.length;
    changes.push(change);
  }
  return changes;
}

/** True when every change's span lies within the addressed document text. */
export function validateSuggestionChanges(
  changes: readonly AgentSuggestionChangeV1[],
  documentLength: number,
): boolean {
  return changes.every(
    (change) => change.from >= 0 && change.from + change.length <= documentLength,
  );
}

/** Default strict diff-format prompt assembler. */
export function createDefaultSuggestionPrompt(
  options: DefaultSuggestionPromptOptions = {},
): AgentSuggestionPromptPort {
  const temperature = options.temperature ?? AGENT_SUGGESTION_DEFAULT_TEMPERATURE;
  return {
    build(input) {
      const { documentId, documentText, selection, instruction } = input;
      const user = [
        `Document: ${documentId}`,
        `Selection: characters ${selection.from} to ${selection.to} of ${documentText.length}`,
        '',
        '--- document start ---',
        documentText,
        '--- document end ---',
        '',
        `Instruction: ${instruction}`,
        '',
        'Respond with ONLY the JSON edit array.',
      ].join('\n');
      return {
        system: SYSTEM_PROMPT,
        user,
        ...(options.model === undefined ? {} : { model: options.model }),
        temperature,
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      };
    },
  };
}

/**
 * Proposal-only suggestion pipeline over injected document, presence, task,
 * and effect ports. Construct once per Host process and share.
 */
export class AgentSuggestionService {
  readonly #documents: AgentDocumentPort;
  readonly #tasks: AgentTaskService;
  readonly #command: AgentCommandService;
  readonly #presence: AgentPresencePort;
  readonly #prompt: AgentSuggestionPromptPort;
  readonly #newSuggestionId: () => string;
  readonly #maxDocumentCharacters: number;
  readonly #maxInstructionCharacters: number;

  constructor(options: AgentSuggestionServiceOptions) {
    const documents = options.documents;
    if (
      documents === null ||
      typeof documents !== 'object' ||
      typeof documents.load !== 'function'
    ) {
      throw new TypeError('AgentSuggestionService requires an injected AgentDocumentPort (load)');
    }
    const tasks = options.tasks;
    if (tasks === null || typeof tasks !== 'object' || typeof tasks.run !== 'function') {
      throw new TypeError('AgentSuggestionService requires an injected AgentTaskService (run)');
    }
    const command = options.command;
    if (
      command === null ||
      typeof command !== 'object' ||
      typeof command.applyEffect !== 'function'
    ) {
      throw new TypeError(
        'AgentSuggestionService requires an injected AgentCommandService (applyEffect)',
      );
    }
    const presence = options.presence;
    if (
      presence === null ||
      typeof presence !== 'object' ||
      typeof presence.isHumanEditing !== 'function'
    ) {
      throw new TypeError(
        'AgentSuggestionService requires an injected AgentPresencePort (isHumanEditing); ' +
          'generation pauses fail closed',
      );
    }
    const prompt = options.prompt;
    if (
      prompt !== undefined &&
      (prompt === null || typeof prompt !== 'object' || typeof prompt.build !== 'function')
    ) {
      throw new TypeError('AgentSuggestionService prompt port must implement build');
    }
    const maxDocument = options.maxDocumentCharacters ?? AGENT_SUGGESTION_MAX_DOCUMENT_CHARACTERS;
    if (!Number.isInteger(maxDocument) || maxDocument <= 0) {
      throw new TypeError('maxDocumentCharacters must be a positive integer');
    }
    const maxInstruction =
      options.maxInstructionCharacters ?? AGENT_SUGGESTION_MAX_INSTRUCTION_CHARACTERS;
    if (!Number.isInteger(maxInstruction) || maxInstruction <= 0) {
      throw new TypeError('maxInstructionCharacters must be a positive integer');
    }
    this.#documents = documents;
    this.#tasks = tasks;
    this.#command = command;
    this.#presence = presence;
    this.#prompt = prompt ?? createDefaultSuggestionPrompt();
    this.#newSuggestionId = options.newSuggestionId ?? randomUUID;
    this.#maxDocumentCharacters = maxDocument;
    this.#maxInstructionCharacters = maxInstruction;
  }

  /**
   * Generate one reviewable proposal. Never writes anything: presence pause
   * and stale-vector are typed outcomes, the provider task is executed
   * strictly, and the parsed diff is bound to the base vector and base-text
   * hash. An invalid or unparseable provider response is a typed `failed`
   * result, never a proposal.
   */
  async generate(input: AgentSuggestionInput): Promise<AgentSuggestionResult> {
    this.#validateGenerateInput(input);
    const { projectId, documentId, sceneId, documentText, baseVector, selection, instruction } =
      input;
    try {
      if (documentText.length > this.#maxDocumentCharacters) {
        return {
          status: 'failed',
          errorCode: 'agent.suggestion.input-too-large',
          message:
            `Document text exceeds the ${this.#maxDocumentCharacters} character ` +
            'suggestion limit.',
        };
      }
      if (instruction.length > this.#maxInstructionCharacters) {
        return {
          status: 'failed',
          errorCode: 'agent.suggestion.instruction-too-long',
          message: `Instruction exceeds the ${this.#maxInstructionCharacters} character limit.`,
        };
      }
      const humanEditing = await this.#presence.isHumanEditing({
        projectId,
        documentId,
        ...(sceneId === undefined ? {} : { sceneId }),
      });
      if (humanEditing) {
        return {
          status: 'paused',
          reason: 'human-presence',
          projectId,
          documentId,
          ...(sceneId === undefined ? {} : { sceneId }),
          liveStateVector: await this.#loadStateVector(projectId, documentId),
          replanRequired: true,
        };
      }
      const live = await this.#documents.load({ projectId, documentId });
      const liveVector = live?.stateVector ?? new Uint8Array(0);
      if (
        liveVector.length !== baseVector.length ||
        !liveVector.every((byte, index) => baseVector[index] === byte)
      ) {
        return {
          status: 'stale',
          reason: 'stale-vector',
          projectId,
          documentId,
          liveStateVector: liveVector,
        };
      }
      const request = this.#prompt.build({
        projectId,
        documentId,
        ...(sceneId === undefined ? {} : { sceneId }),
        documentText,
        selection,
        instruction,
      });
      const task = await this.#tasks.run(request);
      if (task.status === 'failed') {
        return { status: 'failed', errorCode: task.errorCode, message: task.message };
      }
      const changes = parseSuggestionChanges(task.content);
      if (changes === null || !validateSuggestionChanges(changes, documentText.length)) {
        return {
          status: 'failed',
          errorCode: 'agent.suggestion.invalid-response',
          message: 'Provider response did not parse as a strict, in-bounds edit array.',
        };
      }
      const suggestionId = this.#newSuggestionId();
      const baseTextHash = sha256Hex(documentText);
      const suggestion: AgentSuggestionV1 = {
        version: AGENT_SUGGESTION_CONTRACT_VERSION,
        suggestionId,
        projectId,
        documentId,
        ...(sceneId === undefined ? {} : { sceneId }),
        baseVector,
        baseTextHash,
        selection,
        changes,
        generatedAt: new Date().toISOString(),
        suggestionHash: suggestionHashOf({
          suggestionId,
          projectId,
          documentId,
          baseVector,
          baseTextHash,
          selection,
          changes,
        }),
      };
      return { status: 'proposal', suggestion };
    } catch (error) {
      return { status: 'failed', errorCode: errorCodeOf(error), message: errorMessageOf(error) };
    }
  }

  /**
   * Explicit human apply of one proposal. Re-verifies the suggestion's hash
   * binding and the caller's text against `baseTextHash`, then delegates the
   * effect to {@link AgentCommandService.applyEffect} — the capability gate,
   * atomic human-presence guard, and vector CAS all re-run there. Paused,
   * conflict, denied, and failed stay typed outcomes; nothing is applied
   * otherwise.
   */
  async applySuggestion(input: AgentSuggestionApplyInput): Promise<AgentEditEffectResult> {
    this.#validateApplyInput(input);
    const { suggestion, documentText, capabilityId, scope, expectedVersion, materialize } = input;
    try {
      this.#validateSuggestionShape(suggestion);
      if (suggestionHashOf(suggestion) !== suggestion.suggestionHash) {
        return {
          status: 'failed',
          errorCode: 'agent.suggestion.integrity-mismatch',
          message: 'Suggestion hash no longer matches its contents; re-generate the proposal.',
        };
      }
      if (sha256Hex(documentText) !== suggestion.baseTextHash) {
        return {
          status: 'failed',
          errorCode: 'agent.suggestion.base-text-mismatch',
          message:
            'Provided document text does not match the suggestion base; re-read and re-propose.',
        };
      }
      if (!validateSuggestionChanges(suggestion.changes, documentText.length)) {
        return {
          status: 'failed',
          errorCode: 'agent.suggestion.invalid-changes',
          message: 'Suggestion changes fall outside the addressed document text.',
        };
      }
      const update = await materialize({
        projectId: suggestion.projectId,
        documentId: suggestion.documentId,
        baseText: documentText,
        changes: suggestion.changes,
      });
      if (!(update instanceof Uint8Array)) {
        return {
          status: 'failed',
          errorCode: 'agent.suggestion.materialize-invalid',
          message: 'Suggestion materializer did not return a Yjs update.',
        };
      }
      return await this.#command.applyEffect({
        documentId: suggestion.documentId,
        ...(suggestion.sceneId === undefined ? {} : { sceneId: suggestion.sceneId }),
        capabilityId,
        scope,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        expectedBaseVector: suggestion.baseVector,
        update,
      });
    } catch (error) {
      return { status: 'failed', errorCode: errorCodeOf(error), message: errorMessageOf(error) };
    }
  }

  async #loadStateVector(projectId: string, documentId: string): Promise<Uint8Array | null> {
    try {
      const state = await this.#documents.load({ projectId, documentId });
      return state?.stateVector ?? null;
    } catch {
      // Best-effort: the paused outcome still requires a replan either way.
      return null;
    }
  }

  #validateGenerateInput(input: AgentSuggestionInput): void {
    if (input === null || typeof input !== 'object') {
      throw new AgentSuggestionInputError(
        'AgentSuggestionService requires a suggestion input object.',
      );
    }
    for (const key of Object.keys(input)) {
      if (!GENERATE_FIELDS.includes(key as (typeof GENERATE_FIELDS)[number])) {
        throw new AgentSuggestionInputError(
          `Unknown field "${key}" passed to AgentSuggestionService.generate; ` +
            'suggestions are strict.',
        );
      }
    }
    if (typeof input.projectId !== 'string' || input.projectId.length === 0) {
      throw new AgentSuggestionInputError('projectId must be a non-empty string.');
    }
    if (typeof input.documentId !== 'string' || input.documentId.length === 0) {
      throw new AgentSuggestionInputError('documentId must be a non-empty string.');
    }
    if (
      input.sceneId !== undefined &&
      (typeof input.sceneId !== 'string' || input.sceneId.length === 0)
    ) {
      throw new AgentSuggestionInputError('sceneId must be a non-empty string when provided.');
    }
    if (typeof input.documentText !== 'string') {
      throw new AgentSuggestionInputError('documentText must be a string.');
    }
    if (!(input.baseVector instanceof Uint8Array)) {
      throw new AgentSuggestionInputError('baseVector must be a Uint8Array.');
    }
    this.#validateSelection(input.selection, input.documentText.length);
    if (typeof input.instruction !== 'string' || input.instruction.length === 0) {
      throw new AgentSuggestionInputError('instruction must be a non-empty string.');
    }
  }

  #validateSelection(selection: AgentTextSelectionV1, documentLength: number): void {
    if (selection === null || typeof selection !== 'object') {
      throw new AgentSuggestionInputError('selection is required.');
    }
    const from = selection.from;
    const to = selection.to;
    if (
      !Number.isInteger(from) ||
      from < 0 ||
      !Number.isInteger(to) ||
      to < from ||
      to > documentLength
    ) {
      throw new AgentSuggestionInputError(
        'selection must satisfy 0 <= from <= to <= documentText.length.',
      );
    }
  }

  #validateApplyInput(input: AgentSuggestionApplyInput): void {
    if (input === null || typeof input !== 'object') {
      throw new AgentSuggestionInputError('AgentSuggestionService requires an apply input object.');
    }
    for (const key of Object.keys(input)) {
      if (!APPLY_FIELDS.includes(key as (typeof APPLY_FIELDS)[number])) {
        throw new AgentSuggestionInputError(
          `Unknown field "${key}" passed to AgentSuggestionService.applySuggestion; ` +
            'applies are strict.',
        );
      }
    }
    if (typeof input.documentText !== 'string') {
      throw new AgentSuggestionInputError('documentText must be a string.');
    }
    if (typeof input.capabilityId !== 'string' || input.capabilityId.length === 0) {
      throw new AgentSuggestionInputError('capabilityId must be a non-empty string.');
    }
    if (!Array.isArray(input.scope) || input.scope.length === 0) {
      throw new AgentSuggestionInputError('at least one scope is required.');
    }
    if (
      input.expectedVersion !== undefined &&
      (!Number.isInteger(input.expectedVersion) || input.expectedVersion <= 0)
    ) {
      throw new AgentSuggestionInputError(
        'expectedVersion must be a positive integer when provided.',
      );
    }
    if (typeof input.materialize !== 'function') {
      throw new AgentSuggestionInputError(
        'a materialize function is required to build the scoped Yjs update.',
      );
    }
  }

  #validateSuggestionShape(suggestion: AgentSuggestionV1): void {
    if (suggestion === null || typeof suggestion !== 'object') {
      throw new AgentSuggestionInputError('suggestion is required.');
    }
    if (suggestion.version !== AGENT_SUGGESTION_CONTRACT_VERSION) {
      throw new AgentSuggestionInputError('suggestion version must be 1.');
    }
    if (typeof suggestion.suggestionId !== 'string' || suggestion.suggestionId.length === 0) {
      throw new AgentSuggestionInputError('suggestionId must be a non-empty string.');
    }
    if (typeof suggestion.projectId !== 'string' || suggestion.projectId.length === 0) {
      throw new AgentSuggestionInputError('suggestion projectId must be a non-empty string.');
    }
    if (typeof suggestion.documentId !== 'string' || suggestion.documentId.length === 0) {
      throw new AgentSuggestionInputError('suggestion documentId must be a non-empty string.');
    }
    if (!(suggestion.baseVector instanceof Uint8Array)) {
      throw new AgentSuggestionInputError('suggestion baseVector must be a Uint8Array.');
    }
    if (
      typeof suggestion.baseTextHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(suggestion.baseTextHash)
    ) {
      throw new AgentSuggestionInputError('suggestion baseTextHash must be a 64-char hex hash.');
    }
    if (
      typeof suggestion.suggestionHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(suggestion.suggestionHash)
    ) {
      throw new AgentSuggestionInputError('suggestion suggestionHash must be a 64-char hex hash.');
    }
    if (!Array.isArray(suggestion.changes)) {
      throw new AgentSuggestionInputError('suggestion changes must be an array.');
    }
  }
}

/**
 * Create one AgentSuggestionService. Fails closed on missing injected ports:
 * a suggestion surface must never exist without document reads, a provider,
 * the effect service, and working presence semantics.
 */
export function createAgentSuggestionService(
  options: AgentSuggestionServiceOptions,
): AgentSuggestionService {
  return new AgentSuggestionService(options);
}
