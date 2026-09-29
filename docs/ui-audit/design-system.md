# GikoMart — Design Direction & Design System

> Documented 2026-09-11 from source analysis of `public/assets/css/style.css`, `public/assets/js/app.js`, and `public/index.html`. This is the extracted, current design of the live app (revision `8ac100a`).
>
> **Remediation (2026-09-12, P0 fix pass):** the color token table below now reflects the post-P0 state of `style.css` `:root` — `--marigold-dark` was redefined (`#E8870A` → `#9A5600`) for WCAG AA on marigold price/hover text; new tokens `--marigold-strong`, `--marigold-light`, `--wa-green-strong`, `--wa-green-strong-dark`, `--card`, `--ink-faint`, `--neutral`, `--wa-chat-bg`, `--success`, `--success-bg`, `--danger`, `--danger-bg`, `--warning-bg` were added; and the former §"Semantic status colors used inline" are now tokens. The P0 contrast findings themselves are recorded historically in [`docs/ui-audit/audit-report.md`](audit-report.md) and are not rewritten there.

---

## 1. Design direction

**One-liner:** *"A warm campus noticeboard fused with a live WhatsApp broadcast feel."*

GikoMart's UI bridges two mental models:

1. **Buy & sell marketplace** — familiar to anyone who has used Jiji/Facebook Marketplace: a hero, category pills, a card grid, a sell form, a detail modal.
2. **Live campus broadcast** — the signature that sets it apart: a scrolling *pulse ticker* under the nav, a phone mock styled as a **WhatsApp channel message**, and "sent to WhatsApp group →" language throughout. The product's core claim ("Post once, reach the whole campus") is dramatized as a live message being pushed to a phone.

**Voice:** energetic, friendly, transactionally clear. Copy is short, emoji-forward (📱 📢 🏪 📩), and localized to Egerton University (Njoro, Hostel C, Nairobi CBD, KSh pricing).

**Visual language:**
- **Warm cream ground** (`--cream #FFF8EE`) with **marigold orange** as the primary action color — reads as affordable, lively, student-market.
- **Deep teal** as the secondary/support color (WhatsApp-header mock, channel branding, campus tag) — borrows WhatsApp's trust signal while staying on-brand.
- **Charcoal ink** for nav pill-active, text, and dark surfaces (pulse ticker, accent stat cards).
- **Pill geometry everywhere**: buttons, nav, search bar, category pills, condition badges, broadcast chips, the toast — all fully rounded. Sharper cards and modals use `--radius-lg 22px`; inputs use `--radius-sm 8px`.
- **Emoji as icons** — there is no icon font or SVG set; emoji carry category, condition, location, and status semantics. Cheap, on-brand for the audience, but a documented limitation (cross-platform rendering).
- **Signature elements**: the pulse ticker (`#pulseTrack`, 28s marquee), the `underline-pop` marigold highlight on the hero headline, floating emoji (`floaty` bob animation), and the WhatsApp channel mock.

**Motion:**
- View transitions: `fade-in` (0.4s ease, slight upward drift).
- Card hover: rise `-4px` + deeper shadow.
- Buttons: `translateY(-2px)` on hover; `--marigold-strong` → `--marigold-dark` fill.
- Marquee: 28s linear infinite scroll.
- Modal: `modal-pop` scale 0.95→1 + 10px rise (0.25s).
- Toast: slides up from bottom, 3s auto-dismiss.
- `prefers-reduced-motion` is respected for the marquee and floaty emoji (animation disabled); the `fade-in`/`modal-pop`/slide animations are **not** gated behind reduced-motion.

---

## 2. Design tokens (as authored in `:root`)

### Color

| Token | Hex | Role |
|---|---|---|
| `--marigold` | `#FF9F1C` | Large display/price highlights, decorative uses, boost CTAs |
| `--marigold-strong` | `#A56300` | Primary button fill (white text ≥4.5:1) |
| `--marigold-dark` | `#9A5600` | Price text on light, hover state of primary |
| `--marigold-light` | `#FFE3B8` | Light marigold tints (see usage in markup) |
| `--teal` | `#0B6E6E` | Secondary brand, WA header mock, eyebrow, campus tag |
| `--teal-light` | `#E3F3F2` | Tag/badge backgrounds, broadcast toggle |
| `--wa-green` | `#25D366` | WhatsApp live pulse dot, decorative |
| `--wa-green-strong` | `#0D7F41` | WhatsApp contact button fill (white text ≥4.5:1) |
| `--wa-green-strong-dark` | `#0B6A36` | WhatsApp contact button hover |
| `--wa-green-dark` | `#1DA851` | Hover state (decorative uses) |
| `--wa-chat-bg` | `#ECE5DD` | WhatsApp bubble background |
| `--cream` | `#FFF8EE` | Page ground, inputs, nav track |
| `--cream-deep` | `#FFF1DC` | Hero top gradient, image slots, upload hover |
| `--ink` | `#2B2B2B` | Body text, active nav pill, dark surfaces, phone border |
| `--ink-soft` | `#6B6660` | Secondary text, meta, placeholders |
| `--ink-faint` | `#D9D5D0` | Muted ticker/pulse accents |
| `--neutral` | `#C9C2B8` | Slider/switch off-state track |
| `--coral` | `#FF6B6B` | Warning/error, rush badge, logo gradient partner |
| `--white` | `#FFFFFF` | Card/surface backgrounds |
| `--card` | `= --white` | Card/panel surface (aliased) |
| `--border` | `#EEE3D4` | Hairline borders, input borders |

