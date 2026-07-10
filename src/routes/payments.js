const express = require('express');
const router = express.Router();
const { initiateBoost, initiateListing, handleWebhook } = require('../controllers/paymentController');
router.post('/boost', initiateBoost);
router.post('/initiate-listing', initiateListing);
router.post('/webhook', handleWebhook);
module.exports = router;