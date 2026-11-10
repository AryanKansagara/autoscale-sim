import { useMemo, useRef, useState } from 'react'
import { autoMap, detectFormat, FIELDS, FORMATS, guessUnit, mergeReqs, parseCsv, parseJsonl, reqsToCsv, validate, type Format, type Mapping } from './engine/parse.ts'
import type { Req } from './engine/types.ts'
import { createBlankProject } from './projectData.ts'
import { putData, saveProject, uuid, type Project } from './store.ts'
import { RAW_SYNC_LIMIT, useSync } from './sync.ts'
import { ask, download, go, Link, toast } from './ui.tsx'

interface Pending { id: string; name: string; format: Format; json: boolean; csv: { rows: string[][]; lines: number[] }; map: Mapping; unit: 'ms' | 's' | 'auto'; badLines: number[] }

export default function DataTab({ project, ds, update }: { project: Project; ds: Req[]; update(p: Partial<Project>): void }) {
  const [pending, setPending] = useState<Pending[]>([])
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const sync = useSync()
  const rawSize = useMemo(() => project.sampleId ? 0 : JSON.stringify(ds).length, [ds, project.sampleId])

  const readFiles = async (files: FileList | File[]) => {
    setBusy(true)
    const next: Pending[] = []
    for (const f of [...files]) {
      if (f.size > 200_000_000) { toast(`${f.name} is over 200 MB. Export a few days at a time.`, { tone: 'error' }); continue }
      const text = await f.text()
      try {
        const json = /^\s*[[{]/.test(text)
        const t = json ? parseJsonl(text) : { ...parseCsv(text), bad: [] }
        if (t.rows.length < 2) { toast(`${f.name} has no requests in it.`, { tone: 'error' }); continue }
        const map = autoMap(t.rows[0])
        next.push({ id: uuid(), name: f.name, json, format: detectFormat(t.rows[0], json), csv: t, map, unit: guessUnit(map.latency !== undefined ? t.rows[0][map.latency] : undefined), badLines: t.bad })
      } catch (e) { toast(`${f.name}: ${e instanceof Error ? e.message : 'could not be read'}`, { tone: 'error' }) }
    }
    setPending(p => [...p, ...next])
    setBusy(false)
  }

  const commit = async (p: Pending, reqs: Req[], skipped: number) => {
    // Samples are read-only: importing into one starts a new endpoint.
    const t = project.sampleId ? await createBlankProject('My endpoint') : project
    const merged = mergeReqs(project.sampleId ? [] : ds, reqs)
    await putData(t.id, merged)
    const meta = { id: uuid(), kind: p.format, fileName: p.name, rows: reqs.length, skipped, at: Date.now() }
    await saveProject({ ...t, imports: [...(project.sampleId ? [] : project.imports), meta], dataMissing: false })
    setPending(x => x.filter(y => y.id !== p.id))
    toast(`Imported ${reqs.length.toLocaleString()} requests${skipped ? `, skipped ${skipped}` : ''}`, { tone: 'ok' })
    go(`/app/p/${t.id}`)
  }

  return (
    <>
      {project.dataMissing && <div className="banner warn"><span><strong>This endpoint&rsquo;s request log is on another device.</strong> Policy, SLOs and experiments synced; logs over {(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB stay where they were imported. Re-import here to replay.</span></div>}
      {!ds.length && !pending.length && (
        <div className="banner"><span><strong>Start here.</strong> Export a few days of request logs from your gateway or proxy (<Link href="/docs">exact steps</Link>), then drop the file below.</span></div>
      )}
      <div className="panel">
        <div className="panel-head"><h2>Import request logs</h2><span className="muted small">OpenAI-compatible proxy JSONL · LiteLLM spend logs · any CSV or JSONL</span></div>
        {project.sampleId && <p className="muted small">This is a synthetic sample, so its data is read-only. Importing here starts a new endpoint. Want to rehearse? <button type="button" className="linkish" onClick={() => download(`${project.sampleId}-requests.csv`, reqsToCsv(ds))}>Download the sample as CSV</button> and drop it back in.</p>}
        <div className={`drop${drag ? ' over' : ''}`} role="button" tabIndex={0} aria-label="Choose CSV or JSONL files to import"
          onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
          onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); void readFiles(e.dataTransfer.files) }}>
          <h3>{busy ? 'Reading files' : 'Drop log files here, or click to choose'}</h3>
          <p className="muted small" style={{ margin: 0 }}>Parsed in your browser. Re-importing the same requests does not duplicate them.</p>
          <input ref={input} type="file" accept=".csv,.tsv,.txt,.json,.jsonl,.ndjson,.log" multiple hidden onChange={e => { if (e.target.files) void readFiles(e.target.files); e.target.value = '' }} />
        </div>
      </div>

      {pending.map(p => <PendingFile key={p.id} p={p} onChange={n => setPending(x => x.map(y => y.id === p.id ? n : y))} onCancel={() => setPending(x => x.filter(y => y.id !== p.id))} onCommit={commit} />)}

      {(project.imports.length > 0 || ds.length > 0) && (
        <div className="panel">
          <div className="panel-head"><h2>Imported data</h2><span className="muted small">{ds.length.toLocaleString()} requests{rawSize ? ` · ${(rawSize / 1e6).toFixed(2)} MB` : ''}</span></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>File</th><th>Format</th><th className="num">Rows</th><th className="num">Skipped</th><th>When</th></tr></thead>
              <tbody>{[...project.imports].reverse().map(i => <tr key={i.id}><th scope="row" className="break">{i.fileName}</th><td>{FORMATS[i.kind] ?? i.kind}</td><td className="num">{i.rows.toLocaleString()}</td><td className="num">{i.skipped}</td><td className="small">{new Date(i.at).toLocaleString()}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="muted small">{sync.user
            ? rawSize > RAW_SYNC_LIMIT ? `This log is over ${(RAW_SYNC_LIMIT / 1e6).toFixed(1)} MB, so it stays on this device. Policy, SLOs and experiments still sync.` : 'Synced to your account with the policy, SLOs and experiments.'
            : 'Stored in this browser only. Sign in to sync across devices.'}</p>
          <div className="row gap wrap">
            <button type="button" className="btn sm outline" onClick={() => download(`${project.name.replace(/\W+/g, '-').toLowerCase()}-requests.csv`, reqsToCsv(ds))}>Download normalized CSV</button>
            {!project.sampleId && <button type="button" className="btn sm danger-ghost" onClick={async () => {
              if (!(await ask('Clear imported logs?', 'Removes every imported request from this endpoint on this device. Policy, SLOs and experiments stay. You can undo for a few seconds.', 'Clear logs'))) return
              const before = ds, imports = project.imports
              await putData(project.id, [])
              update({ imports: [] })
              toast('Cleared imported logs', { undo: async () => { await putData(project.id, before); update({ imports }) } })
            }}>Clear imported logs</button>}
          </div>
        </div>
      )}
    </>
  )
}

function PendingFile({ p, onChange, onCancel, onCommit }: { p: Pending; onChange(p: Pending): void; onCancel(): void; onCommit(p: Pending, rows: Req[], skipped: number): Promise<void> }) {
  const v = useMemo(() => validate(p.csv, p.map, p.unit), [p])
  const [busy, setBusy] = useState(false)
  const headers = p.csv.rows[0] ?? []
  const issues = [...p.badLines.map(line => ({ line, level: 'error' as const, message: 'Not valid JSON; skipped' })), ...v.issues].sort((a, b) => a.line - b.line)
  const errors = issues.filter(i => i.level === 'error')
  const skipped = v.skipped + p.badLines.length
  const range = v.reqs.length ? `${new Date(v.reqs[0].t).toISOString().slice(0, 16).replace('T', ' ')} to ${new Date(v.reqs[v.reqs.length - 1].t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="break">{p.name}</h2>
        <label className="row gap-sm small">Detected format
          <select value={p.format} style={{ width: 'auto' }} onChange={e => onChange({ ...p, format: e.target.value as Format })}>
            {(Object.keys(FORMATS) as Format[]).map(f => <option key={f} value={f}>{FORMATS[f]}</option>)}
          </select>
        </label>
      </div>
      <h3 className="small strong">Column mapping</h3>
      <div className="map-grid">
        {FIELDS.map(f => (
          <label key={f.key} className="field"><span>{f.label}{f.required ? ' *' : ''}</span>
            <select value={p.map[f.key] ?? ''} onChange={e => { const map = { ...p.map }; if (e.target.value === '') delete map[f.key]; else map[f.key] = Number(e.target.value); onChange({ ...p, map }) }}>
              <option value="">Not mapped</option>
              {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
            </select>
          </label>
        ))}
        <label className="field"><span>Latency / TTFT unit</span>
          <select value={p.unit} onChange={e => onChange({ ...p, unit: e.target.value as Pending['unit'] })}>
            <option value="auto">Auto ({v.unit === 's' ? 'seconds' : 'milliseconds'})</option><option value="ms">Milliseconds</option><option value="s">Seconds</option>
          </select>
        </label>
      </div>
      <h3 className="small strong" style={{ marginTop: 8 }}>Validation</h3>
      <p className="small">
        <strong className="good-text">{v.reqs.length.toLocaleString()} requests ready</strong> of {(v.total + p.badLines.length).toLocaleString()} rows
        {skipped > 0 && <>, <strong className="error">{skipped} skipped</strong></>}
        {issues.length > errors.length && <>, {issues.length - errors.length} warnings</>}.
        {range && <> Range {range}. With TTFT: {v.reqs.filter(r => r.ttft !== undefined).length.toLocaleString()}. Failed: {v.reqs.filter(r => !r.ok).length.toLocaleString()}.</>}
      </p>
      {issues.length > 0 && (
        <div className="issues" role="log" aria-label="Validation issues">
          {issues.slice(0, 200).map((i, k) => <div key={k} className={i.level === 'error' ? 'error-row' : ''}><span className="ln">line {i.line}</span><span>{i.message}</span></div>)}
          {issues.length > 200 && <div><span className="ln" /><span className="muted">and {issues.length - 200} more</span></div>}
        </div>
      )}
      <div className="row gap" style={{ marginTop: 14 }}>
        <button type="button" className="btn primary" disabled={!v.reqs.length || busy} onClick={async () => { setBusy(true); await onCommit(p, v.reqs, skipped); setBusy(false) }}>Import {v.reqs.length.toLocaleString()} requests</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
