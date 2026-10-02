# Legal page placeholders

The three new legal pages use five placeholders instead of real operator and
contact details, so no personal data is committed to the repository. **All five
must be replaced with real values before launch.**

| Placeholder | Replace with | Pages that contain it |
|---|---|---|
| `[OPERATOR_NAME]` | The legal name of the person or business operating GikoMart | `public/legal/privacy-policy.html` |
| `[OPERATOR_ADDRESS]` | The operator's street or postal address | `public/legal/privacy-policy.html` |
| `[SUPPORT_EMAIL]` | A monitored support email address | `public/legal/privacy-policy.html`, `public/legal/prohibited-items.html`, `public/legal/data-requests.html` |
| `[SUPPORT_WHATSAPP]` | A monitored support WhatsApp number | `public/legal/privacy-policy.html`, `public/legal/prohibited-items.html`, `public/legal/data-requests.html` |
| `[EFFECTIVE_DATE]` | The date the page takes effect | `public/legal/privacy-policy.html`, `public/legal/prohibited-items.html`, `public/legal/data-requests.html` |

Find any that are still present with:

```bash
grep -rEn "\[[A-Z][A-Z_]+\]" public/legal/
```
