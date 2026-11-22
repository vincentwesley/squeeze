# Needs Vin

Nothing here blocks the project; everything works from the repository as it is. These are optional steps that need an account owner.

## 1. Web page hosting (automatic)

`.github/workflows/pages.yml` deploys `dist/web` to GitHub Pages on every push to `main`, at `https://vincentwesley.github.io/squeeze/`. It asks GitHub to enable Pages itself; if that step fails for lack of permission, open **Settings → Pages → Build and deployment → Source** once, choose **GitHub Actions**, and re-run the workflow from the Actions tab.

## 2. Publish to npm (optional)

```sh
npm login                      # an npm account that owns (or can create) the @vins-atelier scope
npm run build && npm test
npm publish --access public
```

## 3. Enable private vulnerability reporting

`SECURITY.md` asks reporters to use GitHub's private reporting. Turn it on: **Settings → Code security → Private vulnerability reporting → Enable**.

## 4. Releases (automatic)

`.github/workflows/release.yml` creates the `v<version>` tag and a GitHub Release whenever `main` carries a `package.json` version that is not tagged yet. v1.0.0 is released this way. For a new release, bump the version, add a CHANGELOG section and merge to `main`.
