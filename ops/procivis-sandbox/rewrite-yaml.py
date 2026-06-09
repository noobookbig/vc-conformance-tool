#!/usr/bin/env python3
"""
rewrite-yaml.py — patch the two th-public-*-procivis entries in
ops/qa-reports/targets.example.yaml with the live IDs from a seeder
state JSON.

Input:  /tmp/procivis-sandbox-state.json (or path passed via --state)
Output: the YAML file in place (atomic: write to .tmp, then rename)

Design constraint: the YAML carries extensive comments and hand-tuned
field orderings. We deliberately do NOT do a full PyYAML round-trip
(comments would be lost). Instead we do targeted regex substitution of
only the values that drift across a re-seed:

  * the issuer DID                     (did:key:z6Mk...)
  * the identifierId                   (UUID)
  * the credentialSchemaId             (UUID)
  * the proofRequestId                 (UUID)
  * the organisationId                 (UUID, used inside the vct URL)

All other lines in the YAML (notes, auth block, baseUrl, kind, etc.)
are bit-identical before and after the rewrite. This keeps the diff
small and reviewable, and means the change is safe to re-run.

Exit codes:
  0  success, YAML was updated (or already matched the state file)
  1  state file is missing or malformed
  2  YAML file is missing
  3  YAML file does not contain the expected th-public-*-procivis anchors
  4  one of the dynamic values was not found in the YAML (would mean
     the schema drifted; safer to fail loud than to silently no-op)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from pathlib import Path

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
DID_KEY_RE = re.compile(r"did:key:z6Mk[A-Za-z0-9]+")


def find_uuid_after_marker(text: str, marker: str) -> str | None:
    """Return the first UUID appearing in `text` after the first match
    of `marker` on its own line. Used to scope the rewrite so we don't
    accidentally patch the wrong entry."""
    idx = text.find(marker)
    if idx < 0:
        return None
    tail = text[idx:]
    m = UUID_RE.search(tail)
    return m.group(0) if m else None


def find_did_after_marker(text: str, marker: str) -> str | None:
    idx = text.find(marker)
    if idx < 0:
        return None
    tail = text[idx:]
    m = DID_KEY_RE.search(tail)
    return m.group(0) if m else None


def replace_anchored(text: str, anchor: str, new_value: str) -> tuple[str, int]:
    """Replace the first occurrence of `anchor` followed by any of
    {space, colon-slash, end-of-line, quote} with `new_value`, anchored
    to the line where the anchor appears. Returns (new_text, count)."""
    lines = text.split("\n")
    out: list[str] = []
    count = 0
    for line in lines:
        if anchor in line and count == 0:
            # Replace only the first occurrence on the first matching line
            new_line = line.replace(anchor, new_value, 1)
            out.append(new_line)
            count += 1
        else:
            out.append(line)
    return "\n".join(out), count


def replace_all_in_string_values(text: str, old: str, new: str) -> tuple[str, int]:
    """Replace ALL occurrences of `old` with `new` across the file. The
    caller is responsible for picking values that uniquely identify the
    dynamic parts (UUIDs, DID strings) — these are guaranteed unique per
    state file because they were just minted."""
    return text.replace(old, new), text.count(old)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--state", required=True, help="Path to the seeder state JSON")
    p.add_argument(
        "--yaml",
        required=True,
        help="Path to ops/qa-reports/targets.example.yaml (rewritten in place)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change; do not write the file",
    )
    args = p.parse_args()

    state_path = Path(args.state)
    yaml_path = Path(args.yaml)

    if not state_path.is_file():
        print(f"FATAL: state file not found: {state_path}", file=sys.stderr)
        return 1
    if not yaml_path.is_file():
        print(f"FATAL: yaml file not found: {yaml_path}", file=sys.stderr)
        return 2

    try:
        state = json.loads(state_path.read_text())
    except json.JSONDecodeError as e:
        print(f"FATAL: state file is not valid JSON: {e}", file=sys.stderr)
        return 1

    for k in ("did", "identifierId", "credentialSchemaId", "proofRequestId", "organisationId"):
        if k not in state or not state[k]:
            print(f"FATAL: state file missing key: {k}", file=sys.stderr)
            return 1

    original = yaml_path.read_text()

    # Anchors that mark the start of each th-public-* entry. The first
    # line we hit per entry has a stable, well-known shape: the
    # `- id: <entry-id>` line. The dynamic values appear below it; we
    # scope our replacements to the text between the issuer-entry
    # anchor and the next blank-line-then-dash (i.e. the next entry).
    issuer_anchor = "- id: th-public-sandbox-procivis"
    verifier_anchor = "- id: th-public-verifier-procivis"

    # Slice the file into three regions: preamble, issuer entry,
    # verifier entry, rest. We rewrite values inside the two entry
    # regions only, leaving the preamble, in-repo-mock entry, and
    # closing notes untouched.
    issuer_start = original.find(issuer_anchor)
    verifier_start = original.find(verifier_anchor)
    if issuer_start < 0 or verifier_start < 0:
        print("FATAL: could not locate both th-public-*-procivis anchors in YAML", file=sys.stderr)
        return 3
    if verifier_start < issuer_start:
        print("FATAL: verifier anchor appears before issuer anchor (file reordered?)", file=sys.stderr)
        return 3

    preamble = original[:issuer_start]
    issuer_block = original[issuer_start:verifier_start]
    verifier_block = original[verifier_start:]

    # The seeder mints new UUIDs every time. The YAML, however, has
    # specific values that need to be replaced wherever they appear in
    # the two entries. We compute the *currently-in-YAML* values by
    # looking at the first occurrence of each dynamic token inside the
    # two blocks, then replace them globally inside the blocks.

    new_issuer_did = state["did"]
    new_identifier_id = state["identifierId"]
    new_schema_id = state["credentialSchemaId"]
    new_proof_request_id = state["proofRequestId"]
    new_org_id = state["organisationId"]

    # VCT URL = http://localhost:3000/ssi/vct/v1/{org}/{schema}
    # We compose it from the seeder's BASE (the YAML uses localhost:3000
    # because that's how the issuerMetadata serves it back). If the
    # seeder is talking to a non-default BASE, fall back to whatever
    # host the YAML currently has.
    yaml_host = "http://localhost:3000"  # matches what the issuerMetadata serves
    new_vct = f"{yaml_host}/ssi/vct/v1/{new_org_id}/{new_schema_id}"
    new_credential_issuer = (
        f"{yaml_host}/ssi/openid4vci/final-1.0/OPENID4VCI_FINAL1/"
        f"{new_identifier_id}/{new_schema_id}"
    )
    new_credential_endpoint = (
        f"{yaml_host}/ssi/openid4vci/final-1.0/{new_schema_id}/credential"
    )
    new_notification_endpoint = (
        f"{yaml_host}/ssi/openid4vci/final-1.0/{new_schema_id}/notification"
    )
    new_auth_request_endpoint = (
        f"http://127.0.0.1:3000/ssi/openid4vp/draft-25/{new_proof_request_id}/client-request"
    )

    # Detect the OLD values by scanning the issuer/verifier blocks for
    # the first occurrence of each pattern. We need to find the
    # current UUIDs and DID so we can replace them.
    old_issuer_did = find_did_after_marker(issuer_block, "issuerDids:")
    old_identifier_id = find_uuid_after_marker(
        issuer_block, "credential_issuer: http://localhost:3000/ssi/openid4vci"
    )

    # The old VCT and old credential_issuer URL are full strings we
    # can extract by regex too.
    vct_re = re.compile(r"http://localhost:3000/ssi/vct/v1/[0-9a-f-]+/[0-9a-f-]+")
    m_old_vct = vct_re.search(issuer_block)
    old_vct = m_old_vct.group(0) if m_old_vct else None

    cred_issuer_re = re.compile(
        r"http://localhost:3000/ssi/openid4vci/final-1\.0/OPENID4VCI_FINAL1/[0-9a-f-]+/[0-9a-f-]+"
    )
    m_old_cred_issuer = cred_issuer_re.search(issuer_block)
    old_credential_issuer = m_old_cred_issuer.group(0) if m_old_cred_issuer else None

    cred_endpoint_re = re.compile(
        r"http://localhost:3000/ssi/openid4vci/final-1\.0/[0-9a-f-]+/credential"
    )
    m_old_cred_endpoint = cred_endpoint_re.search(issuer_block)
    old_credential_endpoint = m_old_cred_endpoint.group(0) if m_old_cred_endpoint else None

    notif_endpoint_re = re.compile(
        r"http://localhost:3000/ssi/openid4vci/final-1\.0/[0-9a-f-]+/notification"
    )
    m_old_notif = notif_endpoint_re.search(issuer_block)
    old_notification_endpoint = m_old_notif.group(0) if m_old_notif else None

    auth_req_re = re.compile(
        r"http://127\.0\.0\.1:3000/ssi/openid4vp/draft-25/[0-9a-f-]+/client-request"
    )
    m_old_auth = auth_req_re.search(verifier_block)
    old_auth_request_endpoint = m_old_auth.group(0) if m_old_auth else None

    # Sanity: every old value must be findable, and at least the
    # values we will rewrite must be different from the new values
    # (otherwise there's nothing to do, which is fine — exit 0).
    missing = []
    if not old_issuer_did:
        missing.append("old issuerDids[0] DID")
    if not old_vct:
        missing.append("old vct URL")
    if not old_credential_issuer:
        missing.append("old credential_issuer URL")
    if not old_credential_endpoint:
        missing.append("old credential_endpoint URL")
    if not old_notification_endpoint:
        missing.append("old notification_endpoint URL")
    if not old_auth_request_endpoint:
        missing.append("old authorizationRequestEndpoint")
    if missing:
        print(
            "FATAL: could not locate these dynamic values in the YAML (schema drift?):",
            file=sys.stderr,
        )
        for m in missing:
            print(f"  - {m}", file=sys.stderr)
        return 4

    # Build the new issuer and verifier blocks. We rewrite every
    # occurrence of each old value inside its block. The values are
    # specific enough (full URLs / full DID strings) that there is no
    # risk of clobbering the in-repo-mock entry (which lives in the
    # preamble) — and the preamble is rewritten as a no-op pass
    # because none of these strings appear there.
    #
    # We rewrite FULL URL strings first (they encode the bare UUIDs
    # as substrings). The bare-UUID / bare-DID replaces are skipped
    # because after the full-URL pass, the bare tokens no longer
    # exist in the block as standalone strings. The DID is rewritten
    # last because it is the only token that may appear outside
    # of an encoded URL (in the `trust.issuerDids: [...]` field).
    new_issuer_block = issuer_block
    new_issuer_block, n = replace_all_in_string_values(
        new_issuer_block, old_credential_issuer, new_credential_issuer
    )
    assert n > 0, "credential_issuer URL not found in issuer block"
    new_issuer_block, n = replace_all_in_string_values(
        new_issuer_block, old_credential_endpoint, new_credential_endpoint
    )
    assert n > 0, "credential_endpoint URL not found in issuer block"
    new_issuer_block, n = replace_all_in_string_values(
        new_issuer_block, old_notification_endpoint, new_notification_endpoint
    )
    assert n > 0, "notification_endpoint URL not found in issuer block"
    new_issuer_block, n = replace_all_in_string_values(new_issuer_block, old_vct, new_vct)
    assert n > 0, "vct URL not found in issuer block"
    new_issuer_block, n = replace_all_in_string_values(new_issuer_block, old_issuer_did, new_issuer_did)
    assert n > 0, "issuer DID not found in issuer block (race?)"

    new_verifier_block = verifier_block
    new_verifier_block, n = replace_all_in_string_values(
        new_verifier_block, old_auth_request_endpoint, new_auth_request_endpoint
    )
    assert n > 0, "authorizationRequestEndpoint not found in verifier block"
    new_verifier_block, n = replace_all_in_string_values(
        new_verifier_block, old_vct, new_vct
    )
    assert n > 0, "vct URL not found in verifier block"
    new_verifier_block, n = replace_all_in_string_values(
        new_verifier_block, old_issuer_did, new_issuer_did
    )
    assert n > 0, "issuer DID not found in verifier block"

    new_text = preamble + new_issuer_block + new_verifier_block

    if new_text == original:
        print(f"OK: {yaml_path} already matches state file (no change needed)")
        return 0

    if args.dry_run:
        print("DRY-RUN: would rewrite the following values in the YAML:")
        print(f"  issuerDids[0]    : {old_issuer_did}  ->  {new_issuer_did}")
        print(f"  identifierId     : (encoded in URLs)  ->  {new_identifier_id}")
        print(f"  credentialSchemaId: (encoded in URLs)  ->  {new_schema_id}")
        print(f"  proofRequestId   : (encoded in URL)  ->  {new_proof_request_id}")
        print(f"  organisationId   : (used inside vct URL)  ->  {new_org_id}")
        return 0

    # Atomic write: write to a tempfile in the same dir, then rename.
    yaml_dir = yaml_path.parent
    fd, tmp_path = tempfile.mkstemp(prefix=".targets.example.yaml.", dir=yaml_dir)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(new_text)
        os.replace(tmp_path, yaml_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass
        raise

    print(f"OK: rewrote {yaml_path} with live IDs from {state_path}")
    print(f"  issuerDids[0]    : {new_issuer_did}")
    print(f"  identifierId     : {new_identifier_id}")
    print(f"  credentialSchemaId: {new_schema_id}")
    print(f"  proofRequestId   : {new_proof_request_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
