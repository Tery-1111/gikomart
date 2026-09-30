/**
 * Request-ID Middleware
 *
 * Assigns every HTTP request a unique, correlate-able identifier (UUID v4) that
 * threads through the response header (X-Request-ID) and the central error
 * handler so server-side error logs can be matched back to the originating
 * request.
 *
 * Placed immediately after the global rate limiter so it runs before any route
 * or the body-parsing / request-logging middleware that may need it.
 */
const { randomUUID } = require('node:crypto');

module.exports = function requestId(req, res, next) {
  const id = randomUUID();
  req.id = id;
  res.setHeader('X-Request-ID', id);

  res.on('finish', () => {
    // No-op guard: in Express 5 the res finish hook may fire before
    // middleware grafted onto res after this module shares the same res.
    // The header was already set on the res object itself.
  });

  next();
};
