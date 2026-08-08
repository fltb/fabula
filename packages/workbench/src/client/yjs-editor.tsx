import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { onCleanup, onMount } from 'solid-js';
import { yCollab } from 'y-codemirror.next';
import * as Y from 'yjs';
import { BROWSER_SESSION_HEADER } from '../contracts/browser-api.js';
import type { SourceStudioDocumentDescriptorV1 } from '../contracts/source-studio.js';

export type YjsEditorConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'unavailable';

export interface YjsEditorSelection {
  readonly from: number;
  readonly to: number;
}

export interface YjsEditorController {
  /** Close this editor's private Yjs/WebSocket resources. */
  close(): void;
}

export interface YjsEditorProps {
  /** Host-issued descriptor; no document bytes are accepted as props. */
  readonly descriptor: SourceStudioDocumentDescriptorV1;
  /** Transient session credential used only to request a one-time Yjs ticket. */
  readonly sessionId: string | null | undefined;
  /** Same-origin Host URL; defaults to the current page origin. */
  readonly baseUrl?: string;
  readonly readOnly?: boolean;
  readonly onStatusChange?: (status: YjsEditorConnectionStatus) => void;
  /** Fired after local or remote Yjs state changes; never performs HTTP. */
  readonly onWorkingChange?: () => void;
  readonly onSelectionChange?: (selection: YjsEditorSelection) => void;
  readonly onController?: (controller: YjsEditorController) => void;
}

const MESSAGE_SYNC = 0;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;
const REMOTE_ORIGIN = {};
const WORKING_TEXT_TYPE = 'prose';

function writeVarUint(target: number[], value: number): void {
  let number = value >>> 0;
  while (number > 0x7f) {
    target.push((number & 0x7f) | 0x80);
    number >>>= 7;
  }
  target.push(number);
}

function readVarUint(bytes: Uint8Array, cursor: { offset: number }): number {
  let number = 0;
  let shift = 0;
  while (true) {
    if (cursor.offset >= bytes.length) throw new Error('yjs frame is truncated');
    const byte = bytes[cursor.offset++];
    number |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return number >>> 0;
    shift += 7;
    if (shift > 28) throw new Error('yjs frame varuint overflow');
  }
}

function encodeSyncFrame(syncType: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const header: number[] = [];
  writeVarUint(header, MESSAGE_SYNC);
  writeVarUint(header, syncType);
  writeVarUint(header, payload.length);
  const frame = new Uint8Array(header.length + payload.length);
  frame.set(header, 0);
  frame.set(payload, header.length);
  return frame;
}

function parseSyncFrame(
  bytes: Uint8Array,
): { readonly syncType: number; readonly payload: Uint8Array } | null {
  const cursor = { offset: 0 };
  const messageType = readVarUint(bytes, cursor);
  if (messageType !== MESSAGE_SYNC) return null;
  const syncType = readVarUint(bytes, cursor);
  const length = readVarUint(bytes, cursor);
  if (length > bytes.length - cursor.offset) throw new Error('yjs frame payload is truncated');
  return { syncType, payload: bytes.slice(cursor.offset, cursor.offset + length) };
}

async function bytesFromSocketData(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new Error('unsupported yjs WebSocket payload');
}
function yjsUrl(
  baseUrl: string | undefined,
  descriptor: SourceStudioDocumentDescriptorV1,
  ticket: string,
): string {
  const source = baseUrl ?? (typeof location === 'undefined' ? 'http://localhost/' : location.href);
  const url = new URL(source);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/yjs';
  url.search = '';
  url.searchParams.set('ticket', ticket);
  url.searchParams.set('project', descriptor.projectId);
  url.searchParams.set('document', descriptor.documentId);
  return url.toString();
}

