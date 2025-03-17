import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/index.mjs',
  sourcemap: true,
  external: ['@repo/schema', 'zod']
}).then(() => esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/index.js',
  sourcemap: true,
  external: ['@repo/schema', 'zod']
})); 