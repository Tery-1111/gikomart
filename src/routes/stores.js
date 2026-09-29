const express = require('express');
const router = express.Router();
const storeAuth = require('../middleware/storeAuth');
const { getStore, getStoreById, getMyStores, updateStore, deleteStore, attachListing, detachListing } = require('../controllers/storeController');

// Public
router.get('/slug/:slug', getStore);

// Owner-gated (requires X-Store-Owner-Token)
router.get('/me/all', getMyStores);
router.get('/:id', getStoreById);
router.put('/:id', storeAuth({ requireActive: true }), updateStore);
// Deletion additionally allows a valid admin session (post-2FA), so an admin
// can remove any store; `storeAuth({ allowAdmin: true })` records which
// credential type authorized the delete on req.storeCredentialType for the
// audit trail (see storeController.deleteStore).
router.delete('/:id', storeAuth({ allowAdmin: true }), deleteStore);
router.put('/:id/attach-listing', storeAuth({ requireActive: true }), attachListing);
router.put('/:id/detach-listing', storeAuth({ requireActive: true }), detachListing);

module.exports = router;
