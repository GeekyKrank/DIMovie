const languages = {uk:'Українська',ukr:'Українська',ru:'Русский',rus:'Русский',en:'English',eng:'English',pl:'Polski',pol:'Polski',de:'Deutsch',deu:'Deutsch',ger:'Deutsch',fr:'Français',fra:'Français',fre:'Français',ja:'日本語',jpn:'日本語'};
export function audioLabel(track, index) {
  const code = String(track.language || '').toLowerCase().split(/[-_]/)[0];
  const language = languages[code] || (code && code !== 'und' ? code.toUpperCase() : '');
  const label = String(track.label || '').trim();
  return [language, label].filter(Boolean).join(' · ') || `Дорожка ${index + 1}`;
}
export function selectAudioTrack(tracks, index) {
  if (!tracks || !Number.isInteger(index) || index < 0 || index >= tracks.length) return false;
  // Disable every other track so multiple languages never play together.
  for (let i = 0; i < tracks.length; i++) tracks[i].enabled = i === index;
  return Boolean(tracks[index].enabled);
}
