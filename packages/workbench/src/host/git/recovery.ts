/**
 * Deterministic submit recovery for the Workbench Git authoring boundary.
 *
 * Recovery never runs Git and never creates a commit. The single Git path is
 * the submit service's controlled runner; this module only receives read-only
 * Git state through an injected {@link SubmitRecoveryProbe}. Given the durable
 * journal record for a `submitId` plus the probed Git state, recovery returns
 * one of a small set of typed outcomes:
 *
 * - `proceed` — no journal record exists; a fresh submit may start.
 * - `accepted` — a prior accepted receipt exists (or the probed commit landed);
 *   the SAME receipt is returned on every retry.
 * - `stale` / `conflict` — the same typed terminal outcome the journal already
 *   recorded (or that the probe proves) is returned on every retry.
 * - `retry` — nothing with this `submitId` ever landed and the base ref is
 *   unchanged, so the full submit protocol may run once more; exactly one
 *   commit can result.
 * - `cas-pending` — our commit object exists but the fixed ref has not moved;
 *   only the ref CAS may be replayed (no second commit).
 * - `in-progress` — the state cannot be resolved safely; no commit may be
 *   created and no receipt fabricated.
 *
 * The journal is the single durable record keyed by `submitId`; completed rows
 * are immutable at the persistence layer, so a lookup after a restart returns
 * the same receipt or the same typed terminal outcome.
 */

import type {
  GitSubmissionJournal,
  GitSubmissionPhase,
  GitSubmissionReceipt,
} from '../../contracts/persistence.js';
import {
  GIT_SUBMISSION_PHASE_COMPLETE,
  GIT_SUBMISSION_PHASE_CONFLICT,
  GIT_SUBMISSION_PHASE_STALE,
} from '../../contracts/persistence.js';

/** Journal phase written when a submit is accepted; the row becomes immutable. */
export const SUBMIT_PHASE_COMPLETE = GIT_SUBMISSION_PHASE_COMPLETE;
/** Terminal journal phase recorded when the expected base head no longer matches. */
export const SUBMIT_PHASE_STALE = GIT_SUBMISSION_PHASE_STALE;
/** Terminal journal phase recorded when the ref CAS cannot be resolved (external divergence, ambiguous submitId). */
export const SUBMIT_PHASE_CONFLICT = GIT_SUBMISSION_PHASE_CONFLICT;
/** Read-only Git state supplied by the submit service (the single Git path). */
export interface SubmitRecoveryProbe {
  /** Current value of the fixed authoring ref (`refs/heads/workbench`), or null when the ref does not exist. */
  readonly fixedRefHead: string | null;
  /** The commit whose trailer carries this submitId, or null when no such commit exists. */
  readonly commitWithSubmitTrailer: string | null;
}

export type SubmitRecoveryOutcome =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'cas-pending' }
  | { readonly kind: 'accepted'; readonly receipt: GitSubmissionReceipt }
  | { readonly kind: 'stale' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'in-progress' };

/** Normalized view of a journal record regardless of which wire shape it arrived as. */
export interface SubmitJournalRecord {
  readonly submitId: string;
  readonly projectId: string;
  readonly phase: GitSubmissionPhase;
  readonly expectedGitHead: string;
  readonly candidateCommit?: string;
  readonly receiptHash?: string;
  readonly diagnostic?: string;
  readonly updatedAt: string;
}

export function normalizeSubmitJournal(
  record: GitSubmissionJournal | GitSubmissionReceipt,
): SubmitJournalRecord {
  if ('phase' in record) {
    return {
      submitId: record.submitId,
      projectId: record.projectId,
      phase: record.phase,
      expectedGitHead: record.expectedGitHead,
      ...(record.candidateCommit != null ? { candidateCommit: record.candidateCommit } : {}),
      ...(record.receiptHash != null ? { receiptHash: record.receiptHash } : {}),
      ...(record.diagnostic != null ? { diagnostic: record.diagnostic } : {}),
      updatedAt: record.updatedAt,
    };
  }
  // A completed receipt is the journal row viewed through its completed phase:
  // commit lives in candidate_commit, acceptedAt in updated_at, and the source
  // hash rides in the diagnostic slot (the v1 journal has no dedicated column).
  return {
    submitId: record.submitId,
    projectId: record.projectId,
    phase: SUBMIT_PHASE_COMPLETE,
    expectedGitHead: '',
    candidateCommit: record.commit,
    receiptHash: record.receiptHash,
    diagnostic: record.sourceHash,
    updatedAt: record.acceptedAt,
  };
}

/**
 * Build the accepted receipt from a normalized journal record. Returns null
 * when the row does not carry a full commit + receipt hash — recovery never
 * fabricates a receipt.
 */
export function receiptFromRecord(record: SubmitJournalRecord): GitSubmissionReceipt | null {
  if (record.candidateCommit == null || record.receiptHash == null) return null;
  return {
    submitId: record.submitId,
    projectId: record.projectId,
    commit: record.candidateCommit,
    sourceHash: record.diagnostic ?? '',
    receiptHash: record.receiptHash,
    acceptedAt: record.updatedAt,
  };
}

/**
 * Pure, deterministic decision: what may happen for one submitId, given the
 * durable journal record and the current Git state. This function performs no
 * I/O; {@link SubmitRecovery} applies the decision through typed journal calls.
 */