**Semantic status colors (now promoted to tokens):**
- Success green: `--success #1D9A4A` (Excellent badge), `--success` for store Active, `--success-bg #E7F8ED` (success chip bg)
- Error red: `--danger #dc3545` / `--danger-bg #FFE6E6` (delete button + error chip bg)
- Warning gold: `--warning-bg #FFF3D9` (condition warning chip bg)

### Typography

| Token | Value | Usage |
|---|---|---|
| `--font-display` | `'Space Grotesk', sans-serif` | Headings, prices, stat numbers, logo, phone-mock strong, dash numbers |
| `--font-body` | `'Inter', sans-serif` | All body, buttons, inputs, meta |

**Type ramp (px):**
- Display/Hero title: **56px / 700 / 1.08** (→40 @900px →32 @640px)
- View header h2: **32px / 700**
- Stat numbers / dash numbers: **30px / 700**
- Modal price: **26px / 700**
- Logo text: **21px / 700**, logo mark 20px
- Listing price: **18px**
- Hero sub: **17px**
- Listing title / modal title: **15px / 700**; section labels 14–15px
- Body/meta: **12–13.5px**, badge text 10.5–11px, wa-time 10.5px
- Eyebrow: **13px / 700 / uppercase / 0.12em tracking**

### Spacing & layout
- Page gutters: `24px` (app-shell), `16–20px` mobile.
- Max width container: **1180px**, centered.
- Card grid: `repeat(auto-fill, minmax(240px, 1fr))`, gap `20px`.
- Section padding: hero `64/80`, app-shell `56px top / 100px bottom`.
- Vertical rhythm: 28px view-header → 32px after filters → 20–32px gaps.

### Radius & shadow

| Token | Value | Used by |
|---|---|---|
| `--radius-sm` | `8px` | Form inputs, boost options |
| `--radius-md` | `14px` | Image upload, stat cards, broadcast toggle, modal image |
| `--radius-lg` | `22px` | Cards, modal, sell form, preview card |
| Pill | `100px` / `9999px` | Buttons, nav, search, tags, toast, switch |
| `--shadow-soft` | `0 4px 20px rgba(43,43,43,.06)` | Cards, forms, stat cards |
| `--shadow-pop` | `0 8px 28px rgba(255,159,28,.18)` | Primary button, logo mark (marigold glow) |
| Phone mock | `0 20px 60px rgba(43,43,43,.15)` | Hero phone |
| Card hover | `0 12px 32px rgba(43,43,43,.1)` | Listing card lift |

### Breakpoints
- **≤900px**: hero → 1 col (visual first), sell-layout → 1 col (preview static), dash-stats → 1 col.
- **≤640px**: topbar wraps (nav full-width), campus-tag hidden, hero title 32px, field-rows stack, app-shell padding tightened.

---

## 3. Component inventory

### Navigation (topbar + pulse ticker)
- Sticky white topbar, 38px gradient logo tile (marigold→coral), Space Grotesk wordmark "Giko**Mart**" (teal accented).
- Nav = segmented pill control on cream track; active link is a **filled ink pill** (white text). Links: Browse / Sell / My Listings / My Store. Buttons, not anchors — view switching is JS.
- Campus tag "📍 Egerton University" — teal text on teal-light pill (hidden ≤640px).
- **Pulse ticker**: full-width ink bar, 34px tall, 28s marquee of `pulse-item`s (green pulse-dot + "📢 Just posted: X → sent to group"). Content is static/demo text in JS.

### Buttons
- `.btn` base: 15px/700, `14px 26px`, radius 100px.
- **Primary** `--marigold` fill + shadow-pop + `--marigold-dark` hover w/ lift.
- **Ghost**: transparent, 2px ink border → fills ink on hover.
- Block variant `width:100%`.
- Owner controls (edit/delete on owned listings): `.owner-btn` — amber edit / soft-red delete.
- Contact & pay buttons (in modal / store): green `--wa-green` and marigold respectively, both radius 100px.
- **Focus**: all interactive elements get a 3px marigold outline + 2px offset on `:focus-visible`.

### Category pills & search
- Chips: white bg, `--border` 2px border, emoji+label; active = ink filled; hover border→marigold. Wrap.
- Search: 480px-max pill with leading "⌕" glyph, marigold focus border.

