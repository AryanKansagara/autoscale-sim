import type { Req } from "./types.ts"

export function parseCsv(text: string): { rows: string[][]; lines: number[] } {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const delim = sniffDelimiter(text)
  const rows: string[][] = []
  const lines: number[] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else {
        if (c === '\n') line++
        field += c
      }
      continue
    }
    if (c === '"' && field === '') quoted = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }
      row = []
      line++
      rowLine = line
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') { rows.push(row); lines.push(rowLine) }
  }
  return { rows, lines }
}

function sniffDelimiter(text: string): string {
  const head = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  const counts = [',', '\t', ';', '|'].map(d => [d, head.split(d).length] as const)
  return counts.sort((a, b) => b[1] - a[1])[0][0]
}

/** Parses ISO 8601 (with or without offset), epoch seconds/ms, YYYY/MM/DD and US M/D/YYYY. No offset means UTC. Returns ms or NaN. */
export function parseTime(raw: string): number {
  const s = raw.trim()
  if (!s) return NaN
  if (/^\d{10}(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000)
  if (/^\d{13}$/.test(s)) return Number(s)
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i)
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', se = '0', frac = '0', tz] = m
    let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, Math.round(Number('0.' + frac) * 1000))
    if (tz && !/^(z|utc)$/i.test(tz)) {
      const sign = tz[0] === '-' ? -1 : 1
      const digits = tz.slice(1).replace(':', '')
      t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60000
    }
    return t
  }
  // US style from spreadsheets: 10/1/2026 7:00(:00)( AM)
  const u = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i)
  if (u) {
    let h = Number(u[4] ?? 0)
    if (u[7]) h = (h % 12) + (/pm/i.test(u[7]) ? 12 : 0)
    return Date.UTC(+u[3], +u[1] - 1, +u[2], h, Number(u[5] ?? 0), Number(u[6] ?? 0))
  }
  return NaN
}


