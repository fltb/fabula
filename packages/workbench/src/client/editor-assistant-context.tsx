import { type Accessor, createContext, createSignal, type JSX, useContext } from 'solid-js';
import {
  EDITOR_ASSISTANT_CONTEXT_VERSION,
  type EditorAssistantContextV1,
} from './editor-assistant-contract.js';

export type {
  EditorAssistantContextV1,
  EditorAssistantContextVersion,
  EditorAssistantSelectionRangeV1,
} from './editor-assistant-contract.js';
export { EDITOR_ASSISTANT_CONTEXT_VERSION } from './editor-assistant-contract.js';

export interface EditorAssistantContextValue {
  /** The current editor selection context, or null when no editor is active. */
  readonly selection: Accessor<EditorAssistantContextV1 | null>;
  /** Replace the active editor context without writing to the Host. */
  readonly setSelection: (context: EditorAssistantContextV1 | null) => void;
  /** Clear the active editor context when its editor unmounts or loses scope. */
  readonly clearSelection: () => void;
}

/**
 * Shared context consumed by source editors, scene canvases, and structured
 * forms. It carries only safe identity and selection metadata; the Agent Drawer
 * remains a separate consumer so editors do not need to know about HTTP.
 */
export const EditorAssistantContext = createContext<EditorAssistantContextValue>();

function isSafeIdentifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return false;
  }
  return true;
}

/** Runtime guard used by editor adapters before publishing context. */
export function isEditorAssistantContext(value: unknown): value is EditorAssistantContextV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!('version' in value) || value.version !== EDITOR_ASSISTANT_CONTEXT_VERSION) return false;
  if (!('projectId' in value) || !isSafeIdentifier(value.projectId)) return false;
  if (!('documentId' in value) || !isSafeIdentifier(value.documentId)) return false;
  if ('sceneId' in value && value.sceneId !== undefined && !isSafeIdentifier(value.sceneId)) {
    return false;
  }
  if (!('baseVector' in value) || !isSafeIdentifier(value.baseVector)) return false;
  if (!('selection' in value) || typeof value.selection !== 'object' || value.selection === null) {
    return false;
  }
  const selection = value.selection;
  if (!('from' in selection) || !('to' in selection)) return false;
  const from = selection.from;
  const to = selection.to;
  return (
    typeof from === 'number' &&
    Number.isInteger(from) &&
    from >= 0 &&
    typeof to === 'number' &&
    Number.isInteger(to) &&
    to >= from
  );
}

function copyContext(context: EditorAssistantContextV1): EditorAssistantContextV1 {
  if (!isEditorAssistantContext(context)) {
    throw new TypeError(
      'Editor assistant context must contain safe document identity and selection.',
    );
  }
  return {
    version: EDITOR_ASSISTANT_CONTEXT_VERSION,
    projectId: context.projectId,
    documentId: context.documentId,
    ...(context.sceneId === undefined ? {} : { sceneId: context.sceneId }),
    selection: { from: context.selection.from, to: context.selection.to },
    baseVector: context.baseVector,
  };
}

/** Creates a standalone controller for tests or an editor host. */
export function createEditorAssistantContext(
  initial: EditorAssistantContextV1 | null = null,
): EditorAssistantContextValue {
  const [selection, setSelectionSignal] = createSignal<EditorAssistantContextV1 | null>(
    initial === null ? null : copyContext(initial),
  );
  const setSelection = (context: EditorAssistantContextV1 | null): void => {
    setSelectionSignal(context === null ? null : copyContext(context));
  };
  return {
    selection,
    setSelection,
    clearSelection: () => setSelectionSignal(null),
  };
}

export interface EditorAssistantProviderProps {
  readonly value?: EditorAssistantContextValue;
  readonly initialContext?: EditorAssistantContextV1 | null;
  readonly children: JSX.Element;
}

/** Provides the editor-neutral selection controller to a workspace subtree. */
export function EditorAssistantProvider(props: EditorAssistantProviderProps): JSX.Element {
  const local = createEditorAssistantContext(props.initialContext ?? null);
  return (
    <EditorAssistantContext.Provider value={props.value ?? local}>
      {props.children}
    </EditorAssistantContext.Provider>
  );
}

/** Alias kept descriptive for callers that prefer the provider-style name. */
export const EditorAssistantContextProvider = EditorAssistantProvider;

/** Reads the nearest editor assistant controller. */
export function useEditorAssistantContext(): EditorAssistantContextValue {
  const value = useContext(EditorAssistantContext);
  if (value === undefined) {
    throw new Error('useEditorAssistantContext must be used inside EditorAssistantProvider.');
  }
  return value;
}
