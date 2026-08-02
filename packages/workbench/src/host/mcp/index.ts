/**
 * Host-only MCP surface: session+token authorization, the session-bound tool
 * registry, and the streamable Fetch-native endpoint. Mounted through
 * HostServer routes; never imported by the browser client.
 */
export * from './auth.js';
export * from './registry.js';
export * from './transport.js';
