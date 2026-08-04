import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(packageRoot, 'src/index.ts')],
  outdir: join(packageRoot, 'dist'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2024',
  sourcemap: true,
});
