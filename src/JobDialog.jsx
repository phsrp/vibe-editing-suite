import { useSyncExternalStore } from 'react'
import { currentJob, onJobChange, cancelJob } from './mcpJobs.js'

// Shows while an AI app has the editor working on something long (tracking, captions, an export, a download).
export default function JobDialog() {
  const job = useSyncExternalStore(onJobChange, currentJob)
  if (!job || job.state !== 'running') return null
  return (
    <div className="modal-bg top">
      <div className="modal update-modal">
        <h3>{job.title}</h3>
        <p className="upd-text">An AI app asked for this. {job.text}</p>
        <div className="bar"><div className="bar-fill" style={{ width: `${(100 * job.done) / Math.max(1, job.total)}%` }} /></div>
        <div className="modal-foot">
          <span />
          {job.cancellable && <button onClick={cancelJob} disabled={job.cancelled}>{job.cancelled ? 'Cancelling…' : 'Cancel'}</button>}
        </div>
      </div>
    </div>
  )
}
