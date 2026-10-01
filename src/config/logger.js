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
const { redact } = require('../utils/redact');
require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

const logDir = path.join(__dirname, '../../logs');

// Key-based redaction. Winston merges a call's meta argument into the info
// object, so `info` IS the meta carrier at this point in the pipeline — there
// is no discrete meta object to intercept separately. Runs after timestamp and
// errors (so those fields are present) and before the JSON/console format, so
// nothing sensitive is ever serialized. Mutates in place to keep winston's
// Symbol properties (level / splat / message) intact.
const redactMeta = winston.format((info) => {
  const safe = redact(info);
  for (const key of Object.keys(info)) {
    info[key] = safe[key];
  }
  return info;
})();

const logger = winston.createLogger({
  level: isProduction ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    redactMeta,
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