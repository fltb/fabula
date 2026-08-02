/**
 * GitAuthoringSubmitService — the single path by which accepted authoring
 * changes become Workbench Git history.
 *
 * Concurrent calls for the same `submitId` are serialized in-process: the
 * later call awaits the single in-flight run and replays its outcome, so no
 * second commit object can ever be created before the ref CAS.
 *
 * A submit is a typed request `{submitId, projectId, expectedGitHead,
 * expectedWorkingStateVector, manifest, entries, sourceHash, provenance}`.
 * The service runs, in order and only after every gate passes:
 *
 * 1. working-state-vector confirmation through the REQUIRED injected
 *    `confirmWorkingStateVector` callback — absence or failure rejects BEFORE
 *    any Git command runs;
 * 2. a read-only fixed-ref preflight (expected-head match, primary clean,
 *    controlled isolation) — a moved base is the terminal `stale` outcome, any
 *    other divergence fails closed with a typed error;
 * 3. journal recovery via {@link SubmitRecovery} — an existing receipt, stale
 *    or conflict outcome replays exactly (never a second commit or receipt),
 *    and `cas-pending` replays ONLY the ref CAS;
 * 4. Core candidate validation through the REQUIRED injected
 *    `validateCandidate` callback — failure rejects before any Git mutation;
 * 5. a manifest-gated tree built in a runner temporary index (`GIT_INDEX_FILE`
 *    seeded with `read-tree`, then `hash-object --no-filters` +
 *    `update-index --cacheinfo` + `write-tree`); the primary index and
 *    worktree are never staged through;
 * 6. `commit-tree` with sanitized non-secret trailers (`Submit-Id`,
 *    `Source-Hash`, `Actor-Id`, optional `Capability-Id`);
 * 7. `git update-ref <ref> <new> <expected>` compare-and-swap — the only
 *    acceptance point; a failed CAS is a typed terminal `conflict`;
 * 8. primary worktree sync (`reset --hard`) ONLY after the CAS succeeded;
 * 9. exactly one durable receipt via `SubmitJournalPort.complete`.
 *
 * No credentials, provider keys or other secrets ever enter the commit
 * message, the journal or the receipt.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  GitSubmissionJournal,
  GitSubmissionPhase,
  GitSubmissionReceipt,
} from '../../contracts/persistence.js';
import {
  type AuthoringEntry,
  AuthoringManifest,
  classifyAuthoringPath,
  ManifestValidationError,
} from './manifest.js';
import {
  normalizeSubmitJournal,
  receiptFromRecord,
  SUBMIT_PHASE_CONFLICT,
  SUBMIT_PHASE_STALE,
  type SubmitJournalPort,
  SubmitRecovery,
  type SubmitRecoveryProbe,
} from './recovery.js';
import {
  ControlledGitRunner,
  GitHostError,
  type GitRepositoryPreflight,
  type GitRunResult,
  WORKBENCH_AUTHORING_REF,
} from './runner.js';

/** Non-secret actor/capability provenance recorded in commit trailers. */
export interface AuthoringSubmitProvenance {
  /** Identity of the authenticated actor authoring the submit. */
  readonly actorId: string;
  /** Optional capability under which the actor submitted. */
  readonly capabilityId?: string;
}

export interface GitAuthoringSubmitRequest {
  /** Stable client id; the exact-once key of the durable journal. */
  readonly submitId: string;
  /** Non-secret project id recorded in journal rows and commit provenance. */
  readonly projectId: string;
  /** Full 40-hex commit the fixed ref must still point at (CAS old value). */
  readonly expectedGitHead: string;
  /** Yjs state vector the working copy must still match when the submit lands. */
  readonly expectedWorkingStateVector: Uint8Array;
  /** Per-submit staging authority; `validate(entries)` is the sole stage gate. */
  readonly manifest: AuthoringManifest;
  /** Manifest-approved author entries making up the candidate delta. */
  readonly entries: readonly AuthoringEntry[];
  /** Non-secret content hash of the candidate source. */
  readonly sourceHash: string;
  /** Non-secret actor/capability provenance recorded in commit trailers. */
  readonly provenance: AuthoringSubmitProvenance;
  /**
   * Host-internal reconciliation of a filesystem candidate. The candidate
   * must be a complete manifest tree that byte-matches the primary worktree;
   * ordinary browser/MCP working submits must never enable this path.
   */
  readonly externalReconciliation?: boolean;
}

/** Typed result of the injected working-state-vector confirmation. */
export type WorkingStateVectorConfirmation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Typed result of the injected Core candidate validation. */
export type CandidateValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/**
 * REQUIRED callback: confirms the live working state vector still matches the
 * request's `expectedWorkingStateVector` before any Git mutation. Absence or a
 * `ok: false` result rejects the submit before the first Git command.
 */
