import '@testing-library/jest-dom/vitest';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

const localValues = new Map<string, string>();
const clientLocalStorage: Storage = {
  get length() {
    return localValues.size;
  },
  clear() {
    localValues.clear();
  },
  getItem(key) {
    return localValues.get(key) ?? null;
  },
  key(index) {
    return [...localValues.keys()][index] ?? null;
  },
  removeItem(key) {
    localValues.delete(key);
  },
  setItem(key, value) {
    localValues.set(String(key), String(value));
  },
};

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: clientLocalStorage,
});
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: clientLocalStorage,
});

/**
 * Client tests own a permissive MSW lifecycle. They do not load Core's global
 * network-denial setup because the shell is tested without a Core transport.
 */
export const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
