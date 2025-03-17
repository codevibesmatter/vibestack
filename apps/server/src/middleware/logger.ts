import { MiddlewareHandler } from 'hono';
import type { LogLevel } from '../types/env';
import type { AppBindings } from '../types/hono';
import { logger } from '../utils/logger';

// Log level priorities (for comparison)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  'debug': 0,
  'info': 1,
  'warn': 2,
  'error': 3
};

// Helper to compare log levels
const isLogLevelEnabled = (configLevel: LogLevel, checkLevel: LogLevel): boolean => {
  return LOG_LEVEL_PRIORITY[configLevel] <= LOG_LEVEL_PRIORITY[checkLevel];
};

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  blink: '\x1b[5m',
  reverse: '\x1b[7m',
  hidden: '\x1b[8m',
  
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

// Logger configuration
export interface LoggerConfig {
  level: LogLevel;
  prettyPrint?: boolean;
  includeRequestBody?: boolean;
  includeResponseBody?: boolean;
  includeHeaders?: boolean;
  excludePaths?: string[];
  excludeHeaders?: string[];
  useColors?: boolean;
  jsonIndent?: number;
  timestampFormat?: 'none' | 'short' | 'time' | 'full';
}

// Default configuration based on environment
const getDefaultConfig = (): LoggerConfig => {
  // Set timestamp format to 'none' by default
  const timestampFormat = process.env.LOG_TIMESTAMP_FORMAT as LoggerConfig['timestampFormat'] || 'none';
  
  return {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    prettyPrint: process.env.NODE_ENV !== 'production',
    includeRequestBody: process.env.NODE_ENV !== 'production',
    includeResponseBody: false,
    includeHeaders: process.env.NODE_ENV !== 'production',
    excludePaths: ['/health', '/api/health'],
    excludeHeaders: ['authorization', 'cookie'],
    useColors: process.env.NODE_ENV !== 'production',
    jsonIndent: 2,
    timestampFormat
  };
};

/**
 * Format a timestamp based on the configured format
 * @param date The date to format
 * @param format The timestamp format to use
 * @returns Formatted timestamp or empty string if format is 'none'
 */
