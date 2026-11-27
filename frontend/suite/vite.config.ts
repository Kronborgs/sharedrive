import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: '/mail/suite-ui/',
  plugins: [vue()],
  build: { outDir: 'dist' },
})
