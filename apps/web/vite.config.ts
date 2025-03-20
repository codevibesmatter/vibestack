import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import { resolve } from 'path'
import { TanStackRouterVite } from '@tanstack/router-vite-plugin'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    TanStackRouterVite({ autoCodeSplitting: true }),
    react({
      jsxImportSource: 'react',
      tsDecorators: true
    })
  ],
  css: {
    postcss: {
      plugins: [
        tailwindcss,
        autoprefixer,
      ],
    },
  },
  optimizeDeps: {
    include: ['reflect-metadata'],
    exclude: ['@electric-sql/pglite']
  },
  worker: {
    format: 'es'
  },
  build: {
    target: 'esnext',
    modulePreload: {
      polyfill: false
    },
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['reflect-metadata']
        }
      }
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@repo/db': resolve(__dirname, '../../packages/db/dist/client.js'),
      '@repo/db-migrations': resolve(__dirname, '../../packages/db/src/migrations'),
      '@repo/db-migrations-client': resolve(__dirname, '../../packages/db/src/migrations/client'),
      '@repo/dataforge': resolve(__dirname, '../../packages/typeorm/dist'),
      '@repo/dataforge/client-entities': resolve(__dirname, '../../packages/typeorm/dist/client-entities.js'),
      '@repo/dataforge/dist/entities/Task': resolve(__dirname, '../../packages/typeorm/dist/entities/Task.js'),
      '@repo/dataforge/dist/entities/Project': resolve(__dirname, '../../packages/typeorm/dist/entities/Project.js')
    }
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
})
