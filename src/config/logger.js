/**
 * Structured Logging Configuration (winston)
 *
 * Console transport: JSON format in production, colored/readable in development.
 * File transport: error-level only, written to logs/error.log (rotated daily).
 *
 * Phase 4A — Security Hardening
 */
const winston = require('winston');
const path = require('path');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

const logDir = path.join(__dirname, '../../logs');

const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    isProduction
      ? winston.format.json()
      : winston.format.printf(({ timestamp, level, message, stack }) => {
          const meta = stack ? `\n${stack}` : '';
          return `${timestamp} [${level.toUpperCase()}] ${message}${meta}`;
        })
  ),
  transports: [
    new winston.transports.File({
      dirname: logDir,
      filename: 'error.log',
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.File({
      dirname: logDir,
      filename: 'combined.log',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  ],
  exceptionHandlers: [
    new winston.transports.File({ dirname: logDir, filename: 'exceptions.log' }),
  ],
});

// In development/test, also log to console
if (process.env.NODE_ENV !== 'test') {
  logger.add(new winston.transports.Console({
    format: isProduction
      ? winston.format.simple()
      : winston.format.printf(({ timestamp, level, message }) =>
          `${timestamp} [${level.toUpperCase()}] ${message}`),
  }));
}

module.exports = logger;