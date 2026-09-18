import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { printApiPlugin } from './server/print-api-plugin.mjs'

export default defineConfig({
  plugins: [react(), printApiPlugin()],
})
