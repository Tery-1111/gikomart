const express = require('express');
const router = express.Router();
const {
  createListing,
  getListings,
  getListing,
  updateListing,
  deleteListing
} = require('../controllers/listingController');

router.post('/', createListing);
router.get('/', getListings);
router.get('/:id', getListing);
router.put('/:id', updateListing);
router.delete('/:id', deleteListing);

module.exports = router;