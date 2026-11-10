// node scripts/qa-sync.mjs : signs up a throwaway account, round-trips an endpoint and an experiment through the same tables the app syncs to, then deletes the account
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => l.split('=')))
const sb = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } })
const email = `qa-autoscale-sim-${Date.now()}@example.com`, password = 'qa-' + Math.random().toString(36).slice(2) + 'X9!'
const ok = (label, r) => { if (r.error) { console.log('FAIL', label, r.error.message); process.exitCode = 1 } else console.log('ok  ', label) }
const up = await sb.auth.signUp({ email, password }); ok('sign up ' + email, up)
if (!up.data.session) ok('sign in', await sb.auth.signInWithPassword({ email, password }))
const id = crypto.randomUUID(), vid = crypto.randomUUID()
ok('upsert endpoint', await sb.from('projects').upsert({ id, app: 'autoscale-sim', name: 'QA endpoint', data: { project: { id, name: 'QA endpoint', policy: { minReplicas: 1, maxReplicas: 3 } } }, updated_at: new Date().toISOString() }))
ok('insert snapshot', await sb.from('project_versions').insert({ id: vid, project_id: id, label: 'min 1', data: { id: vid, label: 'min 1', at: Date.now(), result: { p99: 1000 } } }))
const rows = await sb.from('projects').select('id,name,data').eq('app', 'autoscale-sim'); ok('read back', rows)
console.log(rows.data?.length === 1 && rows.data[0].data.project.policy.maxReplicas === 3 ? 'ok   round trip matches' : 'FAIL round trip')
const vs = await sb.from('project_versions').select('id').in('project_id', [id]); console.log(vs.data?.length === 1 ? 'ok   snapshot round trip' : 'FAIL snapshot')
ok('delete account', await sb.rpc('delete_my_account'))
const after = await sb.auth.signInWithPassword({ email, password }); console.log(after.error ? 'ok   account gone (' + after.error.message + ')' : 'FAIL account still exists')
