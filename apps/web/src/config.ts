/**
 * Environment configuration
 */
export const config = {
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:8787',
  wsUrl: (import.meta.env.VITE_API_URL || 'http://localhost:8787').replace(/^http/, 'ws')
} as const;

// Type for our config
export type Config = typeof config; 