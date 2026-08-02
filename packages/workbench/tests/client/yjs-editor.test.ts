import { describe, expect, it } from 'vitest';
import { encodeSyncFrame, parseSyncFrame } from '../../src/client/yjs-editor.js';

describe('Yjs editor transport binding', () => {
  it('uses the Host sync framing without exposing HTTP/source DTOs', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = encodeSyncFrame(2, payload);
    expect(parseSyncFrame(frame)).toEqual({ syncType: 2, payload });
  });

  it('rejects malformed binary frames before applying them', () => {
    expect(() => parseSyncFrame(new Uint8Array([0, 2, 5, 1]))).toThrow(/truncated/i);
  });
});
