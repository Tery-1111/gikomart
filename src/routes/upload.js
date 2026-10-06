const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const cloudinary = require('../config/cloudinary');
const { uploadLimiter, uploadDailyLimiter } = require('../middleware/rateLimiter');
const Upload = require('../models/Upload');
const logger = require('../config/logger');
const { createSemaphore } = require('../utils/semaphore');

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024, files: 1 }, // 3MB max, single file
});

// Bound concurrent sharp decoding. A single decode can allocate tens of MB at
// the 25 MP input cap, and the route awaits sharp inline in the request, so
// without a limit enough parallel uploads can exhaust the process. Three decode
// at once, up to ten more wait; beyond that the caller is asked to retry rather
// than queued indefinitely.
const uploadSemaphore = createSemaphore(3, 10);

// MIME types we accept despite what the client claims. The actual format is
// validated by magic-byte sniffing (file-type), so an attacker can't bypass
// the check by forging the Content-Type header.
const ACCEPTED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

// Multer errors (LIMIT_FILE_SIZE etc.) are client faults: return 4xx instead
// of letting them fall through to the generic 500 error handler.
function handleMulterError(err, req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, error: 'Image must be 3 MB or smaller' });
  }
  if (err && err.code && err.code.startsWith('LIMIT_')) {
    return res.status(400).json({ success: false, error: 'Upload rejected: ' + err.code });
  }
  return next(err);
}

router.post('/', uploadLimiter, uploadDailyLimiter, upload.single('image'), handleMulterError, async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    // Server-side MIME check via magic bytes, independent of client-declared type
    const { fileTypeFromBuffer } = await import('file-type');
    const detected = await fileTypeFromBuffer(req.file.buffer);
    if (!detected || !ACCEPTED_MIME.has(detected.mime)) {
      return res.status(400).json({ success: false, error: 'Only JPG, PNG, WEBP, or GIF images are allowed' });
    }

    // Reject GIF frames (potential denial-of-service via decompression bombs)
    // by re-encoding stills only. Animated GIFs slide through fine after this
    // because sharp re-encodes to a single still — acceptable behaviour here.
    // Acquire a decode slot BEFORE touching sharp. This needs its own try/catch:
    // the sharp block below answers 400 for ANY error, so a shared catch would
    // misreport an overloaded server as a client-side bad image.
    let release;
    try {
      release = await uploadSemaphore.acquire();
    } catch (err) {
      if (err && err.code === 'UPLOAD_BUSY') {
        return res.status(503).json({ success: false, error: 'Server busy — please try again in a moment', requestId: req.id });
      }
      throw err;
    }

    let data;
    try {
      // limitInputPixels caps DECODE, not output: a solid-colour PNG can declare
      // far more pixels than its file size suggests, so without an explicit cap
      // sharp falls back to its ~268 MP library default and happily allocates
      // hundreds of MB of raw pixels for a sub-3 MB upload.
      ({ data } = await sharp(req.file.buffer, { animated: false, limitInputPixels: 25_000_000 })
        // Strip metadata (EXIF contains location + camera data) and cap resolution.
        .rotate() // bake EXIF orientation into pixels
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer({ resolveWithObject: true }));
    } catch (err) {
      // Corrupt/malformed image bytes that passed magic-byte sniffing are the
      // caller's fault — a 4xx bad request, not a 5xx server error.
      return res.status(400).json({ success: false, error: 'Image could not be processed' });
    } finally {
      // Always return the slot, whether the decode succeeded or 400'd.
      release();
    }

    const b64 = Buffer.from(data).toString('base64');
    const dataURI = `data:image/jpeg;base64,${b64}`;

    const result = await cloudinary.uploader.upload(dataURI, {
      folder: 'gikomart',
      resource_type: 'image',
      quality: 'auto',
      fetch_format: 'auto',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    });

    // Track the asset so cleanupService can destroy uploads that are never
    // attached to a paid listing/store (orphan sweep). A bookkeeping failure
    // must not fail an upload that already succeeded in Cloudinary.
    try {
      await Upload.create({ publicId: result.public_id, url: result.secure_url });
    } catch (err) {
      logger.warn('Failed to record Upload for orphan tracking', { publicId: result.public_id, error: err.message });
    }

    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;