# Autoscale Sim

An inference endpoint traffic and autoscaling analyzer. Import real request logs and replay them against autoscaling policies to see the cold-start, latency and GPU-cost tradeoffs before you change settings on a dedicated GPU deployment.

**Live:** https://autoscale-sim.vercel.app

## The pain
Min replicas, scale-down delay and concurrency targets are usually set by guesswork. Too low and the first user after a quiet period waits a minute for a cold start; too high and you pay for idle GPUs all night. Autoscale Sim answers "what would last week have looked like with these settings?" from your own logs.

## Features
- Import OpenAI-compatible proxy JSONL, LiteLLM spend logs, the Azure LLM inference and BurstGPT public traces, or any CSV/JSONL: format detection, column mapping, validation report with line numbers; traces without latency get an editable token-based service-time model
- Latency percentiles with bootstrap confidence intervals, TTFT vs decode speed, error and timeout rates
- Cold-start detection (latency outliers after idle gaps) and burstiness (peak-to-mean, inter-arrival CV)
- Discrete-event autoscaler replay: min/max replicas, concurrency target, target utilization, autoscaling window, scale-down delay, cold-start time, FIFO queueing; queue wait, p95/p99, cold-start hits, replica-hours and cost
- Policy sweep (min replicas x scale-down delay) with the cost vs p99 Pareto frontier and an SLO-aware recommendation
- Tomorrow's hourly demand forecast (seasonal naive vs EWMA, backtested) and a pre-warm cron schedule
- Recommended config as annotated YAML, JSON and an API call; SLO check; printable capacity report; CSV exports
- Saved policy experiments with a compare view
- Local-first workspace (IndexedDB) with optional email/password sync, light and dark themes
- Two labelled synthetic samples (a chat LLM endpoint and a spiky image model) and one real public trace: 7 days of ChatGPT arrivals from BurstGPT

## Data credits
- BurstGPT (Yuxin Wang, Yuhan Chen, Zeyu Li et al., KDD 2025), https://github.com/HPMLL/BurstGPT, CC BY 4.0. `public/samples/burstgpt-chatgpt-7d.csv` and `src/engine/fixtures/burstgpt-1.csv` are unmodified row excerpts of `BurstGPT_1.csv`.
- Azure LLM inference trace 2023, https://github.com/Azure/AzurePublicDataset, CC BY 4.0. `src/engine/fixtures/azure-llm-conv-2023.csv` is the first 30 rows of `AzureLLMInferenceTrace_conv.csv`.

## Known gaps
- Public traces have no latency, so latency is modelled from tokens and cold starts come from the replay, not the log.
- Service time does not grow with batch size; set the concurrency target from a load test.
- BurstGPT times are relative, anchored at a fixed Monday; hour-of-day is the trace's local time.

## Run locally
```
npm install
npm run dev
npm test          # engine tests
npm run build
npm run test:e2e  # browser tests, see below
```
Optional sync needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`.

## End-to-end tests
`npm run test:e2e` builds the app and runs a [Playwright](https://playwright.dev) suite (Chromium) in `e2e/` against the production build served by `vite preview`. Install the browser once with `npx playwright install chromium` (on Linux add `--with-deps`).

The tests are signed out and never reach a real backend: requests to anything but the preview server are aborted (Google Fonts is stubbed), and a test fails if the app tries to call one or throws an uncaught page error. They cover:
- the three built-in samples: percentiles with confidence intervals, cold starts, the policy sweep and its recommendation, forecast, config, experiments, the capacity report and the landing page replay;
- a three-request trace (`e2e/fixtures/tiny.csv`) whose replay cost, cold starts and latency are worked out by hand in `e2e/replay.spec.ts`, for several min replicas and scale-down delays, including every cell of the policy sweep export;
- importing CSV, JSONL and the public Azure and BurstGPT excerpts from `src/engine/fixtures`, with traces that have no latency labelled as modelled;
- every export: normalized CSV, YAML, JSON and API-call config, replay timeline, sweep and forecast CSVs, and the all-data JSON;
- empty, wrong and truncated files: a message with the line number, no import, no recommendation;
- persistence across a reload: policy, SLOs, experiments, imported logs, settings, theme, delete and undo.

`e2e/known-bugs.spec.ts` holds tests for open app bugs, marked `test.fail` with the issue link so the suite stays green until the bug is fixed and then asks for the marker to be removed.

The preview port defaults to 4173; set `E2E_PORT` to use another. GitHub Actions (`.github/workflows/ci.yml`, job `test`) runs install, build, unit and E2E tests on every pull request and push to `main`, and caches the Chromium download by Playwright version. `vercel.json` deploys only `main`, so pull request branches get no preview deployment.

Built by Aryan Kansagara.
