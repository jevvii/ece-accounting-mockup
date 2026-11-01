# Deploy ECE Accounting to GitHub Pages

This walkthrough publishes the contents of `mockup/` as a separate repository named
`ece-accounting-mockup`. In that repository, `package.json`, `index.html`, `src/` and
`.github/` must be at the top level. The parent project's workbook/research files stay local.

Prepared configuration:

- `vite.config.ts` uses `base: './'`, so built assets work at a repository subpath.
- Hash routes such as `#/reports/trial-balance` require no server rewrite or 404 workaround.
- `.github/workflows/pages.yml` installs the locked dependencies and Chromium, runs
  `npm run verify`, uploads only `dist/`, and deploys after those checks succeed.
- Pull requests run checks only. Pushes to `main` and manual runs on `main` can publish.
- The accounting oracle fixture is included in `tests/fixtures/`; tests do not need the
  parent project directory.

## 1. Create an empty repository

On GitHub, create a repository named **ece-accounting-mockup**. For GitHub Free, use a
public repository; private-repository Pages availability depends on the plan. Leave
**Add a README**, **Add .gitignore**, and **Choose a license** unchecked so the repository
is empty. Public visibility also makes committed source visible.

GitHub documents [Pages plan availability and custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## 2. Push only the mockup folder

Run these commands in your own terminal. Replace `YOUR_GITHUB_USERNAME` with the owner of
the repository you just created. This workspace currently has no usable Git repository;
these commands initialize one inside `mockup/`.

```bash
cd /home/javvii/FreelanceProject/Project7/fin-axis/mockup
git init -b main
git add .
git status --short
git commit -m "Publish ECE Accounting mockup"
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/ece-accounting-mockup.git
git push -u origin main
```

The `.gitignore` excludes dependencies, build output, browser artifacts and local environment
files. Commit `package-lock.json`; GitHub will build `dist/` itself. Before committing,
`git status --short` should list `.github/workflows/pages.yml`, `package.json`, the lockfile
and source, and should not list `node_modules/`, `dist/` or `.env`.

If Git asks for a commit identity, configure your own Git name/email and repeat the commit.
If HTTPS authentication fails, sign in with GitHub CLI (`gh auth login`, then
`gh auth setup-git`) if installed, or use GitHub's supported Git authentication method.
Your GitHub website password does not authenticate HTTPS Git pushes. See
[GitHub's HTTPS authentication guide](https://docs.github.com/en/get-started/git-basics/about-remote-repositories#cloning-with-https-urls).

These commands assume a new local repository and empty remote. If `origin` or an existing
history is already present, inspect it rather than force-pushing or replacing it.

## 3. Enable Pages

Open the GitHub repository, then **Settings → Pages → Build and deployment → Source**.
Choose **GitHub Actions**. Use the prepared workflow; do not add a separate Jekyll workflow
or choose branch-based publishing of the source folder.

See [GitHub's publishing-source instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## 4. Run the deployment

Open **Actions → Deploy ECE Accounting mockup → Run workflow**, select **main**, and run it.
The workflow checks TypeScript, domain tests, the production build and Playwright before
publishing. The first automatic run may have reached deployment before Pages was enabled;
run it again after completing step 3.

Wait for both **build** and **deploy** to succeed. Use the URL shown in the deployment
summary or **Settings → Pages**. For the proposed repository it will normally be:

```text
https://YOUR_GITHUB_USERNAME.github.io/ece-accounting-mockup/
```

Open Main, Admin → Numbering, and Reports → Trial Balance. Confirm that assets load, account
codes match the policy, and monthly controls work. Open a record, reload it, and use Back.
This checks the deployed repository path as well as the source-based test suite.

## 5. Publish later changes

From the same local `mockup/` repository:

```bash
git add .
git diff --cached --stat
git commit -m "Describe the mockup change"
git push
```

Each push to `main` runs the workflow again. Deployment uses only the verified `dist/`
artifact. If a check fails, inspect that step in Actions and fix the failure; do not remove
the check to publish. To roll back a deployed change, revert its commit and push the revert
so the same checks/build/deploy process runs again.

## What hosting changes

GitHub Pages serves the static mockup. The synthetic data still lives in each browser's
localStorage; there is no shared database, login server or multiuser synchronization.
Your localhost edits are not automatically copied to the Pages origin. First use on the
hosted origin starts from its own stored state or the synthetic seed. Continue using only
synthetic data; hosting does not add production identity or payroll protection.

## If deployment fails

| Symptom | Check |
|---|---|
| Workflow absent in Actions | `.github/workflows/pages.yml` must be at the repository root, not under a committed `mockup/` subfolder; include hidden files in any manual copy |
| `package-lock.json` or package scripts not found | The recommended repository root is the contents of `mockup/` |
| Pages configuration / 404 error in the configure step | Enable **Settings → Pages → Source → GitHub Actions**, then rerun on `main` |
| `npm ci` / registry / dependency failure | Expand the install log; ensure the committed lockfile is present and its exact packages are available; do not silently replace locked versions |
| TypeScript, Vitest or Playwright failure | Read the first failing step/test; deployment intentionally waits for a real pass |
| Browser installation failure | Inspect `Install Chromium and system dependencies`; do not skip browser tests |
| Build is green but deploy reports permissions | Inspect repository/organization Actions policy and the `github-pages` environment; the workflow supplies Pages write and OIDC permissions only to deployment |
| Blank page or JS/CSS 404 | Confirm the committed config contains `base: './'`, use the URL ending in `/`, and hard-reload after a successful deployment |
| Public site URL still 404 | Check that the deploy job completed and use its exact URL; allow publication to finish |

## Local preparation evidence

The prior review passed TypeScript, 169 domain tests and build; its browser/benchmark runs
were blocked by local sandbox startup restrictions. Those historical checks do not prove
that this new workflow has run on GitHub. Consult `STATE.json`, `ACCEPTANCE.md` and the
current handoff for the preparation check results. No repository has been created, pushed
or deployed by preparing these files.

Technical references: [Vite relative base](https://vite.dev/guide/build.html#relative-base),
[Vite GitHub Pages deployment](https://vite.dev/guide/static-deploy.html#github-pages),
and [GitHub Pages workflow permissions/artifacts](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
