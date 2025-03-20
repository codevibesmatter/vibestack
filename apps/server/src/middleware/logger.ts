import { MiddlewareHandler } from 'hono';
import type { LogLevel, DeploymentEnv } from '../types/env';
import type { AppBindings } from '../types/hono';

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
const getDefaultConfig = (environment: DeploymentEnv = 'production'): LoggerConfig => {
  // Set timestamp format to 'none' by default
  const timestampFormat = 'none';
  const isProduction = environment === 'production';
  
  return {
    level: isProduction ? 'info' : 'debug',
    prettyPrint: !isProduction,
    includeRequestBody: !isProduction,
    includeResponseBody: false,
    includeHeaders: !isProduction,
    excludePaths: ['/health', '/api/health'],
    excludeHeaders: ['authorization', 'cookie'],
    useColors: !isProduction,
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
 * @param module Module name
 * @param config Logger configuration
 * @returns Color code or empty string
 */
const getContextColor = (context: string | undefined, module: string | undefined, config: LoggerConfig): string => {
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

/**
 * Format context string with optional module
 */
const getContextString = (context?: string, module?: string): string => {
  if (!context) return '';
  return module ? `[${context}:${module}] ` : `[${context}] `;
};

// Helper function to format the timestamp part of the log message
const getTimestampPrefix = (timestamp: string, config: LoggerConfig): string => {
  if (config.timestampFormat === 'none' || !timestamp) return '';
  
  const timeColor = config.useColors ? colors.dim : '';
  const reset = config.useColors ? colors.reset : '';
  
  return `${timeColor}[${timestamp}]${reset} `;
};

/**
 * Base logger implementation
 */
export const logger = {
  debug(message: string, data?: any, context?: string, module?: string, environment?: DeploymentEnv): void {
    const config = getDefaultConfig(environment);
    if (!isLogLevelEnabled(config.level, 'debug')) return;
    
    const timestamp = formatTimestamp(new Date(), config.timestampFormat);
    const contextStr = getContextString(context, module);
    const levelColor = getLevelColor('debug', config);
    const contextColor = getContextColor(context, module, config);
    const emoji = getLevelEmoji('debug');
    
    console.debug(
      `${getTimestampPrefix(timestamp, config)}${levelColor}${emoji} DEBUG${colors.reset} ${contextColor}${contextStr}${colors.reset}${message}`,
      data ? formatData(data, config) : ''
    );
  },

  info(message: string, data?: any, context?: string, module?: string, environment?: DeploymentEnv): void {
    const config = getDefaultConfig(environment);
    if (!isLogLevelEnabled(config.level, 'info')) return;
    
    const timestamp = formatTimestamp(new Date(), config.timestampFormat);
    const contextStr = getContextString(context, module);
    const levelColor = getLevelColor('info', config);
    const contextColor = getContextColor(context, module, config);
    const emoji = getLevelEmoji('info');
    
    console.info(
      `${getTimestampPrefix(timestamp, config)}${levelColor}${emoji} INFO${colors.reset} ${contextColor}${contextStr}${colors.reset}${message}`,
      data ? formatData(data, config) : ''
    );
  },

  warn(message: string, data?: any, context?: string, module?: string, environment?: DeploymentEnv): void {
    const config = getDefaultConfig(environment);
    if (!isLogLevelEnabled(config.level, 'warn')) return;
    
    const timestamp = formatTimestamp(new Date(), config.timestampFormat);
    const contextStr = getContextString(context, module);
    const levelColor = getLevelColor('warn', config);
    const contextColor = getContextColor(context, module, config);
    const emoji = getLevelEmoji('warn');
    
    console.warn(
      `${getTimestampPrefix(timestamp, config)}${levelColor}${emoji} WARN${colors.reset} ${contextColor}${contextStr}${colors.reset}${message}`,
      data ? formatData(data, config) : ''
    );
  },

  error(message: string, errorOrData?: any, additionalData?: any, context?: string, module?: string, environment?: DeploymentEnv): void {
    const config = getDefaultConfig(environment);
    if (!isLogLevelEnabled(config.level, 'error')) return;
    
    const timestamp = formatTimestamp(new Date(), config.timestampFormat);
    const contextStr = getContextString(context, module);
    const levelColor = getLevelColor('error', config);
    const contextColor = getContextColor(context, module, config);
    const emoji = getLevelEmoji('error');
    
    // Handle both error objects and data objects
    let errorObject: any = undefined;
    let dataObject: any = undefined;
    
    if (errorOrData instanceof Error) {
      errorObject = errorOrData;
      dataObject = additionalData;
    } else {
      dataObject = errorOrData;
    }
    
    console.error(
      `${getTimestampPrefix(timestamp, config)}${levelColor}${emoji} ERROR${colors.reset} ${contextColor}${contextStr}${colors.reset}${message}`,
      errorObject,
      dataObject ? formatData(dataObject, config) : ''
    );
  },

  createLogger(context: string, defaultModule?: string) {
    return {
      debug: (message: string, data?: any, module?: string, environment?: DeploymentEnv) => 
        this.debug(message, data, context, module || defaultModule, environment),
      info: (message: string, data?: any, module?: string, environment?: DeploymentEnv) => 
        this.info(message, data, context, module || defaultModule, environment),
      warn: (message: string, data?: any, module?: string, environment?: DeploymentEnv) => 
        this.warn(message, data, context, module || defaultModule, environment),
      error: (message: string, errorOrData?: any, additionalData?: any, module?: string, environment?: DeploymentEnv) => 
        this.error(message, errorOrData, additionalData, context, module || defaultModule, environment)
    };
  }
};

// Create specialized loggers
export const serverLogger = logger.createLogger('server');
export const syncLogger = logger.createLogger('sync');
export const replicationLogger = logger.createLogger('replication');
export const dbLogger = logger.createLogger('db');
export const apiLogger = logger.createLogger('api');
export const workerLogger = logger.createLogger('worker');

/**
 * Create a structured logger middleware
 * Logs request/response information and timing
 */
export function createStructuredLogger(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const startTime = Date.now();
    const method = c.req.method;
    const url = new URL(c.req.url);
    const environment = c.env.ENVIRONMENT;

    try {
      await next();
      const endTime = Date.now();
      const duration = endTime - startTime;

      logger.info('Request completed', {
        method,
        url: url.toString(),
        status: c.res.status,
        duration
      }, undefined, environment);
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;

      logger.error('Request failed', error, {
        method,
        url: url.toString(),
        duration
      }, undefined, environment);

      throw error;
    }
  };
} 