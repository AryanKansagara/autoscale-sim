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
npm test
npm run build
```
Optional sync needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`.

Built by Aryan Kansagara. Independent project, not affiliated with Baseten.
