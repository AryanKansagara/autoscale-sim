import type { Policy, Slo } from './types.ts'
import type { SimResult, SweepCell } from './sim.ts'
import { pareto } from './sim.ts'
import type { PrewarmBlock } from './forecast.ts'

export const DEFAULT_POLICY: Policy = { minReplicas: 0, maxReplicas: 4, concurrency: 4, targetUtil: 0.7, windowSec: 60, scaleDownDelaySec: 900, coldStartSec: 60, gpuHourly: 6.5 }
export const DEFAULT_SLO: Slo = { p95Ms: 15000, p99Ms: 30000, coldRate: 0.01, errorRate: 0.01 }

export interface SloCheck { key: keyof Slo; label: string; target: number; actual: number; pass: boolean; unit: 'ms' | 'pct' }

export function checkSlo(slo: Slo, r: { p95: number; p99: number; coldRate: number; errorRate: number }): SloCheck[] {
  const row = (key: keyof Slo, label: string, unit: 'ms' | 'pct', actual: number): SloCheck => ({ key, label, unit, target: slo[key], actual, pass: Number.isFinite(actual) ? actual <= slo[key] : false })
  return [row('p95Ms', 'p95 latency', 'ms', r.p95), row('p99Ms', 'p99 latency', 'ms', r.p99), row('coldRate', 'Requests hitting a cold start', 'pct', r.coldRate), row('errorRate', 'Error + timeout rate', 'pct', r.errorRate)]
}

/** Cheapest frontier policy that meets the latency and cold-start SLOs; otherwise the lowest p99. */
export function recommend(cells: SweepCell[], slo: Slo): { cell: SweepCell; meets: boolean; frontier: number[] } | null {
  if (!cells.length) return null
  const frontier = pareto(cells.map(c => c.r))
  const ok = frontier.map(i => cells[i]).filter(c => c.r.p95 <= slo.p95Ms && c.r.p99 <= slo.p99Ms && c.r.coldRate <= slo.coldRate)
  if (ok.length) return { cell: ok[0], meets: true, frontier }
  return { cell: cells[frontier[frontier.length - 1]], meets: false, frontier }
}

/** Body for the deployment autoscaling settings API. */
export function configJson(p: Policy) {
  return {
    min_replica: p.minReplicas,
    max_replica: p.maxReplicas,
    autoscaling_window: p.windowSec,
    scale_down_delay: p.scaleDownDelaySec,
    concurrency_target: p.concurrency,
    target_utilization_percentage: Math.round(p.targetUtil * 100),
  }
}

const dur = (s: number) => s >= 3600 && s % 3600 === 0 ? `${s / 3600} h` : s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`

export function configYaml(p: Policy, r?: SimResult) {
  const lines = [
    '# Autoscaling settings for a dedicated deployment',
    r ? `# Replayed: p95 ${(r.p95 / 1000).toFixed(1)} s, p99 ${(r.p99 / 1000).toFixed(1)} s, ${(r.coldRate * 100).toFixed(2)}% of requests waited on a cold start, ${r.replicaHours.toFixed(1)} replica-hours` : '',
    'autoscaling_settings:',
    `  min_replica: ${p.minReplicas}            # always-warm replicas; 0 allows scale to zero (every idle period ends in a cold start)`,
    `  max_replica: ${p.maxReplicas}            # hard cap on replicas, and on spend`,
    `  concurrency_target: ${p.concurrency}     # requests one replica handles at once; set from load tests of your model server`,
    `  target_utilization_percentage: ${Math.round(p.targetUtil * 100)}  # scale up when average load passes this share of concurrency_target`,
    `  autoscaling_window: ${p.windowSec}      # seconds of traffic averaged before a scaling decision (${dur(p.windowSec)})`,
    `  scale_down_delay: ${p.scaleDownDelaySec}       # seconds load must stay low before a replica is removed (${dur(p.scaleDownDelaySec)})`,
  ]
  return lines.filter(Boolean).join('\n') + '\n'
}

export function configCurl(p: Policy) {
  return `curl -X PATCH \\
  https://api.baseten.co/v1/models/$MODEL_ID/deployments/$DEPLOYMENT_ID/autoscaling_settings \\
  -H "Authorization: Api-Key $BASETEN_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(configJson(p))}'`
}

const hh = (h: number) => String(h % 24).padStart(2, '0')

/** Cron lines (UTC) that set min replicas per block, raising them early by the cold-start time. */
export function prewarmCron(blocks: PrewarmBlock[], coldStartSec: number) {
  const lead = Math.min(59, Math.ceil(coldStartSec / 60))
  return blocks.map((b, i) => {
    let h = b.fromH, m = 0
    const prev = blocks[(i + blocks.length - 1) % blocks.length]
    // Only raises need a head start; lowering can happen on the hour.
    if (lead > 0 && b.minReplicas > prev.minReplicas) { h = (b.fromH + 23) % 24; m = 60 - lead }
    return `${String(m).padStart(2, ' ')} ${String(h).padStart(2, " ")} * * *  set_min_replica ${b.minReplicas}   # ${hh(b.fromH)}:00-${hh(b.toH)}:00 UTC`
  }).join('\n')
}
