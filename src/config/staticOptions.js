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
  },
};
