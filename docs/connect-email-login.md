# StillOn Connect email login

Connect is a separately runnable account service for the planned managed remote
entry. It provides email-code sign-in, verified account creation, remembered
sessions and logout. The local StillOn server remains independently usable.

The account module also powers the [remote-access development preview](connect-remote-access.md).
Computer access additionally requires enrollment, ownership, a host-specific
session and a transport lease. Configure the transport settings in `.env.example`
for the complete service, or omit them for account-only development.

## Mail setup

The included sender uses [Resend's email API](https://resend.com/docs/api-reference/emails/send-email)
behind the small `LoginEmailSender` interface in `src/connect/mail.ts`.
Another transactional mail provider can implement that interface without
replacing accounts or sessions.

1. Create a sending account and verify a dedicated sender subdomain, such as
   `mail.example.com`, using the DNS records supplied by the provider. See
   [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction).
   The sender domain is separate from the Connect website hostname; existing
   personal/business mailbox routing need not be repurposed.
2. Create a key restricted to sending from the verified domain where the provider
   supports that restriction. Store it in a private environment file or secret
   manager.
3. Set `STILLON_CONNECT_EMAIL_FROM`, for example
   `StillOn <login@mail.example.com>`, and `STILLON_CONNECT_RESEND_API_KEY`.

A sending-only key cannot list or manage domains. Resend documents HTTP 401
`restricted_api_key` for these operations; do not treat it as an invalid key or
broaden the runtime key just to inspect domains. Complete domain administration
in the provider dashboard, then configure the verified sender address. See
[Resend error definitions](https://resend.com/docs/api-reference/errors).

There is no console-code fallback in the runnable service. Missing mail settings
prevent startup; provider errors produce a retryable failure instead of a false
"sent" response. API acceptance is not proof of inbox delivery. Before enabling
customer use, verify delivery, expiry, resend order and spam placement with the
actual QQ, 163, Gmail, Outlook and customer company inboxes.

## Run

From the repository root:

```sh
bun install --frozen-lockfile
bun run build:connect
cp src/connect/.env.example .env.connect
```

Edit `.env.connect` with real private settings. Generate the auth secret from at
least 32 random bytes (for example `openssl rand -base64 32`); keep it stable
across restarts. `STILLON_CONNECT_DATA_DIR` must be a dedicated persistent local
directory, outside public web assets. Back up its databases and the secret
separately with access restricted to the operator.

```sh
bun --env-file=.env.connect run connect
```

The process listens only on `127.0.0.1:3220` by default. For a local manual mail
test, use `STILLON_CONNECT_ORIGIN=http://127.0.0.1:3220`. Public origins require
HTTPS; credentials, URL paths, queries and fragments are rejected in the origin
setting. The configured public Host must reach the service unchanged.

For a local Caddy proxy, an illustrative configuration is:

```caddyfile
connect.stillon.example {
    reverse_proxy 127.0.0.1:3220 {
        header_up X-Real-IP {remote_host}
    }
}
```

Set `STILLON_CONNECT_TRUST_PROXY=true` only for this exclusive local proxy path.
It accepts a single valid `X-Real-IP` only from a loopback peer. The proxy must
overwrite that header; do not forward a browser-supplied value. Without this
option, forwarded IP headers are ignored. This example does not configure DNS,
the current personal gateway, upstream protection or a process supervisor.

## Account contract

| Route | Method | Behavior |
| --- | --- | --- |
| `/api/connect/request-code` | POST | `{email}`; normalize the address and submit a six-digit code |
| `/api/connect/verify-code` | POST | `{email, code, remember}` plus the initiating browser's HttpOnly challenge cookie |
| `/api/connect/session` | GET | Verified account ID/email and expiration, or `session: null` |
| `/api/connect/logout` | POST | Revoke this browser's account session and expire its cookies |

Mutation requests require JSON where a body is used and the exact configured
Origin. Cross-site and sibling-site API requests are rejected. There is no public
passthrough to Better Auth's registration, password, email-change, OTP-read or
other endpoints. Responses do not expose bearer tokens. No host identifiers or
host grants are inferred from the account's email address.

The UI uses `input-otp` with six slots, paste and one-time-code autofill support.
The default remembered login expires after 30 days; unchecking the option issues
a browser-session cookie. Session refresh and cookie caching are disabled, so a
session does not silently become persistent and logout is checked against the
database. Browser session restoration may retain session cookies according to
the browser's own settings; use explicit logout when ending access.

Account state is shared across tabs. The UI broadcasts sign-in/sign-out and
refreshes account state on focus. This does not implement or mutate a global
"current computer"; host routing retains each tab's explicit target.

## Verification limits

- Codes expire after five minutes and are single-use. A separate keyed receipt
  binds each code to the initiating browser. Resending rotates the code and
  invalidates the previous receipt for that email.
- Persistent SQLite rolling budgets: one send per email per 60 seconds, five per
  email per hour, twenty per source IP per hour, one hundred globally per hour;
  five verification attempts per email per five minutes and thirty per source
  IP per five minutes. General API requests are capped at 120 per IP per minute.
  IPv6 source keys are grouped by /64. These are conservative pilot defaults in
  `src/connect/auth.ts`, not a service capacity commitment.
- Budgets reserve atomically and survive resends/restarts. Incorrect attempts
  cannot be reset by requesting another code. Valid verification claims a
  challenge atomically before account/session creation.
- OTPs and receipts use separate keyed HMAC namespaces. Codes, auth secrets and
  mail API keys are not written into application logs. Database files use private
  filesystem permissions; SQLite/WAL data must remain on a local persistent disk.
- Production cookies are host-only `__Host-` cookies with Secure, HttpOnly and
  SameSite attributes. Mutation Origin checks remain active on localhost too.
- Email proves access to an inbox. Trusted-browser approval, computer ownership,
  recovery proofs, authorization revocation and host-bound grants belong to the
  [remote-access layer](connect-remote-access.md), independently of email login.

Better Auth 1.7.10 and input-otp 1.5.0 are pinned in `bun.lock`. The service uses a
single process per SQLite data directory. Schema initialization uses Better
Auth's migrations; back up state and rehearse migrations before upgrading the
authentication dependency. No multi-node deployment or real mail deliverability
is implied by the local test suite.

## Checks

```sh
bun test ./src/connect
bun run check:connect
bun run check
bun run audit
```

Tests inject a capture sender and never send real email. They exercise account
creation, challenge binding, expiry, replay/concurrent verification, resend and
attempt limits, persistent sessions, logout, request-origin boundaries, opaque
provider failures and the fixed Resend request template.
