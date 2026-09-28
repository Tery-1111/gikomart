const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const cloudinary = require('../config/cloudinary');

// /health backs the uptime monitor: 200 whenever the API can do its core job
// (MongoDB up), 503 only when it cannot. Cloudinary is reported for
// observability but does NOT gate the status — an image-CDN blip must not
// flap uptime alerts or trigger Render restarts for an otherwise-working API.
router.get('/', async (req, res) => {
  const checks = {
    mongodb: mongoose.connection.readyState === 1,
    cloudinary: false,
  };

  try {
    await cloudinary.api.ping();
    checks.cloudinary = true;
  } catch (err) {
    checks.cloudinary = false;
  }

  const healthy = checks.mongodb; // only the critical dependency gates 200/503

  res.status(healthy ? 200 : 503).json({
    status: healthy ? (checks.cloudinary ? 'healthy' : 'degraded') : 'unhealthy',
    checks,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;