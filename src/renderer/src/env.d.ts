/// <reference types="vite/client" />

import type { WindowApi } from '@shared/api'

declare global {
  interface Window {
    idraw?: WindowApi
  }
}

export {}
