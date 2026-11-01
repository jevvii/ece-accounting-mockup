# Environment — observed values

Collected on **2026-11-01** in the working workspace. These are observations from the actual
machine, not assumed compatibility.

## Machine

| Item | Observed |
|---|---|
| OS | Linux `archlinux` 7.1.9-arch1-2, x86_64 |
| CPU | AMD Ryzen 5 4600H with Radeon Graphics, 6 cores / 12 threads |
| Memory | 14 GiB visible total (`free -h`: 14Gi; benchmark records 15 GB via `os.totalmem()`) |
| Working directory | `/home/javvii/FreelanceProject/Project7/fin-axis/mockup` |
| Git | Project root is not a Git repository; no Git metadata was initialized or modified |

## Runtime and package manager

```text
$ node -v
v26.8.1
$ npm -v
12.0.2
```

`package.json` declares `"engines": { "node": ">=22.12.0" }`. The installed Node v26.8.1 is the
release actually used for every check below. No dependency upgrade was performed after the
lockfile was created.

## Resolved dependencies

Production:

| Package | Version |
|---|---|
| `react` | 19.3.1 |
| `react-dom` | 19.3.1 |
| `zod` | 4.6.7 |
| `papaparse` | 5.7.0 |

Development:

| Package | Version |
|---|---|
| `typescript` | 5.9.3 |
| `vite` | 8.3.5 |
| `@vitejs/plugin-react` | 6.1.2 |
| `vitest` | 5.0.5 |
| `@playwright/test` | 1.64.1 |
| `tsx` | 4.23.15 |
| `@types/node` | 24.10.1 |
| `@types/react` | 19.3.0 |
| `@types/react-dom` | 19.3.0 |
| `@types/papaparse` | 5.5.2 |

`package-lock.json` is present and was used with `npm ci` during setup.

## Browser

| Item | Observed |
|---|---|
| `npx playwright --version` | Version 1.64.1 |
| Chromium binary | Chrome for Testing 156.0.8078.4 (Playwright chromium v1248) |
| Install location | `/home/javvii/.cache/ms-playwright/chromium-1248` |
| Headless shell | 156.0.8078.4 (`chromium_headless_shell-1248`) |
| Playwright project | Desktop Chrome, viewport 1280 × 720 |
| Also installed | Firefox 157.0, WebKit 27.2 (not used by the acceptance suite) |

The real CLI Playwright runner launched the installed Chromium binary. Browser package
installation alone was not treated as proof; the browser suite actually executed.

## Local servers

| Command | Address |
|---|---|
| `npm run dev` | `http://127.0.0.1:5173` (strict port, host `127.0.0.1`) |
| `npm run preview` | `http://127.0.0.1:4173` (strict port, host `127.0.0.1`) |

Playwright starts its own `npm run dev` server and reuses an existing one when present.

## Verification tools

| Tool | Result source |
|---|---|
| `tsc --noEmit -p tsconfig.json` | `npm run typecheck` |
| Vitest 5.0.5 | `npm test`, 17 files / 115 tests |
| Vite 8.3.5 | `npm run build` |
| Playwright 1.64.1 | `npm run test:e2e`, 23 tests |
| Benchmark | `npm run benchmark`, opt-in, Chromium 156.0.8078.4 |

## Environment notes and limitations

- The configured `plugin:playwright:playwright` MCP server failed to connect in this session
  with `CONNECT_TIMEOUT` after 30 seconds. It was not used. Browser verification was performed
  with the CLI Playwright runner and the installed Chromium binary. The timeout is an MCP
  connection problem, not evidence that Playwright itself is unavailable.
- The build emits a Vite warning that the single JavaScript chunk is larger than 500 kB
  (755.32 kB, 191.88 kB gzip). This is a warning, not a failed build; no code-splitting was added
  because the mockup is a single local SPA and the prompt forbids speculative architecture.
- Timings in `artifacts/benchmark/results.json` are from this machine and this browser only.
  They are not a production capacity or concurrency claim.
- Browser storage is plaintext localStorage. No encryption, MFA, backup delivery or hosted
  database exists in this environment.