export type WorkingStateVectorConfirmer = (
  request: GitAuthoringSubmitRequest,
) => WorkingStateVectorConfirmation | Promise<WorkingStateVectorConfirmation>;

/**
 * REQUIRED callback: runs Core source validation over the candidate.
 * Absence or a `ok: false` result rejects the submit before any Git mutation.
 */
export type CandidateValidator = (
  request: GitAuthoringSubmitRequest,
) => CandidateValidationResult | Promise<CandidateValidationResult>;

export type AuthoringSubmitRejectionCode =
  | 'working-state-vector-unconfirmed'
  | 'candidate-invalid'
  | 'manifest-rejected';

/** Typed per-submit outcome; the single surface callers must handle. */
export type AuthoringSubmitOutcome =
  | { readonly kind: 'accepted'; readonly receipt: GitSubmissionReceipt }
  | { readonly kind: 'stale'; readonly reason: string }
  | { readonly kind: 'conflict'; readonly reason: string }
  | {
      readonly kind: 'rejected';
      readonly code: AuthoringSubmitRejectionCode;
      readonly reason: string;
    };

export interface GitAuthoringSubmitServiceOptions {
  /** The only Git authority; must be a controlled runner pinning the fixed identity. */
  readonly runner: ControlledGitRunner;
  /** Primary worktree / project root the fixed ref belongs to. */
  readonly projectRoot: string;
  /** Durable exact-once journal keyed by submitId (begin/checkpoint/complete). */
  readonly journal: SubmitJournalPort;
  /** Recovery engine over the same journal; defaults to a fresh SubmitRecovery. */
  readonly recovery?: SubmitRecovery;
  /** REQUIRED: confirms the live working state vector before any Git mutation. */
  readonly confirmWorkingStateVector: WorkingStateVectorConfirmer;
  /** REQUIRED: Core candidate validation; failure rejects before any Git mutation. */
  readonly validateCandidate: CandidateValidator;
  /** Fixed authoring ref; defaults to `refs/heads/workbench`. */
  readonly ref?: string;
  /** Injected clock for journal timestamps and the receipt; defaults to the ISO wall clock. */
  readonly now?: () => string;
}

/** Base class for all structured errors thrown by the submit service. */
export class GitAuthoringSubmitError extends GitHostError {}

/** Invalid submit input or service construction — thrown before any git command. */
export class AuthoringSubmitInputError extends GitAuthoringSubmitError {
  constructor(message: string) {
    super('git-submit-input-invalid', message);
  }
}

