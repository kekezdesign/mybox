// Service worker хранилища.
// Нужен, чтобы видео проигрывалось и большие файлы скачивались без загрузки целиком в память.
// Ключа шифрования здесь нет: воркер только просит у открытой страницы
// нужный кусок уже расшифрованных данных и отдаёт его проигрывателю.

const STEP = 4 * 1024 * 1024; // сколько отдаём за один запрос

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', () => {}); // "пинги" страницы не дают воркеру уснуть во время скачивания

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  const prefix = scope.pathname + '__vault/';
  if (url.origin !== scope.origin || !url.pathname.startsWith(prefix)) return; // остальное не трогаем
  event.respondWith(serve(event.request, url, url.pathname.slice(prefix.length)));
});

// Спросить у страницы байты [start, end] расшифрованного файла
async function ask(token, id, start, end) {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (!pages.length) throw new Error('Хранилище закрыто');
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('Страница хранилища не ответила'));
      }
    }, 120000);
    for (const page of pages) {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (e.data && e.data.ok) resolve(e.data.buf);
        else reject(new Error((e.data && e.data.error) || 'Ошибка чтения'));
      };
      page.postMessage({ type: 'vault-read', token, id, start, end }, [channel.port2]);
    }
  });
}

async function serve(request, url, rest) {
  const [token, rawId] = rest.split('/');
  const id = decodeURIComponent(rawId || '');
  const size = Number(url.searchParams.get('size'));
  const type = url.searchParams.get('type') || 'application/octet-stream';
  const name = url.searchParams.get('name') || 'file';
  const download = url.searchParams.get('dl') === '1';
  if (!token || !id || !Number.isFinite(size) || size < 0) return new Response('Неверный адрес', { status: 400 });

  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (download) headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(name);

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') || '');
  try {
    if (range && (range[1] || range[2]) && size > 0) {
      let start;
      let end;
      if (range[1] === '') {
        start = Math.max(0, size - Number(range[2]));
        end = size - 1;
      } else {
        start = Number(range[1]);
        end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      }
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      end = Math.min(end, start + STEP - 1);
      const buf = await ask(token, id, start, end);
      return new Response(buf, {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(buf.byteLength) },
      });
    }

    // Запрос без диапазона: отдаём файл целиком, потоком, кусок за куском
    let pos = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (pos >= size) {
          controller.close();
          return;
        }
        const end = Math.min(size - 1, pos + STEP - 1);
        try {
          const buf = await ask(token, id, pos, end);
          controller.enqueue(new Uint8Array(buf));
          pos = end + 1;
        } catch (err) {
          controller.error(err);
        }
      },
    });
    return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  } catch (err) {
    return new Response(String((err && err.message) || err), { status: 502 });
  }
}
