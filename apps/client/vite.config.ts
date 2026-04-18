import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const backendTarget =
  process.env.VITE_BACKEND_URL ??
  derivePortlessServiceUrl(process.env.PORTLESS_URL, "hylo", "api.hylo") ??
  "http://localhost:8787"

const backendProxy = {
  target: backendTarget,
  changeOrigin: true,
  secure: false,
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/doc": backendProxy,
      "/graph": backendProxy,
      "/health": backendProxy,
      "/runs": backendProxy,
      "/state": backendProxy,
    },
  },
})

function derivePortlessServiceUrl(
  sourceUrl: string | undefined,
  sourceName: string,
  targetName: string,
): string | undefined {
  if (!sourceUrl) return undefined

  try {
    const url = new URL(sourceUrl)
    const sourcePrefix = `${sourceName}.`
    const sourceMarker = `.${sourceName}.`

    if (url.hostname.startsWith(sourcePrefix)) {
      url.hostname = `${targetName}.${url.hostname.slice(sourcePrefix.length)}`
      return url.origin
    }

    const markerIndex = url.hostname.indexOf(sourceMarker)
    if (markerIndex === -1) return undefined

    const prefix = url.hostname.slice(0, markerIndex)
    const suffix = url.hostname.slice(markerIndex + sourceMarker.length)
    url.hostname = `${prefix}.${targetName}.${suffix}`
    return url.origin
  } catch {
    return undefined
  }
}
