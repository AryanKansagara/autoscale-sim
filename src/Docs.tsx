import { FIELDS } from './engine/parse.ts'
import { Code, Link } from './ui.tsx'

const LITELLM_SQL = `-- LiteLLM proxy with a Postgres DATABASE_URL: one row per request in "LiteLLM_SpendLogs"
\\copy (
  SELECT "request_id", "startTime", "endTime", "completionStartTime",
         "prompt_tokens", "completion_tokens", "status", "api_base", "model"
  FROM "LiteLLM_SpendLogs"
  WHERE "model" = 'my-llama-70b'
    AND "startTime" >= now() - interval '7 days'
  ORDER BY "startTime"
) TO 'litellm-7d.csv' WITH CSV HEADER`

const PY_LOG = `# Wrap your OpenAI-compatible client (works with any endpoint that speaks the OpenAI API)
import json, time, datetime
from openai import OpenAI

client = OpenAI(base_url="https://<your-endpoint>/v1", api_key=API_KEY)
log = open("requests.jsonl", "a")

def chat(messages, **kw):
    t0 = time.perf_counter(); ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
    ttft, status, usage = None, 200, None
    try:
        stream = client.chat.completions.create(messages=messages, stream=True,
                                                stream_options={"include_usage": True}, **kw)
        for chunk in stream:
            if ttft is None and chunk.choices and chunk.choices[0].delta.content:
                ttft = (time.perf_counter() - t0) * 1000
            if chunk.usage: usage = chunk.usage
            yield chunk
    except Exception as e:
        status = getattr(e, "status_code", 500); raise
    finally:
        log.write(json.dumps({
            "timestamp": ts, "duration_ms": round((time.perf_counter() - t0) * 1000),
            "ttft_ms": ttft and round(ttft), "status": status,
            "usage": {"prompt_tokens": usage and usage.prompt_tokens,
                      "completion_tokens": usage and usage.completion_tokens},
        }) + "\\n"); log.flush()`

const NGINX = `# nginx in front of the endpoint: JSON access log, one line per request
log_format infer escape=json '{"timestamp":"$time_iso8601","duration_s":$request_time,'
  '"status":$status,"upstream":"$upstream_addr"}';
access_log /var/log/nginx/infer.jsonl infer;`

const CSV = `timestamp,latency_ms,ttft_ms,status,input_tokens,output_tokens,replica_id
2026-11-02T14:03:11.204Z,6120,342,200,812,240,replica-a
2026-11-02T14:03:12.950Z,71880,66410,200,95,310,replica-b
2026-11-02T14:03:13.007Z,30000,,504,1200,,replica-b`

