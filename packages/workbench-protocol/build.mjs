import { build } from 'esbuild';
await build({ entryPoints: ['src/index.ts'], outdir: 'dist', bundle: true, format: 'esm', platform: 'neutral', target: 'es2024', sourcemap: true });
