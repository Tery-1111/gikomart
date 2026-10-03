# GikoMart — UI/UX Audit (Final Report)

> Scope: 5-step audit of the running campus marketplace app (Express 5 + Mongo + vanilla JS SPA, revision `8ac100a`).
> Date: 2026-09-12. Audited from source (`public/assets/css/style.css`, `public/assets/js/app.js`, `public/index.html`, `server.js`) plus live HTTP/CSP probes of the built UI preview.
> Companion doc: [`docs/ui-audit/design-system.md`](design-system.md) — full design direction, token tables, component inventory.

---

## 1. The five steps, and what each produced

| # | Step | Delivered | Status |
|---|---|---|---|
| 1 | Audit running app | Source-level audit of design tokens, components, view flow; live probes of the server | ✅ (visual screenshots not possible — see §6) |
| 2 | Document design direction & design system | `docs/ui-audit/design-system.md` — direction, 13-token palette, type ramp, 3 radii, 2 shadows, full component inventory, a11y posture | ✅ |
| 3 | Build isolated `/ui-preview` | `public/ui-preview/index.html` (29.8 KB) — self-contained token + component gallery, shares no CSS with the app | ✅ |
| 4 | Verify the preview | Static structural pass + CSP audit + Express/Helmet live check → **200, 29,783 B, correct CSP, 0 inline scripts, 301 for bare path** | ✅ (HTTP level; no Chromium render — §6) |
| 5 | Write final report + stop for approval | this document | ✅ — **awaiting approval, no live-app files modified** |

---

## 2. The design, in one paragraph

GikoMart is a **warm campus noticeboard fused with a live WhatsApp broadcast**. The signature is the tension between a familiar marketplace UI (hero, category pills, card grid, sell form, detail modal) and a live-broadcast layer (the scrolling pulse ticker, a phone mock styled as a WhatsApp channel message, "sent to the group →" language, KSh/local prices). The visual language is coherent: a **cream ground** (`#FFF8EE`), **marigold** as the action color, **deep teal** borrowing WhatsApp's trust signal, **ink** for active/dark moments, and pill geometry almost everywhere. Voice is energetic and campus-localized to Njoro (Hostel C). This is a genuinely distinctive, well-executed direction for the audience.

---

## 3. What's strong (keep)

- **Distinctive signature elements** — pulse ticker, WhatsApp phone mock, `underline-pop` hero highlight, floating emoji. These make the product feel like a broadcast network, not just another classifieds CRUD.
- **Tokens are real** — 13 colors, 2 font stacks, 3 radii, 2 shadows all defined in `:root` and used consistently across the app.
- **Empty states exist and are designed** (🔍 🏷️ 🏪) — good discipline for a marketplace that starts empty.
- **Progressive degradation is built in** — when the API is unreachable (which happened this very session: Atlas `ETIMEDOUT`), `DEMO_LISTINGS` + hard-coded pulse items keep the "live" feel so the UI can be demonstrated.
- **Accessibility foundations** — consistent `:focus-visible` outline (3px marigold + 2px offset), semantic `<button>` navigation, responsive single-column fallbacks at 900/640px, and partial `prefers-reduced-motion` support.
- **`/ui-preview` is CSP-clean by construction** — verified the exact Helmet directives in `server.js` permit everything it ships (inline styles, Google Fonts stylesheet + gstatic font files), and it emits zero inline scripts.

---

## 4. Findings, prioritized

### P0 — fix before launch

