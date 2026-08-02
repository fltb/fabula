#!/usr/bin/env node

// Remove the generated `dist` directories of the fixed workspace packages
// before the canonical root build regenerates declarations and bundles.
// Cleaning first guarantees the build starts from fresh output, so a source
// module deleted since the previous build cannot leave stale `.js`, `.map`,
// `.d.ts`, or `.d.ts.map` artifacts behind.
//
// Safety:
// - The target list is hard-coded; no user-controlled input ever reaches
//   the deletion.
// - Every target is anchored to the repository root (resolved via realpath
//   from this script's own location) and must resolve strictly beneath it.
// - Every path component from the root down to `dist` is lstat-checked:
//   a symlinked component is a containment escape vector and fails the
//   cleanup instead of being followed into arbitrary directories.
// - Only real directories are removed; missing directories are skipped and
//   non-directory entries are refused.
// - A final realpath re-check immediately before removal closes the
//   check-then-delete race for a directory swapped for a symlink.

import { lstat, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = await realpath(path.resolve(scriptDir, '..'));

// Fixed workspace packages whose generated `dist` output the root build owns.
const PACKAGES = ['core', 'node-host', 'bench', 'cli', 'workbench'];

function assertInsideRepoRoot(target) {
  const relative = path.relative(repoRoot, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `clean-build-output: refusing path outside repository root: ${target}`,
    );
  }
}

// Walk from the repository root to the target; any symlinked component
// aborts the cleanup rather than letting `rm` follow it elsewhere.
async function assertNoSymlinkComponents(target) {
  assertInsideRepoRoot(target);
  const relative = path.relative(repoRoot, target);
  let current = repoRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstat(current).catch(() => null);
    if (stat?.isSymbolicLink()) {
      throw new Error(
        `clean-build-output: refusing to remove through symlink: ${current}`,
      );
    }
  }
}

const removed = [];
for (const pkg of PACKAGES) {
  const target = path.join(repoRoot, 'packages', pkg, 'dist');
  assertInsideRepoRoot(target);
  if (path.basename(target) !== 'dist') {
    throw new Error(`clean-build-output: unexpected target name: ${target}`);
  }
  await assertNoSymlinkComponents(target);

  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') continue; // nothing generated yet
    throw error;
  }
  if (stat.isSymbolicLink()) {
    // Also caught by the component walk; kept as an explicit guard.
    throw new Error(`clean-build-output: refusing to remove symlink: ${target}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `clean-build-output: refusing to remove non-directory: ${target}`,
    );
  }

  // Race guard: re-resolve immediately before removal so a directory
  // swapped for a symlink between the checks above and the deletion cannot
  // redirect `rm` outside the repository root.
  try {
    const canonical = await realpath(target);
    assertInsideRepoRoot(canonical);
  } catch (error) {
    if (error?.code === 'ENOENT') continue; // removed concurrently; nothing to do
    throw error;
  }

  await rm(target, { recursive: true, force: true });
  removed.push(target);
}

if (removed.length > 0) {
  console.log(
    `clean-build-output: removed ${removed.length} generated dist director${
      removed.length === 1 ? 'y' : 'ies'
    }`,
  );
  for (const dir of removed) {
    console.log(`  - ${path.relative(repoRoot, dir)}`);
  }
} else {
  console.log('clean-build-output: no generated dist directories to remove');
}