export default function Docs() {
  return (
    <section className="page narrow docs">
      <div className="eyebrow">Docs</div>
      <h1>Getting request logs out</h1>
      <p className="muted">Autoscale Sim needs one row per inference request: when it arrived and how long it took. Time to first token, status, token counts and the replica that served it make the analysis sharper. Export a few days (a week shows weekday patterns) and drop the file on an endpoint&rsquo;s <strong>Data</strong> tab. Formats are detected from the header, every column can be re-mapped, and rejected rows are listed by line number. Last reviewed November 2026.</p>
      <nav className="toc" aria-label="On this page">
        <a href="#fields">Fields</a><a href="#litellm">LiteLLM</a><a href="#openai">OpenAI-compatible proxy</a><a href="#ttft">Logging TTFT</a><a href="#nginx">nginx / gateways</a><a href="#csv">Plain CSV</a><a href="#model">How the replay works</a><a href="#pricing">Pricing assumptions</a><a href="#privacy">Privacy</a>
      </nav>

      <h2 id="fields">Fields</h2>
      <div className="table-wrap"><table>
        <thead><tr><th>Field</th><th>Recognised column names</th></tr></thead>
        <tbody>{FIELDS.map(f => <tr key={f.key}><th scope="row">{f.label}{f.required ? ' *' : ''}</th><td className="small mono">{f.aliases.slice(0, 6).join(', ')}</td></tr>)}</tbody>
      </table></div>
      <p className="small">Times: ISO 8601 (with or without offset; none means UTC), epoch seconds or milliseconds, or <code>YYYY-MM-DD HH:MM:SS</code>. Latency: milliseconds or seconds (auto-detected from the column name or the values; you can override). Status: HTTP codes, or words such as <code>success</code>, <code>failure</code>, <code>timeout</code>. 408 and 504 count as timeouts.</p>

      <h2 id="litellm">LiteLLM proxy: spend logs</h2>
      <p>With a database configured, LiteLLM writes every request to <code>LiteLLM_SpendLogs</code>. Latency is <code>endTime − startTime</code> and TTFT is <code>completionStartTime − startTime</code> (only set for streaming calls).</p>
      <Code label="psql" code={LITELLM_SQL} />
      <p>No database? The admin UI&rsquo;s <strong>Logs</strong> page can export the same columns, or enable a JSON logging callback and import the JSONL.</p>

      <h2 id="openai">OpenAI-compatible proxy logs (JSONL)</h2>
      <p>Any gateway that logs one JSON object per line works. Nested keys are flattened, so <code>response.usage.prompt_tokens</code> and <code>usage.completion_tokens</code> are picked up automatically. Lines that are not valid JSON are reported by line number and skipped.</p>

      <h2 id="ttft">Logging TTFT from your client</h2>
      <p>Server-side logs often miss time spent queued in front of the model server. Logging at the client captures what users feel, including cold starts. This wrapper streams, records TTFT and token usage, and appends one line per request:</p>
      <Code label="python" code={PY_LOG} />

      <h2 id="nginx">nginx and other gateways</h2>
      <p><code>$request_time</code> is in seconds; the importer detects that. Add <code>$upstream_addr</code> to approximate the replica.</p>
      <Code label="nginx.conf" code={NGINX} />

      <h2 id="csv">Plain CSV</h2>
      <Code label="requests.csv" code={CSV} />

      <h2 id="model">How the replay works</h2>
      <ul>
        <li><strong>Cold-start detection.</strong> A request is a cold start if it arrives after an idle gap (default 5 minutes; set per endpoint) or on a replica id seen for the first time, and is at least 3× the median latency and 2 s slower. The median extra latency becomes the suggested cold-start time.</li>
        <li><strong>Service time.</strong> Each request is replayed with its logged latency, except detected cold starts, which use the warm median: the simulator adds cold starts itself.</li>
        <li><strong>Autoscaler.</strong> Each replica serves up to <em>concurrency target</em> requests at once; the rest queue first in, first out. Every 5 s the autoscaler averages in-flight plus queued requests over the <em>autoscaling window</em> and wants <code>ceil(load / (concurrency × utilization))</code> replicas, clamped to min and max. New replicas serve after the <em>cold start</em>. Replicas are removed only after load stays below capacity for the <em>scale-down delay</em>, idle ones first. With zero replicas, the first request starts one immediately.</li>
        <li><strong>Cost.</strong> Replicas are billed from the moment they start booting until removal, at your $ per replica-hour.</li>
        <li><strong>Statistics.</strong> Percentile confidence intervals are bootstraps (100 to 200 resamples). Burstiness is the busiest minute over the mean minute and the coefficient of variation of inter-arrival times (1 is random, above 1 is bursty).</li>
        <li><strong>Forecast.</strong> Hourly demand for the next UTC day by seasonal naive (same weekday last week once a week of data exists, otherwise yesterday) and an EWMA per hour of day; the last full day is held out and the better method is used. Pre-warm replicas per hour come from Little&rsquo;s law using the busiest-minute factor for that hour.</li>
        <li><strong>Limits.</strong> The replay assumes service time does not depend on how busy a replica is, which understates latency for batched LLM servers near their concurrency limit. Set the concurrency target from a load test so that assumption holds.</li>
      </ul>

      <h2 id="pricing">Pricing and default assumptions</h2>
      <p>GPU price is whatever you enter per endpoint. Samples use approximate public on-demand list prices as of late 2025 (H100 80 GB about $6.50 per hour, A100 80 GB about $4.00 per hour); use your contracted rate. Default autoscaling values (min 0, concurrency target and window as entered, scale-down delay 15 minutes, 70% target utilization) mirror common platform defaults for dedicated deployments at that time. Check your provider&rsquo;s current docs before applying a config; the generated API call targets the deployment autoscaling settings endpoint as documented then.</p>

      <h2 id="privacy">Privacy</h2>
      <p>Files are parsed in your browser and stored in IndexedDB on this device. If you <Link href="/settings">sign in</Link>, endpoint settings, SLOs and experiments sync to your account; request logs sync only when under 1.5 MB, otherwise they stay here. No prompts or completions are ever needed: the importer only reads times, statuses, token counts and replica ids.</p>
    </section>
  )
}
