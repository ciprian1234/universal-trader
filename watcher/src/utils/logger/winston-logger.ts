import winston from 'winston';
import path from 'path';
import DailyRotateFile from 'winston-daily-rotate-file';
import { formatMeta } from './serialization';
import type { Logger } from './interface';

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Define colors for console output
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  debug: 'blue',
};

winston.addColors(colors);

// ===============================================================
// Formats
// ===============================================================
// Custom format for console (colorized, readable)
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, context, ...meta }) => {
    const contextStr = context ? (context as string).padEnd(23) : ''; // Fixed width for context
    const metaStr = formatMeta(meta); // safe serialization for logging
    return `${timestamp} ${level} ${contextStr} ${message} ${metaStr}`;
  }),
);

// Custom format for files (JSON, structured)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.printf(({ timestamp, level, message, context, ...meta }) => {
    const contextStr = context ? (context as string).padEnd(23) : ''; // Fixed width for context
    const metaStr = formatMeta(meta); // safe serialization for logging
    return `${timestamp} ${level} ${contextStr} ${message} ${metaStr}`;
  }),
);

// ===============================================================
// Transports
// ===============================================================

// Create logs on following directory
const logsDir = path.join(process.cwd(), 'data/logs');

// console transport
const consoleTransport = new winston.transports.Console({
  format: consoleFormat,
  level: process.env.LOG_LEVEL || 'info', // Control via env var
});

// File transport with daily rotation
const infoFileRotateTransport = new DailyRotateFile({
  filename: path.join(logsDir, 'info-%DATE%.log'),
  datePattern: 'DD-MM-YYYY',
  maxSize: '30m', // Max 30MB per file
  maxFiles: '14d', // Keep 14 days
  format: fileFormat,
  level: 'info', // Log everything to file
});

// Error file transport (separate file for errors)
const errorFileRotateTransport = new DailyRotateFile({
  filename: path.join(logsDir, 'error-%DATE%.log'),
  datePattern: 'DD-MM-YYYY',
  maxSize: '30m',
  maxFiles: '30d', // Keep errors longer
  format: fileFormat,
  level: 'warn', // Only errors and warnings
});

// exception and rejection handlers
const exceptionOrRejectionTransport = new winston.transports.File({
  filename: path.join(logsDir, 'exceptions_or_rejections.log'),
  format: fileFormat,
  level: 'debug',
});

// ===============================================================
// Logger instance
// ===============================================================

const transports: winston.transport[] = [infoFileRotateTransport, errorFileRotateTransport];
if (process.env.NODE_ENV === 'development') transports.push(consoleTransport); // Only log to console in development

// Create the logger
export const logger = winston.createLogger({
  levels,
  transports,

  // Handle uncaught exceptions and rejections
  exceptionHandlers: [exceptionOrRejectionTransport],
  rejectionHandlers: [exceptionOrRejectionTransport],
});

// Create child logger with context
export function createLogger(context: string): Logger {
  return {
    error: (message: string, meta?: any) => logger.error(message, { context, ...meta }),
    warn: (message: string, meta?: any) => logger.warn(message, { context, ...meta }),
    info: (message: string, meta?: any) => logger.info(message, { context, ...meta }),
    debug: (message: string, meta?: any) => logger.debug(message, { context, ...meta }),
  };
}