async function requestYjsTicket(
  baseUrl: string | undefined,
  descriptor: SourceStudioDocumentDescriptorV1,
  sessionId: string,
): Promise<string> {
  const source = baseUrl ?? (typeof location === 'undefined' ? 'http://localhost/' : location.href);
  const url = new URL(source);
  url.pathname = `/api/v1/projects/${encodeURIComponent(descriptor.projectId)}/source/${encodeURIComponent(descriptor.documentId)}/yjs-ticket`;
  url.search = '';
  const response = await fetch(url, { headers: { [BROWSER_SESSION_HEADER]: sessionId } });
  if (!response.ok) throw new Error('yjs ticket unavailable');
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('ticket' in body) ||
    typeof body.ticket !== 'string' ||
    body.ticket.length === 0
  ) {
    throw new Error('invalid yjs ticket');
  }
  return body.ticket;
}

/** One-shot programmatic working-document text replacement. */
export interface ReplaceWorkingDocumentTextInput {
  readonly projectId: string;
  /** Host-validated working-document id (the Yjs ticket scope). */
  readonly documentId: string;
  /** Transient session credential used only to request a one-time Yjs ticket. */
  readonly sessionId: string;
  /** Full replacement text for the `prose` Yjs text type. */
  readonly text: string;
  /** Same-origin Host URL; defaults to the current page origin. */
  readonly baseUrl?: string;
}

/** Bound the write against a silent sync so the caller promise never hangs. */
const REPLACE_WRITE_TIMEOUT_MS = 10_000;

/**
 * Replace the full working text of one document through the same
 * authenticated Yjs channel the editor uses: request a one-time ticket,
 * bind the `/yjs` WebSocket, wait for the authoritative sync state, then
 * `getText('prose').delete(0, len); insert(0, text)` so the resulting diff
 * update is sent and persisted Host-side. Resolves after the update has been
 * handed to the socket; rejects on ticket/connection/sync failures.
 */
export function replaceWorkingDocumentText(input: ReplaceWorkingDocumentTextInput): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const descriptor: SourceStudioDocumentDescriptorV1 = {
      projectId: input.projectId,
      documentId: input.documentId,
      kind: 'raw-yaml',
      available: true,
    };
    const document = new Y.Doc();
    const text = document.getText(WORKING_TEXT_TYPE);
    let socket: WebSocket | null = null;
    let settled = false;
    let applied = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      socket = null;
      document.destroy();
      if (error === undefined) resolve();
      else reject(error instanceof Error ? error : new Error(String(error)));
    };

    // Local transaction (the replacement) → send the diff to the Host.
    document.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN || socket?.readyState !== WebSocket.OPEN) return;
      socket.send(encodeSyncFrame(SYNC_UPDATE, update));
      // Frames are ordered ahead of the close frame, so the persisted update
      // reaches the Host before the connection finalizes.
      queueMicrotask(() => settle());
    });

    void requestYjsTicket(input.baseUrl, descriptor, input.sessionId)
      .then((ticket) => {
        if (settled) return;
        socket = new WebSocket(yjsUrl(input.baseUrl, descriptor, ticket));
        socket.binaryType = 'arraybuffer';
        socket.addEventListener('open', () => {
          if (settled || socket === null) return;
          socket.send(encodeSyncFrame(SYNC_STEP_1, Y.encodeStateVector(document)));
        });
        socket.addEventListener('message', (event) => {
          void bytesFromSocketData(event.data)
            .then((bytes) => {
              if (settled) return;
              const frame = parseSyncFrame(bytes);
              if (frame === null) return;
              if (frame.syncType !== SYNC_STEP_2 && frame.syncType !== SYNC_UPDATE) return;
              Y.applyUpdate(document, frame.payload, REMOTE_ORIGIN);
              if (applied) return;
              applied = true;
              // Authoritative state is loaded: replace the full text. The
              // update event above sends the diff and settles the promise.
              text.delete(0, text.length);
              text.insert(0, input.text);
            })
            .catch(() => settle(new Error('working document sync failed')));
        });
        socket.addEventListener('close', () => {
          if (!settled) settle(new Error('working document connection closed before write'));
        });
        socket.addEventListener('error', () => {
          if (!settled) settle(new Error('working document connection failed'));
        });
        timer = setTimeout(() => {
          if (!settled) settle(new Error('working document write timed out'));
        }, REPLACE_WRITE_TIMEOUT_MS);
      })
      .catch((cause: unknown) => settle(cause));
  });
}

