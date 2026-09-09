import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// DNS rebinding 対策で許可ホストは明示リストにする。`.ts.net` は Tailscale の
// MagicDNS 名（tailnet 内でしか解決されない）なので、Tailscale 前提の本プロジェクト
// では既定で許可する。それ以外のホスト名は AZITO_ALLOWED_HOSTS（カンマ区切り）で追加する。
const extraHosts = (process.env.AZITO_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@azito/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    allowedHosts: ['localhost', '127.0.0.1', '.ts.net', ...extraHosts],
    proxy: {
      // changeOrigin:true rewrites the Host header to the target
      // (localhost:3001), so the server can't recover the client's actual
      // host from `request.headers.host` alone (e.g. for the /api/browser/devtools
      // redirect's `ws=` param). xfwd:true adds X-Forwarded-Host/-Proto/-For
      // so the server can use those instead. See devtools.ts.
      '/api': { target: 'http://localhost:3001', changeOrigin: true, xfwd: true },
      '/devtools-fe': { target: 'http://localhost:3001', changeOrigin: true, xfwd: true },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        xfwd: true,
      },
    },
  },
})
