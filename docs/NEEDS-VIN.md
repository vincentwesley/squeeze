# Needs Vin

Nothing here blocks the project; everything works from the repository as it is. These are optional steps that need an account owner.

## 1. Publish the web page (optional)

`dist/web/` is a static site. To host it on GitHub Pages:

1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Add `.github/workflows/pages.yml`:

   ```yaml
   name: Pages
   on: { push: { branches: [main] }, workflow_dispatch: {} }
   permissions: { contents: read, pages: write, id-token: write }
   jobs:
     deploy:
       runs-on: ubuntu-latest
       environment: { name: github-pages, url: '${{ steps.d.outputs.page_url }}' }
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 22, cache: npm }
         - run: npm ci && npm run build:web
         - uses: actions/upload-pages-artifact@v3
           with: { path: dist/web }
         - id: d
           uses: actions/deploy-pages@v4
   ```
3. Push to `main`; the page appears at `https://vincentwesley.github.io/squeeze/`.

## 2. Publish to npm (optional)

```sh
npm login                      # an npm account that owns (or can create) the @vins-atelier scope
npm run build && npm test
npm publish --access public
```

## 3. Enable private vulnerability reporting

`SECURITY.md` asks reporters to use GitHub's private reporting. Turn it on: **Settings → Code security → Private vulnerability reporting → Enable**.

## 4. Tag and release v1.0.0 (only if missing)

The session tries to push the `v1.0.0` tag itself. If https://github.com/vincentwesley/squeeze/tags does not list it, or if you want a GitHub Release page:

```sh
git checkout main && git pull
git tag -a v1.0.0 -m "Squeeze 1.0.0"
git push origin v1.0.0
```

Then go to **Releases → Draft a new release**, choose tag `v1.0.0`, title it "Squeeze 1.0.0", paste the 1.0.0 section of CHANGELOG.md, and optionally attach `dist/web` as a zip (`npm run build && cd dist && zip -r squeeze-web.zip web`).
