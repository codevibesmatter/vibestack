import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // VitePWA({
    //   registerType: 'autoUpdate', // Automatically update the service worker when new content is available
    //   includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'], // Cache these static assets
    //   manifest: { // Basic PWA manifest generation
    //     name: 'ShadAdmin',
    //     short_name: 'ShadAdmin',
    //     description: 'Admin Dashboard',
    //     theme_color: '#ffffff',
    //     icons: [
    //       {
    //         src: 'pwa-192x192.png',
    //         sizes: '192x192',
    //         type: 'image/png'
    //       },
    //       {
    //         src: 'pwa-512x512.png',
    //         sizes: '512x512',
    //         type: 'image/png'
    //       }
    //     ]
    //   },
    //   workbox: {
    //     globPatterns: ['**/*.{js,css,html,ico,png,svg}'] // Cache JS, CSS, HTML, and image assets
    //   }
    // }),
    // cloudflare(),
    TanStackRouterVite({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  optimizeDeps: {
    include: ['reflect-metadata'],
    exclude: ['@electric-sql/pglite']
  },
  worker: {
    format: 'es'
  },
  resolve: {
    alias: {
      // Ensure TypeORM uses its browser bundle
      typeorm: 'typeorm/browser',
      // Restore alias, pointing to JS file for Vite runtime
      '@repo/dataforge/client-entities': path.resolve(__dirname, '../../packages/dataforge/dist/client-entities.js'), 
      '@repo/sync-types': path.resolve(__dirname, '../../packages/sync-types/dist/index.js'),
      '@': path.resolve(__dirname, './src'),

      // fix loading all icon chunks in dev mode
      // https://github.com/tabler/tabler-icons/issues/1233
      '@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
    },
  },
  // Add build options to externalize typeorm
  build: {
    rollupOptions: {
      external: ["typeorm"]
    }
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
})
