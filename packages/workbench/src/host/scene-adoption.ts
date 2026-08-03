/**
 * Explicit Host-only bridge from an accepted Core scene revision to the one
 * authoring-manifest entry that may introduce generated prose. Rendering never
 * calls this service: a human must invoke adoption, and the claim is derived
 * from the persisted released revision rather than browser-supplied hashes.
 */
import type { CoreExecutionRepository } from '@novalistically/core';
import { sceneRevisionEnvelopeV1Schema } from '@novalistically/core/editorial';
import {
  type AdoptSceneClaim,
  type AuthoringEntry,
  adoptClaimFromEnvelope,
  sceneBytesMatchClaim,
} from './authoring/manifest.js';

export type SceneAdoptionFailureCode =
  | 'REVISION_NOT_FOUND'
  | 'REVISION_INVALID'
  | 'REVISION_MISMATCH'
  | 'REVISION_UNRELEASED'
  | 'PROSE_HASH_MISMATCH';

export type SceneAdoptionPreparation =
  | {
      readonly ok: true;
      readonly claim: AdoptSceneClaim;
      readonly entry: AuthoringEntry;
      /** User-visible disclosure: adoption is the deliberate authoring transition. */
      readonly disclosure: 'accepted generated prose will enter the authoring manifest';
    }
  | { readonly ok: false; readonly code: SceneAdoptionFailureCode; readonly message: string };

export interface SceneAdoptionServiceOptions {
  /** Persisted Core revisions are the only authority for generated prose. */
  readonly execution: Pick<CoreExecutionRepository, 'readSceneRevision'>;
}

/**
 * Resolve a released Core revision into a manifest claim and exact UTF-8 scene
 * entry. This is preparation only: Git submit remains the sole commit path.
 */
export async function prepareSceneAdoption(
  options: SceneAdoptionServiceOptions,
  input: { readonly projectId: string; readonly eventId: string; readonly revisionId: string },
): Promise<SceneAdoptionPreparation> {
  const record = await options.execution.readSceneRevision(input);
  if (record === null) {
    return {
      ok: false,
      code: 'REVISION_NOT_FOUND',
      message: 'The selected scene revision was not found.',
    };
  }
  if (
    record.value.projectId !== input.projectId ||
    record.value.eventId !== input.eventId ||
    record.value.revisionId !== input.revisionId
  ) {
    return {
      ok: false,
      code: 'REVISION_MISMATCH',
      message:
        'The stored revision record does not match the requested project, scene, and revision identity.',
    };
  }
  const parsed = sceneRevisionEnvelopeV1Schema.safeParse(record.value.value);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'REVISION_INVALID',
      message: 'The stored scene revision is invalid.',
    };
  }
  const envelope = parsed.data;
  if (envelope.eventId !== input.eventId || envelope.revisionId !== input.revisionId) {
    return {
      ok: false,
      code: 'REVISION_MISMATCH',
      message: 'The stored revision does not match the requested scene and revision identity.',
    };
  }
  if (!envelope.released) {
    return {
      ok: false,
      code: 'REVISION_UNRELEASED',
      message: 'Only a released scene revision can be adopted into authoring source.',
    };
  }
  const claim = adoptClaimFromEnvelope(envelope);
  const entry: AuthoringEntry = {
    path: `scenes/${envelope.eventId}.md`,
    bytes: new TextEncoder().encode(envelope.prose),
  };
  if (!sceneBytesMatchClaim(entry.bytes, claim)) {
    return {
      ok: false,
      code: 'PROSE_HASH_MISMATCH',
      message: 'The accepted revision prose does not match its persisted hash.',
    };
  }
  return {
    ok: true,
    claim,
    entry,
    disclosure: 'accepted generated prose will enter the authoring manifest',
  };
}