const formatTimestamp = (date: Date, format: LoggerConfig['timestampFormat'] = 'full'): string => {
  if (format === 'none') return '';
  
  const pad = (num: number) => num.toString().padStart(2, '0');
  
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  const millis = date.getMilliseconds().toString().padStart(3, '0');
  
  // Short format: HH:MM:SS
  if (format === 'short') {
    return `${hours}:${minutes}:${seconds}`;
  }
  
  // Time format: HH:MM:SS.mmm
  if (format === 'time') {
    return `${hours}:${minutes}:${seconds}.${millis}`;
  }
  
  // Full format: YYYY-MM-DD HH:MM:SS.mmm
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`;
};

/**
 * Format data for pretty printing
 * @param data The data to format
 * @param config Logger configuration
 * @returns Formatted data string
 */
const formatData = (data: any, config: LoggerConfig): string => {
  if (!data) return '';
  
  try {
    if (typeof data === 'string') return data;
    
    if (config.prettyPrint && config.jsonIndent) {
      // For objects, format with proper indentation and colors
      const formatted = JSON.stringify(data, null, config.jsonIndent);
      
      if (!config.useColors) return '\n' + formatted;
      
      // Add colors to JSON keys and values
      return '\n' + formatted
        .replace(/^(\s*)(".*?"):/gm, `$1${colors.cyan}$2${colors.reset}:`) // Color keys
        .replace(/: (".*?")([,\n]|$)/g, `: ${colors.green}$1${colors.reset}$2`) // Color string values
        .replace(/: (true|false)([,\n]|$)/g, `: ${colors.yellow}$1${colors.reset}$2`) // Color boolean values
        .replace(/: (\d+)([,\n]|$)/g, `: ${colors.magenta}$1${colors.reset}$2`); // Color number values
    }
    
    return JSON.stringify(data);
  } catch (err) {
    return String(data);
  }
};

/**
 * Get color for log level
 * @param level Log level
 * @param config Logger configuration
 * @returns Color code or empty string
 */
const getLevelColor = (level: string, config: LoggerConfig): string => {
  if (!config.useColors) return '';
  
  switch (level.toLowerCase()) {
    case 'debug': return colors.gray;
    case 'info': return colors.green;
    case 'warn': return colors.yellow;
    case 'error': return colors.red;
    default: return '';
  }
};

/**
 * Get emoji for log level
 * @param level Log level
 * @returns Emoji for the log level
 */
const getLevelEmoji = (level: string): string => {
  switch (level.toLowerCase()) {
    case 'debug': return '🔍';
    case 'info': return 'ℹ️';
    case 'warn': return '⚠️';
    case 'error': return '❌';
    default: return '📝';
  }
};

/**
 * Get color for context
 * @param context Context name
 * @param config Logger configuration
 * @returns Color code or empty string
 */
const getContextColor = (context: string | undefined, config: LoggerConfig): string => {
  if (!context || !config.useColors) return '';
  
  // Assign consistent colors to different contexts
  const contextColors: Record<string, string> = {
    'sync': colors.cyan,
    'connection': colors.blue,
    'replication': colors.magenta,
    'api': colors.green,
    'db': colors.yellow,
    'auth': colors.red,
    'storage': colors.blue,
    'worker': colors.magenta
  };
  
  return contextColors[context.toLowerCase()] || colors.white;
};

// Helper function to format the timestamp part of the log message
const getTimestampPrefix = (timestamp: string, config: LoggerConfig): string => {
  if (config.timestampFormat === 'none' || !timestamp) return '';
  
  const timeColor = config.useColors ? colors.dim : '';
  const reset = config.useColors ? colors.reset : '';
  
  return `${timeColor}[${timestamp}]${reset} `;
};

/**
 * Create a structured logger middleware
 * Logs request/response information and timing
 */
export function createStructuredLogger(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const startTime = Date.now();
    const method = c.req.method;
    const url = new URL(c.req.url);

    try {
      await next();
      const endTime = Date.now();
      const duration = endTime - startTime;

      logger.info('Request completed', {
        method,
        url: url.toString(),
        status: c.res.status,
        duration
      });
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;

      logger.error('Request failed', {
        method,
        url: url.toString(),
        error,
        duration
      });

      throw error;
    }
  };
}

// Utility logger for non-request contexts
export const serverLogger = {
  debug(message: string, data?: any, context?: string): void {
    if (getDefaultConfig().level === 'debug') {
      const config = getDefaultConfig();
      const timestamp = formatTimestamp(new Date(), config.timestampFormat);
      const contextStr = context ? `[${context}]` : '';
      const logData = {
        level: 'debug',
        message,
        context,
        data,
        timestamp
      };
      
      if (config.prettyPrint) {
        const levelColor = getLevelColor('debug', config);
        const contextColor = getContextColor(context, config);
        const timeColor = config.useColors ? colors.dim : '';
        const reset = config.useColors ? colors.reset : '';
        const emoji = getLevelEmoji('debug');
        
        // Print the log header
        console.debug(
          `${getTimestampPrefix(timestamp, config)}${levelColor}${emoji}${reset} ${contextColor}${contextStr}${reset} ${message}`
        );
        
        // Print data on a new line if it exists
        if (data) {
          console.debug(formatData(data, config));
        }
      } else {
        console.debug(JSON.stringify(logData));
      }
    }
  },
  
  info(message: string, data?: any, context?: string): void {
    const config = getDefaultConfig();
    if (config.level === 'debug' || config.level === 'info') {
      const timestamp = formatTimestamp(new Date(), config.timestampFormat);
      const contextStr = context ? `[${context}]` : '';
      const logData = {
        level: 'info',
        message,
        context,
        data,
        timestamp
      };
      
      if (config.prettyPrint) {
        const levelColor = getLevelColor('info', config);
        const contextColor = getContextColor(context, config);
        const timeColor = config.useColors ? colors.dim : '';
        const reset = config.useColors ? colors.reset : '';
        const emoji = getLevelEmoji('info');
        
        // Print the log header
        console.log(
          `${getTimestampPrefix(timestamp, config)}${levelColor}${emoji}${reset} ${contextColor}${contextStr}${reset} ${message}`
        );
        
        // Print data on a new line if it exists
        if (data) {
          console.log(formatData(data, config));
        }
      } else {
        console.log(JSON.stringify(logData));
      }
    }
  },
  
  warn(message: string, data?: any, context?: string): void {
    if (getDefaultConfig().level === 'warn') {
      const config = getDefaultConfig();
      const timestamp = formatTimestamp(new Date(), config.timestampFormat);
      const contextStr = context ? `[${context}]` : '';
      const logData = {
        level: 'warn',
        message,
        context,
        data,
        timestamp
      };
      
      if (config.prettyPrint) {
        const levelColor = getLevelColor('warn', config);
        const contextColor = getContextColor(context, config);
        const timeColor = config.useColors ? colors.dim : '';
        const reset = config.useColors ? colors.reset : '';
        const emoji = getLevelEmoji('warn');
        
        // Print the log header
        console.warn(
          `${getTimestampPrefix(timestamp, config)}${levelColor}${emoji}${reset} ${contextColor}${contextStr}${reset} ${message}`
        );
        
        // Print data on a new line if it exists
        if (data) {
          console.warn(formatData(data, config));
        }
      } else {
        console.warn(JSON.stringify(logData));
      }
    }
  },
  
  error(message: string, error?: any, data?: any, context?: string): void {
    if (getDefaultConfig().level === 'error') {
      const config = getDefaultConfig();
      const timestamp = formatTimestamp(new Date(), config.timestampFormat);
      const contextStr = context ? `[${context}]` : '';
      const logData = {
        level: 'error',
        message,
        context,
        error: error instanceof Error ? {
          name: error.name,
          message: error.message,
          stack: error.stack
        } : error,
        data,
        timestamp
      };
      
      if (config.prettyPrint) {
        const levelColor = getLevelColor('error', config);
        const contextColor = getContextColor(context, config);
        const timeColor = config.useColors ? colors.dim : '';
        const reset = config.useColors ? colors.reset : '';
        const emoji = getLevelEmoji('error');
        
        // Print the log header
        console.error(
          `${getTimestampPrefix(timestamp, config)}${levelColor}${emoji}${reset} ${contextColor}${contextStr}${reset} ${message}`
        );
        
        // Print error if it exists
        if (error) {
          if (error instanceof Error) {
            console.error(`${levelColor}${error.message}${reset}`);
            if (error.stack) {
              console.error(`${levelColor}${error.stack.split('\n').slice(1).join('\n')}${reset}`);
            }
          } else {
            console.error(formatData(error, config));
          }
        }
        
        // Print data on a new line if it exists
        if (data) {
          console.error(formatData(data, config));
        }
      } else {
        console.error(JSON.stringify(logData));
      }
    }
  },
  
  /**
   * Create a context-specific logger (backward compatibility)
   * @param context The context name
   * @returns A logger instance with the specified context
   * @deprecated Use createLogger instead
   */
  withContext(context: string) {
    return this.createLogger(context);
  },
  
  /**
   * Create a context-specific logger
   * @param context The context name
   * @param config Optional configuration overrides
   * @returns A logger instance with the specified context
   */
  createLogger(context: string, config?: Partial<LoggerConfig>) {
    const mergedConfig = { ...getDefaultConfig(), ...config };
    
    return {
      debug: (message: string, data?: any) => 
        serverLogger.debug(message, data, context),
      
      info: (message: string, data?: any) => 
        serverLogger.info(message, data, context),
      
      warn: (message: string, data?: any) => 
        serverLogger.warn(message, data, context),
      
      error: (message: string, error?: any, data?: any) => 
        serverLogger.error(message, error, data, context),
      
      // Configure timestamp format for this logger instance
      withTimestampFormat(format: LoggerConfig['timestampFormat']) {
        return serverLogger.createLogger(context, { ...mergedConfig, timestampFormat: format });
      },
      
      // Create a logger with no timestamps
      withoutTimestamps() {
        return this.withTimestampFormat('none');
      },
      
      // Create a logger with short timestamps (HH:MM:SS)
      withShortTimestamps() {
        return this.withTimestampFormat('short');
      },
      
      // Create a logger with time-only timestamps (HH:MM:SS.mmm)
      withTimeTimestamps() {
        return this.withTimestampFormat('time');
      },
      
      // Create a logger with full timestamps (YYYY-MM-DD HH:MM:SS.mmm)
      withFullTimestamps() {
        return this.withTimestampFormat('full');
      }
    };
  }
};

// Create context-specific loggers
export const syncLogger = serverLogger.createLogger('sync');
export const connectionLogger = serverLogger.createLogger('connection');
export const replicationLogger = serverLogger.createLogger('replication');
export const apiLogger = serverLogger.createLogger('api');
export const dbLogger = serverLogger.createLogger('db');
export const authLogger = serverLogger.createLogger('auth');
export const storageLogger = serverLogger.createLogger('storage');
export const workerLogger = serverLogger.createLogger('worker'); 