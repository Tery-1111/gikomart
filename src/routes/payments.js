const express = require('express');
const router = express.Router();
const { initiateBoost, handleWebhook } = require('../controllers/paymentController');

router.post('/boost', initiateBoost);
router.post('/webhook', handleWebhook);

module.exports = router;