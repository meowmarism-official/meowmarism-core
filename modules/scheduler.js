// Scheduled tasks: interval / daily / weekly triggers running backups, restarts, start/stop and console commands.
const crypto = require('crypto');

const ACTIONS = ['backup', 'restart', 'stop', 'start', 'command'];
const ACTION_CAP = { backup: 'backups', restart: 'power', stop: 'power', start: 'power', command: 'console' };
const GRACE_MS = 10 * 60 * 1000;

function cleanTask(input, existing) {
  const t = input || {};
  const name = String(t.name || '').trim().slice(0, 60);
  if (!name) throw new Error('give the task a name');
  const action = t.action || {};
  if (!ACTIONS.includes(action.type)) throw new Error('unknown action');
  const cleanAction = { type: action.type };
  if (action.type === 'command') {
    const command = String(action.command || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 300);
    if (!command) throw new Error('enter a console command');
    cleanAction.command = command;
  }
  if (action.type === 'restart' || action.type === 'stop') {
    cleanAction.warnSec = Math.max(0, Math.min(3600, Math.round(Number(action.warnSec) || 0)));
  }
  const trig = t.trigger || {};
  let trigger;
  if (trig.type === 'interval') {
    const every = Math.round(Number(trig.everyMinutes));
    if (!Number.isFinite(every) || every < 5 || every > 10080) throw new Error('interval must be between 5 minutes and 7 days');
    trigger = { type: 'interval', everyMinutes: every };
  } else if (trig.type === 'daily' || trig.type === 'weekly') {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(trig.time || ''))) throw new Error('time must look like 04:30');
    trigger = { type: trig.type, time: trig.time };
    if (trig.type === 'weekly') {
      const days = [...new Set((trig.days || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
      if (!days.length) throw new Error('pick at least one weekday');
      trigger.days = days;
    }
  } else throw new Error('unknown schedule type');
  return {
    id: existing ? existing.id : crypto.randomBytes(6).toString('hex'),
    name,
    enabled: t.enabled !== false,
    trigger,
    action: cleanAction,
    createdAt: existing ? existing.createdAt : Date.now(),
    lastRunAt: existing ? existing.lastRunAt || null : null,
    lastResult: existing ? existing.lastResult || null : null,
  };
}

function scheduledTimeToday(task, now) {
  const [h, m] = task.trigger.time.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function nextRunAt(task, now = Date.now()) {
  if (!task.enabled) return null;
  const tr = task.trigger;
  if (tr.type === 'interval') return (task.lastRunAt || task.createdAt) + tr.everyMinutes * 60000;
  for (let i = 0; i < 8; i++) {
    const day = new Date(now);
    day.setDate(day.getDate() + i);
    if (tr.type === 'weekly' && !tr.days.includes(day.getDay())) continue;
    const at = scheduledTimeToday(task, day.getTime());
    if (at > now && at > (task.lastRunAt || 0)) return at;
  }
  return null;
}

function isDue(task, now = Date.now()) {
  if (!task.enabled) return false;
  const tr = task.trigger;
  if (tr.type === 'interval') return now >= (task.lastRunAt || task.createdAt) + tr.everyMinutes * 60000;
  if (tr.type === 'weekly' && !tr.days.includes(new Date(now).getDay())) return false;
  const at = scheduledTimeToday(task, now);
  return now >= at && now - at < GRACE_MS && (task.lastRunAt || 0) < at;
}

module.exports = { ACTIONS, ACTION_CAP, cleanTask, nextRunAt, isDue };
