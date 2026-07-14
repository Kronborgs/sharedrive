// Declare Vite-injected globals
declare const __APP_VERSION__: string | undefined

export const APP_VERSION: string = __APP_VERSION__ ?? 'dev'