1. **White text on marigold fails color-contrast AA (≈2.1:1).** The primary CTA is `--marigold #FF9F1C` with white 15px-bold text; hover `--marigold-dark #E8870A` with white ≈2.7:1. Both are below the 4.5:1 normal-text threshold (button text isn't large-text). Same class of issue on the WhatsApp green `#25D366` contact button (≈2:1) — matching WhatsApp's own brand look, but still sub-AA.
   → Recommend: darken the fill for buttons (e.g., a `--marigold-700`-style token landing ≥4.5:1 with white, around `#B86A00`), or move to dark-ink text on marigold. Keep `#FF9F1C` for large display/price highlights and decorative uses where it works.
2. **Semantic/status colors are hard-coded outside tokens.** `#1D9A4A`, `#16a34a`, `#dc2626`, `#dc3545`, `#E7F8ED`, `#FFF3D9`, `#FFE6E6`, `#C9C2B8`, `#D9D5D0`, `#ECE5DD`, `#1a1a1a` appear inline in CSS/JS (condition badges, store status, success/warning/error chips). These should be promoted to `--success / --success-bg / --danger / --warning-bg / …` so the two palettes don't drift.
3. **`--card` and `--marigold-light` are referenced but never defined.** Store panel & page markup falls back to the browser default silently. Either define them or replace usages.
4. **Port/API coupling (caught live this session):** `app.js` hard-codes `API_BASE = http://localhost:5000/api`, and `server.js` CORS allowlists only `localhost:5000` / the Render origin — while this machine's dev runner brings the server up on **20128**. Result: the browser would hit a 404/blocked-origin against the configured port unless it happens to match. → Make `API_BASE` relative (`/api`) or env-driven, and drive CORS from an env var so ports can't silently diverge.

### P1 — design-system hygiene

5. **Inline `style="…"` drift in the store & modal markup.** Store panel/page, empty-state CTAs, and `margin-top`/`margin-bottom` resets duplicate spacing values inline instead of using the class system. Consolidate into classes so the token layer stays the single source of truth (the very thing `/ui-preview` demonstrates).
6. **`prefers-reduced-motion` coverage is incomplete.** Only the marquee + floaty emoji are gated; `fade-in`, `modal-pop`, toast slide, hover lifts still animate. Gate the rest under the same media query.
7. **Demo-vs-real ambiguity.** When the API is down, `DEMO_LISTINGS` (which includes a `totp-test`-adjacent fake dataset shape) render with no marker. Add a small "preview data" chip when demo rows are shown, so QA / early users aren't misled.
8. **`marigold-dark` price text on white ≈2.7:1** — price is 18px bold (just under the AA "large text" cutoff of ~18.66px bold). Darken the price text slightly, or bump to a font-size/spec that counts as large text. Verify with a checker before/after.

### P2 — polish / next iteration

9. **No dark mode / high-contrast variant** — given the cream/ink palette, a dark build is cheap: tokens are already centralized, so a `data-theme="dark"` swap is mostly adding a second token block (the `/ui-preview` page token mirrors make this a 30-minute job).
10. **Emoji-as-icons is a platform risk.** Categories, conditions, status and every icon are emoji; on a device without the emoji font or with Windows vs Android rendering differences, semantics and spacing shift. Either adopt an SVG/icon-font set (overkill for v1 of a campus app) or at minimum document the expectation and ensure text also carries the meaning (it mostly does already — "Electronics", "Broadcast", etc.).
11. **Small a11y nudges:** pass `aria-live="polite"`/`role="status"` on the toast so screen readers announce it; give the search glyph an `aria-hidden` + rely on an `aria-label` on the input; ensure the mock phone/ticker copy is marked decorative where it is.
12. **Repo hygiene (non-UI, flagged in passing):** untracked `totp-test.json` and a stray `-w` file sit in the repo root — `totp-test.json` looks like a TOTP/2FA test artifact and should not be committed. `.env` also carries a live-looking `WHAPI_TOKEN` and Atlas credentials; it already has a `# .gitignore` convention? — double-check `.env` is ignored.

---

## 5. The `/ui-preview` deliverable

**What it is:** `public/ui-preview/index.html` — an isolated, self-contained design-system gallery at `/ui-preview/`. It shares **no CSS** with the app; every token is mirrored from `:root` so the page is its own documentation. Zero backend calls. Sections: 01 Color tokens (13 swatches), 02 Typography ramp + font stacks, 03 Radius & shadow, 04 Buttons, 05 Nav / pills / search, 06 Form controls + switch + upload zone, 07 Listing cards & badges, 08 Listing-detail modal, 09 Status chips / toast / pulse ticker, 10 the WhatsApp broadcast phone mock (signature).

**Verified:** structural pass (all 10 sections balanced, valid markup); CSP pass (exactly the directives Helmet emits — `style-src 'unsafe-inline' https://fonts.googleapis.com`, `font-src 'self' https://fonts.gstatic.com` — cover its two external assets; 0 inline scripts); live HTTP pass through Express 5 + Helmet + `express.static('public')`: **HTTP 200 · 29,783 B · markers present · correct CSP header · bare path 301s to trailing slash.**

**How to view it:** run `npm start` (or `node server.js`, port from `.env`, currently 5000) and open `http://localhost:5000/ui-preview/`.

---

## 6. Honest limits of this audit

- **No pixel-level verification.** The plan called for Playwright screenshots, but Chromium cannot be installed on this machine (8 GB RAM, 84–87% used — the dev server was OOM-killed twice during the audit). Step 1 was therefore a source-level audit, and step 4 was HTTP/CSP-level verification, both transparent here rather than silently substituted.
- **Dark-side dev environment.** This machine's dev runner (omniroute) had a *different* app (a Next.js dashboard) occupying the app's configured port, and MongoDB Atlas timed out from here (`ETIMEDOUT …:27017`). That port/CORS coupling is itself **finding #4** — the app quietly falls back to demo mode when its backend is unreachable, which is exactly why finding #7 matters.
- **Recommended follow-up (5 min, on any machine with ≥16 GB or a cloud sandbox):** start the app, open `/ui-preview/` and the four views, and do a one-page visual pass against the two docs. Change nothing — the point is to confirm the token mirror matches what you see.

---

*Audit produced without modifying any live-app file. All artifacts live under `docs/ui-audit/` and `public/ui-preview/`. Awaiting approval before any changes (including the P0 fixes) are applied.*