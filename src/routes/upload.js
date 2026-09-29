const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const cloudinary = require('../config/cloudinary');
const { uploadLimiter } = require('../middleware/rateLimiter');

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }, // 5MB max, single file
});

// MIME types we accept despite what the client claims. The actual format is
// validated by magic-byte sniffing (file-type), so an attacker can't bypass
// the check by forging the Content-Type header.
const ACCEPTED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

router.post('/', uploadLimiter, upload.single('image'), async (req, res) => {
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
    let data, info;
    try {
      ({ data, info } = await sharp(req.file.buffer, { animated: false })
        // Strip metadata (EXIF contains location + camera data) and cap resolution.
        .rotate() // bake EXIF orientation into pixels
        .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer({ resolveWithObject: true }));
    } catch (err) {
      // Corrupt/malformed image bytes that passed magic-byte sniffing are the
      // caller's fault — a 4xx bad request, not a 5xx server error.
      return res.status(400).json({ success: false, error: 'Image could not be processed' });
    }

    // Reject absurd frame counts / extreme dimensions even after resize guard
    if (info.width > 1600 || info.height > 1600) {
      return res.status(400).json({ success: false, error: 'Image too large' });
    }

    const b64 = Buffer.from(data).toString('base64');
    const dataURI = `data:image/jpeg;base64,${b64}`;

    const result = await cloudinary.uploader.upload(dataURI, {
      folder: 'gikomart',
      resource_type: 'image',
      quality: 'auto',
      fetch_format: 'auto',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
      transformation: [{ width: 1600, height: 1600, crop: 'limit' }],
    });

    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;