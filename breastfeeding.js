import { NursingLog, NursingSync, nursingView } from './breastfeeding-sync.js';
import { emptyFeed, elapsed, switchSide, pause, validateFeed, formatDuration } from './breastfeeding-timer.js';

const $ = id => document.getElementById(id);
let db;
let state = { current: emptyFeed(), feeds: [] };
let editingId = null;
let editSnapshot;
let busy = false;
let syncEngine;
let syncMessage = '';
let syncBusy = false;
let revision = -1;
async function refresh() {
  if (!db || busy) return;
  try { const journal = await db.read(); if (journal.revision < revision) return; revision = journal.revision; state = nursingView(journal); render(); renderSync(journal); }
  catch (error) { $('message').textContent = `Could not read saved feeds: ${error.message}`; }
}
async function mutate(change, notice = '') {
  if (!db || busy) return false;
  busy = true;
  render();
  try {
    const expectedId = state.current.id;
    const journal = await db.update(latest => {
      if (latest.current.id !== expectedId) throw new Error('The current feed changed on another device. Review the updated timer and try again.');
      change(latest);
    });
    revision = journal.revision;
    state = nursingView(journal);
    renderSync(journal);
    $('message').textContent = '';
    $('notice').textContent = notice;
    void syncEngine.run();
    return true;
  } catch (error) {
    $('message').textContent = `Change not saved: ${error.message}`;
    return false;
  } finally { busy = false; render(); void refresh(); }
}
function summary(feed) {
  return `L${feed.last === 'left' ? '*' : ''} ${formatDuration(feed.left)} · R${feed.last === 'right' ? '*' : ''} ${formatDuration(feed.right)}`;
}
function ago(start, now) {
  const minutes = Math.floor(Math.max(0, now - start) / 60000);
  if (!minutes) return 'Just now';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  return `${days ? days + 'd ' : ''}${hours ? hours + 'h ' : ''}${minutes % 60}m ago`;
}
function renderTimer() {
  const now = Date.now();
  const feed = elapsed(state.current, now);
  $('total').textContent = formatDuration(feed.left + feed.right);
  $('started').textContent = feed.start === null ? 'Choose a side to begin' : `Started ${new Date(feed.start).toLocaleString()}`;
  $('timerStatus').textContent = feed.active ? `Nursing on the ${feed.active}` : feed.start === null ? 'Ready when you are' : 'Paused';
  for (const side of ['left', 'right']) {
    $(side + 'Time').textContent = formatDuration(feed[side]);
    $(side).setAttribute('aria-pressed', String(feed.active === side));
    $(side + 'Action').textContent = feed.active === side ? 'Ⅱ Pause' : feed.active ? '▶ Switch here' : `▶ ${feed.start === null ? 'Start' : 'Resume'} ${side}`;
    $(side).disabled = !db || busy;
  }
  $('pause').disabled = !db || busy || !feed.active;
  $('save').disabled = !db || busy || feed.left + feed.right <= 0;
  $('reset').disabled = !db || busy || feed.start === null;
  $('editCurrent').disabled = !db || busy;
  const last = [...state.feeds].sort((a, b) => b.start - a.start)[0];
  $('lastAgo').textContent = last ? ago(last.start, now) : 'No feeds yet';
  $('lastSummary').textContent = last ? summary(last) : 'Your last feed will appear here.';
  $('lastHint').textContent = last ? `Since feed started · * Last breast used: ${last.last}` : '';
}
function render() {
  renderTimer();
  const drafts = $('drafts');
  drafts.replaceChildren();
  for (const feed of state.drafts || []) {
    const button = document.createElement('button');
    button.textContent = `Continue unfinished feed from ${new Date(feed.start).toLocaleString()}`;
    button.disabled = busy;
    button.addEventListener('click', async () => {
      try { await db.selectDraft(feed.id); await refresh(); void syncEngine.run(); }
      catch (error) { $('message').textContent = error.message; }
    });
    drafts.append(button);
  }
  $('draftSection').hidden = !(state.drafts || []).length;
  const history = $('history');
  history.replaceChildren();
  if (!state.feeds.length) {
    const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No saved feeds yet.'; history.append(p);
  }
  for (const feed of [...state.feeds].sort((a, b) => b.start - a.start)) {
    const row = document.createElement('article'); row.className = 'feed';
    const date = document.createElement('strong'); date.textContent = new Date(feed.start).toLocaleString();
    const details = document.createElement('p'); details.textContent = summary(feed);
    const total = document.createElement('small'); total.textContent = `${formatDuration(feed.left + feed.right)} total · * Last breast used`;
    const actions = document.createElement('div'); actions.className = 'actions';
    const edit = document.createElement('button'); edit.textContent = 'Edit'; edit.disabled = busy;
    edit.addEventListener('click', () => openEditor(feed.id));
    const remove = document.createElement('button'); remove.textContent = 'Delete'; remove.disabled = busy;
    remove.addEventListener('click', () => {
      if (confirm('Delete this saved feed?')) void mutate(s => { s.feeds = s.feeds.filter(f => f.id !== feed.id); }, 'Feed deleted.');
    });
    actions.append(edit, remove); row.append(date, details, total, actions); history.append(row);
  }
}
for (const side of ['left', 'right']) $(side).addEventListener('click', () => mutate(s => { s.current = switchSide(s.current, side, Date.now()); }));
$('pause').addEventListener('click', () => mutate(s => { s.current = pause(s.current, Date.now()); }));
$('save').addEventListener('click', () => mutate(s => {
  const now = Date.now();
  const feed = validateFeed(pause(s.current, now), now);
  s.feeds.push({ ...feed, id: feed.id || crypto.randomUUID() });
  s.current = emptyFeed();
}, 'Feed saved.'));
$('reset').addEventListener('click', () => {
  if (confirm('Reset the current timer? Unsaved nursing time will be discarded.')) void mutate(s => { s.current = emptyFeed(); }, 'Timer reset.');
});
function localDate(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function editableDuration(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
async function openEditor(id = null) {
  if (busy) return;
  if (id === null && !await mutate(s => { s.current = pause(s.current, Date.now()); })) return;
  const feed = id === null ? state.current : state.feeds.find(f => f.id === id);
  if (!feed) return;
  editingId = id;
  editSnapshot = structuredClone(feed);
  $('editTitle').textContent = id === null ? 'Edit current feed' : 'Edit saved feed';
  $('startInput').value = localDate(feed.start ?? Date.now());
  $('leftInput').value = editableDuration(feed.left);
  $('rightInput').value = editableDuration(feed.right);
  $('lastInput').value = feed.last || (feed.right ? 'right' : 'left');
  $('editError').textContent = '';
  $('editor').showModal();
}
$('editCurrent').addEventListener('click', () => openEditor());
$('cancelEdit').addEventListener('click', () => $('editor').close());
$('editForm').addEventListener('submit', async event => {
  event.preventDefault();
  const parse = value => { const [m, s] = value.split(':').map(Number); return (m * 60 + s) * 1000; };
  const feed = { ...editSnapshot, start: new Date($('startInput').value).getTime(), last: $('lastInput').value };
  // Preserve subsecond precision if the displayed value was not edited.
  for (const side of ['left', 'right']) feed[side] = $(side + 'Input').value === editableDuration(editSnapshot[side]) ? editSnapshot[side] : parse($(side + 'Input').value);
  if (editSnapshot.start !== null && $('startInput').value === localDate(editSnapshot.start)) feed.start = editSnapshot.start;
  try { validateFeed(feed, Date.now()); } catch (error) { $('editError').textContent = error.message; return; }
  const saved = await mutate(s => {
    const latest = editingId === null ? s.current : s.feeds.find(f => f.id === editingId);
    if (JSON.stringify(latest) !== JSON.stringify(editSnapshot)) throw new Error('This feed changed in another tab. Close this editor and reopen it to edit the latest version.');
    if (editingId === null) s.current = feed;
    else s.feeds = s.feeds.map(f => f.id === editingId ? feed : f);
  }, editingId === null ? 'Timer updated. Resume a side or save the feed.' : 'Feed updated.');
  if (saved) $('editor').close();
  else $('editError').textContent = $('message').textContent;
});
function renderSync(journal) {
  const linked = !!journal.sync;
  const enabled = journal.sync?.enabled;
  if (linked) $('syncKey').value = journal.sync.key;
  $('syncKey').readOnly = linked;
  $('syncCreate').hidden = linked;
  $('syncConnect').hidden = !!enabled;
  $('syncConnect').textContent = linked ? 'Reconnect' : 'Connect';
  $('syncDisconnect').hidden = !enabled;
  $('syncNow').hidden = !enabled;
  $('syncCopy').hidden = !linked;
  for (const id of ['syncCreate', 'syncConnect', 'syncDisconnect', 'syncNow']) $(id).disabled = syncBusy;
  const waiting = journal.pending.length;
  $('syncStatus').textContent = !enabled
    ? linked ? `Disconnected · ${waiting} actions waiting` : 'Saved on this device · sync is off'
    : !navigator.onLine ? `Offline · ${waiting} actions waiting`
    : syncMessage || (waiting ? `${waiting} actions waiting to sync` : 'Up to date · checking every 5 seconds');
}
async function syncAction(action) {
  if (!db || syncBusy) return;
  syncBusy = true;
  syncMessage = 'Connecting…';
  await refresh();
  try { await action(); if (syncMessage === 'Connecting…') syncMessage = ''; }
  catch (error) { syncMessage = error.message; $('message').textContent = error.message; }
  finally { syncBusy = false; await refresh(); }
}
$('syncCreate').addEventListener('click', () => syncAction(async () => { await syncEngine.create(); await syncEngine.run({ force: true }); }));
$('syncConnect').addEventListener('click', () => syncAction(async () => { await syncEngine.connect($('syncKey').value); await syncEngine.run({ force: true }); }));
$('syncDisconnect').addEventListener('click', () => syncAction(() => db.disconnect()));
$('syncNow').addEventListener('click', () => syncEngine.run({ force: true }));
$('syncCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('syncKey').value); $('notice').textContent = 'Nursing sync key copied.'; }
  catch { $('syncKey').type = 'text'; $('syncKey').select(); $('notice').textContent = 'Select and copy the sync key.'; }
});
$('syncShow').addEventListener('click', () => {
  $('syncKey').type = $('syncKey').type === 'password' ? 'text' : 'password';
  $('syncShow').textContent = $('syncKey').type === 'password' ? 'Show key' : 'Hide key';
});
try {
  db = await NursingLog.open();
  syncEngine = new NursingSync(db, { onStatus: message => { syncMessage = message; void refresh(); } });
  db.subscribe(() => { void refresh(); });
  await refresh();
  void syncEngine.run();
  const wake = () => { void refresh(); void syncEngine.run({ force: true }); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  window.addEventListener('focus', wake);
  window.addEventListener('online', wake);
  window.addEventListener('offline', () => { void refresh(); });
  setInterval(() => { if (!document.hidden) renderTimer(); }, 250);
  setInterval(() => { if (!document.hidden) { void refresh(); void syncEngine.run(); } }, 5000);
} catch (error) {
  db = null;
  render();
  $('message').textContent = `Local storage unavailable: ${error.message}. Saving is disabled; existing data has not been removed.`;
}
