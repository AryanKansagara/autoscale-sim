import { sweep, type Job } from './engine/sim.ts'
import type { Policy } from './engine/types.ts'

self.onmessage = (e: MessageEvent<{ jobs: Job[]; policy: Policy; start: number; end: number; key: string }>) => {
  const { jobs, policy, start, end, key } = e.data
  self.postMessage({ key, cells: sweep(jobs, policy, undefined, undefined, { start, end }) })
}
