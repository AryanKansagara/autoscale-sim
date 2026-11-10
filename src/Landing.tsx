import { useEffect, useMemo, useRef, useState } from 'react'
import { SAMPLES, SAMPLE_START } from './engine/sample.ts'
import { detectColdStarts } from './engine/stats.ts'
import { simulate, toJobs } from './engine/sim.ts'
import { fmtMs, ReplayChart } from './charts.tsx'
import { sampleReqs } from './projectData.ts'
import { fmtN, Link } from './ui.tsx'

const DAY = 86_400_000
const DELAYS = [60, 300, 900, 1800, 3600]
const dur = (s: number) => s >= 3600 ? `${s / 3600} h` : s >= 60 ? `${s / 60} min` : `${s} s`

function useHero() {
  return useMemo(() => {
    const def = SAMPLES[0]
    const reqs = sampleReqs(def.id)!
    const cold = detectColdStarts(reqs)
    // Tuesday of the sample week: diurnal peak, quiet night, 02:00 batch job.
    const start = SAMPLE_START + DAY, end = start + DAY
    const jobs = toJobs(reqs, cold.idx, cold.medianLat).filter(j => j.t >= start && j.t < end)
    return { def, jobs, start, end }
  }, [])
}

function useTween(target: number, ms = 450) {
  const [v, setV] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setV(target); return }
    const a = from.current, t0 = performance.now()
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms), e = 1 - (1 - k) ** 3
      const x = a + (target - a) * e
      from.current = x
      setV(x)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}

