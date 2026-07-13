# External ingress

StillOn is local-first, not local-only. It listens on `127.0.0.1` by default,
and an operator may make that local service reachable from another device.
StillOn owns the local origin and its HTTP/WebSocket behavior; it does not
create tunnels, configure DNS or TLS, or administer Cloudflare, VPNs, or other
edge services.

## Choose an ingress model

Keep the default loopback listener when a reverse proxy or tunnel runs on the
same machine:

```bash
stillon --trust-proxy
```

Use `--host <address>` or `--remote` only when the StillOn listener itself
must be reachable on a network interface:

```bash
stillon --remote --password '<optional-password>'
```

`--share` and `--cloudflared` are no longer built in. Run a Cloudflare Tunnel,
another tunnel, or a reverse proxy independently, then point it at StillOn.

## Trusted-proxy contract

For a same-machine proxy or tunnel, send traffic to:

```text
http://127.0.0.1:3210
```

The proxy must:

- preserve or set the public `Host` header;
- forward WebSocket upgrades for `/ws`;
- set `X-Forwarded-Proto` to the browser-facing scheme (`https` in a normal
  public deployment); and
- forward client addressing with `X-Forwarded-For` when login rate limiting
  should distinguish users behind the proxy.

Enable `--trust-proxy` only when the proxy is the sole route to StillOn. In
that mode StillOn trusts `X-Forwarded-Proto` for HTTPS redirects, origin
validation, and Secure cookies. It deliberately does not trust
`X-Forwarded-Host`; use the normal `Host` header for the public hostname.

If StillOn listens on a non-loopback address with `--trust-proxy`, enforce a
firewall or network rule so direct clients cannot reach the port and forge
forwarded headers.

## Authentication

`--password` is optional and accepts any non-empty value. It is a convenience
barrier for a local machine, not a complete Internet-facing access policy.
For external access, protect the ingress with an appropriate authentication
and authorization policy in addition to normal network controls.

The native service intentionally does not persist a `--password` flag. It can
persist the listener and trusted-proxy contract instead:

```bash
stillon service install --trust-proxy --env-file /absolute/path/to/stillon.env
```

`STILLON_TRUST_PROXY=1` in that environment file is an equivalent way to
enable trusted-proxy behavior.

## Development

Development stays on loopback by default. When testing through an externally
managed proxy or tunnel, run:

```bash
bun run dev -- --trust-proxy
```

Vite will accept the proxy's public `Host` header while both the development
server and the StillOn backend remain on `127.0.0.1`. The `/ws` proxy supports
WebSocket upgrades.
