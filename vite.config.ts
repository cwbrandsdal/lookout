import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const devPort = Number(process.env.LOOKOUT_DEV_PORT ?? '5173')

// Production renderer CSP (dev needs inline scripts/HMR websockets, so it is build-only).
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // The SIXEL decoder of @xterm/addon-image is WebAssembly.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'lookout-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  plugins: [react(), contentSecurityPolicy()],
  server: {
    port: devPort,
    strictPort: true,
  },
}))
