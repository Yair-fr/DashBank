# Compliance Check: DashBank (self-hosted personal finance tracker)

> Not legal advice. A structured assessment for a single-user, self-hosted tool, to be reviewed by an Israeli lawyer before any distribution to other people or clients. Regulations change; verify against official sources.

## Summary
**Proceed with conditions** for personal use by the account owner.
**Requires further review** before offering it to anyone else, as a product or for clients.

Two findings matter most:
1. **The bank's terms of use, not privacy law.** Automated login with your own credentials (scraping) probably breaches your online-banking terms. [Likely]
2. **Third-party relays of transaction data.** The public ntfy.sh server and the Telegram Bot API both carry your transaction details. [Certain]

## Applicable Regulations and Policies
| Regulation / Policy | Relevance | Key requirements |
|---|---|---|
| Privacy Protection Law 5741-1981, as amended by Amendment 13 (in force Aug 2025) | Low for one person processing their own data. **High** if other people's data is processed (family, clients). | Obligations attach to the "database controller". For a product: privacy notice, purpose limitation, data-subject access/correction, a security officer where it applies, breach reporting to the PPA. |
| Privacy Protection (Data Security) Regulations 5777-2017 | Best-practice baseline. Binding if you become a database controller of others' data. | Access control, authentication, encryption, logging, backups, periodic review. Already mapped below. |
| Equal Rights for Persons with Disabilities (Service Accessibility Adjustments) Regulations 5773-2013, reg. 35, IS 5568 (≈ WCAG 2.0 AA) | Not binding for a private tool. **Binding** if offered as a service to the public. | WCAG AA conformance, an accessibility statement, and a named accessibility coordinator contact. We target **WCAG 2.1 AA** anyway. |
| Bank Hapoalim / Isracard / Cal / Max online-service terms | **High.** | Typically prohibit automated access and disclosing credentials to third parties. Possible consequences: account lock, and the user bearing liability for fraud arising from credential exposure. |
| Financial Information Service Law 5782-2021 + Bank of Israel Open Banking directive (368) | An alternative path | Licensed information-service providers access data through APIs with consent. That is the compliant route for any **commercial** version. |
| Google API Services User Data Policy (OAuth sign-in) | Medium | Request only the `openid email profile` scopes, keep the OAuth app in "Testing" mode limited to your own account, and don't store Google tokens. |
| Telegram ToS / ntfy.sh terms | Medium | Bot messages are not end-to-end encrypted. Public ntfy topics are readable by anyone who guesses the name. |

## Requirements
| # | Requirement | Status | Action |
|---|---|---|---|
| 1 | Credentials encrypted at rest | Met | AES-256-GCM vault, scrypt KDF, file mode 0600 |
| 2 | No credentials in logs, API or notifications | Met | Logger never receives credentials; covered by tests |
| 3 | Network exposure minimised | Met | Server binds 127.0.0.1; phone access only via Tailscale (WireGuard, device-authenticated) |
| 4 | Strong user authentication | In progress | Password (scrypt) + TOTP MFA (RFC 6238), optional Google OIDC limited to an allow-listed email; secure session cookie |
| 5 | Notification data minimisation | In progress | `NOTIFY_PRIVACY=1` hides merchant names. Docs require a long random ntfy topic plus an access token, or self-hosted ntfy |
| 6 | Privacy notice, terms of use, accessibility statement | In progress | In-app pages in Hebrew and English |
| 7 | WCAG 2.1 AA | In progress | Semantic HTML, keyboard navigation, focus rings, ARIA labels, contrast ≥ 4.5:1, data tables as alternatives to charts, reduced motion, RTL/LTR |
| 8 | Data-subject rights (export/delete) | In progress | CSV export; "delete all data" = remove `data/` (documented) |
| 9 | Backups | User action | Back up `data/` encrypted, never to a public cloud folder in plaintext |
| 10 | Bank ToS acceptance of risk | User action | Read your bank's terms; the README contains an explicit risk notice |

## Risk Areas
| Risk | Severity | Mitigation |
|---|---|---|
| Bank/card account locked or flagged for automated access | High | Conservative sync interval (default 30 min, minimum 10), one login per institution per run, no parallel logins. Accept the risk knowingly. For a commercial product, use a licensed Open Banking provider instead. |
| Liability for fraud if credentials leak from your PC | High | Vault encryption; don't store the passphrase in `.env` on a shared PC; full-disk encryption (BitLocker/FileVault); OS account password |
| Transaction details exposed through public ntfy topic | Medium | Random 24+ character topic, access token, self-hosting, or Telegram only; privacy mode |
| Telegram bot token leak lets an attacker read or send messages | Medium | Token stays only in `.env`; rotate with @BotFather if exposed |
| Google OAuth misconfiguration lets another Google user in | Medium | Email allow-list enforced server-side (`AUTH_ALLOWED_EMAILS`); state + PKCE + nonce checks |
| Distributing the tool to clients turns you into a database controller and possibly an unlicensed financial-information service | High (business) | Don't distribute it as a service without legal review and an Open Banking licence or partner. Keep the core generic (your IP). |

## Recommended Actions
1. Read your bank's and card companies' online-service terms, and decide knowingly whether to accept the scraping risk.
2. Enable full-disk encryption on the PC that runs DashBank, and don't put `DASHBANK_PASSPHRASE` in `.env` unless the PC is yours alone.
3. Use Telegram, or ntfy with a long random topic plus a token. Turn on `NOTIFY_PRIVACY=1` if you want merchant names hidden on the lock screen.
4. Before any commercial use, get an Israeli privacy/fintech lawyer's review and evaluate licensed Open Banking providers.

## Approvals Needed
| Approver | Why | Status |
|---|---|---|
| You (account owner) | Accept bank-ToS risk for personal use | Pending |
| Israeli counsel | Only if distributed or commercialised | Not required for personal use |

## Further Review Recommended
- The exact wording of each institution's current online terms (they change, and I haven't read the current versions). [Guessing on specific clauses]
- Whether Amendment 13 obligations reach a family-shared deployment.