export function Landing() {
  const { def, jobs, start, end } = useHero()
  const [minR, setMinR] = useState(0)
  const [di, setDi] = useState(2)
  const touched = useRef(false)
  useEffect(() => {
    // Show it working once, unless the visitor gets there first.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setTimeout(() => { if (!touched.current) setMinR(1) }, 2400)
    return () => clearTimeout(t)
  }, [])
  const policy = { ...def.policy, minReplicas: minR, scaleDownDelaySec: DELAYS[di] }
  const r = useMemo(() => simulate(jobs, policy, { start, end, bucketSec: 600 }), [jobs, minR, di])
  const base = useMemo(() => simulate(jobs, def.policy, { start, end, series: false }), [jobs])
  const cost = useTween(r.cost), p99 = useTween(r.p99), cold = useTween(r.coldHits)
  const touch = () => { touched.current = true }

  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div>
            <div className="eyebrow mono">Inference autoscaling, replayed</div>
            <h1>Know what a cold start costs <span className="hl">before</span> you change min replicas.</h1>
            <p className="lede">Import your endpoint&rsquo;s request logs and replay every request against any autoscaling policy. See queue wait, p95 and p99, cold-start hits and GPU spend side by side, then ship the config that meets your SLO for the least money.</p>
            <div className="hero-ctas">
              <Link href="/app?sample=chat-llm&tab=replay" className="btn primary lg">Open the sample endpoint</Link>
              <Link href="/app" className="btn outline lg">Import your logs</Link>
            </div>
            <p className="hero-note mono">Runs in your browser · no account needed · samples are synthetic</p>
          </div>
          <div className="console" aria-label="Live replay of a synthetic chat endpoint">
            <div className="console-bar mono"><span className="dot-live" aria-hidden="true" />REPLAY · {def.name.toUpperCase()} · TUE 27 OCT (UTC) · SYNTHETIC</div>
            <div className="console-body">
              <div className="console-kpis">
                <div><small className="mono">GPU COST / DAY</small><b>${fmtN(cost)}</b><span className={r.cost > base.cost ? 'up' : 'down'}>{r.cost >= base.cost ? '+' : '−'}${fmtN(Math.abs(r.cost - base.cost))} vs scale-to-zero</span></div>
                <div><small className="mono">P99 LATENCY</small><b>{fmtMs(p99)}</b><span>{r.p99 <= 30000 ? 'meets 30 s SLO' : 'misses 30 s SLO'}</span></div>
                <div><small className="mono">COLD-START HITS</small><b>{fmtN(cold)}</b><span>{fmtN(r.n)} requests</span></div>
              </div>
              <ReplayChart series={r.series} sloMs={30000} compact label="Requests, replicas and p95 latency for the replayed day" />
              <div className="console-controls">
                <label className="slider-field"><span className="row between"><span>Min replicas</span><output className="mono">{minR}</output></span>
                  <input type="range" min={0} max={4} value={minR} onPointerDown={touch} onKeyDown={touch} onChange={e => { touch(); setMinR(Number(e.target.value)) }} /></label>
                <label className="slider-field"><span className="row between"><span>Scale-down delay</span><output className="mono">{dur(DELAYS[di])}</output></span>
                  <input type="range" min={0} max={DELAYS.length - 1} value={di} onPointerDown={touch} onKeyDown={touch} onChange={e => { touch(); setDi(Number(e.target.value)) }} /></label>
              </div>
              <p className="console-note mono">Every slider move re-runs the discrete-event simulator over {fmtN(jobs.length)} logged requests.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="eyebrow mono">The pain</div>
          <h2>Autoscaling settings are guesses with a GPU bill attached.</h2>
          <p>Engineers serving models on dedicated GPUs keep running into the same three problems, and every one of them is a policy tradeoff you can measure from your own traffic.</p>
        </div>
        <div className="quotes">
          <figure className="quote"><blockquote>Picking a provider came down to failed starts, dropped connections and pricing nobody could predict.</blockquote><figcaption className="src mono">Paraphrased · r/LocalLLaMA thread on choosing hosted inference</figcaption></figure>
          <figure className="quote"><blockquote>How do you forecast cold starts so the first user of the morning is not the one who waits a minute?</blockquote><figcaption className="src mono">Paraphrased · r/MachineLearning, cold start forecasting</figcaption></figure>
          <figure className="quote"><blockquote>What is a realistic cold start for a big model, and is keeping a worker warm worth the money?</blockquote><figcaption className="src mono">Paraphrased · r/RunPod, cold start expectations</figcaption></figure>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div className="eyebrow mono">How it works</div>
          <h2>From request log to a config you can apply.</h2>
        </div>
        <ol className="steps">
          <li><b>Import</b><p>OpenAI-compatible proxy JSONL, LiteLLM spend logs or any CSV. Format detection, column mapping and a validation report with line numbers.</p></li>
          <li><b>Measure</b><p>p95 and p99 with bootstrap confidence intervals, TTFT vs decode speed, errors and timeouts, cold starts found from idle gaps, burstiness.</p></li>
          <li><b>Replay</b><p>A discrete-event autoscaler: min and max replicas, concurrency target, utilization, window, scale-down delay, cold-start time, queueing.</p></li>
          <li><b>Decide</b><p>A 25-policy sweep with the cost vs p99 frontier, an hourly forecast with a pre-warm schedule, and the cheapest policy that meets your SLO.</p></li>
        </ol>
      </section>

      <section className="section">
        <div className="features">
          {[
            ['Policy sweep', 'Min replicas × scale-down delay, every cell a full replay. The efficient frontier shows which settings are simply wasted money.'],
            ['Cold-start forensics', 'Slow requests right after idle periods are flagged with the idle gap and penalty, and the median penalty seeds the simulator.'],
            ['Forecast and pre-warm', 'Tomorrow by hour from seasonal naive and EWMA, backtested on your last day, turned into a cron schedule for min replicas.'],
            ['Config you can ship', 'Annotated YAML, the JSON body and the API call for autoscaling settings, with every field explained.'],
            ['Experiments', 'Save policies with their replay results, compare any two, restore one with a click. Synced across devices if you sign in.'],
            ['Capacity report', 'A printable one-pager: logged vs replayed latency, SLO check, recommended config and the pre-warm schedule.'],
          ].map(([t, d]) => <article key={t} className="feature"><h3>{t}</h3><p>{d}</p></article>)}
        </div>
      </section>

      <section className="cta-band">
        <div className="cta-inner">
          <div><h2>Replay a week in under a second.</h2><p>Two synthetic endpoints are ready: a chat LLM with a nightly batch job, and a spiky image model.</p></div>
          <div className="row gap wrap">
            <Link href="/app?sample=chat-llm" className="btn primary lg">Chat LLM sample</Link>
            <Link href="/app?sample=image-gen" className="btn outline lg">Image model sample</Link>
          </div>
        </div>
      </section>
    </>
  )
}
