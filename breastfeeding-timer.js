// Durations are milliseconds. Only the active segment uses wall-clock time.
export function emptyFeed() {
  return { start: null, left: 0, right: 0, active: null, since: null, last: null };
}
export function elapsed(feed, now) {
  const result = { ...feed };
  if (feed.active) result[feed.active] += Math.max(0, now - feed.since);
  result.since = feed.active ? now : null;
  return result;
}
export function switchSide(feed, side, now) {
  const next = elapsed(feed, now);
  next.start ??= now;
  next.active = feed.active === side ? null : side;
  next.since = next.active ? now : null;
  if (next.active) next.last = side;
  return next;
}
export function pause(feed, now) {
  return { ...elapsed(feed, now), active: null, since: null };
}
export function validateFeed(feed, now) {
  if (!Number.isFinite(feed.start) || feed.start > now || feed.start < 0) throw new Error('Choose a start time in the past or now.');
  if (![feed.left, feed.right].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Enter a valid duration for each side.');
  if (feed.left + feed.right <= 0) throw new Error('Add some nursing time before saving.');
  if (!['left', 'right'].includes(feed.last) || feed[feed.last] <= 0) throw new Error('Choose a last side with nursing time.');
  return feed;
}
export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}
