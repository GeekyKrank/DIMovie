const key = () => 'dimovie-history:' + (localStorage.getItem('dimovie-profile') || 'guest');
export function historyItems() {
  try { return JSON.parse(localStorage.getItem(key()) || '[]').filter(row => Number.isFinite(row.position) && row.position >= 0); }
  catch { return []; }
}
export function historyFor(movie) {
  return historyItems().find(row => row.id === movie.id && row.animeId === movie.animeId);
}
export function saveHistory(movie, position, duration, episode) {
  if (!movie || !Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
  try {
    const items = historyItems().filter(row => !(row.id === movie.id && row.animeId === movie.animeId));
    localStorage.setItem(key(), JSON.stringify([{...movie, position, duration, episode, watchedAt: Date.now()}, ...items].slice(0, 100)));
  } catch {}
}
