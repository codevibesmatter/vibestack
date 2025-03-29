/**
 * Logger utility for consistent logging across components
 */

// Log levels
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Logger configuration
interface LoggerConfig {
  showTimestamp: boolean;
  minLevel: LogLevel;
  colors: boolean;
  showLevel: boolean;
}

// Default configuration
const DEFAULT_CONFIG: LoggerConfig = {
  showTimestamp: true,
  minLevel: 'info',
  colors: true,
  showLevel: true
};

// Current configuration
let config: LoggerConfig = { ...DEFAULT_CONFIG };

// ANSI color codes
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

// Color mapping for components and levels
const COMPONENT_COLORS: Record<string, keyof typeof COLORS> = {
  POC: 'cyan',
  POCClient: 'green',
  POCClientWorker: 'green',
  POCDBWorker: 'blue',
  Client: 'green',
  RunPOC: 'magenta',
  CORE: 'magenta',
  TEST: 'yellow'
};

const LEVEL_COLORS: Record<LogLevel, keyof typeof COLORS> = {
  debug: 'gray',
  info: 'reset',
  warn: 'yellow',
  error: 'red'
};

// Short level names for compact display
const LEVEL_SHORT: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR'
};

// Log level priorities (higher number = higher priority)
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

/**
 * Create a logger instance for a specific component
 */
export function createLogger(component: string) {
  return {
    /**
     * Log a debug message
     */
    debug: (message: string): void => {
      logMessage(component, 'debug', message);
    },

    /**
     * Log an info message
     */
    info: (message: string): void => {
      logMessage(component, 'info', message);
    },

    /**
     * Log a warning message
     */
    warn: (message: string): void => {
      logMessage(component, 'warn', message);
    },

    /**
     * Log an error message
     */
    error: (message: string | Error): void => {
      const errorMessage = message instanceof Error
        ? `${message.message} (${message.stack?.split('\n')[1]?.trim() || 'no stack'})`
        : message;
      
      logMessage(component, 'error', errorMessage);
    }
  };
}

/**
 * Internal function to format and print log messages
 */
function logMessage(component: string, level: LogLevel, message: string): void {
  // Skip if level is below minimum
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[config.minLevel]) {
    return;
  }

  // Format timestamp if enabled
  const timestamp = config.showTimestamp
    ? `${new Date().toISOString().replace('T', ' ').substring(0, 19)} `
    : '';

  // Format component with color
  const componentColor = COMPONENT_COLORS[component] || 'reset';
  const levelColor = LEVEL_COLORS[level];
  
  // Format level if enabled
  const levelStr = config.showLevel ? `${LEVEL_SHORT[level]} ` : '';
  
  // Format the final message
  const prefix = config.colors
    ? `${COLORS.dim}${timestamp}${COLORS.reset}${COLORS[levelColor]}${levelStr}${COLORS[componentColor]}${COLORS.bold}[${component}]${COLORS.reset}`
    : `${timestamp}${levelStr}[${component}]`;
  
  // Write to console based on level
  switch (level) {
    case 'error':
      console.error(`${prefix} ${message}`);
      break;
    case 'warn':
      console.warn(`${prefix} ${message}`);
      break;
    default:
      console.log(`${prefix} ${message}`);
  }
}

/**
 * Configure logger settings
 */
export function configureLogger(newConfig: Partial<LoggerConfig>): void {
  config = { ...config, ...newConfig };
}

/**
 * Reset logger to default configuration
 */
export function resetLogger(): void {
  config = { ...DEFAULT_CONFIG };
}

// Export a default logger for general use
export const logger = createLogger('CORE'); 