# Autoscale Sim

An inference endpoint traffic and autoscaling analyzer. Import real request logs and replay them against autoscaling policies to see the cold-start, latency and GPU-cost tradeoffs before you change settings on a dedicated GPU deployment.

**Live:** https://autoscale-sim.vercel.app

## The pain
Min replicas, scale-down delay and concurrency targets are usually set by guesswork. Too low and the first user after a quiet period waits a minute for a cold start; too high and you pay for idle GPUs all night. Autoscale Sim answers "what would last week have looked like with these settings?" from your own logs.

## Features
- Import OpenAI-compatible proxy JSONL, LiteLLM spend logs or any CSV/JSONL: format detection, column mapping, validation report with line numbers
- Latency percentiles with bootstrap confidence intervals, TTFT vs decode speed, error and timeout rates
- Cold-start detection (latency outliers after idle gaps) and burstiness (peak-to-mean, inter-arrival CV)
- Discrete-event autoscaler replay: min/max replicas, concurrency target, target utilization, autoscaling window, scale-down delay, cold-start time, FIFO queueing; queue wait, p95/p99, cold-start hits, replica-hours and cost
- Policy sweep (min replicas x scale-down delay) with the cost vs p99 Pareto frontier and an SLO-aware recommendation
- Tomorrow's hourly demand forecast (seasonal naive vs EWMA, backtested) and a pre-warm cron schedule
- Recommended config as annotated YAML, JSON and an API call; SLO check; printable capacity report; CSV exports
- Saved policy experiments with a compare view
- Local-first workspace (IndexedDB) with optional email/password sync, light and dark themes
- Two labelled synthetic samples: a chat LLM endpoint and a spiky image model

## Run locally
```
npm install
npm run dev
npm test
npm run build
```
Optional sync needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`.

Built by Aryan Kansagara. Independent project, not affiliated with Baseten.
