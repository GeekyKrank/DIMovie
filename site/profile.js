const BASE='https://158-180-61-121.sslip.io/dimovie-library/library';
export function normalizeNick(value) {
  const nick=String(value || '').normalize('NFKC').trim().toLowerCase();
  if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(nick)) throw new Error('Ник: 3–32 буквы, цифры, дефис или подчёркивание.');
  return nick;
}
export async function profileLibrary(nick, action='get', payload={}, signal) {
  const timeout=AbortSignal.timeout(15000);
  const response=await fetch(BASE,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',signal:signal?AbortSignal.any([signal,timeout]):timeout,headers:{'Content-Type':'application/json'},body:JSON.stringify({nick:normalizeNick(nick),action,...payload})});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error || 'Не удалось сохранить библиотеку.');
  if(!Array.isArray(data.movies)||data.movies.length>100)throw new Error('Некорректный ответ библиотеки.');
  return data;
}
