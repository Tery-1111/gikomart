const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const sanitize = require('./src/middleware/sanitize');
const { globalLimiter } = require('./src/middleware/rateLimiter');
const logger = require('./src/config/logger');
require('dotenv').config();

// Fail fast on insecure production secrets BEFORE any route module is required
// (adminAuth reads ADMIN_SESSION_SECRET at module load). Development/test are
// exempt — see src/config/envGuard.js.
const { assertProductionSecrets, assertStartupConfig } = require('./src/config/envGuard');
assertProductionSecrets();

const { startCleanupScheduler } = require('./src/services/cleanupService');

const app = express();

// Proxy trust: bounds how many hops of X-Forwarded-For are believed so req.ip is
// the real client address, not the proxy. Never the boolean `true` (that trusts
// the whole chain, letting a client spoof its own address). 1 covers Render
// alone; set TRUST_PROXY=2 when Cloudflare proxies traffic.
const TRUST_PROXY = Number.parseInt(process.env.TRUST_PROXY, 10);
app.set('trust proxy', Number.isInteger(TRUST_PROXY) && TRUST_PROXY >= 0 ? TRUST_PROXY : 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "gc.zgo.at", "'sha256-rqVYfj8ffdtUcz9D4+PFMNRtvPCPi1wPxdcs0/GnAw0='"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com", "https://gikomart.goatcounter.com"],
      connectSrc: ["'self'", "https://gikomart.goatcounter.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Permissions-Policy — helmet 8 dropped this header (not in its options), so
// it is set directly. Disallow browser features the app does not use.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

app.use(compression());

// CORS — restrict to known origins. Allowlist is env-overridable (CORS_ORIGINS,
// comma-separated) so a dev port or new domain can never silently diverge from
// the API's real origin; the default matches production + localhost.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'https://gikomart.onrender.com,http://localhost:5000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (same-origin, mobile apps, curl)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
}));

const requestId = require('./src/middleware/requestId');
app.use(requestId);

// Global rate limiter
app.use(globalLimiter);

// Body must be parsed BEFORE the injection guard so req.body is populated.
app.use(express.json({ limit: '1mb' }));

// NoSQL injection guard
app.use(sanitize);

// Request logging — structured access log with status + latency.
// Uses req.originalUrl (never rewritten by routers) so logged paths are absolute.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const ip = req.ip;
    logger.info('request', {
      method: req.method,
      path: (req.originalUrl || req.url).split('?')[0],
      status: res.statusCode,
      ms,
      ip,
      userAgent: req.get('user-agent') || '',
    });
  });
  next();
});

// Static frontend. No build step and no hashed filenames, so /assets/* is cached
// for a week and everything that is HTML is left to revalidate on every load —
// index.html must never be cached long or a deploy would appear broken until the
// TTL lapsed.
app.use(express.static('public', require('./src/config/staticOptions')));

// Routes
app.use('/api/listings', require('./src/routes/listings'));
app.use('/api/upload', require('./src/routes/upload'));
app.use('/api/payments', require('./src/routes/payments'));
app.use('/api/admin', require('./src/routes/adminAuth'));
app.use('/api/admin', require('./src/routes/adminGrant'));
app.use('/api/admin', require('./src/routes/adminGrants'));
app.use('/api/grants', require('./src/routes/grants'));
app.use('/api/stores', require('./src/routes/stores'));
app.use('/api/terms', require('./src/routes/terms'));
app.use('/api/reports', require('./src/routes/reports'));
app.use('/api/vitals', require('./src/routes/vitals'));
app.use('/health', require('./src/routes/health'));

// Central error handler — must be the LAST middleware so every thrown/
// next(err)'d error is funnelled here and gated on NODE_ENV.
app.use(require('./src/middleware/errorHandler'));

if (require.main === module) {
  // Fail fast when the database is not configured — the API is useless without
  // it, and a silent start would leave the health check flapping forever.
  assertStartupConfig();
  mongoose.connect(process.env.MONGO_URI)
    .then(() => {
      logger.info('MongoDB connected');
      startCleanupScheduler();
    })
    .catch(err => logger.error('MongoDB connection error', { error: err.message }));

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
}

module.exports = app;