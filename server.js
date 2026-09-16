const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');
const sanitize = require('./src/middleware/sanitize');
const { globalLimiter } = require('./src/middleware/rateLimiter');
const logger = require('./src/config/logger');
require('dotenv').config();
const { startCleanupScheduler } = require('./src/services/cleanupService');

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "gc.zgo.at", "us.i.posthog.com", "us-assets.i.posthog.com", "eu.i.posthog.com", "eu-assets.i.posthog.com", "'sha256-rqVYfj8ffdtUcz9D4+PFMNRtvPCPi1wPxdcs0/GnAw0='"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
      connectSrc: ["'self'", "https://gikomart.goatcounter.com", "https://us.i.posthog.com", "https://eu.i.posthog.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(compression());

// CORS — restrict to known origins
const ALLOWED_ORIGINS = [
  'https://gikomart.onrender.com',
  'http://localhost:5000',
];
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
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
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

app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    logger.info('MongoDB connected');
    startCleanupScheduler();
  })
  .catch(err => logger.error('MongoDB connection error', { error: err.message }));

// Routes
app.use('/api/listings', require('./src/routes/listings'));
app.use('/api/upload', require('./src/routes/upload'));
app.use('/api/payments', require('./src/routes/payments'));
app.use('/api/admin', require('./src/routes/adminAuth'));
app.use('/health', require('./src/routes/health'));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => logger.info(`Server running on port ${PORT}`));