/**
 * CodeMirror/Yjs editor binding for one Host-validated descriptor. The only
 * network writes here are authenticated binary WebSocket Yjs updates. No
 * fetch, submit or provider request is made from editor transactions.
 */
export function YjsEditor(props: YjsEditorProps) {
  let host: HTMLElement | undefined;

  onMount(() => {
    const document = new Y.Doc();
    const text = document.getText(WORKING_TEXT_TYPE);
    let view: EditorView;
    let socket: WebSocket | null = null;
    let closed = false;
    const pending: Uint8Array[] = [];

    const status = (next: YjsEditorConnectionStatus): void => props.onStatusChange?.(next);
    const send = (update: Uint8Array): void => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(encodeSyncFrame(SYNC_UPDATE, update));
      } else {
        pending.push(update.slice());
      }
    };

    document.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE_ORIGIN) send(update);
      props.onWorkingChange?.();
    });

    const extensions = [
      lineNumbers(),
      drawSelection(),
      highlightActiveLine(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      yaml(),
      EditorView.lineWrapping,
      yCollab(text, null),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet) {
          const range = update.state.selection.main;
          props.onSelectionChange?.({ from: range.from, to: range.to });
        }
      }),
      ...(props.readOnly ? [EditorState.readOnly.of(true)] : []),
    ];
    view = new EditorView({
      state: EditorState.create({ doc: text.toString(), extensions }),
      parent: host,
    });

    const controller: YjsEditorController = {
      close() {
        if (closed) return;
        closed = true;
        socket?.close();
        socket = null;
        view.destroy();
        document.destroy();
        status('disconnected');
      },
    };
    props.onController?.(controller);

    if (!props.descriptor.available) {
      status('unavailable');
    } else if (typeof props.sessionId !== 'string' || props.sessionId.length === 0) {
      status('disconnected');
    } else if (typeof WebSocket !== 'function') {
      status('unavailable');
    } else {
      status('connecting');
      void requestYjsTicket(props.baseUrl, props.descriptor, props.sessionId)
        .then((ticket) => {
          if (closed) return;
          socket = new WebSocket(yjsUrl(props.baseUrl, props.descriptor, ticket));
          socket.binaryType = 'arraybuffer';
          socket.addEventListener('open', () => {
            if (closed || socket === null) return;
            status('connected');
            socket.send(encodeSyncFrame(SYNC_STEP_1, Y.encodeStateVector(document)));
            for (const update of pending.splice(0)) {
              if (socket.readyState !== WebSocket.OPEN) {
                pending.unshift(update);
                break;
              }
              socket.send(encodeSyncFrame(SYNC_UPDATE, update));
            }
          });
          socket.addEventListener('message', (event) => {
            void bytesFromSocketData(event.data)
              .then((bytes) => {
                if (closed) return;
                const frame = parseSyncFrame(bytes);
                if (frame === null) return;
                if (frame.syncType === SYNC_STEP_2 || frame.syncType === SYNC_UPDATE) {
                  Y.applyUpdate(document, frame.payload, REMOTE_ORIGIN);
                  props.onWorkingChange?.();
                }
              })
              .catch(() => {
                if (!closed) status('disconnected');
              });
          });
          socket.addEventListener('close', () => {
            if (!closed) status('disconnected');
          });
          socket.addEventListener('error', () => {
            if (!closed) status('disconnected');
          });
        })
        .catch(() => {
          if (!closed) status('unavailable');
        });
    }

    onCleanup(() => controller.close());
  });

  return (
    <section
      ref={host}
      class="min-h-0 flex-1 overflow-auto"
      aria-label={`Editing ${props.descriptor.documentId}`}
    />
  );
}

export { encodeSyncFrame, parseSyncFrame };
