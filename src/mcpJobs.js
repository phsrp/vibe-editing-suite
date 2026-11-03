// Long work an AI app asks for (tracking, captions, exports, downloads). AI apps give up on a tool that takes too long, so the work
// runs here in the background: the tool only starts it, and check_job says how far it got. JobDialog shows it to the person.
let job = null
const listeners = new Set()
const update = (patch) => {
  job = { ...job, ...patch }
  listeners.forEach((f) => f())
}
export const currentJob = () => job
export const jobRunning = () => !!job && job.state === 'running'
export const onJobChange = (f) => {
  listeners.add(f)
  return () => listeners.delete(f)
}
export function cancelJob() {
  if (!jobRunning() || !job.cancellable || job.cancelled) return false
  update({ cancelled: true })
  if (job.onCancel) job.onCancel()
  return true
}

// run({progress(done, total, text), cancelled(), onCancel(fn)}) does the work; what it returns is the result the AI app is told
export function startJob({ title, text = '', seconds, cancellable = true }, run) {
  job = null
  update({ state: 'running', title, text, done: 0, total: 0, seconds, cancellable, cancelled: false, onCancel: null })
  const tools = {
    progress: (done, total, t) => update({ done, total, text: t == null ? job.text : t }),
    cancelled: () => job.cancelled,
    onCancel: (f) => (job.onCancel = f),
  }
  Promise.resolve()
    .then(() => run(tools))
    .then(
      (result) => update(job.cancelled ? { state: 'cancelled' } : { state: 'done', result }),
      (e) => update(job.cancelled ? { state: 'cancelled' } : { state: 'failed', error: String((e && e.message) || e) }),
    )
}
