import { attachPrintApi } from './print-api.mjs'

export function printApiPlugin() {
  return {
    name: 'local-print-api',
    configureServer(server) {
      attachPrintApi(server.middlewares)
    },
    configurePreviewServer(server) {
      attachPrintApi(server.middlewares)
    },
  }
}
