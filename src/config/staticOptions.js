// Options for express.static('public', ...). The admin portal and its assets are
// never cached and never indexed; everything else keeps the previous behavior
// (assets cached for a week, HTML revalidated on every load).
module.exports = {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    const isAdmin = /[\\/]public[\\/]admin[\\/]/.test(filePath)
      || /[\\/]assets[\\/](js|css)[\\/]admin\.(js|css)$/.test(filePath);
    if (isAdmin) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      return;
    }
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'public, max-age=0');
    }

    // Scripts and stylesheets are MUTABLE files referenced by a page that is
    // revalidated on every load. A week-long cache here pairs fresh markup with
    // an old script — a stale app.js has no delegated case for a newly added
    // data-action, so new UI fails silently with no error at all (seen live:
    // the Free Grant button did nothing for returning visitors). A short TTL
    // keeps in-session caching while bounding post-deploy staleness to minutes.
    if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  },
};
