/**
 * Browser-safe Source Studio contract: the Host-derived accepted source
 * projection identity/diagnostics plus the descriptors needed to bind the
 * online-only Yjs working layer. Boundary rules mirror the rest of the
 * browser read surface: these DTOs never carry raw source or Yjs bytes,
 * filesystem paths, root labels, Git state, SQLite material, credentials,
 * capability tokens, or operation output paths. Yjs working documents are
 * explicitly noncanonical — only a Host submit turns working bytes into
 * accepted source.
 */

import type { ProjectSessionProjectionV1 } from '../host/project-session.js';
import type { BrowserApiVersion } from './browser-api.js';
import { BROWSER_API_BASE_PATH } from './browser-api.js';

/** `GET /api/v1/projects/:projectId/source` — Source Studio state. */
export const BROWSER_PROJECT_SOURCE_PATH = `${BROWSER_API_BASE_PATH}/projects/:projectId/source`;

/**
 * One Yjs working-document descriptor: the exact document identity a client
 * needs to bind a working-layer connection (project + document), what the
 * document holds, and whether the Host currently has it available. It never
 * carries working bytes, a state vector, or any parsed content — availability
 * is a boolean flag, not data.
 */
export interface SourceStudioDocumentDescriptorV1 {
  readonly projectId: string;
  /** Exact Yjs `documentId` for the working document (a Host-validated id). */
  readonly documentId: string;
  /** What the working document holds; the Host decides valid ids, never the client. */
  readonly kind: 'prose' | 'raw-yaml';
  /** True when the Host currently has a live working document for this key. */
  readonly available: boolean;
}

/** The online-only working layer: document descriptors, never raw bytes. */
export interface SourceStudioWorkingLayerV1 {
  readonly documents: readonly SourceStudioDocumentDescriptorV1[];
}

/**
 * One Source Studio read: the accepted last-valid projection identity and
 * diagnostics plus the working-layer descriptors. `accepted` is null when the
 * Host has not accepted any source yet (honest "no accepted source" state,
 * never an invented one). Everything here is Host-derived; the client renders
 * it and never constructs project facts or source bytes.
 */
export interface SourceStudioStateV1 {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  /** Accepted last-valid projection identity and diagnostics, or null. */
  readonly accepted: ProjectSessionProjectionV1 | null;
  readonly working: SourceStudioWorkingLayerV1;
  readonly generatedAt: string;
}

/** One working-layer read the host derives from the production document store. */
export interface SourceStudioWorkingDocumentView {
  readonly documentId: string;
  readonly kind: 'prose' | 'raw-yaml';
  /** True when the Host currently holds a live working document for this key. */
  readonly available: boolean;
}

/**
 * Host-side derivation of the safe working-layer view. Takes ONLY the
 * descriptor facts the production document store exposes and maps them onto
 * the browser-safe contract; the derivation itself never sees raw document
 * bytes, state vectors, or filesystem paths, so they cannot leak through it.
 */
export function deriveSourceStudioWorkingLayer(input: {
  readonly projectId: string;
  readonly documents: readonly SourceStudioWorkingDocumentView[];
}): SourceStudioWorkingLayerV1 {
  return {
    documents: input.documents.map((document) => ({
      projectId: input.projectId,
      documentId: document.documentId,
      kind: document.kind,
      available: document.available,
    })),
  };
}

/** Host-side derivation of the complete Source Studio read. */
export function deriveSourceStudioState(input: {
  readonly version: BrowserApiVersion;
  readonly projectId: string;
  readonly accepted: ProjectSessionProjectionV1 | null;
  readonly documents: readonly SourceStudioWorkingDocumentView[];
  readonly generatedAt: string;
}): SourceStudioStateV1 {
  return {
    version: input.version,
    projectId: input.projectId,
    accepted: input.accepted,
    working: deriveSourceStudioWorkingLayer({
      projectId: input.projectId,
      documents: input.documents,
    }),
    generatedAt: input.generatedAt,
  };
}