### Listing card
- White, radius `--radius-lg`, soft shadow, 1px border. Hover: lift `-4px` + deeper shadow.
- Image slot: 140px, cream-deep bg, 46px emoji fallback; Cloudinary `<img>` `object-fit:cover`, lazy.
- Badges (absolutely positioned top-right): condition chip (color-coded 6 states), featured ⭐ / rush 🚀 (marigold/coral, top-left).
- Body: optional store badge (teal pill), title (15px Space Grotesk, ellipsized), price (18px marigold-dark, `KSh` localize), meta row (📍 location · 📢 Broadcast or 👁️ views).
- Owner controls appear only when browser holds the owner token.

### Empty states
- Centered, 40px emoji, bold heading + one-line hint. Distinct per view (🔍 browse, 🏷️ dashboard, 🏪 store).

### Sell form
- White panel radius `--radius-lg`, 32px padding.
- Fields: label 13px/700; inputs on cream, 2px border, 8px radius, marigold focus border + white bg.
- Layered: photo upload (dashed dropzone w/ preview + remove), title, category/condition row, price/location row, description textarea, seller name/WhatsApp row, **package chooser** (Quick 24h KSh30 / Standard 7d KSh50 / Premium 30d KSh150), M-Pesa number, submit.
- Honeypot field (visually hidden) for anti-bot.
- **Live preview card**: teal panel, sticky right column — phone mock with same WhatsApp header + bubble reflecting the typed values in real time (title, price, category, desc ≤80 chars, location, optional image).

### Broadcast toggle + switch
- Teal-light panel "Give this listing an instant boost" with a reusable iOS-style switch (`.switch`, `--wa-green` when checked, 20px knob slide 20px).

### Dashboard
- 3 stat cards row (→1 col mobile): total listings / total views / broadcasts sent; the accent card is **ink filled** with white text.
- My listings reuse the listing card grid + empty state.

### Modal (listing detail + store)
- Overlay: fixed, `rgba(43,43,43,.5)`, `z-200`; card: white, `--radius-lg`, max-width 460, max-height 85vh scroll, `modal-pop` animation.
- Content: 180px image/emoji slot, condition chip, Space Grotesk title, marigold price, meta row, description, full-width green **Contact seller on WhatsApp** (wa.me deep link), optionally owner controls + **Boost** section (Featured KSh50 / Rush KSh80 / Priority Broadcast KSh30 + M-Pesa number).
- Floating ✕ close (cream circle); overlay click closes.

### Toast
- Fixed bottom-center pill, ink fill, white text, 100px hidden offset → slides up (`.show`), 3s auto-hide.

### Store features
- **Open a Store modal**: name/category/description/phones/payment plan (Starter/Standard/Pro) + M-Pesa.
- **My Store panel**: 80px logo tile or 🏪, name + status dot, 3-stat row (listings / limit / days left), ghost-button row (Edit, Attach, Store Listings, Public Page, Delete).
- **Public store page**: header block w/ cover gradient or image, logo, verified ✅, meta chips (location, hours, delivery, pickup, WhatsApp), listings grid.

---

## 4. Accessibility & responsive posture

- `:focus-visible` marigold outline on all controls. ⚠️ Outline may clash with marigold-focused inputs (double affordance) — cosmetic.
- `prefers-reduced-motion` handled for marquee + floaty only; other animations are not gated (see §1).
- Mobile: campus-tag hidden ≤640px; nav goes full-width segmented; hero stacks with phone mock first; grid adapts via auto-fill.
- Notable gaps (see audit report): no `aria-*` on icon-only buttons (nav uses buttons with text, so OK), the search icon is a raw glyph, emoji-only category semantics depend on emoji font support, and there is **no dark-mode / high-contrast variant**.

---

## 5. Code-level consistency issues observed

1. **Inline style drift** — Store & modal markup uses many inline `style="..."` blocks (store panel, store page, empty-state CTAs, `margin-top` resets) instead of classes. Token variables are still referenced, but it fragments the class system and duplicates values (e.g. `margin-bottom:16px` repeated). *(P1, not part of the P0 fix pass.)*
2. **Hard-coded colors outside tokens** — *Resolved in the P0 fix pass:* the status hexes listed in the original audit (`#1D9A4A`, `#16a34a`, `#dc2626`, `#dc3545`, `#C9C2B8`, `#D9D5D0`, `#ECE5DD`, `#E7F8ED`, `#FFF3D9`, `#FFE6E6`, `#1a1a1a`) were promoted to `--success`, `--success-bg`, `--danger`, `--danger-bg`, `--warning-bg`, `--neutral`, `--ink-faint`, `--wa-chat-bg` in `:root` and replaced at their component call sites.
3. **`--card`, `--marigold-light` referenced but not defined** in `:root` (store panel & page use them) — silently falls back to default values. *Resolved in the P0 fix pass:* both are now defined.
4. **Demo-data fallback** — when the API is unreachable, `DEMO_LISTINGS` and hard-coded pulse items render, so the "live" feel can be shown without a backend; flag in any QA to distinguish demo vs real listings.
5. **Reduced-motion coverage incomplete** as noted in §4.
6. **Emoji-as-icon dependency** — no fallback if emoji font missing; sizes/rendering differ by platform (Windows vs Android).

---

*Next step: build the isolated `/ui-preview` design-system gallery from these tokens.*