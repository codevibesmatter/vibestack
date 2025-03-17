import type { LogLevel } from '../types/env';

interface LoggerConfig {
  level: LogLevel;
  useColors: boolean;
  prettyPrint: boolean;
}

class Logger {
  private config: LoggerConfig;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = {
      level: 'info',
      useColors: true,
      prettyPrint: true,
      ...config
    };
  }

  debug(message: string, data?: Record<string, any>) {
    if (this.config.level === 'debug') {
      this.log('debug', message, data);
    }
  }

  info(message: string, data?: Record<string, any>) {
    if (this.config.level === 'debug' || this.config.level === 'info') {
      this.log('info', message, data);
    }
  }

  warn(message: string, data?: Record<string, any>) {
    if (this.config.level !== 'error') {
      this.log('warn', message, data);
    }
  }

  error(message: string, data?: Record<string, any>) {
    this.log('error', message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, any>) {
    const timestamp = new Date().toISOString();
    const logData = {
      level,
      message,
      timestamp,
      ...data
    };

    if (this.config.prettyPrint) {
      const levelColor = this.getLevelColor(level);
      const reset = this.config.useColors ? '\x1b[0m' : '';
      
      console.log(`${timestamp} ${levelColor}${level.toUpperCase()}${reset} ${message}`);
      if (data) {
        console.log(JSON.stringify(data, null, 2));
      }
    } else {
      console.log(JSON.stringify(logData));
    }
  }

  private getLevelColor(level: LogLevel): string {
    if (!this.config.useColors) return '';

    switch (level) {
      case 'debug': return '\x1b[90m'; // Gray
      case 'info': return '\x1b[32m';  // Green
      case 'warn': return '\x1b[33m';  // Yellow
      case 'error': return '\x1b[31m'; // Red
      default: return '';
    }
  }
}

export const logger = new Logger(); 