import * as esbuild from 'esbuild';
import { resolve } from 'path';

async function build() {
  try {
    await esbuild.build({
      entryPoints: ['src/index.ts'],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      outdir: 'dist',
      sourcemap: true,
      external: [
        '__STATIC_CONTENT_MANIFEST',
        '@repo/shared-types',
        '@repo/schema'
      ],
      define: {
        'global': 'globalThis',
      },
      alias: {
        '@repo/shared-types': resolve('../../packages/shared-types/src'),
        '@repo/schema': resolve('../../packages/schema/src'),
        'typeorm': 'typeorm/browser'
      }
    });
    console.log('Build completed successfully');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build(); 