/** Repository-level divergence/isolation/clean failure the submit cannot resolve. */
export class AuthoringSubmitPreflightError extends GitAuthoringSubmitError {
  readonly preflight: GitRepositoryPreflight;
  constructor(preflight: GitRepositoryPreflight) {
    const failed = preflight.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.condition}: ${check.detail ?? 'failed'}`)
      .join('; ');
    super('git-submit-preflight-failed', `authoring submit preflight failed: ${failed}`);
    this.preflight = preflight;
  }
}

/** Journal/git state cannot be resolved safely; no commit or receipt may be produced. */
export class AuthoringSubmitRecoveryError extends GitAuthoringSubmitError {
  constructor(message: string) {
    super('git-submit-recovery-blocked', message);
  }
}

/** In-flight journal phases written between the begin and the terminal outcome. */
const SUBMIT_PHASE_LOCK_ACQUIRED = 'lock-acquired' satisfies GitSubmissionPhase;
const SUBMIT_PHASE_YJS_ACKED = 'yjs-acked' satisfies GitSubmissionPhase;
const SUBMIT_PHASE_CANDIDATE_VALIDATED = 'candidate-validated' satisfies GitSubmissionPhase;
const SUBMIT_PHASE_MANIFEST_REJECTED = 'manifest-rejected' satisfies GitSubmissionPhase;
const SUBMIT_PHASE_CANDIDATE_MATERIALIZED = 'candidate-materialized' satisfies GitSubmissionPhase;
const SUBMIT_PHASE_COMMIT_CREATED = 'commit-created' satisfies GitSubmissionPhase;
const SUBMIT_PHASE_REF_CAS = 'ref-cas' satisfies GitSubmissionPhase;
const SUBMIT_PHASE_PRIMARY_SYNCED = 'primary-synced' satisfies GitSubmissionPhase;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Replace control characters (U+0000–U+001F, U+007F) with spaces, then collapse whitespace so a value can never inject message content. */
function sanitizeTrailerValue(value: string): string {
  const sanitized = value
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (sanitized.length === 0) {
    throw new AuthoringSubmitInputError(
      `commit trailer value is empty after sanitization: ${JSON.stringify(value)}`,
    );
  }
  return sanitized;
}

/** Deterministic non-secret receipt fingerprint; excludes the acceptance timestamp. */
function computeReceiptHash(
  submitId: string,
  projectId: string,
  commit: string,
  sourceHash: string,
): string {
  return createHash('sha256')
    .update(`${submitId}\0${projectId}\0${commit}\0${sourceHash}`)
    .digest('hex');
}

export class GitAuthoringSubmitService {
  readonly #runner: ControlledGitRunner;
  readonly #root: string;
  readonly #ref: string;
  readonly #journal: SubmitJournalPort;
  readonly #recovery: SubmitRecovery;
  readonly #confirmWorkingStateVector: WorkingStateVectorConfirmer;
  readonly #validateCandidate: CandidateValidator;
  readonly #now: () => string;
  /**
   * In-flight submit runs keyed by submitId. A concurrent call for the same
   * submitId awaits the single run and replays its outcome instead of racing
   * a second commit; entries are removed as soon as the run settles.
   */
  readonly #inFlight = new Map<string, Promise<AuthoringSubmitOutcome>>();
  /** Serializes all primary-worktree preflight/CAS/sync runs for this service. */
  #repositoryTail: Promise<void> = Promise.resolve();
  constructor(options: GitAuthoringSubmitServiceOptions) {
    const root = resolve(options.projectRoot);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new AuthoringSubmitInputError(`project root is not an existing directory: ${root}`);
    }
    if (!(options.runner instanceof ControlledGitRunner)) {
      throw new AuthoringSubmitInputError(
        'runner must be a ControlledGitRunner (the only Git authority)',
      );
    }
    if (typeof options.confirmWorkingStateVector !== 'function') {
      throw new AuthoringSubmitInputError(
        'confirmWorkingStateVector callback is required: the working state vector must be verified before any Git mutation',
      );
    }
    if (typeof options.validateCandidate !== 'function') {
      throw new AuthoringSubmitInputError(
        'validateCandidate callback is required: Core candidate validation must pass before any Git mutation',
      );
    }
    const journal = options.journal;
    if (
      typeof journal !== 'object' ||
      journal === null ||
      typeof journal.load !== 'function' ||
      typeof journal.checkpoint !== 'function' ||
      typeof journal.complete !== 'function'
    ) {
      throw new AuthoringSubmitInputError(
        'journal must be a SubmitJournalPort exposing load/checkpoint/complete',
      );
    }
    const ref = options.ref ?? WORKBENCH_AUTHORING_REF;
    if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
      throw new AuthoringSubmitInputError(
        `fixed authoring ref must be a branch under refs/heads/: ${ref}`,
      );
    }
    this.#runner = options.runner;
    this.#root = root;
    this.#ref = ref;
    this.#journal = journal;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#recovery = options.recovery ?? new SubmitRecovery({ journal, now: this.#now });
    this.#confirmWorkingStateVector = options.confirmWorkingStateVector;
    this.#validateCandidate = options.validateCandidate;
  }

  /**
   * Submit one candidate exactly once. Concurrent calls for the same submitId
   * are serialized: the later call awaits the single in-flight run and replays
   * its outcome, so no second commit object can be created before the ref CAS.
   * An existing terminal journal outcome (accepted receipt, stale or conflict)
   * replays it; otherwise the full gated protocol runs. Never creates a second
   * commit or receipt for a submitId that already landed.
   */
  async submit(request: GitAuthoringSubmitRequest): Promise<AuthoringSubmitOutcome> {
    this.#assertValidRequest(request);
    const existing = this.#inFlight.get(request.submitId);
    if (existing !== undefined) return existing;
    const run = this.#enqueueRepository(() => this.#runSubmit(request));
    this.#inFlight.set(request.submitId, run);
    try {
      return await run;
    } finally {
      this.#inFlight.delete(request.submitId);
    }
  }

  /** Serialize repository-affecting runs, including distinct submit ids. */
  #enqueueRepository<T>(run: () => Promise<T>): Promise<T> {
    const slot = this.#repositoryTail.then(run, run);
    this.#repositoryTail = slot.then(
      () => undefined,
      () => undefined,
    );
    return slot;
  }

  /** The actual submit protocol; always entered under the repository lock. */
  async #runSubmit(request: GitAuthoringSubmitRequest): Promise<AuthoringSubmitOutcome> {
    const probe = await this.#probeGitState(request.submitId);
    const outcome = await this.#recovery.recover(request.submitId, probe);
    switch (outcome.kind) {
      case 'accepted':
        return this.#replayAccepted(request, outcome.receipt);
      case 'stale':
        return { kind: 'stale', reason: this.#staleReason(request) };
      case 'conflict':
        return { kind: 'conflict', reason: this.#conflictReason(request) };
      case 'in-progress':
        throw new AuthoringSubmitRecoveryError(
          `cannot resolve submit ${request.submitId}: journal and git state disagree; no commit may be created and no receipt fabricated`,
        );
      case 'cas-pending':
        return this.#replayCas(request);
      case 'proceed':
      case 'retry':
        return this.#runFreshSubmit(request);
    }
  }

  // --- retry/replay paths ----------------------------------------------------------

  /** Replay an already-accepted receipt; completes an interrupted primary sync only when the ref still points at the accepted commit. */
  async #replayAccepted(
    request: GitAuthoringSubmitRequest,
    receipt: GitSubmissionReceipt,
  ): Promise<AuthoringSubmitOutcome> {
    // Preflight without an expected head: the fixed ref may legitimately have
    // advanced past this receipt. The checks protect the primary worktree
    // before the idempotent sync below.
    const { preflight } = await this.#preflightFor(request, null);
    if (!preflight.ok) throw new AuthoringSubmitPreflightError(preflight);
    const head = (await this.#strict(['rev-parse', this.#ref])).stdout.trim();
    if (head === receipt.commit) {
      // Completes a sync interrupted between ref CAS and primary sync; a
      // no-op when the primary was already synced.
      await this.#strict(['reset', '--hard', receipt.commit]);
    }
    return { kind: 'accepted', receipt };
  }

  /** Replay ONLY the ref CAS for a commit that exists but never landed on the fixed ref. */
  async #replayCas(request: GitAuthoringSubmitRequest): Promise<AuthoringSubmitOutcome> {
    const record = await this.#journal.load(request.submitId);
    const normalized = record === null ? null : normalizeSubmitJournal(record);
    if (
      normalized === null ||
      normalized.candidateCommit == null ||
      normalized.receiptHash == null
    ) {
      throw new AuthoringSubmitRecoveryError(
        `cannot replay the ref CAS for submit ${request.submitId}: the journal lacks the candidate commit or receipt hash`,
      );
    }
    const { preflight, externalCandidateFailure } = await this.#preflightFor(
      request,
      normalized.expectedGitHead,
    );
    if (externalCandidateFailure !== null) {
      await this.#checkpointTerminal(
        request.submitId,
        request.projectId,
        normalized.expectedGitHead,
        SUBMIT_PHASE_CONFLICT,
        normalized.candidateCommit,
        normalized.receiptHash,
        externalCandidateFailure,
      );
      return { kind: 'conflict', reason: this.#conflictReason(request) };
    }
    if (!preflight.ok) {
      if (this.#isExpectedHeadMismatch(preflight)) {
        await this.#checkpointTerminal(
          request.submitId,
          request.projectId,
          normalized.expectedGitHead,
          SUBMIT_PHASE_CONFLICT,
          normalized.candidateCommit,
          normalized.receiptHash,
          `cas-pending replay: fixed ref ${this.#ref} moved from expected head ${normalized.expectedGitHead}`,
        );
        return { kind: 'conflict', reason: this.#conflictReason(request) };
      }
      throw new AuthoringSubmitPreflightError(preflight);
    }
    const cas = await this.#run([
      'update-ref',
      this.#ref,
      normalized.candidateCommit,
      normalized.expectedGitHead,
    ]);
    if (cas.exitCode !== 0) {
      await this.#checkpointTerminal(
        request.submitId,
        request.projectId,
        normalized.expectedGitHead,
        SUBMIT_PHASE_CONFLICT,
        normalized.candidateCommit,
        normalized.receiptHash,
        `ref CAS replay rejected: ${cas.stderr.trim()}`,
      );
      return { kind: 'conflict', reason: this.#conflictReason(request) };
    }
    await this.#strict(['reset', '--hard', normalized.candidateCommit]);
    const receipt = receiptFromRecord(normalized);
    if (receipt === null) {
      throw new AuthoringSubmitRecoveryError(
        `cannot build the receipt for submit ${request.submitId}`,
      );
    }
    const stored = await this.#journal.complete(receipt);
    return { kind: 'accepted', receipt: stored };
  }

  // --- fresh submit protocol -------------------------------------------------------

  async #runFreshSubmit(request: GitAuthoringSubmitRequest): Promise<AuthoringSubmitOutcome> {
    const checkpoint = (
      phase: GitSubmissionPhase,
      extra: {
        readonly candidateCommit?: string;
        readonly receiptHash?: string;
        readonly diagnostic?: string;
      } = {},
    ): Promise<GitSubmissionJournal> =>
      this.#journal.checkpoint({
        submitId: request.submitId,
        projectId: request.projectId,
        phase,
        expectedGitHead: request.expectedGitHead,
        ...(extra.candidateCommit != null ? { candidateCommit: extra.candidateCommit } : {}),
        ...(extra.receiptHash != null ? { receiptHash: extra.receiptHash } : {}),
        ...(extra.diagnostic != null ? { diagnostic: extra.diagnostic } : {}),
        updatedAt: this.#now(),
      });

    // Durable journal row before any further gate; a crash at any later point
    // replays to the same outcome instead of creating a second commit.
    await checkpoint(SUBMIT_PHASE_LOCK_ACQUIRED);

    // 1. Working-state vector confirmation (required callback).
    const vector = await this.#confirmWorkingStateVector(request);
    if (!vector.ok) {
      return { kind: 'rejected', code: 'working-state-vector-unconfirmed', reason: vector.reason };
    }
    await checkpoint(SUBMIT_PHASE_YJS_ACKED);

    // 2. Read-only fixed-ref preflight (expected-head match, primary clean,
    //    controlled isolation). A moved base is the terminal stale outcome;
    //    any other divergence fails closed before anything is written.
    const { preflight, externalCandidateFailure } = await this.#preflightFor(
      request,
      request.expectedGitHead,
    );
    if (externalCandidateFailure !== null) {
      await this.#checkpointTerminal(
        request.submitId,
        request.projectId,
        request.expectedGitHead,
        SUBMIT_PHASE_CONFLICT,
        undefined,
        undefined,
        externalCandidateFailure,
      );
      return { kind: 'conflict', reason: this.#conflictReason(request) };
    }
    if (!preflight.ok) {
      if (this.#isExpectedHeadMismatch(preflight)) {
        await this.#checkpointTerminal(
          request.submitId,
          request.projectId,
          request.expectedGitHead,
          SUBMIT_PHASE_STALE,
          undefined,
          undefined,
          `expected head ${request.expectedGitHead} no longer matches ${this.#ref}`,
        );
        return { kind: 'stale', reason: this.#staleReason(request) };
      }
      throw new AuthoringSubmitPreflightError(preflight);
    }

    // 3. Core candidate validation (required callback).
    const validation = await this.#validateCandidate(request);
    if (!validation.ok) {
      return { kind: 'rejected', code: 'candidate-invalid', reason: validation.reason };
    }
    await checkpoint(SUBMIT_PHASE_CANDIDATE_VALIDATED);

    // 4. Manifest-gated tree in a runner temporary index; the primary index
    //    and worktree are never staged through.
    let tree: string;
    try {
      request.manifest.validate(request.entries);
      tree = await this.#writeManifestTree(
        request.entries,
        request.expectedGitHead,
        request.externalReconciliation === true,
      );
    } catch (error) {
      if (error instanceof ManifestValidationError) {
        await checkpoint(SUBMIT_PHASE_MANIFEST_REJECTED, { diagnostic: error.message });
        return { kind: 'rejected', code: 'manifest-rejected', reason: error.message };
      }
      throw error;
    }
    await checkpoint(SUBMIT_PHASE_CANDIDATE_MATERIALIZED);

    // 5. Commit with sanitized non-secret trailers. The source hash rides in
    //    the journal diagnostic slot so any replay builds the identical
    //    receipt without refabricating it.
    const commit = await this.#createCommit(tree, request);
    const receiptHash = computeReceiptHash(
      request.submitId,
      request.projectId,
      commit,
      request.sourceHash,
    );
    await checkpoint(SUBMIT_PHASE_COMMIT_CREATED, {
      candidateCommit: commit,
      receiptHash,
      diagnostic: request.sourceHash,
    });

    // 6. Atomic ref compare-and-swap: the only acceptance point.
    // The primary was byte-checked before building the isolated tree. Check
    // again immediately before the acceptance CAS so a new handwritten change
    // is never silently overwritten by the post-CAS primary alignment.
    if (request.externalReconciliation === true) {
      const candidate = await this.#verifyExternalCandidate(request);
      if (!candidate.ok) {
        await this.#checkpointTerminal(
          request.submitId,
          request.projectId,
          request.expectedGitHead,
          SUBMIT_PHASE_CONFLICT,
          commit,
          receiptHash,
          candidate.detail,
        );
        return { kind: 'conflict', reason: this.#conflictReason(request) };
      }
    }

    const cas = await this.#run(['update-ref', this.#ref, commit, request.expectedGitHead]);
    if (cas.exitCode !== 0) {
      await this.#checkpointTerminal(
        request.submitId,
        request.projectId,
        request.expectedGitHead,
        SUBMIT_PHASE_CONFLICT,
        commit,
        receiptHash,
        `ref CAS rejected: ${cas.stderr.trim()}`,
      );
      return { kind: 'conflict', reason: this.#conflictReason(request) };
    }
    await checkpoint(SUBMIT_PHASE_REF_CAS, {
      candidateCommit: commit,
      receiptHash,
      diagnostic: request.sourceHash,
    });

    // 7. Primary sync only after the CAS succeeded.
    await this.#strict(['reset', '--hard', commit]);
    await checkpoint(SUBMIT_PHASE_PRIMARY_SYNCED, {
      candidateCommit: commit,
      receiptHash,
      diagnostic: request.sourceHash,
    });

    // 8. Exactly one durable receipt.
    const receipt: GitSubmissionReceipt = {
      submitId: request.submitId,
      projectId: request.projectId,
      commit,
      sourceHash: request.sourceHash,
      receiptHash,
      acceptedAt: this.#now(),
    };
    const stored = await this.#journal.complete(receipt);
    return { kind: 'accepted', receipt: stored };
  }

  // --- read-only git state ---------------------------------------------------------

  /** Read-only Git state for recovery: the fixed ref head and any commit carrying this submitId trailer. */
  async #probeGitState(submitId: string): Promise<SubmitRecoveryProbe> {
    const refRev = await this.#run(['rev-parse', '--verify', '--quiet', this.#ref]);
    const fixedRefHead =
      refRev.exitCode === 0 && refRev.stdout.trim().length > 0 ? refRev.stdout.trim() : null;

    let commitWithSubmitTrailer: string | null = null;
    const log = await this.#run([
      'log',
      '--format=%H',
      '--fixed-strings',
      '--grep',
      `Submit-Id: ${submitId}`,
      this.#ref,
    ]);
    if (log.exitCode === 0) {
      const first = log.stdout.split('\n').find((line) => line.trim().length > 0);
      commitWithSubmitTrailer = first === undefined ? null : first.trim();
    }

    if (commitWithSubmitTrailer === null) {
      // A commit created for this submitId but never CAS'd is unreachable from
      // any ref; the journal records its object id, so confirm the object
      // still exists. Recovery then replays only the ref CAS instead of
      // authorizing a second commit.
      const record = await this.#journal.load(submitId);
      const normalized = record === null ? null : normalizeSubmitJournal(record);
      if (normalized?.candidateCommit != null) {
        const exists = await this.#run(['cat-file', '-e', normalized.candidateCommit]);
        if (exists.exitCode === 0) commitWithSubmitTrailer = normalized.candidateCommit;
      }
    }
    return { fixedRefHead, commitWithSubmitTrailer };
  }

  /**
   * Strict preflight for one submission. External reconciliation is allowed
   * to replace only the otherwise-failing `primary-clean` check, and only
   * after the complete primary tree byte-matches the manifest candidate.
   */
  async #preflightFor(
    request: GitAuthoringSubmitRequest,
    expectedHead: string | null = request.expectedGitHead,
  ): Promise<{
    readonly preflight: GitRepositoryPreflight;
    readonly externalCandidateFailure: string | null;
  }> {
    const preflight = await this.#runner.preflightRepository({
      cwd: this.#root,
      ref: this.#ref,
      ...(expectedHead === null ? {} : { expectedHead }),
    });
    if (request.externalReconciliation !== true) {
      return { preflight, externalCandidateFailure: null };
    }
    const candidate = await this.#verifyExternalCandidate(request);
    if (!candidate.ok) {
      return {
        preflight: this.#replacePrimaryClean(
          preflight,
          false,
          `external candidate does not exactly match primary: ${candidate.detail}`,
        ),
        externalCandidateFailure: candidate.detail,
      };
    }
    return {
      preflight: this.#replacePrimaryClean(
        preflight,
        true,
        'primary worktree exactly matches the verified external manifest candidate',
      ),
      externalCandidateFailure: null,
    };
  }

  /** Replace only the primary-clean result after a strict external byte check. */
  #replacePrimaryClean(
    preflight: GitRepositoryPreflight,
    ok: boolean,
    detail: string,
  ): GitRepositoryPreflight {
    const checks = preflight.checks.map((check) =>
      check.condition === 'primary-clean' ? { ...check, ok, detail } : check,
    );
    return { ...preflight, checks, ok: checks.every((check) => check.ok) };
  }

  /**
   * Confirm that the dirty primary is precisely the captured full external
   * candidate: every candidate byte matches, every baseline omission is an
   * actual deletion, the baseline contains authoring paths only, and status
   * has neither staged nor unknown changes. New manifest-approved files are
   * permitted only when their bytes are present in the candidate.
   */
  async #verifyExternalCandidate(
    request: GitAuthoringSubmitRequest,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
    try {
      request.manifest.validate(request.entries);
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'manifest candidate is invalid',
      };
    }
    const candidateByPath = new Map(request.entries.map((entry) => [entry.path, entry]));
    const baseline = await this.#run([
      'ls-tree',
      '-r',
      '--name-only',
      request.expectedGitHead,
    ]);
    if (baseline.exitCode !== 0) {
      return { ok: false, detail: 'cannot read the expected Git baseline tree' };
    }
    const baselinePaths = baseline.stdout
      .split('\n')
      .map((path) => path.trim())
      .filter((path) => path.length > 0);
    for (const path of baselinePaths) {
      if (!classifyAuthoringPath(path).ok) {
        return { ok: false, detail: `expected Git baseline contains non-authoring path ${path}` };
      }
      if (!candidateByPath.has(path)) {
        try {
          readFileSync(join(this.#root, path));
          return {
            ok: false,
            detail: `external candidate omits existing baseline path ${path}`,
          };
        } catch {
          // Missing from both the candidate and primary is an explicit delete.
        }
      }
    }
    for (const entry of request.entries) {
      try {
        const primary = readFileSync(join(this.#root, entry.path));
        if (!primary.equals(Buffer.from(entry.bytes))) {
          return { ok: false, detail: `primary bytes differ for ${entry.path}` };
        }
      } catch {
        return { ok: false, detail: `primary file is missing for ${entry.path}` };
      }
    }
    const status = await this.#run(['status', '--porcelain=v1', '-z']);
    if (status.exitCode !== 0) {
      return { ok: false, detail: 'cannot inspect primary repository status' };
    }
    const records = status.stdout.split('\u0000').filter((record) => record.length > 0);
    for (const record of records) {
      if (record.length < 4 || record[2] !== ' ') {
        return { ok: false, detail: 'primary repository status is malformed' };
      }
      const indexStatus = record[0];
      const worktreeStatus = record[1];
      const path = record.slice(3);
      if (
        indexStatus === 'R' ||
        indexStatus === 'C' ||
        worktreeStatus === 'R' ||
        worktreeStatus === 'C'
      ) {
        return { ok: false, detail: `rename or copy status is not reconcilable for ${path}` };
      }
      if (indexStatus !== ' ') {
        return { ok: false, detail: `staged primary change is not reconcilable for ${path}` };
      }
      if (!candidateByPath.has(path) && !baselinePaths.includes(path)) {
        return { ok: false, detail: `unknown or untracked primary path ${path}` };
      }
      if (!classifyAuthoringPath(path).ok) {
        return { ok: false, detail: `non-authoring primary change at ${path}` };
      }
    }
    return { ok: true };
  }

  /**
   * A preflight whose only meaningful failure is `expected-head-match` means
   * the base moved externally: the submit can never CAS, so the terminal
   * stale outcome applies. Any other failing condition is a repository-level
   * divergence that must fail closed instead.
   */
  #isExpectedHeadMismatch(preflight: GitRepositoryPreflight): boolean {
    const failed = new Set(
      preflight.checks.filter((check) => !check.ok).map((check) => check.condition),
    );
    return (
      failed.has('expected-head-match') &&
      !failed.has('inside-work-tree') &&
      !failed.has('fixed-ref-present') &&
      !failed.has('head-on-fixed-ref') &&
      !failed.has('primary-clean') &&
      !failed.has('controlled-config') &&
      !failed.has('isolation-clean')
    );
  }

  // --- controlled invocation helpers -------------------------------------------------

  #run(args: readonly string[]): Promise<GitRunResult> {
    return this.#runner.run({ args, cwd: this.#root });
  }

  #strict(args: readonly string[], env?: Record<string, string>): Promise<GitRunResult> {
    return this.#runner.runStrict({ args, cwd: this.#root, ...(env === undefined ? {} : { env }) });
  }

  /** Manifest-gated tree: seed a temporary index, then stage the candidate. */
  async #writeManifestTree(
    entries: readonly AuthoringEntry[],
    expectedGitHead: string,
    removeMissingBaselineEntries: boolean,
  ): Promise<string> {
    const scratch = mkdtempSync(join(this.#runner.scratchDir, 'workbench-submit-'));
    try {
      const indexEnv = { GIT_INDEX_FILE: join(scratch, 'index') };
      await this.#strict(['read-tree', expectedGitHead], indexEnv);
      if (removeMissingBaselineEntries) {
        const candidatePaths = new Set(entries.map((entry) => entry.path));
        const baseline = await this.#strict(['ls-tree', '-r', '--name-only', expectedGitHead]);
        for (const path of baseline.stdout
          .split('\n')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)) {
          if (!candidatePaths.has(path)) {
            await this.#strict(['update-index', '--force-remove', '--', path], indexEnv);
          }
        }
      }
      for (let index = 0; index < entries.length; index += 1) {
        const item = entries[index];
        const blobFile = join(scratch, `blob-${index}`);
        writeFileSync(blobFile, item.bytes);
        const blob = (
          await this.#strict(['hash-object', '-w', '--no-filters', blobFile])
        ).stdout.trim();
        const mode = item.mode === 'executable' ? '100755' : '100644';
        await this.#strict(
          ['update-index', '--add', '--cacheinfo', `${mode},${blob},${item.path}`],
          indexEnv,
        );
      }
      return (await this.#strict(['write-tree'], indexEnv)).stdout.trim();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** Commit the tree on the expected head with sanitized non-secret trailers. */
  async #createCommit(tree: string, request: GitAuthoringSubmitRequest): Promise<string> {
    const subject = `chore(workbench): authoring submit ${sanitizeTrailerValue(request.submitId)}`;
    const body = [
      `Project: ${request.projectId}`,
      `Ref: ${this.#ref}`,
      `Entries: ${request.entries.length}`,
      'Workbench-Submit: true',
    ].join('\n');
    const trailers = [
      `Submit-Id: ${sanitizeTrailerValue(request.submitId)}`,
      `Source-Hash: ${sanitizeTrailerValue(request.sourceHash)}`,
      `Actor-Id: ${sanitizeTrailerValue(request.provenance.actorId)}`,
      ...(request.provenance.capabilityId != null
        ? [`Capability-Id: ${sanitizeTrailerValue(request.provenance.capabilityId)}`]
        : []),
    ].join('\n');
    const result = await this.#strict([
      'commit-tree',
      tree,
      '-p',
      request.expectedGitHead,
      '-m',
      subject,
      '-m',
      body,
      '-m',
      trailers,
    ]);
    return result.stdout.trim();
  }

  /** Record a terminal stale/conflict outcome; the persistence layer ignores it once the row is terminal. */
  async #checkpointTerminal(
    submitId: string,
    projectId: string,
    expectedGitHead: string,
    phase: typeof SUBMIT_PHASE_STALE | typeof SUBMIT_PHASE_CONFLICT,
    candidateCommit: string | undefined,
    receiptHash: string | undefined,
    diagnostic: string | undefined,
  ): Promise<void> {
    await this.#journal.checkpoint({
      submitId,
      projectId,
      phase,
      expectedGitHead,
      ...(candidateCommit != null ? { candidateCommit } : {}),
      ...(receiptHash != null ? { receiptHash } : {}),
      ...(diagnostic != null ? { diagnostic } : {}),
      updatedAt: this.#now(),
    });
  }

  #staleReason(request: GitAuthoringSubmitRequest): string {
    return `submit ${request.submitId} cannot land: fixed ref ${this.#ref} no longer points at expected head ${request.expectedGitHead}`;
  }

  #conflictReason(request: GitAuthoringSubmitRequest): string {
    return `submit ${request.submitId} is conflicted: the ref CAS at ${this.#ref} cannot be resolved (external divergence or ambiguous submitId)`;
  }

  /** Reject malformed requests before any Git or journal access. */
  #assertValidRequest(request: GitAuthoringSubmitRequest): void {
    const fail = (message: string): never => {
      throw new AuthoringSubmitInputError(message);
    };
    if (typeof request !== 'object' || request === null) fail('submit request must be an object');
    if (
      typeof request.submitId !== 'string' ||
      request.submitId.length === 0 ||
      hasControlCharacter(request.submitId)
    ) {
      fail('submitId must be a non-empty string without control characters');
    }
    if (
      typeof request.projectId !== 'string' ||
      request.projectId.length === 0 ||
      hasControlCharacter(request.projectId)
    ) {
      fail('projectId must be a non-empty string without control characters');
    }
    if (!/^[0-9a-f]{40}$/.test(request.expectedGitHead)) {
      fail('expectedGitHead must be a full 40-hex commit object id');
    }
    if (!(request.expectedWorkingStateVector instanceof Uint8Array)) {
      fail('expectedWorkingStateVector must be a Uint8Array');
    }
    if (!(request.manifest instanceof AuthoringManifest)) {
      fail('manifest must be an AuthoringManifest');
    }
    if (!Array.isArray(request.entries) || request.entries.length === 0) {
      fail('entries must be a non-empty array of AuthoringEntry');
    }
    if (
      typeof request.sourceHash !== 'string' ||
      request.sourceHash.length === 0 ||
      hasControlCharacter(request.sourceHash)
    ) {
      fail('sourceHash must be a non-empty string without control characters');
    }
    if (
      typeof request.provenance !== 'object' ||
      request.provenance === null ||
      typeof request.provenance.actorId !== 'string' ||
      request.provenance.actorId.length === 0 ||
      hasControlCharacter(request.provenance.actorId)
    ) {
      fail('provenance.actorId must be a non-empty string without control characters');
    }
    if (
      request.externalReconciliation !== undefined &&
      typeof request.externalReconciliation !== 'boolean'
    ) {
      fail('externalReconciliation must be a boolean when supplied');
    }
    if (
      request.provenance.capabilityId != null &&
      (typeof request.provenance.capabilityId !== 'string' ||
        request.provenance.capabilityId.length === 0 ||
        hasControlCharacter(request.provenance.capabilityId))
    ) {
      fail('provenance.capabilityId must be a non-empty string without control characters');
    }
  }
}
