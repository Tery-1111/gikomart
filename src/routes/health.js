const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const cloudinary = require('../config/cloudinary');

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

  const healthy = checks.mongodb && checks.cloudinary;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;