const logger = require('../config/logger');

module.exports = function errorHandler(err, req, res, next) {
  // 1. If headers already sent, delegate.
  if (res.headersSent) {
    return next(err);
  }

  // 2. Determine status.
  let status = err && (err.status || err.statusCode);
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    status = 500;
  }

  // 3. Log.
  logger.error('request_failed', {
    method: req.method,
    url: req.originalUrl,
    status,
    message: err && err.message,
    stack: err && err.stack,
    requestId: req.id,
  });

  // 4. Body.
  const isProd = process.env.NODE_ENV === 'production';
  let body;
  if (isProd) {
    body = { error: status >= 500 ? 'Internal Server Error' : (err && err.publicMessage) || 'Bad Request' };
  } else {
    body = { error: err && err.message, stack: err && err.stack };
  }

  res.status(status).json(body);
};