export function parseNum(raw: string): number {
  const s = raw.trim().replace(/[,\s$]/g, '')
  if (s === '' || /^null$/i.test(s)) return NaN
  return Number(s)
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map(r => r.map(v => {
    const s = typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : v
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n') + '\n'
}


// ---------- Formats ----------

export type Format = 'openai-proxy' | 'litellm' | 'plain'

export const FORMATS: Record<Format, string> = {
  'openai-proxy': 'OpenAI-compatible proxy log (JSONL)',
  litellm: 'LiteLLM spend logs',
  plain: 'Plain CSV / JSONL',
}

export interface FieldSpec { key: FieldKey; label: string; required?: boolean; aliases: string[] }
export type FieldKey = 'time' | 'latency' | 'end' | 'ttft' | 'firstToken' | 'queue' | 'status' | 'inTok' | 'outTok' | 'replica'

/** Aliases are normalized header names, most specific first. */
export const FIELDS: FieldSpec[] = [
  { key: 'time', label: 'Request time', required: true, aliases: ['starttime', 'start_time', 'request_start', 'timestamp', 'created_at', 'created', 'time', 'ts', 'date', '@timestamp'] },
  { key: 'latency', label: 'Latency', aliases: ['latency_ms', 'duration_ms', 'response_time_ms', 'total_time_ms', 'elapsed_ms', 'latency', 'duration', 'response_time', 'request_duration', 'elapsed'] },
  { key: 'end', label: 'Finished at (if no latency)', aliases: ['endtime', 'end_time', 'completed_at', 'finished_at', 'response_time_at'] },
  { key: 'ttft', label: 'Time to first token', aliases: ['ttft_ms', 'ttft', 'time_to_first_token_ms', 'time_to_first_token', 'first_token_ms'] },
  { key: 'firstToken', label: 'First token at (if no TTFT)', aliases: ['completionstarttime', 'completion_start_time', 'first_token_at', 'first_token_time'] },
  { key: 'queue', label: 'Queue / wait time', aliases: ['queue_ms', 'queue_time_ms', 'time_in_queue_ms', 'queue_duration_ms', 'wait_ms', 'queue_time', 'time_in_queue', 'queue_duration'] },
  { key: 'status', label: 'Status', aliases: ['status_code', 'http_status', 'status', 'response_status', 'code', 'outcome', 'result'] },
  { key: 'inTok', label: 'Input tokens', aliases: ['prompt_tokens', 'input_tokens', 'usage_prompt_tokens', 'response_usage_prompt_tokens', 'tokens_in', 'in_tokens'] },
  { key: 'outTok', label: 'Output tokens', aliases: ['completion_tokens', 'output_tokens', 'usage_completion_tokens', 'response_usage_completion_tokens', 'tokens_out', 'out_tokens'] },
  { key: 'replica', label: 'Replica / pod', aliases: ['replica_id', 'replica', 'pod', 'pod_name', 'instance', 'instance_id', 'host', 'hostname', 'worker'] },
]

export const norm = (h: string) => h.trim().toLowerCase().replace(/^"|"$/g, '').replace(/[\s\-.]+/g, '_')

export function detectFormat(headers: string[], json: boolean): Format {
  const h = new Set(headers.map(norm))
  if (h.has('completionstarttime') || (h.has('starttime') && h.has('endtime')) || h.has('api_base') && h.has('spend')) return 'litellm'
  if (json && [...h].some(k => /(^|_)usage_(prompt|completion)_tokens$/.test(k))) return 'openai-proxy'
  return 'plain'
}

export type Mapping = Partial<Record<FieldKey, number>>

export function autoMap(headers: string[]): Mapping {
  const n = headers.map(norm)
  const m: Mapping = {}
  const used = new Set<number>()
  for (const f of FIELDS) {
    for (const a of f.aliases) {
      const i = n.findIndex((h, k) => !used.has(k) && h === a)
      if (i >= 0) { m[f.key] = i; used.add(i); break }
    }
  }
  if (m.latency !== undefined && m.end !== undefined) delete m.end
  if (m.ttft !== undefined && m.firstToken !== undefined) delete m.firstToken
  return m
}

/** Latency unit from the header name; "auto" falls back to magnitude in validate(). */
export function guessUnit(header: string | undefined): 'ms' | 's' | 'auto' {
  if (!header) return 'auto'
  const h = norm(header)
  if (/_ms$|millis/.test(h)) return 'ms'
  if (/_s$|_sec|seconds/.test(h)) return 's'
  return 'auto'
}

// ---------- JSON / JSONL ----------

function flatten(o: unknown, prefix: string, out: Record<string, string>) {
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) flatten(v, prefix ? `${prefix}.${k}` : k, out)
  } else if (prefix) out[prefix] = o === null || o === undefined ? '' : typeof o === 'object' ? JSON.stringify(o) : String(o)
}

/** JSONL (one object per line) or a JSON array, flattened to a table with dot-path headers. Line numbers are kept. */
export function parseJsonl(text: string): { rows: string[][]; lines: number[]; bad: number[] } {
  const recs: { line: number; o: Record<string, string> }[] = []
  const bad: number[] = []
  const t = text.trim()
  if (t.startsWith('[')) {
    const arr = JSON.parse(t) as unknown[]
    arr.forEach((o, i) => { const f: Record<string, string> = {}; flatten(o, '', f); recs.push({ line: i + 1, o: f }) })
  } else {
    text.split(/\r?\n/).forEach((l, i) => {
      if (!l.trim()) return
      try { const f: Record<string, string> = {}; flatten(JSON.parse(l), '', f); recs.push({ line: i + 1, o: f }) } catch { bad.push(i + 1) }
    })
  }
  const keys: string[] = []
  const seen = new Set<string>()
  for (const r of recs.slice(0, 500)) for (const k of Object.keys(r.o)) if (!seen.has(k)) { seen.add(k); keys.push(k) }
  return { rows: [keys, ...recs.map(r => keys.map(k => r.o[k] ?? ''))], lines: [0, ...recs.map(r => r.line)], bad }
}

// ---------- Validation ----------

export interface Issue { line: number; level: 'error' | 'warn'; message: string }
export interface Validation { reqs: Req[]; issues: Issue[]; total: number; skipped: number; unit: 'ms' | 's' }

export function parseStatus(raw: string): { ok: boolean; timeout: boolean; code?: number } | null {
  const s = raw.trim().toLowerCase()
  if (!s) return null
  const n = Number(s)
  if (Number.isFinite(n) && n >= 100 && n < 600) return { ok: n < 400, timeout: n === 408 || n === 504, code: n }
  if (/^(ok|success|succeeded|completed|true|2xx)$/.test(s)) return { ok: true, timeout: false }
  if (/timeout|timed_out|deadline/.test(s)) return { ok: false, timeout: true }
  if (/^(fail|failure|failed|error|false|cancelled|canceled|5xx|4xx)/.test(s)) return { ok: false, timeout: false }
  return null
}

export function validate(csv: { rows: string[][]; lines: number[] }, map: Mapping, unit: 'ms' | 's' | 'auto' = 'auto'): Validation {
  const issues: Issue[] = []
  const reqs: Req[] = []
  const get = (r: string[], k: FieldKey) => map[k] === undefined ? '' : (r[map[k]!] ?? '')
  if (map.time === undefined) issues.push({ line: 1, level: 'error', message: 'Map a column to "Request time".' })
  if (map.latency === undefined && map.end === undefined) issues.push({ line: 1, level: 'error', message: 'Map "Latency" or "Finished at" so latency can be computed.' })
  if (issues.length) return { reqs, issues, total: csv.rows.length - 1, skipped: csv.rows.length - 1, unit: 'ms' }

  // Auto unit: latencies that are mostly under 50 with decimals look like seconds.
  let u: 'ms' | 's' = unit === 'auto' ? 'ms' : unit
  if (unit === 'auto' && map.latency !== undefined) {
    const vals = csv.rows.slice(1, 400).map(r => parseNum(get(r, 'latency'))).filter(Number.isFinite).sort((a, b) => a - b)
    if (vals.length && vals[Math.floor(vals.length / 2)] < 50) u = 's'
  }
  const k = u === 's' ? 1000 : 1
  let skipped = 0
  let warnedStatus = 0
  for (let i = 1; i < csv.rows.length; i++) {
    const r = csv.rows[i]
    const line = csv.lines[i]
    const t = parseTime(get(r, 'time'))
    if (!Number.isFinite(t)) { issues.push({ line, level: 'error', message: `Unreadable request time "${get(r, 'time').slice(0, 40)}"` }); skipped++; continue }
    let lat = NaN
    if (map.latency !== undefined) lat = parseNum(get(r, 'latency')) * k
    else { const e = parseTime(get(r, 'end')); lat = e - t }
    if (!Number.isFinite(lat) || lat < 0) { issues.push({ line, level: 'error', message: `Missing or negative latency "${(map.latency !== undefined ? get(r, 'latency') : get(r, 'end')).slice(0, 40)}"` }); skipped++; continue }
    const q: Req = { t, lat, ok: true }
    let ttft = NaN
    if (map.ttft !== undefined) ttft = parseNum(get(r, 'ttft')) * k
    else if (map.firstToken !== undefined) ttft = parseTime(get(r, 'firstToken')) - t
    if (Number.isFinite(ttft)) {
      if (ttft < 0 || ttft > lat + 1) issues.push({ line, level: 'warn', message: `TTFT ${Math.round(ttft)} ms is outside 0..latency; ignored` })
      else q.ttft = ttft
    }
    if (map.queue !== undefined) {
      const qv = parseNum(get(r, 'queue')) * k
      if (Number.isFinite(qv)) {
        if (qv < 0 || qv > lat + 1) issues.push({ line, level: 'warn', message: `Queue time ${Math.round(qv)} ms is outside 0..latency; ignored` })
        else q.queue = qv
      }
    }
    if (map.status !== undefined) {
      const st = parseStatus(get(r, 'status'))
      if (st) { q.ok = st.ok; if (st.timeout) q.timeout = true; if (st.code) q.status = st.code }
      else if (get(r, 'status').trim() && warnedStatus++ < 20) issues.push({ line, level: 'warn', message: `Unknown status "${get(r, 'status').slice(0, 30)}", counted as success` })
    }
    const inT = parseNum(get(r, 'inTok')), outT = parseNum(get(r, 'outTok'))
    if (Number.isFinite(inT) && inT >= 0) q.inTok = inT
    if (Number.isFinite(outT) && outT >= 0) q.outTok = outT
    const rep = get(r, 'replica').trim()
    if (rep) q.replica = rep
    reqs.push(q)
  }
  reqs.sort((a, b) => a.t - b.t)
  return { reqs, issues, total: csv.rows.length - 1, skipped, unit: u }
}

/** Merge by (time, latency) so re-importing the same file does not duplicate requests. */
export function mergeReqs(a: Req[], b: Req[]): Req[] {
  const key = (r: Req) => `${r.t}|${Math.round(r.lat)}|${r.replica ?? ''}`
  const seen = new Set(a.map(key))
  return [...a, ...b.filter(r => !seen.has(key(r)) && (seen.add(key(r)), true))].sort((x, y) => x.t - y.t)
}

export function reqsToCsv(reqs: Req[]): string {
  return toCsv([['timestamp', 'latency_ms', 'ttft_ms', 'queue_ms', 'status', 'input_tokens', 'output_tokens', 'replica_id'],
    ...reqs.map(r => [new Date(r.t).toISOString(), Math.round(r.lat), r.ttft === undefined ? '' : Math.round(r.ttft), r.queue === undefined ? '' : Math.round(r.queue), r.status ?? (r.timeout ? 'timeout' : r.ok ? 200 : 500), r.inTok ?? '', r.outTok ?? '', r.replica ?? ''])])
}
