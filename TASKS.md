# Remaining tasks — dsh-mcp-apps

Verified against `origin/main` @ `3b04e22` (tag `v0.2.2`) on 2026-09-27. Published: `dsh-mcp-apps@0.2.2` (npm OIDC trusted publishing, SLSA provenance). `0.2.1` and `0.2.0` remain published as prior versions; `NPM_TOKEN` has been removed from repo secrets (`gh secret list` returns none); a branch ruleset (`protect-main`) is active on `main` requiring the `Test & Build (22.x)` check; CI actions are pinned to SHAs. Release notes for `v0.1.0`, `v0.2.0`, `v0.2.1`, and `v0.2.2` are all published (none are drafts).

Everything code-side and GitHub-side from the prior round of this list is done. Two items remain, and both require action on npmjs.com — they cannot be done from the CLI or this repo.

## Remaining — [you: npm]

- [ ] **Revoke the leftover npm token** `2439da` ("tset", created 2026-09-23). It can still publish packages.
  ```
  npm token revoke 2439da
  ```
- [ ] **Tighten package publishing access.** On https://www.npmjs.com/package/dsh-mcp-apps/access:
  - Set publishing access to "Require two-factor authentication and disallow tokens".
  - On the trusted publisher (GitHub Actions OIDC) configuration, restrict it to **publish only** and turn off staged publishing, which `release.yml` never uses.

Neither of these is verifiable from the CLI (`npm token revoke` needs an authenticated session; the access-control toggles have no `npm` CLI equivalent) — confirm both directly on npmjs.com.

## Code Tasks

- [ ] **RFC 9207 (OAuth 2.0 Authorization Server Issuer Identification) compliance**
  - In [`handleOAuthCallback` in `src/index.ts`](src/index.ts), extract the `iss` query parameter from the callback URL and pass it to `pool.completeOAuthCallback(server, code, state, iss)`.
  - In [`completeOAuthCallback` in `src/transports/server-pool.ts`](src/transports/server-pool.ts), validate that if `iss` is present, it matches `authorizationServerMetadata.issuer` (or `authorizationServerUrl`). Reject the authorization response and abort token exchange on mismatch per RFC 9207 §2.3.
  - Add unit tests in `tests/` verifying callback behavior: succeeds when `iss` matches expected issuer, succeeds when `iss` is omitted (fallback via state and server-specific callback URI), and rejects when `iss` mismatches.

- [ ] **OAuth token store ignores `DSH_HOME`** (`src/transports/oauth-token-store.ts:8` derives its path from `homedir()`), so an instance booted with an isolated `DSH_HOME` still reads/writes the *real* user's `~/.dsh/mcp-apps/oauth` store — the packaged smoke tests never notice (stdio fixtures), but any isolated instance with an OAuth server shares and mutates the user's tokens. Consider honoring `DSH_HOME` like the rest of DSH's state, or documenting the `HOME`-override workaround.
