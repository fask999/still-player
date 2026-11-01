'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StillTimeline = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function effectiveTime(positionSeconds, offsetMs) {
    const audio = Number.isFinite(Number(positionSeconds)) ? Number(positionSeconds) * 1000 : 0;
    const offset = Number.isFinite(Number(offsetMs)) ? Number(offsetMs) : 0;
    return audio - offset;
  }
  function lineIndex(lines, positionSeconds, offsetMs) {
    const now = effectiveTime(positionSeconds, offsetMs);
    let found = -1;
    for (let i = 0; i < (Array.isArray(lines) ? lines.length : 0); i++) {
      const raw = lines[i]?.startMs;
      if (raw == null || (typeof raw === 'string' && !raw.trim())) continue;
      const start = Number(raw);
      if (Number.isFinite(start) && start <= now && (found < 0 || start >= Number(lines[found].startMs))) found = i;
    }
    if (found < 0) return -1;
    const rawEnd = lines[found].endMs, end = Number(rawEnd);
    return rawEnd != null && !(typeof rawEnd === 'string' && !rawEnd.trim()) && Number.isFinite(end) && now >= end ? -1 : found;
  }
  function wordProgress(word, positionSeconds, offsetMs) {
    const start = Number(word?.startMs), end = Number(word?.endMs);
    if (word?.startMs == null || word?.endMs == null || (typeof word.startMs === 'string' && !word.startMs.trim()) || (typeof word.endMs === 'string' && !word.endMs.trim()) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return Math.max(0, Math.min(1, (effectiveTime(positionSeconds, offsetMs) - start) / (end - start)));
  }
  function seekPosition(line, offsetMs) {
    const start = Number(line?.startMs), offset = Number(offsetMs);
    if (line?.startMs == null || (typeof line.startMs === 'string' && !line.startMs.trim()) || !Number.isFinite(start)) return null;
    return Math.max(0, (start + (Number.isFinite(offset) ? offset : 0)) / 1000);
  }
  return {effectiveTime, lineIndex, wordProgress, seekPosition};
});
