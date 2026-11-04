# Structured Data — Next Steps

Status: homepage and listing-page JSON-LD shipped in c73fbae (PR #4). Live at https://gikomart.onrender.com/.

## Done (do not redo)

- Homepage: Organization + WebSite JSON-LD (public/index.html)
- Listing page: Product JSON-LD via buildListingJsonLd in src/controllers/listingController.js
- llms.txt served at /llms.txt
- Visible-UI compliance scrub; category display names renamed (IDs preserved)
- Full vitest suite green: 80 files / 932 passed / 1 skipped
- Live checks: JSON-LD 1 block, /llms.txt 200, /sitemap.xml 200, /health healthy

## Yours to do (in order)

1. Paste the homepage JSON-LD into https://validator.schema.org/ and confirm 0 errors.
   Fetch it fresh with:
     curl -s https://gikomart.onrender.com/ | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=s.match(/<script type=\"application\/ld\+json\">([\s\S]*?)<\/script>/);process.stdout.write(m[1].replace(/<script[^>]*>|<\/script>/g,''))})"
   Save the output to a file and paste the file contents into the validator. Do not paste
   the HTML — paste only the JSON-LD body.

2. Open PR #4 on GitHub and read the three comments already posted:
   - merge confirmation (squash commit c73fbae)
   - compliance sign-off
   - product sign-off

3. Weekly for two weeks, check Google Search Console:
   - URL Inspection on https://gikomart.onrender.com/ → confirm indexed, canonical populated
   - Enhancements → Product snippets → 0 errors
   - Enhancements → Breadcrumbs → 0 errors
   - Sitemaps → 8 URLs, 0 errors
   - Pages → "Crawled – currently not indexed" → confirm / is off this list

4. When /api/listings returns total > 0 (first real listing):
   - fetch /listing/<id> and confirm one application/ld+json block in the response
   - paste that URL into https://search.google.com/test/rich-results → expect valid Product

## Seven follow-up tickets already filed on GitHub (see issues list)

- Legal: scrub campus wording from 4 legal pages
- Product: rename 'Semester Rush Boost (72h)'
- Engineering: category ID migration
- Engineering: homepage ItemList when catalog > 0
- Engineering: /search route + SearchAction
- Engineering: dynamic sitemap for /listing/*
- Product: scrub MATH 111 + 112 from demo copy

## What NOT to do

- Do not re-run the Rich Results Test on the homepage expecting a result — Organization and
  WebSite are not rich-result-eligible types. Use validator.schema.org for correctness.
- Do not edit legal pages without legal sign-off.
- Do not add SearchAction, ItemList, or CollectionPage schema until their prerequisites
  (search route, non-empty catalog, category route) exist.
- Do not re-open or re-run the merged PR.

## Rollback (if ever needed)

    git revert c73fbae && git push origin main
