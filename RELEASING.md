# Releasing

This package uses Semantic Versioning and Conventional Commits.

## Before every release

1. Ensure `main` is up to date and clean.
2. Update `CHANGELOG.md`.
3. Set the intended version in `package.json` and `package-lock.json`.
4. Run:

```bash
npm ci
npm run release:check
npm run smoke:live
npm run verify:interest-live
```

`release:check` runs the deterministic test and package validation suite, creates the npm tarball, installs it into a temporary consumer project, and verifies both ESM and CommonJS imports.

`smoke:live` is the broad real-Google-data gate across the public data methods. `verify:interest-live` is a deeper Interest Over Time validator that compares the package output with the raw Google timeline response used for the same request. Keep these live checks separate from normal CI because Google may rate-limit or challenge external runners.

The deep live validator supports optional environment overrides such as `GOOGLE_TRENDS_TEST_KEYWORDS`, `GOOGLE_TRENDS_TEST_GEO`, and `GOOGLE_TRENDS_TEST_TIME_RANGE`.

## First release: `0.1.0`

npm Trusted Publishing cannot create the first version of a brand-new package. Publish `0.1.0` manually with your npm account and two-factor authentication:

```bash
npm login
npm whoami
npm run release:check
npm publish --access public
```

After npm confirms the publication:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The tag workflow detects that `0.1.0` already exists and exits without republishing it.

## Enable Trusted Publishing after `0.1.0`

Using npm 11.5.1 or newer, run:

```bash
npm trust github @arham-rumi/google-trends-api --file publish.yml --repo arham-rumi/google-trends-api --allow-publish
```

Alternatively, configure it on npmjs.com under the package's **Settings → Trusted publishing** section using:

- GitHub user: `arham-rumi`
- Repository: `google-trends-api`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Do not add an `NPM_TOKEN` secret to GitHub. The workflow uses short-lived OIDC credentials.

## Future releases

Update the changelog, then create the version commit and tag:

```bash
npm version patch -m "chore(release): v%s"
git push origin main --follow-tags
```

Use `minor` or `major` instead of `patch` when required by Semantic Versioning. The pushed tag triggers `.github/workflows/publish.yml`.

After Trusted Publishing has succeeded once, npm recommends disallowing traditional publish tokens in the package settings.
