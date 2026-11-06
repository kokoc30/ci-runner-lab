# CI Runner Lab

Understand your GitHub Actions workflows and measure trusted npm scripts with a small, local-first tool.

- Try a synthetic demo, then inspect your computer's capacity.
- Read workflow YAML and recent GitHub run/job metadata.
- Review timings, evidence, recommendations and qualified cost scenarios.
- Measure trusted npm scripts and compare saved reports with context warnings.

## Quick start

Use a current security-patched Node.js **24 LTS** release, or Node 22.13+ LTS.
Git and npm are required. There is no application server to configure.

```sh
git clone https://github.com/kokoc30/ci-runner-lab.git
cd ci-runner-lab
npm ci
npm start
```

Choose **1** to see the demo. It works offline without a GitHub login or API key.
The menu offers device inspection, GitHub analysis, local inspection,
trusted-script benchmarking, and report comparison. Enter `back` at a target
prompt to return to the menu, or `0` at the menu to exit.

In a terminal, finished reports open in your default browser.
In CI or a noninteractive shell, choose a command explicitly; no prompt or
browser opens by default. The tool prints the exact report path.

## Three useful commands

```sh
npm start -- demo --no-open
npm start -- audit --repo owner/repository --runs 10 --no-open
npm start -- bench --path "my-project" --script test:ci --allow-exec --no-open
```

For GitHub history, install [GitHub CLI](https://cli.github.com/) and run
`gh auth login` separately. CI Runner Lab never asks you to paste a token.
GitHub.com is supported; GitHub Enterprise hosts are outside v0.1.

Use `npm start -- --help` for local `audit --path`, `doctor`, `compare`,
workflow/branch/event filters, and optional cost inputs.
`--out <directory>` changes the output root; `--open` explicitly opens a report.
For machine-readable output use `node src/cli.js demo --json --no-open`;
progress and report paths go to stderr. npm itself can print a script banner.

## Reports and measurements

Each command creates a unique directory under `.ci-runner-lab/reports/` with
`report.html`, `report.md`, and versioned `report.json`. HTML is self-contained,
JavaScript-free, responsive, printable and usable offline. No telemetry is sent.
Reports stay in the invoking directory or explicit output root, not the target.
Private-repository reports may contain sensitive metadata: review before sharing.

Execution span and aggregate job time are separate. Timings are grouped by
workflow, branch and event; successful speed distributions exclude failed or
incompletely timed runs. Usage estimates still include known failed-job time.
Only the latest run attempt is analyzed. Static source is read at the reported
default-branch commit, which can differ from historical run revisions.

Benchmark defaults are one warm-up and three sequential measured invocations,
with a 120-second timeout each. Warm-ups do not enter the median. A failed,
timed-out or interrupted invocation stops the benchmark and retains evidence.
An output limit also aborts excessively noisy commands. Elapsed time is measured;
total process-tree RAM, CPU usage and power are not. Comparisons are descriptive
and flag changed workloads, revisions, environments and overlapping observations.

## Safety and limits

Audits are read-only and never execute repository code. Benchmarks require
explicit consent and run npm scripts plus lifecycle hooks with your normal
permissions: they can change files, access the network and spawn workers.
Common auth environment variables are removed, but this is **not a sandbox**.
Cleanup targets the owned process tree; detached/adversarial processes are outside
that guarantee. Capacity advice is a conservative heuristic, not a resource limit.
Cost estimates use dated list prices before allowances, retain unknown components,
and exclude storage and other costs. There is no automatic runner installation
or workflow rewriting. Expressions, action internals and reusable workflows
remain unresolved by static inspection. No dependencies are installed in targets.

## Development

`npm run check` runs lint, JSDoc/TypeScript checks and offline unit/integration tests.
Install the locked browser with `npx --no-install playwright install chromium`,
then run `npm run test:ui`. Browsers are not needed for normal startup.
CI checks Node 24 on Ubuntu, Windows and macOS, plus Node 22 on Ubuntu;
Chromium report checks run on Ubuntu/Node 24. Only standard hosted runners are used.
The lockfile pins a patched minimatch override for the development linter.

MIT licensed. See [LICENSE](LICENSE).
