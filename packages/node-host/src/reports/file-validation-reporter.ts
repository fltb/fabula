import * as path from 'node:path';
import { formatValidationReport, type ValidationReport } from '@novalistically/core/tooling';
import { atomicWrite, prepareDirectory, recoverJournal, withDirectoryLock } from '../execution/types.js';

/** Persist a pure Core validation report under a Host-owned output directory. */
export async function writeFileValidationReport(
  projectRoot: string,
  report: ValidationReport,
  relativeOutputDirectory = 'output',
): Promise<string> {
  if (!relativeOutputDirectory || path.isAbsolute(relativeOutputDirectory)) {
    throw new Error('Validation report directory must be project-relative');
  }
  const root = path.resolve(projectRoot);
  const directory = path.resolve(root, relativeOutputDirectory);
  if (!directory.startsWith(`${root}${path.sep}`)) {
    throw new Error('Validation report directory escapes project root');
  }
  await prepareDirectory(root, directory);
  const target = path.join(directory, 'validation.md');
  return withDirectoryLock(root, directory, async () => {
    await recoverJournal(root, directory);
    await atomicWrite(root, directory, target, formatValidationReport(report));
    return target;
  });
}