export function resolveSubmitRecovery(
  record: SubmitJournalRecord | null,
  probe: SubmitRecoveryProbe | null,
): SubmitRecoveryOutcome {
  if (record === null) return { kind: 'proceed' };

  const phase = record.phase;
  if (phase === SUBMIT_PHASE_COMPLETE) {
    const receipt = receiptFromRecord(record);
    // A completed row without a commit/hash is malformed: fail closed rather
    // than invent an accepted outcome.
    return receipt === null ? { kind: 'in-progress' } : { kind: 'accepted', receipt };
  }
  if (phase === SUBMIT_PHASE_STALE) return { kind: 'stale' };
  if (phase === SUBMIT_PHASE_CONFLICT) return { kind: 'conflict' };

  // In-flight journal with no terminal outcome. Without Git state we cannot
  // resolve safely; never create a second commit on a guess.
  if (probe === null) return { kind: 'in-progress' };

  if (probe.commitWithSubmitTrailer != null) {
    // A commit with this submitId exists. It must be OUR candidate, and it may
    // only be accepted once the fixed ref points at it.
    if (
      record.candidateCommit != null &&
      probe.commitWithSubmitTrailer !== record.candidateCommit
    ) {
      return { kind: 'conflict' }; // two different commits claim this submitId
    }
    if (probe.fixedRefHead === probe.commitWithSubmitTrailer) {
      const receipt = receiptFromRecord({
        ...record,
        candidateCommit: probe.commitWithSubmitTrailer,
        phase: SUBMIT_PHASE_COMPLETE,
      });
      return receipt === null ? { kind: 'in-progress' } : { kind: 'accepted', receipt };
    }
    if (probe.fixedRefHead === record.expectedGitHead) {
      return { kind: 'cas-pending' }; // commit exists; only the ref CAS is pending — no second commit
    }
    return { kind: 'conflict' }; // ref moved elsewhere: our commit is orphaned
  }

  if (record.candidateCommit != null) {
    // A candidate was journaled but no commit with the submitId trailer exists.
    if (probe.fixedRefHead === record.candidateCommit) {
      // The fixed ref is authoritative: it points at our candidate commit.
      const receipt = receiptFromRecord({ ...record, phase: SUBMIT_PHASE_COMPLETE });
      return receipt === null ? { kind: 'in-progress' } : { kind: 'accepted', receipt };
    }
    return { kind: 'in-progress' }; // ambiguous: unverifiable — never a second commit
  }

  // Nothing was committed for this submitId.
  if (probe.fixedRefHead === record.expectedGitHead) return { kind: 'retry' };
  return { kind: 'stale' }; // the base moved; the submit can never CAS
}

/** Typed journal access (maps 1:1 to the persistence worker's domain calls). */
export interface SubmitJournalPort {
  /** Durable lookup keyed by submitId (`loadGitSubmission`). */
  load(submitId: string): Promise<GitSubmissionJournal | GitSubmissionReceipt | null>;
  /** Record progress or a terminal typed outcome (`checkpointGitSubmission`). */
  checkpoint(record: GitSubmissionJournal): Promise<GitSubmissionJournal>;
  /** Persist the accepted receipt exactly once (`completeGitSubmission`). */
  complete(receipt: GitSubmissionReceipt): Promise<GitSubmissionReceipt>;
}

export interface SubmitRecoveryOptions {
  readonly journal: SubmitJournalPort;
  /** Injected clock for terminal-outcome timestamps; defaults to the ISO wall clock. */
  readonly now?: () => string;
}

/**
 * Journal-backed recovery. `recover` resolves one submitId to a typed outcome
 * and records probe-derived terminal outcomes once, so a retry after any crash
 * point returns the same receipt or the same typed stale/conflict result
 * without ever authorizing a second commit or a duplicate receipt.
 */
export class SubmitRecovery {
  readonly #journal: SubmitJournalPort;
  readonly #now: () => string;

  constructor(options: SubmitRecoveryOptions) {
    this.#journal = options.journal;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async recover(submitId: string, probe: SubmitRecoveryProbe): Promise<SubmitRecoveryOutcome> {
    const record = await this.#journal.load(submitId);
    const outcome = resolveSubmitRecovery(
      record === null ? null : normalizeSubmitJournal(record),
      probe,
    );
    if (outcome.kind !== 'accepted' && outcome.kind !== 'stale' && outcome.kind !== 'conflict')
      return outcome;
    if (record === null) return outcome;

    const normalized = normalizeSubmitJournal(record);
    if (outcome.kind === 'accepted') {
      // A stored receipt is already exact-once: return it unchanged.
      if (normalized.phase === SUBMIT_PHASE_COMPLETE) return outcome;
      const stored = await this.#journal.complete(outcome.receipt);
      return { kind: 'accepted', receipt: stored };
    }

    // Probe-derived terminal outcome: record it once keyed by submitId so every
    // later retry (including after a restart) replays the same typed result.
    if (normalized.phase !== outcome.kind) {
      await this.#journal.checkpoint({
        submitId: normalized.submitId,
        projectId: normalized.projectId,
        phase: outcome.kind,
        expectedGitHead: normalized.expectedGitHead,
        ...(normalized.candidateCommit != null
          ? { candidateCommit: normalized.candidateCommit }
          : {}),
        ...(normalized.receiptHash != null ? { receiptHash: normalized.receiptHash } : {}),
        diagnostic: `recovery: ${outcome.kind} detected via git probe`,
        updatedAt: this.#now(),
      });
    }
    return outcome;
  }
}
