/**
 * Browser-safe identity carried between an editor and the guarded Agent API.
 * It intentionally contains no document bytes, raw Yjs vector, capability, or
 * provider detail: the Host verifies the live working document before effects.
 */

export const EDITOR_ASSISTANT_CONTEXT_VERSION = 1 as const;
export type EditorAssistantContextVersion = typeof EDITOR_ASSISTANT_CONTEXT_VERSION;

export interface EditorAssistantSelectionRangeV1 {
  readonly from: number;
  readonly to: number;
}

export interface EditorAssistantContextV1 {
  readonly version: EditorAssistantContextVersion;
  readonly projectId: string;
  readonly documentId: string;
  readonly sceneId?: string;
  readonly selection: EditorAssistantSelectionRangeV1;
  /** Opaque Host-issued identity for the working document revision. */
  readonly baseVector: string;
}
