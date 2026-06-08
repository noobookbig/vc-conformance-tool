# Test case source

The conformance cases implemented in this webapp derive from the corrected
Thailand VC OID4VCI / OID4VP 1.0 conformance testcase **v2.0** maintained in
a separate repo:

| Item | Value |
|---|---|
| Source repo | `/home/big/Documents/vc-test` |
| Branch | `docs/mas-59-thai-language-review` |
| Tip | `389a2f6b2a76cf96c311cc10d94c06994ed610d1` |
| Canonical doc | `docs/conformance/openid4vci-vp/conformance-testcase-corrected.md` |
| Cases | 283 (106 Issuer, 80 Holder, 34 Verifier, 17 Interop, 24 Resolver, 18 Security, 4 Integration) |

## Coverage in v1 of this webapp

The hand-curated catalog in `apps/web/src/wallet/catalog.ts` covers a
representative subset of the spec, focused on:

- **Issue VC — Credential Offer** (by value + by reference)
- **Issue VC — Authorization** (PKCE, authorization_details)
- **Issue VC — Token Exchange**
- **Issue VC — Credential Request** (KB-JWT, both ES256 and EdDSA proof types)
- **Issue VC — Deferred Credential**
- **Notification**
- **Present VP — Authorization Request** (DCQL)
- **Present VP — Response** (vp_token with KB-JWT)

Target: ≥30 concrete cases per cross-mode. The full 283-case coverage is a
later milestone; the catalog-driven architecture makes incremental
ingest straightforward.

## Versioning

The catalog version is pinned to **v2.0**. When `vc-test` ships v3.0, this
webapp will need:

1. A `scripts/parse-testcases.mjs` to ingest the new markdown spec
2. A catalog version bump
3. A note in the changelog

This document will be updated as part of that change.
