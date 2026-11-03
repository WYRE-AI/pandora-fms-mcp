# Changelog

## [Unreleased]

- Initial Pandora FMS / Pandora Open MCP server: 55 tiered tools (33 read, 14 write, 8 admin) over API v2 and the legacy api.php, Bearer-token auth.

### Security (round 4)

- `pandora_module_disable` and `pandora_module_alerts_disable` (destructive) moved from the write tier to the admin tier (now 33 read, 14 write, 8 admin).
- `CONDUIT_S2S_SECRET` must be at least 32 characters and not a known placeholder; startup fails otherwise.
- Host header (DNS-rebinding) check with `MCP_ALLOWED_HOSTS`; 1 MiB body limit on `/mcp` (413).
- Upstream error text and JSON responses are redacted before the 2000-char truncation; successful responses are redacted too.
- `sortField` restricted to `[A-Za-z0-9_]+`; legacy `other` values containing `,` are rejected.
- The undici Agent is cached per CA path.
- CI: reusable workflow references corrected; `mcp-assert` has `permissions: contents: read`.
- Added a `.dockerignore`.
