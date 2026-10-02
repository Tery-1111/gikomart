const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Public health reports only whether MongoDB is up; details are in
// /api/admin/health.
router.get('/', (req, res) => {
  const healthy = mongoose.connection.readyState === 1;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'unhealthy',
  });
});

module.exports = router;