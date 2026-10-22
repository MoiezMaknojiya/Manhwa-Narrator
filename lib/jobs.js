// Chhota in-memory job registry — image voices background mein bante hain,
// UI har 2s status poll karti hai. Server restart par jobs khatam (files disk par rehti hain).

const jobs = new Map(); // key: `${chapterId}:${type}`

function key(cid, type) { return `${cid}:${type}`; }

function get(cid, type) {
  return jobs.get(key(cid, type)) || null;
}

function isRunning(cid, type) {
  const j = get(cid, type);
  return !!(j && j.status === 'running');
}

/**
 * Job start karo. runner(progress) async hai; progress(step, total, message) call karta rahe.
 * Resolve hone par result save hota hai, reject par error.
 */
function start(cid, type, runner) {
  if (isRunning(cid, type)) throw new Error(`A ${type} job is already running for this chapter.`);
  const job = {
    type, status: 'running', step: 0, total: 0, message: 'Starting…',
    startedAt: Date.now(), endedAt: null, result: null, error: '',
  };
  jobs.set(key(cid, type), job);
  const progress = (step, total, message) => {
    job.step = step;
    job.total = total;
    if (message) job.message = message;
  };
  Promise.resolve()
    .then(() => runner(progress))
    .then((result) => {
      job.status = 'done';
      job.result = result || null;
      job.message = 'Done';
      job.endedAt = Date.now();
    })
    .catch((err) => {
      job.status = 'error';
      job.error = (err && err.message) || String(err);
      job.message = 'Failed';
      job.endedAt = Date.now();
      console.error(`  ❌ ${type} job failed (${cid}):`, job.error);
    });
  return job;
}

function publicView(j) {
  if (!j) return null;
  return {
    type: j.type, status: j.status, step: j.step, total: j.total, message: j.message,
    error: j.error, startedAt: j.startedAt, endedAt: j.endedAt,
    elapsedSec: Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000),
  };
}

module.exports = { start, get, isRunning, publicView };
