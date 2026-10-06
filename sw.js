/* =========================================================================
   LQ Música Sureña — sw.js
   Service Worker: cachea el "app shell" (HTML/CSS/JS/íconos), las portadas,
   y el ÚLTIMO listado de catálogo que haya llegado bien del Worker (Cloudflare).
   El audio NUNCA se cachea aquí (eso lo maneja app.js aparte, para favoritos).
   El catálogo es "red primero": si hay internet, siempre se usa la versión
   más fresca; si no hay internet, se usa la última copia guardada en vez de
   dejar la app vacía.
   ========================================================================= */

const CACHE_NAME = 'lq-musica-surena-shell-v6';

// Caché aparte para portadas/íconos que vienen de Cloudflare R2 (otro origen).
// Es "cache-first a secas": una vez guardada una imagen, ya no vuelve a pedirse
// por red (ni gasta datos ni muestra "cargando") hasta que el usuario toque
// el botón de actualizar, que limpia esta caché a propósito.
const IMAGE_CACHE_NAME = 'lq-musica-surena-images-v1';
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif)(\?.*)?$/i;

// Caché del listado del catálogo (respuestas del Worker: carpetas/archivos de R2).
// app.js siempre pide estas URLs con "?prefix=...", así que basta con detectar eso.
const CATALOG_CACHE_NAME = 'lq-musica-surena-catalog-v1';
function isCatalogRequest(url) {
  return url.searchParams.has('prefix');
}

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/config.js',
  './js/app.js',
  './assets/logo.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

// OJO: antes esto borraba cualquier caché que no fuera la del "shell", lo
// que incluía (sin querer) la de imágenes y la del catálogo cada vez que se
// publicaba una versión nueva de este archivo. Ahora se protegen las tres
// cachés vigentes; solo se borran cachés viejas/huérfanas de versiones
// anteriores (por ejemplo "lq-musica-surena-shell-v4").
const KNOWN_CACHES = [CACHE_NAME, IMAGE_CACHE_NAME, CATALOG_CACHE_NAME];
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !KNOWN_CACHES.includes(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Permite que app.js pida "olvidar" las imágenes guardadas (botón de refrescar).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CLEAR_IMAGE_CACHE') {
    event.waitUntil(caches.delete(IMAGE_CACHE_NAME));
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // ---- Listado del catálogo (Worker): red primero, con el último guardado como respaldo ----
  // Así Inicio/Agrupaciones/Álbumes muestran la última versión conocida sin
  // internet, en vez de quedar vacíos, pero cuando SÍ hay internet siempre
  // se usa lo más fresco.
  if (isCatalogRequest(url)) {
    event.respondWith(
      caches.open(CATALOG_CACHE_NAME).then(async (cache) => {
        try {
          const response = await fetch(request);
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        } catch (err) {
          const cached = await cache.match(request);
          if (cached) return cached; // sin conexión: usamos el último catálogo conocido
          throw err;
        }
      })
    );
    return;
  }

  // ---- Portadas/íconos (cualquier origen): cache-first, sin expiración propia ----
  if (IMAGE_EXT_RE.test(url.pathname)) {
    event.respondWith(
      caches.open(IMAGE_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached; // ya la teníamos: ni toca la red
        try {
          const response = await fetch(request);
          // Las imágenes cruzan de origen (R2) sin cabeceras CORS, así que llegan
          // como respuesta "opaca": no se puede leer su contenido/estado, pero sí
          // se puede guardar y volver a servir tal cual. Una respuesta opaca
          // SIEMPRE tiene response.ok = false aunque haya llegado perfecto, así
          // que hay que aceptarla explícitamente o nunca se guarda nada.
          if (response && (response.ok || response.type === 'opaque')) {
            cache.put(request, response.clone());
          }
          return response;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // Solo intervenimos además en peticiones GET a nuestro propio origen (el app shell).
  // Todo lo demás (audio en R2, listados del Worker, fuentes de Google) pasa
  // directo a la red, tal cual, sin pasar por la caché.
  const isOwnOrigin = url.origin === self.location.origin;
  const isShellRequest = isOwnOrigin;

  if (!isShellRequest) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // sin conexión: usa lo cacheado si existe

      // Estrategia "stale-while-revalidate": responde rápido con lo cacheado
      // y de paso actualiza la caché en segundo plano.
      return cached || network;
    })
  );
});
