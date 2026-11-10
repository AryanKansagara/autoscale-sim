import { useState } from 'react'
import { deleteProject, getDefaults, getProjects, setDefaults, type Defaults } from "./store.ts"
import { exportAll, RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, setTheme, toast, useDark } from './ui.tsx'

export default function Settings() {
  const [d, setD] = useState<Defaults>(getDefaults)
  const dark = useDark()
  const sync = useSync()
  const save = (p: Partial<Defaults>) => { const next = { ...d, ...p }; setD(next); setDefaults(next); toast('Saved', { tone: 'ok', ttl: 1500 }) }

  return (
    <section className="page narrow settings">
      <div className="eyebrow">Settings</div>
      <h1>Settings</h1>

      <div className="panel">
        <h2>Defaults for new endpoints</h2>
        <p className="muted small">Existing endpoints keep their own settings; change those on the endpoint&rsquo;s Replay and Config &amp; SLO tabs.</p>
        <div className="inline-fields">
          <label className="field"><span>GPU type</span><input value={d.gpu} onChange={e => save({ gpu: e.target.value })} /></label>
          <label className="field"><span>$ per replica-hour</span><input type="number" min="0" step="0.01" value={d.gpuHourly} onChange={e => save({ gpuHourly: Math.max(0, Number(e.target.value)) })} /></label>
          <label className="field"><span>Cold-start idle gap (s)</span><input type="number" min="30" step="30" value={d.coldGapSec} onChange={e => save({ coldGapSec: Math.max(30, Number(e.target.value)) })} /></label>
          <label className="field"><span>Client timeout (s)</span><input type="number" min="1" value={d.timeoutMs / 1000} onChange={e => save({ timeoutMs: Math.max(1, Number(e.target.value)) * 1000 })} /></label>
          <label className="field"><span>SLO p95 (s)</span><input type="number" min="0.1" step="0.5" value={d.slo.p95Ms / 1000} onChange={e => save({ slo: { ...d.slo, p95Ms: Math.max(0.1, Number(e.target.value)) * 1000 } })} /></label>
          <label className="field"><span>SLO p99 (s)</span><input type="number" min="0.1" step="0.5" value={d.slo.p99Ms / 1000} onChange={e => save({ slo: { ...d.slo, p99Ms: Math.max(0.1, Number(e.target.value)) * 1000 } })} /></label>
          <label className="field"><span>Max cold-start share (%)</span><input type="number" min="0" step="0.1" value={d.slo.coldRate * 100} onChange={e => save({ slo: { ...d.slo, coldRate: Math.max(0, Number(e.target.value)) / 100 } })} /></label>
        </div>
      </div>

      <div className="panel">
        <h2>Appearance</h2>
        <div className="seg-control" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked={!dark} className={!dark ? 'on' : ''} onClick={() => setTheme('light')}>Light</button>
          <button type="button" role="radio" aria-checked={dark} className={dark ? 'on' : ''} onClick={() => setTheme('dark')}>Dark</button>
        </div>
      </div>

      <div className="panel">
        <h2>Your data</h2>
        <p>Endpoints live in this browser (IndexedDB). {sync.user ? <>Signed in as <b>{sync.user.email}</b>: policies, SLOs, experiments and request logs under {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB per project sync to your account.</> : 'Sign in from the account menu (top right) to sync across devices. It is optional.'}</p>
        <div className="row gap wrap">
          <button type="button" className="btn ghost" onClick={async () => download(`autoscale-sim-export-${new Date().toISOString().slice(0, 10)}.json`, await exportAll())}>Export all my data (JSON)</button>
          <button type="button" className="btn danger-ghost" onClick={async () => {
            const list = getProjects()
            if (!list.length) { toast('Nothing to delete'); return }
            if (!(await ask('Delete all local endpoints?', `Removes ${list.length} endpoint${list.length > 1 ? 's' : ''} from this browser${sync.user ? ' and from your cloud account' : ''}. You can undo for a few seconds.`, 'Delete everything'))) return
            const undos = await Promise.all(list.map(p => deleteProject(p.id)))
            toast(`Deleted ${list.length} endpoints`, { undo: () => { for (const u of undos) void u() } })
          }}>Delete all endpoints</button>
        </div>
      </div>

      <div className="panel">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          <div><dt><kbd>1</kbd>&ndash;<kbd>7</kbd></dt><dd>Switch endpoint sections</dd></div>
          <div><dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>Previous / next replay day</dd></div>
          <div><dt><kbd>S</kbd></dt><dd>Save the policy as an experiment</dd></div>
          <div><dt><kbd>P</kbd></dt><dd>Printable capacity report</dd></div>
          <div><dt><kbd>&#8984;</kbd>/<kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo the last delete</dd></div>
          <div><dt><kbd>?</kbd></dt><dd>Show shortcuts on an endpoint page</dd></div>
        </dl>
      </div>
    </section>
  )
}
