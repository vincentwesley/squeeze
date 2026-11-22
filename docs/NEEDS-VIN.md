# Needs Vin

Nothing here blocks the project; everything works from the repository as it is. These are optional steps that need an account owner.

## 1. Turn on GitHub Pages (one click, recommended)

The Pages workflow is ready, but GitHub only lets a repository admin switch Pages on; the workflow's own token is not allowed to (the first run failed with "Resource not accessible by integration", and the workflow now skips deployment with a notice until Pages is on).

1. Open **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Open **Actions → Pages → Run workflow** (or push anything to `main`).

The page then appears at `https://vincentwesley.github.io/squeeze/` and redeploys on every push to `main`.

## 2. Publish to npm (optional)

```sh
npm login                      # an npm account that owns (or can create) the @vins-atelier scope
npm run build && npm test
npm publish --access public
```

## 3. Enable private vulnerability reporting

`SECURITY.md` asks reporters to use GitHub's private reporting. Turn it on: **Settings → Code security → Private vulnerability reporting → Enable**.

## 4. Releases (done, automatic)

`v1.0.0` is tagged and published at https://github.com/vincentwesley/squeeze/releases/tag/v1.0.0 with the changelog notes, `squeeze-web-1.0.0.zip` and `vins-atelier-squeeze-1.0.0.tgz`. `.github/workflows/release.yml` does this whenever `main` carries an untagged `package.json` version: for the next release, bump the version, add a CHANGELOG section and merge to `main`.
