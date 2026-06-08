# Catalog coverage map

This document maps every test case in `apps/web/src/wallet/catalog.ts` to the
spec section it covers. It is the authoritative cross-reference for
`MAS-136`: when a spec section is cited in a test's `specRef`, it must appear
here.

Source spec:

- `/home/big/Documents/vc-test` (branch `docs/mas-58-mechanical-correction`, tip `02debd4f`)
- Canonical doc: `docs/conformance/openid4vci-vp/conformance-testcase-corrected.md`

Format: `[test_id](…)` → spec section.

## OID4VCI — Credential Offer (§4.1)

- `FT.IC.CO.I.H.VB.001` — Credential Offer (by value) — §4.1.1 + §4.1.2
- `FT.IC.CO.I.H.VB.002` — Credential Offer (by reference, `offer_uri`) — §4.1.1
- `FT.IC.CO.I.H.IB.001` — Offer missing both `credential_configuration_ids` and `offer_uri` — §4.1.1

## OID4VCI — Authorization (§5)

- `FT.IC.AU.I.H.VB.001` — Authorization Request with PKCE + `authorization_details` — §5.1.1 + §5.1.2 + §3.5 (RFC 7636) + RFC 9396
- `FT.IC.AU.I.H.VB.AD.001` — `authorization_details` entry shape — §5.1.1 + RFC 9396
- `FT.IC.AU.I.H.IB.PKCE.001` — PKCE missing `code_challenge` — §3.5
- `FT.IC.AU.I.H.IB.PKCE.002` — PKCE downgraded to `plain` — §3.5
- `FT.IC.AU.I.H.IB.AD.001` — `authorization_details` missing `type` — §5.1.1
- `FT.IC.AU.I.H.IB.AD.003` — `authorization_details` malformed JSON — §5.1.1
- `FT.IC.AU.I.H.IB.005` — Authorization missing `client_id` (invalid_client) — §5.1.1 + RFC 6749 §4.1.2.1

## OID4VCI — Token Exchange (§6)

- `FT.IC.TE.I.H.VB.001` — Token Exchange with PKCE verifier — §6.1 + RFC 6749 §4.1.3 + RFC 7636 §4.4
- `FT.IC.TE.I.H.IB.005` — Token Exchange missing `code_verifier` — §6.1 + RFC 7636 §4.4
- `FT.IC.TE.I.H.IB.006` — Token unsupported `grant_type` (unsupported_grant_type) — §6.1 + RFC 6749 §5.2

## OID4VCI — Credential Request (§7)

- `FT.IC.CI.I.H.VB.001` — Credential Request with KB-JWT (ES256) — §7.1 + §7.2
- `FT.IC.CI.I.H.VB.002` — Credential Request with KB-JWT (EdDSA) — §7.2.1 + App. B
- `FT.IC.CI.I.H.IB.001` — Credential Request missing proof — §7.1
- `FT.IC.CI.I.H.IB.002` — Credential Request bad c_nonce — §7.2
- `FT.IC.CI.I.H.IB.003` — Credential unsupported `credential_format` (unsupported_credential_format) — §7.1 + §A.3
- `FT.IC.CI.I.H.IB.004` — Credential unsupported `credential_type` (unsupported_credential_type) — §7.1 + §A.3

## OID4VCI — Deferred Credential (§8)

- `FT.IC.DC.I.H.VB.001` — Deferred Credential polling → `transaction_id` — §8.1 + §8.2 + §8.3
- `FT.IC.DC.I.H.VB.002` — Pre-authorized + numeric `tx_code` — §8.1 + §6.1
- `FT.IC.DC.I.H.VB.003` — Pre-authorized + alphanumeric `tx_code` — §8.1 + §6.1
- `FT.IC.DC.I.H.VB.004` — `user_pin_required` toggle — §8.1
- `FT.IC.DC.I.H.IB.001` — Deferred invalid `transaction_id` (invalid_request) — §8.3
- `FT.IC.DC.I.H.IB.002` — Deferred missing `tx_code` — §8.1 + §6.1
- `FT.IC.DC.I.H.IB.003` — Deferred `issuance_pending` + interval — §8.3
- `FT.IC.DC.I.H.IB.004` — Deferred `invalid_transaction_id` — §8.3

## OID4VCI — Notification (§9)

