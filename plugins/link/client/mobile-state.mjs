// Session timestamps are Unix milliseconds (including numeric strings) or ISO dates.
function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const parsed = /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function sessionTime(session) {
  return timestamp(session?.updatedAt) ?? timestamp(session?.createdAt);
}

export function recentSessions(sessions, projects, query = '') {
  const names = new Map((projects || []).map(project => [project.id, [project.name, project.path].filter(Boolean).join(' ')]));
  const search = String(query || '').trim().toLocaleLowerCase();
  return (sessions || [])
    .map((session, index) => ({ session, index, time: sessionTime(session) }))
    .filter(({ session }) => !search || [session.title, names.get(session.projectId)].filter(Boolean).join(' ').toLocaleLowerCase().includes(search))
    .sort((a, b) => {
      if (a.time === null) return b.time === null ? a.index - b.index : 1;
      if (b.time === null) return -1;
      return b.time - a.time || a.index - b.index;
    })
    .map(({ session }) => session);
}

export function sessionGroups(sessions, now = Date.now()) {
  const today = new Date(timestamp(now) ?? Date.now());
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const lastWeek = new Date(today); lastWeek.setDate(lastWeek.getDate() - 7);
  const groups = ['今天', '昨天', '过去7天', '更早', '未标注时间'].map(label => ({ label, items: [] }));
  for (const session of recentSessions(sessions, [])) {
    const time = sessionTime(session);
    const index = time === null ? 4 : time >= today.getTime() ? 0 : time >= yesterday.getTime() ? 1 : time >= lastWeek.getTime() ? 2 : 3;
    groups[index].items.push(session);
  }
  return groups.filter(group => group.items.length);
}

export function defaultProjectId(projects, sessions, preferred = '') {
  const ids = new Set((projects || []).map(project => project.id).filter(Boolean));
  if (ids.has(preferred)) return preferred;
  const recent = recentSessions(sessions, []).find(session => ids.has(session.projectId));
  return recent?.projectId || projects?.[0]?.id || '';
}
