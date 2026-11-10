/** One logged inference request. Times in ms since epoch, durations in ms. */
export interface Req {
  t: number
  lat: number
  ttft?: number
  /** Time spent queued (including waiting for a replica to boot), when the server logs it. */
  queue?: number
  ok: boolean
  timeout?: boolean
  status?: number
  inTok?: number
  outTok?: number
  replica?: string
}

/** Autoscaling policy, named after the knobs on a dedicated deployment. */
export interface Policy {
  minReplicas: number
  maxReplicas: number
  /** Requests one replica serves at once. */
  concurrency: number
  /** Fraction of concurrency the autoscaler aims for before adding replicas (0..1). */
  targetUtil: number
  /** Seconds of load the autoscaler averages before deciding. */
  windowSec: number
  /** Seconds load must stay low before replicas are removed. */
  scaleDownDelaySec: number
  /** Seconds from scale-up decision to a replica serving traffic. */
  coldStartSec: number
  /** Price of one replica-hour. */
  gpuHourly: number
}

export interface Slo {
  p95Ms: number
  p99Ms: number
  /** Max share of requests that may wait on a booting replica. */
  coldRate: number
  errorRate: number
}
