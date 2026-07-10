const express = require('express');
const router = express.Router();
const {
  getListings,
  getListing,
  updateListing,
  deleteListing
} = require('../controllers/listingController');
router.get('/', getListings);
router.get('/:id', getListing);
router.put('/:id', updateListing);
router.delete('/:id', deleteListing);
module.exports = router;