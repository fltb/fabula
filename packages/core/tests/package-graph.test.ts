import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type PackageManifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const repositoryRoot = new URL('../../../', import.meta.url);

function readManifest(packagePath: string): PackageManifest {
  const url = new URL(packagePath, repositoryRoot);
  return JSON.parse(readFileSync(url, 'utf8')) as PackageManifest;
}

const manifests = {
  core: readManifest('packages/core/package.json'),
  nodeHost: readManifest('packages/node-host/package.json'),
  cli: readManifest('packages/cli/package.json'),
  bench: readManifest('packages/bench/package.json'),
  workbench: readManifest('packages/workbench/package.json'),
};

const workspacePackages = new Set(Object.values(manifests).map((manifest) => manifest.name));

function workspaceDependencies(manifest: PackageManifest): Set<string> {
  const dependencySections = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];
  return new Set(
    dependencySections
      .flatMap((dependencies) => (dependencies ? Object.keys(dependencies) : []))
      .filter((dependency) => workspacePackages.has(dependency)),
  );
}
describe('workspace package dependency graph', () => {
  it('freezes the host boundary and dependency direction', () => {
    const dependencies = Object.fromEntries(
      Object.entries(manifests).map(([key, manifest]) => [key, workspaceDependencies(manifest)]),
    );

    expect(dependencies.core).toEqual(new Set());
    expect(dependencies.nodeHost).toEqual(new Set(['@novalistically/core']));
    expect(dependencies.cli).toEqual(
      new Set(['@novalistically/core', '@novalistically/node-host']),
    );
    expect(dependencies.bench).toEqual(
      new Set(['@novalistically/core', '@novalistically/node-host']),
    );
    expect(dependencies.workbench).toEqual(
      new Set(['@novalistically/core', '@novalistically/node-host']),
    );

    for (const dependency of dependencies.core) {
      expect(dependency).not.toBe('@novalistically/node-host');
      expect(dependency).not.toBe('@novalistically/workbench');
    }
    expect(dependencies.cli).not.toContain('@novalistically/bench');
    expect(dependencies.bench).not.toContain('@novalistically/cli');
    expect(dependencies.workbench).not.toContain('@novalistically/cli');
    expect(dependencies.workbench).not.toContain('@novalistically/bench');
  });
});
