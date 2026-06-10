# Cutting a v2 release (operator playbook)

This document is the step-by-step recipe for cutting a new v2 release
tarball + Docker image + GitHub release. The intended audience is the
operator (CTO or DevOps) with shell + GitHub + GHCR access. The
workstream owner (SeniorDeveloper) hands off a green build; the
operator runs the rest.

The recipe below is for the **v2.0.0** cut specifically. The shape
applies to future `v2.x.y` cuts with the version bumps updated.

## Pre-flight (verifications the operator runs)

These are the same checks the release PR's CI gate runs. The operator
should re-run them on the release commit just before tagging — never
trust a CI from a week ago.

```bash
# Repo root
cd <repo-root>

# 1. v2 engine + server tests (58 tests)
npm run v2:test

# 2. v2 web UI tests
npm --prefix apps/conformance-v2/web run test

# 3. v2 web UI build (the dist/ the Docker image will mount)
npm --prefix apps/conformance-v2/web run build

# 4. Typecheck
npx tsc -p apps/conformance-v2/tsconfig.json --noEmit

# 5. Image build (this also runs the SPA build inside the container)
docker build -f ops/docker-v2/Dockerfile -t vc-conformance-v2:2.0.0 .

# 6. CLI smoke (independent of UI)
bash ops/smoke/v2-cli.sh

# 7. Server smoke (UI + API)
bash ops/smoke/v2-server.sh
```

If any of the seven checks fail, stop. The release is not green; the
QA gate ([MAS-258](/MAS/issues/MAS-258)) has rejected this commit and
the issue thread will name the blocker.

## Tag the release

The tag is `v<MAJOR>.<MINOR>.<PATCH>` matching the image tag and the
package versions in `apps/conformance-v2/web/package.json` and
`apps/conformance-v2/README.md` (the engine has no `package.json` of
its own; the version is documented in the README and surfaced via
`/api/health`).

```bash
# Verify the working tree is clean
git status

# Tag the current commit (the merge commit of feat/mas-242-conformance-v2
# or the fix branch that closed the QA gate)
git tag -a v2.0.0 -m "v2.0.0 — first release of the v2 conformance test tool"

# Push the tag
git push origin v2.0.0
```

## Build the source tarball

```bash
git archive \
  --format=tar.gz \
  --prefix=vc-conformance-v2-2.0.0/ \
  -o vc-conformance-v2-2.0.0.tar.gz \
  v2.0.0

# Verify the tarball size is reasonable (< 5 MB; the repo's heavy
# assets are gitignored and not part of the archive)
ls -lh vc-conformance-v2-2.0.0.tar.gz
```

## Push the Docker image to GHCR

`docker push` needs GHCR auth. The operator has a Personal Access Token
with `write:packages` scope. The convention is to log in once per
machine:

```bash
# One-time: log in to GHCR
echo "$GHCR_PAT" | docker login ghcr.io -u noobookbig --password-stdin
# or, with the older classic flow:
#   docker login ghcr.io -u noobookbig
# and paste the PAT at the prompt.

# Build the multi-arch image (linux/amd64 + linux/arm64).
# The image is small enough that the build takes ~30s on a warm cache.
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f ops/docker-v2/Dockerfile \
  -t ghcr.io/noobookbig/vc-conformance-v2:2.0.0 \
  --push \
  .

# Also tag :latest so `docker pull ghcr.io/noobookbig/vc-conformance-v2`
# gives the most recent release.
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f ops/docker-v2/Dockerfile \
  -t ghcr.io/noobookbig/vc-conformance-v2:latest \
  --push \
  .
```

If `docker buildx` is not set up on the operator's machine (single-
arch only), drop the `--platform` and `--push` flags; build locally
and `docker push` the single-arch manifest:

```bash
docker build -f ops/docker-v2/Dockerfile \
  -t ghcr.io/noobookbig/vc-conformance-v2:2.0.0 \
  -t ghcr.io/noobookbig/vc-conformance-v2:latest .

docker push ghcr.io/noobookbig/vc-conformance-v2:2.0.0
docker push ghcr.io/noobookbig/vc-conformance-v2:latest
```

## Cut the GitHub release

The release is a GitHub Release (not just a tag) with the three
artefacts attached.

### With `gh` (the operator's machine likely has this)

