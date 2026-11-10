import { useEffect, useMemo, useState } from 'react'
import { generate, SAMPLES, SAMPLE_START } from './engine/sample.ts'
import { burstiness, detectColdStarts, errorStats, latencyStats, mean, tokenSplit } from './engine/stats.ts'
import { simulate, toJobs, type Job, type SimResult } from './engine/sim.ts'
import type { Policy, Req } from './engine/types.ts'
import { blankProject, getData, getProjects, saveProject, useProjects, uuid, type Dataset, type Project, type Snapshot } from './store.ts'

const DAY = 86_400_000
const cache = new Map<string, Req[]>()
export function sampleReqs(id: string): Req[] | null {
  if (!SAMPLES.some(s => s.id === id)) return null
  if (!cache.has(id)) cache.set(id, generate(id))
  return cache.get(id)!
}

export function summary(r: SimResult): Snapshot['result'] {
  const { series: _s, p95WaitMs: _a, p99WaitMs: _b, maxQueue: _c, scaleUps: _d, ...rest } = r
  return rest
}

export function experiment(jobs: Job[], policy: Policy, label: string, range = 'all', note?: string): Snapshot {
  return { id: uuid(), label, at: Date.now(), range, policy, result: summary(simulate(jobs, policy, { series: false })), note }
}

export async function createSampleProject(sampleId: string): Promise<Project> {
  const existing = getProjects().find(p => p.sampleId === sampleId)
  if (existing) return existing
  const def = SAMPLES.find(s => s.id === sampleId)!
  const reqs = sampleReqs(sampleId)!
  const base = blankProject(def.name)
  const cold = detectColdStarts(reqs, base.coldGapSec)
  const jobs = toJobs(reqs, cold.idx, cold.medianLat)
  // Two experiments so History has something to compare: what runs today, and one warm replica.
  const snapshots = [
    experiment(jobs, def.policy, 'Current settings (scale to zero)', 'all', 'What the deployment runs today.'),
    experiment(jobs, { ...def.policy, minReplicas: 1 }, 'One warm replica', 'all'),
  ]
  snapshots[1].at = snapshots[0].at + 1
  return saveProject({
    ...base, name: def.name, policy: { ...def.policy }, slo: { ...def.slo }, gpu: def.gpu, sampleId, snapshots,
    imports: [{ id: uuid(), kind: 'plain', fileName: `synthetic request log (${new Date(SAMPLE_START).toISOString().slice(0, 10)}, 7 days)`, rows: reqs.length, skipped: 0, at: Date.now() }],
  })
}

export const createBlankProject = (name: string) => saveProject(blankProject(name))

export function useProject(id: string) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  const [ds, setDs] = useState<Dataset | null>(null)
  const importsKey = project ? project.imports.map(i => i.id).join(',') : ''
  useEffect(() => {
    if (!project) return
    let live = true
    if (project.sampleId) { setDs(sampleReqs(project.sampleId) ?? []); return }
    void getData(project.id).then(d => { if (live) setDs(d ?? []) })
    return () => { live = false }
  }, [project?.id, project?.sampleId, importsKey])
  const update = (patch: Partial<Project>) => project && saveProject({ ...project, ...patch })
  return { loading: list === null || (project !== null && ds === null), project, ds, update }
}

/** UTC day options for replays: 'all' or 'YYYY-MM-DD'. */
export function dayOptions(reqs: Req[]): string[] {
  if (!reqs.length) return ['all']
  const out = ['all']
  for (let t = Math.floor(reqs[0].t / DAY) * DAY; t <= reqs[reqs.length - 1].t; t += DAY) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

/** Busiest day by request count: the best default for a single-day replay. */
export function busiestDay(reqs: Req[]): string {
  const c = new Map<string, number>()
  for (const r of reqs) { const d = new Date(r.t).toISOString().slice(0, 10); c.set(d, (c.get(d) ?? 0) + 1) }
  return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'all'
}

export function rangeBounds(reqs: Req[], range: string): { start: number; end: number } {
  if (range === 'all' || !reqs.length) return { start: reqs[0]?.t ?? 0, end: reqs[reqs.length - 1]?.t ?? 0 }
  const start = Date.parse(range + 'T00:00:00Z')
  return { start, end: start + DAY }
}

export function sliceJobs(jobs: Job[], range: string, reqs: Req[]): { jobs: Job[]; start: number; end: number } {
  const b = rangeBounds(reqs, range)
  if (range === 'all') return { jobs, ...b }
  return { jobs: jobs.filter(j => j.t >= b.start && j.t < b.end), ...b }
}

export type Analysis = NonNullable<ReturnType<typeof useAnalysis>>

/** Observed traffic statistics and replay jobs. Bootstraps use fewer resamples on big logs. */
export function useAnalysis(ds: Req[] | null, p: Project | null) {
  const gap = p?.coldGapSec ?? 300, timeout = p?.timeoutMs ?? 120000
  return useMemo(() => {
    if (!ds?.length) return null
    const iters = ds.length > 50000 ? 100 : 200
    const ok = ds.filter(r => r.ok)
    const cold = detectColdStarts(ds, gap)
    const coldSet = new Set(cold.idx)
    const warm = ds.filter((r, i) => r.ok && !coldSet.has(i))
    const jobs = toJobs(ds, cold.idx, cold.medianLat)
    return {
      reqs: ds,
      lat: latencyStats(ok.map(r => r.lat), iters),
      ttft: tokenSplit(ds),
      err: errorStats(ds, timeout),
      cold,
      warmMeanMs: mean(warm.map(r => r.lat)),
      burst: burstiness(ds),
      jobs,
      days: (ds[ds.length - 1].t - ds[0].t) / DAY,
      meanServiceMs: mean(jobs.map(j => j.s)),
    }
  }, [ds, gap, timeout])
}

export const fmtRange = (r: string) => r === 'all' ? 'All days' : new Date(r + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
