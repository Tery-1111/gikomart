# Legal page placeholders

The three new legal pages originally used five placeholders instead of real
operator and contact details, so no personal data was committed to the
repository. All five have since been resolved (see the register below): the
four contact/identity placeholders with the approved admin support contact,
and `[EFFECTIVE_DATE]` with the effective date October 22, 2026.

| Placeholder | Status | Resolution |
|---|---|---|
| `[OPERATOR_NAME]` | RESOLVED | `GikoMart` (product identity; no legal-registration claim) — `privacy-policy.html` §1 |
| `[OPERATOR_ADDRESS]` | RESOLVED | `Njoro, Nakuru County, Kenya` (broad locality only; the operator has no physical business premises) — `privacy-policy.html` §1, `terms-of-service.html` |
| `[SUPPORT_EMAIL]` | RESOLVED | Email is centralized in `src/config/supportContact.js` and intentionally NOT rendered on public surfaces; legal pages now route to the WhatsApp support channel — `privacy-policy.html` §8, `prohibited-items.html` §3, `data-requests.html` §3 |
| `[SUPPORT_WHATSAPP]` | RESOLVED | Support WhatsApp `0776844298` (wa.me/254776844298), also linked as "WhatsApp Support" in the homepage footer — same pages |
| `[EFFECTIVE_DATE]` | RESOLVED | `October 22, 2026` — shown as "Effective October 22, 2026" — `privacy-policy.html`, `prohibited-items.html`, `data-requests.html` |

Find any that are still present with:

```bash
grep -rEn "\[[A-Z][A-Z_]+\]" public/legal/
```