```bash
gh release create v2.0.0 \
  --title "v2.0.0 — first release of the v2 conformance test tool" \
  --notes-file - <<'NOTES'
v2.0.0 is the first release of the v2 conformance test tool
(engine + HTTP server + web UI + Docker image), shipping in parallel
with the maintained v0.1.0 webapp. See CHANGELOG.md for the full
list of changes.

**Highlights**
- Real per-case pass/fail, halts on the first real failure
- Stop-on-error is mandatory; the "demo UX" is gone
- Precheck is a separate gate (exit 4)
- Catalog loader rejects >50% coverage (structural fix for the
  v0.1.0 pass-rate inflation pattern)
- Reports in JSON, JUnit XML, and HTML
- Web UI (Vite + React) for browsing runs interactively
- Single Docker image for CLI + server; defaults to UI mode on :8080

**Quick start**
```bash
docker run --rm -p 8080:8080 ghcr.io/noobookbig/vc-conformance-v2:2.0.0
```

CLI mode:
```bash
docker run --rm \
  -v "$PWD/out:/out" \
  ghcr.io/noobookbig/vc-conformance-v2:2.0.0 \
  node --import tsx apps/conformance-v2/src/cli.ts run \
    --config /out/config.yaml \
    --catalog references/testcases \
    --out /out
```

**Known limitations**
- The image is ~250 MB on linux/amd64. Single-arch builds are fine;
  multi-arch is documented in ops/docker-v2/RELEASE.md.
- The HTTP server has no built-in auth; do not expose port 8080 to
  the public internet without a reverse proxy that handles auth.
NOTES
```

### Without `gh` (the build host has no GitHub CLI)

Use the GitHub web UI:

1. Open `https://github.com/noobookbig/vc-conformance-test/releases/new`.
2. Choose tag `v2.0.0`.
3. Release title: `v2.0.0 — first release of the v2 conformance test tool`.
4. Paste the notes from the `--notes-file` block above.
5. Attach the two binary artefacts:
   - `vc-conformance-v2-2.0.0.tar.gz` (the source tarball)
6. The Docker image is **not** attached as a release asset; it
   lives at `ghcr.io/noobookbig/vc-conformance-v2:2.0.0` and is
   linked from the release notes.
7. Click "Publish release".

## Post-cut verifications

The QA gate ([MAS-258](/MAS/issues/MAS-258)) runs these as the final
sign-off:

```bash
# 1. Pull the published image, run the server smoke against it
docker pull ghcr.io/noobookbig/vc-conformance-v2:2.0.0
IMAGE_TAG=ghcr.io/noobookbig/vc-conformance-v2:2.0.0 bash ops/smoke/v2-server.sh

# 2. Pull the source tarball, verify the build is reproducible
curl -L https://github.com/noobookbig/vc-conformance-test/releases/download/v2.0.0/vc-conformance-v2-2.0.0.tar.gz | tar -xz
cd vc-conformance-v2-2.0.0
bash ops/smoke/v2-cli.sh
bash ops/smoke/v2-server.sh
```

## When the cut goes wrong

- **Image build fails on the operator's machine but passes locally**
  → check the `apps/conformance-v2/web` build cache. The Dockerfile's
  `ui-build` stage re-installs the SPA's deps on a clean context; if
  a previous build left a half-written `node_modules`, the install
  fails. Fix: `docker builder prune -af`.
- **GHCR push rejected with `denied: requested access to the resource is denied`**
  → the PAT is missing `write:packages` scope. Generate a new PAT
  with the right scopes (or use a fine-grained token scoped to the
  `vc-conformance-test` repo + `packages:write`).
- **GitHub release upload fails with a 502**
  → retry. The GitHub release API occasionally 502s on the upload;
  re-running `gh release create` with the same args is idempotent.
- **The `:latest` tag points to the wrong image**
  → re-push `:latest` explicitly. GHCR does not auto-update
  `:latest`; the operator must re-build + re-push with the
  `--tag latest` form.

## Versioning rules

- The image tag, the GHCR tag, the git tag, and the
  `apps/conformance-v2/web/package.json` `version` field MUST match.
- A patch release (v2.0.1) increments `version`, re-tags, and ships.
  The `CHANGELOG.md` gets a new `## v2.0.1` section above `## v2.0.0`.
- A minor release (v2.1.0) is reserved for new catalog cases or new
  CLI/server features that do not break the engine contract. A major
  release (v3.0.0) is reserved for a one-way-door change to the
  exit-code contract, the report schema, or the catalog loader
  guards. Both require CTO sign-off.

## Sign-off

The release is not done until:

- [ ] All seven pre-flight checks pass on the release commit.
- [ ] `git tag v2.0.0` is pushed.
- [ ] `vc-conformance-v2-2.0.0.tar.gz` is attached to the GitHub
      release.
- [ ] `ghcr.io/noobookbig/vc-conformance-v2:2.0.0` is published.
- [ ] `CHANGELOG.md` has a `## v2.0.0` section on `main`.
- [ ] [MAS-258](/MAS/issues/MAS-258) QA gate posts a GO verdict
      against the published image and tarball.
- [ ] The release issue ([MAS-257](/MAS/issues/MAS-257) for v2.0.0)
      is marked `done` with a comment linking the GitHub release URL.
