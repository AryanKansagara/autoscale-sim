import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { dayOptions, busiestDay, experiment, fmtRange, sliceJobs, useAnalysis, useProject, type Analysis } from './projectData.ts'
import type { Project as P } from './store.ts'
import { Empty, go, isTyping, Link, Modal, SyntheticBadge, toast } from './ui.tsx'


const Tabs = lazy(() => import('./Tabs.tsx'))
const DataTab = lazy(() => import('./Import.tsx'))

export const TABS = [['overview', 'Traffic'], ['replay', 'Replay'], ['sweep', 'Policy sweep'], ['forecast', 'Forecast'], ['actions', 'Config & SLO'], ['history', 'Experiments'], ['data', 'Data']] as const
export type Tab = (typeof TABS)[number][0]

export interface TabProps { project: P; a: Analysis; range: string; ranges: string[]; setRange(r: string): void; update(p: Partial<P>): void }

export default function ProjectView({ id, tab: rawTab }: { id: string; tab: string }) {
  const { loading, project, ds, update } = useProject(id)
  const tab = (TABS.some(t => t[0] === rawTab) ? rawTab : 'overview') as Tab
  const a = useAnalysis(ds, project)
  const ranges = useMemo(() => dayOptions(ds ?? []), [ds])
  const def = useMemo(() => ds?.length ? busiestDay(ds) : 'all', [ds])
  const q = new URLSearchParams(location.search).get('d')
  const range = q && ranges.includes(q) ? q : def
  const [help, setHelp] = useState(false)

  useEffect(() => { if (project) document.title = `${project.name} · Autoscale Sim` }, [project?.name])

  const qs = range === def ? '' : `?d=${range}`
  const setTab = (t: Tab) => go(`/app/p/${id}${t === 'overview' ? '' : '/' + t}${qs}`, { keepScroll: true })
  const setRange = (r: string) => go(`${location.pathname}?d=${r}`, { replace: true, keepScroll: true })

  const saveExperiment = () => {
    if (!project || !a) return
    const s = sliceJobs(a.jobs, range, a.reqs)
    const p = project.policy
    const label = `min ${p.minReplicas}, max ${p.maxReplicas}, scale-down ${p.scaleDownDelaySec}s, concurrency ${p.concurrency}`
    const snap = experiment(s.jobs, p, label, range)
    const before = project.snapshots
    void update({ snapshots: [...before, snap] })
    toast(`Saved experiment: ${label}`, { tone: 'ok', undo: () => void update({ snapshots: before }) })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= TABS.length) { e.preventDefault(); setTab(TABS[n - 1][0]) }
      else if (e.key === '?') setHelp(true)
      else if (e.key === 's') saveExperiment()
      else if (e.key === 'p') go(`/app/p/${id}/report${qs}`)
      else if (e.key === '[' || e.key === ']') {
        const i = ranges.indexOf(range)
        const j = e.key === '[' ? i - 1 : i + 1
        if (ranges[j]) setRange(ranges[j])
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  if (loading) return <div className="boot" role="status"><span className="spinner" /> Reading the request log</div>
  if (!project) return (
    <section className="page narrow center">
      <Empty title="Endpoint not found"><p className="muted">It may have been deleted, or it lives on another device.</p><Link href="/app" className="btn primary">All endpoints</Link></Empty>
    </section>
  )
  const empty = !ds?.length

  return (
    <section className="page">
      <div className="proj-head">
        <div>
          <div className="eyebrow"><Link href="/app">Endpoints</Link></div>
          <h1 className="row gap wrap">{project.name} {project.sampleId && <SyntheticBadge />}</h1>
          {a && <p className="muted small mono" style={{ margin: 0 }}>{a.reqs.length.toLocaleString()} requests · {a.days.toFixed(1)} days · {project.gpu} at ${project.policy.gpuHourly.toFixed(2)}/h</p>}
        </div>
        {!empty && (
          <div className="toolbar">
            <label className="sr-only" htmlFor="range">Replay range</label>
            <select id="range" value={range} onChange={e => setRange(e.target.value)} title="Replay range ([ and ])">
              {ranges.map(r => <option key={r} value={r}>{fmtRange(r)}{r === def ? ' (busiest)' : ''}</option>)}
            </select>
            <button type="button" className="btn outline" onClick={saveExperiment} title="Save the current policy as an experiment (S)">Save experiment</button>
            <Link href={`/app/p/${id}/report${qs}`} className="btn primary" title="Printable capacity report (P)">Capacity report</Link>
          </div>
        )}
      </div>
      <nav className="tabs" aria-label="Endpoint sections">
        {TABS.map(([t, l], i) => <Link key={t} href={`/app/p/${id}${t === 'overview' ? '' : '/' + t}${qs}`} aria-current={t === tab ? 'page' : undefined} title={`${l} (${i + 1})`}>{l}</Link>)}
      </nav>
      <Suspense fallback={<div className="boot"><span className="spinner" /></div>}>
        {tab === 'data' || empty || !a
          ? <DataTab project={project} ds={ds ?? []} update={update} />
          : <Tabs tab={tab} project={project} a={a} range={range} ranges={ranges} setRange={setRange} update={update} />}
      </Suspense>
      <Modal open={help} onClose={() => setHelp(false)} title="Keyboard shortcuts">
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>7</kbd></dt><dd>Switch sections</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next replay day</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Save the current policy as an experiment</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Open the printable capacity report</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete</dd></div>
        </dl>
      </Modal>
    </section>
  )
}
