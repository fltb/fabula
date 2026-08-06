/**
 * Host-only trusted-plugin discovery port (plan 7.7).
 *
 * The owner admin must restrict trusted-plugin choices to plugins the Host
 * has actually discovered on disk under the project root: name/version/
 * moduleHash triples (plus hook names for display) — never arbitrary module
 * paths, URLs or uploads. This module wraps the node-host containment-checked
 * `discoverNodePlugins` catalog into the `PluginDiscoveryAdminPort` the owner
 * admin surface consumes (both the admin MCP tool `nova_admin_plugins_discovered`
 * and the browser admin read route). Discovery makes no trust decision: it
 * only reads manifests and hashes; activation/trust stays with
 * `activateNodePlugins`.
 */

import { type DiscoveredNodePlugin, discoverNodePlugins } from '@novalistically/node-host';
import type { DiscoveredPluginAdminViewV1, PluginDiscoveryAdminPort } from '../admin-api.js';

export interface PluginDiscoveryPortOptions {
  /** Resolves a configured project id to its project root, or null. */
  readonly resolveProjectRoot: (projectId: string) => string | null | Promise<string | null>;
  /** Project-relative plugin directory; defaults to `plugins`. */
  readonly pluginsDir?: string;
}

const toAdminView = (plugin: DiscoveredNodePlugin): DiscoveredPluginAdminViewV1 => ({
  name: plugin.name,
  version: plugin.version,
  manifestHash: plugin.manifestHash,
  moduleHash: plugin.moduleHash,
  hookNames: [...plugin.hookNames],
});

/** Build the launch-owned discovery port over the configured project list. */
export function createPluginDiscoveryPort(
  options: PluginDiscoveryPortOptions,
): PluginDiscoveryAdminPort {
  const { resolveProjectRoot, pluginsDir } = options;
  return {
    async discover({ projectId }) {
      const root = await resolveProjectRoot(projectId);
      if (root === null) {
        throw new Error(`Project "${projectId}" is not registered.`);
      }
      const discovered = await discoverNodePlugins(root, pluginsDir);
      return discovered.map(toAdminView);
    },
  };
}
