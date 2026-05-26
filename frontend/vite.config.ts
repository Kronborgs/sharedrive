import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import path from 'path'

// APP_VERSION is injected via Makefile: APP_VERSION=$(VERSION) npm run build
const appVersion = process.env.APP_VERSION ?? 'dev'

export default defineConfig({
  plugins: [
    tailwindcss(),
    TanStackRouterVite(),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5173,
    proxy: {
      // In dev, proxy API calls to the Go backend
      '/api': {
        target: process.env.VITE_API_BASE ?? 'http://localhost:8080',
        changeOrigin: true,
      },
      '/upload': {
        target: process.env.VITE_API_BASE ?? 'http://localhost:8080',
        changeOrigin: true,
      },
      '/dav': {
        target: process.env.VITE_API_BASE ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Disable the inline modulepreload polyfill script — all supported browsers
    // handle <link rel="modulepreload"> natively, and the polyfill is an inline
    // <script> that would be blocked by our Content-Security-Policy.
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // Vite 8 / rolldown requires manualChunks as a function (not an object)
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor'
          }
          if (id.includes('@tanstack/react-router')) return 'router'
          if (id.includes('@tanstack/react-query'))  return 'query'
          if (
            id.includes('@radix-ui/react-dialog') ||
            id.includes('@radix-ui/react-dropdown-menu') ||
            id.includes('@radix-ui/react-context-menu') ||
            id.includes('@radix-ui/react-tabs')
          ) return 'radix'
          if (id.includes('node_modules/pdfjs-dist')) return 'pdf'
          if (id.includes('node_modules/three'))      return 'three'
        },
      },
    },
  },
})
