import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // The engine runs in its own utilityProcess (see docs/ARCHITECTURE.md).
          engine: resolve(__dirname, 'src/engine/index.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias: shared },
    build: { externalizeDeps: true }
  },
  renderer: {
    resolve: { alias: shared },
    plugins: [react()]
  }
})
