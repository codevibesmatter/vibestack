// @ts-check
const { defineConfig } = require('tsup');

/** @type {import('tsup').Options} */
const config = {
  entry: ['src/index.ts', 'src/generated/client-entities.ts', 'src/generated/server-entities.ts'],
  format: ['esm'],
  experimentalDts: true,
  clean: true,
  platform: 'node',
  target: 'es2020',
  noExternal: ['./src/**'],
  external: [
    'typeorm',
    'reflect-metadata',
    'class-validator',
    '@electric-sql/pglite',
    'pg',
  ],
  treeshake: false,
  esbuildOptions(options) {
    options.tsconfig = 'tsconfig.json';
  }
};

module.exports = defineConfig(config); 