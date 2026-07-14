// Declare Vite-injected globals
declare const __APP_VERSION__: string

export const APP_VERSION: string =
  __APP_VERSION__ !== undefined ? __APP_VERSION__ : 'dev'
