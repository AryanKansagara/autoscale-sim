import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoMap, parseCsv, parseJsonl, validate } from './parse.ts'

const run = (text: string) => { const c = parseCsv(text); return validate(c, autoMap(c.rows[0])) }
const HEAD = 'timestamp,latency_ms,status\n'
const A = '2026-03-02T02:00:00Z,1000,200\n', B = '2026-03-02T02:10:00Z,1000,200\n'
const brief = (v: ReturnType<typeof run>) => v.issues.map(i => `${i.line} ${i.level} ${i.message}`)

test('a file cut inside the last latency: the row is skipped and reported by line (#2)', () => {
  const v = run(HEAD + A + B + '2026-03-02T12:00:00Z,10')
  assert.equal(v.reqs.length, 2)
  assert.equal(v.skipped, 1)
  assert.deepEqual(brief(v), ['4 error Row has 2 of 3 columns, file may be truncated; row skipped'])
})

test('every cut that leaves fewer columns is reported and never imports the cut row (#2)', () => {
  for (const eol of ['\n', '\r\n']) for (const delim of [',', ';', '\t']) {
    const whole = (HEAD + A + B + '2026-03-02T12:00:00Z,1000,200').replaceAll(',', delim).replaceAll('\n', eol)
    const start = whole.lastIndexOf('2026-')
    for (let cut = start + 1; cut <= whole.lastIndexOf(delim); cut++) {
      const v = run(whole.slice(0, cut))
      assert.equal(v.reqs.length, 2, JSON.stringify(whole.slice(start, cut)))
      assert.equal(v.skipped, 1)
      assert.equal(v.issues.at(-1)!.line, 4)
    }
  }
})

test('a file cut inside a quoted value is reported even when the row has every column (#2)', () => {
  const v = run('timestamp,latency_ms\n"2026-03-02T02:00:00Z","1000"\n"2026-03-02T12:00:00Z","10')
  assert.equal(v.reqs.length, 1)
  assert.deepEqual(brief(v), ['3 error Quoted value is never closed, file may be truncated; row skipped'])
})

test('a short row that ends with a newline is kept with a warning; the list is capped (#2)', () => {
  const v = run(HEAD + A + '2026-03-02T02:05:00Z,900\n' + B)
  assert.equal(v.reqs.length, 3)
  assert.deepEqual(brief(v), ['3 warn Row has 2 of 3 columns; the missing ones are treated as empty'])
  const many = run(HEAD + A + '2026-03-02T02:05:00Z,900\n'.repeat(500) + B)
  assert.equal(many.reqs.length, 502)
  assert.equal(many.issues.length, 21)
  assert.match(many.issues[20].message, /^500 rows in all/)
})

test('complete files are not flagged: no final newline, empty or unnamed trailing columns, columns no row fills, JSONL (#2)', () => {
  for (const text of [
    (HEAD + A + B).trimEnd(),
    HEAD + A + B + '\n\n',
    HEAD + A + '2026-03-02T02:10:00Z,1000,',
    'timestamp,latency_ms,\n2026-03-02T02:00:00Z,1000\n2026-03-02T02:10:00Z,900',
    'timestamp,latency_ms,status,replica\n2026-03-02T02:00:00Z,1000,200\n2026-03-02T02:10:00Z,900,200',
    'timestamp,latency_ms\n2026-03-02T02:00:00Z,1000,extra\n2026-03-02T02:10:00Z,900',
    'timestamp,latency_ms\n2026-03-02T02:00:00Z,1000\n"2026-03-02T02:10:00Z","900"',
  ]) {
    const v = run(text)
    assert.equal(v.reqs.length, 2, text)
    assert.deepEqual(v.issues, [], text)
  }
  const j = parseJsonl('{"timestamp":"2026-03-02T02:00:00Z","latency_ms":1000,"status":200}\n{"timestamp":"2026-03-02T02:10:00Z","latency_ms":900}')
  const v = validate(j, autoMap(j.rows[0]))
  assert.equal(v.reqs.length, 2)
  assert.deepEqual(v.issues, [])
})