- `FT.IC.NO.I.H.VB.001` — `notification` with `event=credential_accepted` — §9.1 + §9.2
- `FT.IC.NO.I.H.VB.002` — `notification` with `event=credential_deleted` — §9.1
- `FT.IC.NO.I.H.VB.003` — `notification` with `event=credential_failure` — §9.1
- `FT.IC.NO.I.H.IB.001` — Unknown event (invalid_request) — §9.1
- `FT.IC.NO.I.H.IB.002` — `invalid_notification_id` — §9.1
- `FT.IC.NO.I.H.IB.003` — Missing `notification_id` — §9.1

## OID4VCI — Refresh (§6.1 + §7.2)

- `FT.IC.RF.I.H.VB.001` — `refresh_token` grant + re-issue — §6.1 + §7.2
- `FT.IC.RF.I.H.IB.001` — Expired `refresh_token` (invalid_grant) — §6.1 + RFC 6749 §5.2
- `FT.IC.RF.I.H.VB.002` — Re-issuance rotates c_nonce (stale-nonce handling) — §7.2 + §6.1
- `FT.IC.RF.I.H.IB.002` — KB-JWT audience mismatch (invalid_grant) — §7.2 + §6.1

## OID4VCI — Discovery (§4.2)

- `FT.WL.MT.W.V.VB.001` — Wallet fetches issuer metadata — §4.2

## OID4VP — Authorization Request (§5.1)

- `FT.PR.AU.V.H.VB.001` — `response_type=vp_token` + DCQL — §6.1 + §5.1 + §6.4
- `FT.PR.AU.V.H.IB.001` — Missing `client_id` (invalid_request) — §5.1
- `FT.PR.AU.V.H.IB.002` — `dcql_query` malformed JSON — §5.1 + §6.4
- `FT.PR.AU.V.H.IB.003` — `vp_token` signature invalid — §6.1
- `FT.PR.AU.V.H.VB.CM.001` — `client_metadata.vp_formats` — §5.1
- `FT.PR.AU.V.H.VB.CM.002` — `client_metadata` + `response_mode=direct_post.jwt` (JARM) — §5.1 + RFC 9101
- `FT.PR.AU.V.H.IB.CM.001` — `client_metadata` missing `vp_formats` — §5.1

## OID4VP — DCQL (§6.4)

- `FT.PR.AU.V.H.VB.DCQL.001` — DCQL rendering — §6.4

## OID4VP — Presentation Exchange 2.x (§6.1)

- `FT.PR.AU.V.H.VB.PD.001` — `presentation_definition` with `input_descriptors` + `format` — §6.1 + DIF PE 2.x
- `FT.PR.AU.V.H.VB.PD.002` — `presentation_definition` with `constraints.fields` — §6.1 + DIF PE 2.x
- `FT.PR.AU.V.H.IB.PD.001` — `presentation_definition` missing `id` — §6.1 + DIF PE 2.x
- `FT.PR.AU.V.H.IB.PD.002` — `presentation_definition` empty `input_descriptors` — §6.1 + DIF PE 2.x

## OID4VP — Presentation Response (§6.1)

- `FT.WL.PR.W.V.VB.001` — Wallet `vp_token` response (DCQL) — §5.1 + §6.1
- `FT.WL.PR.W.V.IB.001` — Wallet rejects unknown credential — §5.1
- `FT.WL.PR.W.V.VB.JARM.001` — Wallet responds to JARM-secured `direct_post.jwt` — §5.1 + RFC 9101

## Wallet — Deferred polling (§8.3)

- `FT.WL.DC.W.V.VB.001` — Wallet polls `/deferred/credential` with interval backoff — §8.3

## Wallet — Notification handling (§9.1)

- `FT.WL.NO.W.V.VB.001` — Wallet handles `credential_deleted` — §9.1

## Wallet — Full issuance flow (§4–§7)

- `FT.WL.IC.W.I.VB.001` — Wallet completes full OID4VCI issuance (offer→auth→token→credential) — §4–§7

## Summary

- Total unique test ids: 56
- Total executed cases across 4 modes: 112 (each case may serve multiple modes)
- OID4VCI cases: 41
- OID4VP cases: 15
- Wallet-side cases: 4
- Spec sections covered: §3.5, §4.1, §4.2, §5.1, §5.2, §6.1, §6.4, §7.1, §7.2, §7.2.1, §8.1, §8.2, §8.3, §9.1, §9.2, §A.3, RFC 6749, RFC 7636, RFC 9101, RFC 9396, DIF PE 2.x
