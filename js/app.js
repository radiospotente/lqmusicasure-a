/* =========================================================================
   LQ Música Sureña — app.js
   Estado global + reproductor persistente + navegación entre vistas.
   Todo en JS puro para máxima compatibilidad con WebView (Android Studio).
   ========================================================================= */

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Estado global de la aplicación
  // ---------------------------------------------------------------------
  const state = {
    songs: [],
    agrupaciones: [], // derivado: nombres únicos de "artist"
    albumes: [],      // derivado: agrupado por "album"
    favorites: new Set(), // ids de canciones marcadas como favoritas (persistido en localStorage)
    queue: [],         // lista de ids que se está reproduciendo actualmente
    queueIndex: -1,
    currentSong: null,
    isPlaying: false,
    shuffle: false,
    detailContext: null, // { type: 'album'|'agrupacion', key: string }
    nextQueueIndex: null, // índice ya precargado en preloadEl, para transición sin baches

    // --- Sello LQ Producciones, superpuesto dentro de la mezcla Aleatoria ---
    aleatorioActive: false,   // true mientras estamos reproduciendo la mezcla aleatoria
    songsSinceStamp: 0,       // canciones reproducidas desde el último sello
    stampDueForCurrent: false,// ¿a esta canción (la actual) le toca sello antes de terminar?
    stampTriggered: false,    // ¿ya se disparó el sello para la canción actual?
    stampPrevVolume: null     // volumen que tenía la canción antes de agacharse ("duck")
  };

  const audio = document.getElementById('audioEl');
  const preloadEl = document.getElementById('preloadEl');
  let stampAudioEl = null;    // <audio> secundario, creado bajo demanda, solo para el sello
  let stampFadeTimer = null;  // referencia al fundido de volumen en curso

  // ---------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function findSong(id) {
    return state.songs.find((s) => s.id === id);
  }

  // Quita acentos para que "corazon" encuentre "Corazón"
  function normalize(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  // ---------------------------------------------------------------------
  // Favoritos: persistidos en localStorage (por dispositivo)
  // ---------------------------------------------------------------------
  const FAVORITES_KEY = 'lq-musica-surena-favoritos';

  function loadFavorites() {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      const ids = raw ? JSON.parse(raw) : [];
      state.favorites = new Set(Array.isArray(ids) ? ids : []);
    } catch (e) {
      state.favorites = new Set();
    }
  }

  function saveFavorites() {
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(state.favorites)));
    } catch (e) { /* almacenamiento no disponible: los favoritos no persistirán */ }
  }

  function isFavorite(id) {
    return state.favorites.has(id);
  }

  function getFavoriteSongs() {
    return state.songs.filter((s) => state.favorites.has(s.id));
  }

  // ---------------------------------------------------------------------
  // "Ficha" de cada favorito (título, artista, portada, url de audio):
  // se guarda aparte del catálogo en vivo, para que si no hay internet y el
  // catálogo del Worker no carga, Favoritos igual pueda mostrarse y sonar
  // usando esta copia + el audio ya descargado en IndexedDB.
  // ---------------------------------------------------------------------
  const FAVORITES_META_KEY = 'lq-musica-surena-favoritos-meta';

  function loadFavoritesMeta() {
    try {
      const raw = localStorage.getItem(FAVORITES_META_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function saveFavoritesMeta(meta) {
    try { localStorage.setItem(FAVORITES_META_KEY, JSON.stringify(meta)); } catch (e) { /* sin almacenamiento disponible */ }
  }

  function snapshotFavoriteMeta(song) {
    if (!song) return;
    const meta = loadFavoritesMeta();
    meta[song.id] = {
      id: song.id, title: song.title, artist: song.artist,
      album: song.album, cover: song.cover, audioUrl: song.audioUrl
    };
    saveFavoritesMeta(meta);
  }

  function removeFavoriteMeta(id) {
    const meta = loadFavoritesMeta();
    delete meta[id];
    saveFavoritesMeta(meta);
  }

  function toggleFavorite(id) {
    if (state.favorites.has(id)) {
      state.favorites.delete(id);
      removeOfflineCopy(id); // libera el espacio guardado, en segundo plano
      removeFavoriteMeta(id);
    } else {
      state.favorites.add(id);
      snapshotFavoriteMeta(findSong(id)); // guarda su ficha para poder mostrarla sin catálogo en vivo
      downloadOfflineCopy(id); // guarda el audio para escucharlo sin internet, en segundo plano
    }
    saveFavorites();
    syncFavoriteButtons(id);
    renderHomeFavorites();
    if (currentView === 'favoritos') renderFavoritosView();
  }

  // Actualiza TODOS los corazones de esta canción en pantalla (puede aparecer
  // a la vez en "Recién agregado", resultados de búsqueda, detalle, etc.)
  function syncFavoriteButtons(id) {
    const active = isFavorite(id);
    document.querySelectorAll(`[data-action="toggle-favorite"][data-id="${cssEscape(id)}"]`).forEach((btn) => {
      btn.classList.toggle('active', active);
      btn.classList.remove('pulse');
      // Forzar reflow para poder relanzar la animación de "pulso" cada vez
      void btn.offsetWidth;
      btn.classList.add('pulse');
    });
  }

  // Los ids pueden incluir "/" y espacios (rutas de R2): los escapamos para usarlos en selectores CSS
  function cssEscape(str) {
    return String(str).replace(/["\\]/g, '\\$&');
  }

  function favBtnHTML(id) {
    const active = isFavorite(id) ? ' active' : '';
    return `<button class="fav-btn${active}" data-action="toggle-favorite" data-id="${id}" aria-label="Favorito">
      <svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 21s-6.7-4.35-9.5-8.28C.6 10.2 1.1 6.9 3.6 5.3c2.1-1.35 4.7-.85 6.1 1 .7.9 1.3 1.9 2.3 3.1 1-1.2 1.6-2.2 2.3-3.1 1.4-1.85 4-2.35 6.1-1 2.5 1.6 3 4.9 1.1 7.42C18.7 16.65 12 21 12 21z"/></svg>
    </button>`;
  }

  // ---------------------------------------------------------------------
  // Descargas offline de Favoritos
  // ---------------------------------------------------------------------
  // Al marcar ♥ se descarga el audio UNA sola vez y se guarda "disfrazado"
  // (bytes con XOR, no un .mp3 reconocible) dentro de IndexedDB, que es
  // almacenamiento privado de la app: no aparece en la galería/reproductor
  // nativo del teléfono ni en un explorador de archivos normal. Al reproducir,
  // si existe copia offline, se usa esa en vez de ir a la red.
  // No es "seguridad" real (eso requeriría DRM del lado del servidor), es
  // únicamente para que el archivo no quede suelto y reproducible por fuera
  // de LQ Música Sureña.
  const OFFLINE_DB_NAME = 'lq-musica-surena-offline';
  const OFFLINE_DB_VERSION = 1;
  const OFFLINE_STORE = 'tracks';
  const OBFUSCATION_KEY = [0x4c, 0x51, 0x53, 0x75, 0x72, 0x65, 0xc3, 0xb1, 0x61]; // bytes arbitrarios ("LQSureña")

  const offlineBlobUrls = new Map(); // id -> object URL ya listo para <audio src>
  const offlineDownloading = new Set(); // ids en descarga, para no duplicar pedidos

  function xorTransform(bufferOrView) {
    const bytesIn = bufferOrView instanceof Uint8Array ? bufferOrView : new Uint8Array(bufferOrView);
    const out = new Uint8Array(bytesIn.length);
    for (let i = 0; i < bytesIn.length; i++) {
      out[i] = bytesIn[i] ^ OBFUSCATION_KEY[i % OBFUSCATION_KEY.length];
    }
    return out;
  }

  function guessMimeFromUrl(url) {
    const ext = extOf(url.split('?')[0]);
    const map = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', aac: 'audio/aac' };
    return map[ext] || 'audio/mpeg';
  }

  function openOfflineDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('indexedDB no disponible')); return; }
      const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
          db.createObjectStore(OFFLINE_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function offlineDBPut(record) {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OFFLINE_STORE, 'readwrite');
      tx.objectStore(OFFLINE_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function offlineDBGet(id) {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OFFLINE_STORE, 'readonly');
      const req = tx.objectStore(OFFLINE_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function offlineDBDelete(id) {
    const db = await openOfflineDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(OFFLINE_STORE, 'readwrite');
      tx.objectStore(OFFLINE_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function buildBlobUrlFromRecord(record) {
    const decoded = xorTransform(record.data);
    const blob = new Blob([decoded], { type: record.mime || 'audio/mpeg' });
    return URL.createObjectURL(blob);
  }

  // Descarga el audio de una canción y la deja lista para sonar sin conexión.
  // Se llama en segundo plano al marcar favorito; no bloquea la interfaz.
  async function downloadOfflineCopy(id) {
    if (offlineBlobUrls.has(id) || offlineDownloading.has(id)) return;
    const song = findSong(id);
    if (!song) return;
    offlineDownloading.add(id);
    try {
      const res = await fetch(song.audioUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mime = res.headers.get('content-type') || guessMimeFromUrl(song.audioUrl);
      const buffer = await res.arrayBuffer();
      const obfuscated = xorTransform(buffer);
      await offlineDBPut({ id, mime, data: obfuscated, savedAt: Date.now() });
      offlineBlobUrls.set(id, buildBlobUrlFromRecord({ id, mime, data: obfuscated }));
    } catch (err) {
      console.warn('No se pudo guardar este tema para escucharlo sin conexión:', err);
    } finally {
      offlineDownloading.delete(id);
    }
  }

  // Borra la copia offline al quitar el favorito (libera espacio en el teléfono).
  async function removeOfflineCopy(id) {
    const url = offlineBlobUrls.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      offlineBlobUrls.delete(id);
    }
    try { await offlineDBDelete(id); } catch (err) { /* nada que borrar */ }
  }

  // Al abrir la app: por cada favorito ya guardado, deja su audio listo en
  // memoria (desde IndexedDB si ya existía, o descargándolo si es nuevo).
  // Corre en segundo plano, después de que el catálogo ya está en pantalla.
  async function ensureOfflineFavorites() {
    for (const id of Array.from(state.favorites)) {
      if (offlineBlobUrls.has(id)) continue;
      try {
        const record = await offlineDBGet(id);
        if (record) {
          offlineBlobUrls.set(id, buildBlobUrlFromRecord(record));
        } else {
          await downloadOfflineCopy(id);
        }
      } catch (err) { /* un favorito falló: seguimos con los demás */ }
    }
  }

  // Devuelve la URL que debe usar <audio>: la copia offline si existe, si no la de red.
  function playbackUrlFor(song) {
    return offlineBlobUrls.get(song.id) || song.audioUrl;
  }

  // Descarga TODAS las portadas del catálogo de una sola vez (no solo las que
  // se alcanzan a ver en pantalla), para que quede todo disponible sin
  // conexión desde la primera vez que se abre la app con internet. El Service
  // Worker intercepta estos fetch() igual que si fueran <img>, y los guarda
  // en su caché de imágenes.
  function prefetchAllCovers() {
    const urls = new Set();
    state.songs.forEach((s) => s.cover && urls.add(s.cover));
    state.agrupaciones.forEach((a) => a.cover && urls.add(a.cover));
    state.albumes.forEach((a) => a.cover && urls.add(a.cover));
    urls.forEach((url) => {
      if (url.startsWith('assets/')) return; // el logo local ya viene en el app shell
      // mode: 'no-cors' porque R2 no manda cabeceras CORS; así el navegador
      // no intenta validar origen y el Service Worker puede cachear la imagen.
      fetch(url, { mode: 'no-cors' }).catch(() => { /* sin conexión o falló: se reintentará en la próxima visita */ });
    });
  }

  // ---------------------------------------------------------------------
  // Cloudflare: listar carpetas/archivos en vivo vía el Worker
  // ---------------------------------------------------------------------
  async function workerList(prefix) {
    const url = `${window.LQ_CONFIG.WORKER_URL}/?prefix=${encodeURIComponent(prefix)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || `El Worker respondió ${res.status}`);
    }
    return res.json(); // { folders: [{name}], files: [{key,name,size}] }
  }

  function r2PublicUrl(key) {
    // Cada segmento de la ruta se codifica por separado para no romper las "/"
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `${window.LQ_CONFIG.PUBLIC_BUCKET_URL}/${encoded}`;
  }

  const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg', 'aac'];
  const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

  function extOf(filename) {
    const m = filename.match(/\.([a-zA-Z0-9]+)$/);
    return m ? m[1].toLowerCase() : '';
  }

  function stripExtension(filename) {
    return filename.replace(/\.[^/.]+$/, '');
  }

  // ---------------------------------------------------------------------
  // Carga de datos: recorre "Musica Sureña" > [Agrupación] > archivos
  // ---------------------------------------------------------------------
  async function loadSongs() {
    const cfg = window.LQ_CONFIG || {};
    if (!cfg.ROOT_PREFIX || !cfg.PUBLIC_BUCKET_URL || !cfg.WORKER_URL) {
      throw new Error('CONFIG_MISSING');
    }

    const root = await workerList(cfg.ROOT_PREFIX);
    const agrupacionFolders = root.folders || [];

    // Se piden TODAS las agrupaciones a la vez (en paralelo), no una por una.
    // Con internet carga varias veces más rápido; sin internet, cada una
    // falla casi al instante (no se van sumando esperas) y cae a la caché.
    const perFolderLists = await Promise.all(
      agrupacionFolders.map(async (folder) => {
        const folderPrefix = `${cfg.ROOT_PREFIX}${folder.name}/`;
        try {
          const listing = await workerList(folderPrefix);
          return { folder, files: listing.files || [] };
        } catch (err) {
          // Una agrupación falló (ni red ni caché la tenían): seguimos con las demás.
          console.warn(`No se pudo cargar "${folder.name}":`, err);
          return { folder, files: [] };
        }
      })
    );

    const songs = [];
    perFolderLists.forEach(({ folder, files }) => {
      const audioFiles = files.filter((f) => AUDIO_EXT.includes(extOf(f.name)));
      const imageFile = files.find((f) => IMAGE_EXT.includes(extOf(f.name)));
      const cover = imageFile ? r2PublicUrl(imageFile.key) : 'assets/logo.png';

      audioFiles.forEach((f) => {
        songs.push({
          id: f.key,
          title: stripExtension(f.name),
          artist: folder.name,
          album: folder.name,
          cover: cover,
          audioUrl: r2PublicUrl(f.key),
          duration: 0,
          uploadedAt: f.uploaded || null
        });
      });
    });

    state.songs = songs;

    // El catálogo en vivo cargó bien: aprovechamos para refrescar la "ficha"
    // de cada favorito (por si cambió el título o la portada en R2).
    if (state.favorites && state.favorites.size) {
      const meta = loadFavoritesMeta();
      state.favorites.forEach((id) => {
        const song = songs.find((s) => s.id === id);
        if (song) {
          meta[id] = {
            id: song.id, title: song.title, artist: song.artist,
            album: song.album, cover: song.cover, audioUrl: song.audioUrl
          };
        }
      });
      saveFavoritesMeta(meta);
    }

    // Derivar agrupaciones únicas
    const artistMap = new Map();
    songs.forEach((s) => {
      if (!artistMap.has(s.artist)) {
        artistMap.set(s.artist, { name: s.artist, cover: s.cover, count: 0 });
      }
      artistMap.get(s.artist).count++;
    });
    state.agrupaciones = Array.from(artistMap.values());

    // Derivar álbumes únicos (por ahora, 1 álbum = 1 agrupación)
    const albumMap = new Map();
    songs.forEach((s) => {
      if (!albumMap.has(s.album)) {
        albumMap.set(s.album, { name: s.album, artist: s.artist, cover: s.cover, songIds: [] });
      }
      albumMap.get(s.album).songIds.push(s.id);
    });
    state.albumes = Array.from(albumMap.values());
  }

  // ---------------------------------------------------------------------
  // Reproductor de audio + MediaSession API
  // ---------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // Precarga del siguiente tema, para que el cambio de pista no tenga
  // el bache de silencio típico mientras el navegador vuelve a bufferizar.
  // -----------------------------------------------------------------------
  function computeNextIndex(fromIndex) {
    if (state.queue.length < 2) return null;
    if (state.shuffle && state.queue.length > 1) {
      let next;
      do { next = Math.floor(Math.random() * state.queue.length); } while (next === fromIndex);
      return next;
    }
    return (fromIndex + 1) % state.queue.length;
  }

  function scheduleGaplessPreload(fromIndex) {
    const nextIndex = computeNextIndex(fromIndex);
    state.nextQueueIndex = nextIndex;
    if (nextIndex === null) return;
    const nextSong = findSong(state.queue[nextIndex]);
    if (!nextSong) return;
    if (preloadEl.dataset.songId === nextSong.id) return; // ya precargado, no repetir
    preloadEl.dataset.songId = nextSong.id;
    preloadEl.src = playbackUrlFor(nextSong);
    preloadEl.load(); // el navegador empieza a bufferizarlo en segundo plano
  }

  function playQueue(ids, startIndex, fromAleatorio) {
    if (!fromAleatorio) state.aleatorioActive = false; // salir de la mezcla aleatoria si se elige otra cosa
    state.queue = ids;
    state.queueIndex = startIndex;
    playSongAtQueueIndex(startIndex);
  }

  function playSongAtQueueIndex(index) {
    const id = state.queue[index];
    const song = findSong(id);
    if (!song) return;

    // Cualquier sello superpuesto que siga sonando de la canción anterior se corta aquí,
    // y el volumen vuelve a la normalidad antes de arrancar el siguiente tema.
    stopStampOverlay();

    state.queueIndex = index;
    state.currentSong = song;
    state.stampTriggered = false;
    state.stampDueForCurrent =
      state.aleatorioActive &&
      index < state.queue.length - 1 && // no tiene sentido en la última canción de la mezcla
      state.songsSinceStamp + 1 >= (window.LQ_CONFIG?.STAMP_INTERVAL || 2);

    audio.src = playbackUrlFor(song); // usa la copia offline si ya está descargada
    audio.play().then(() => {
      state.isPlaying = true;
      updatePlayIcons();
    }).catch(() => {
      state.isPlaying = false;
      updatePlayIcons();
    });
    updateNowPlayingUI();
    updateMediaSession();
    showPlayers();
    scheduleGaplessPreload(index);

    if (state.aleatorioActive) {
      if (state.stampDueForCurrent) {
        state.songsSinceStamp = 0; // se reinicia: el sello está por sonar en este tema
      } else {
        state.songsSinceStamp += 1;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Sello "LQ Producciones" superpuesto sobre el final de la canción
  // -----------------------------------------------------------------------
  function fadeAudioVolume(el, target, durationMs) {
    if (stampFadeTimer) clearInterval(stampFadeTimer);
    const start = el.volume;
    const diff = target - start;
    if (Math.abs(diff) < 0.01 || durationMs <= 0) {
      el.volume = Math.max(0, Math.min(1, target));
      return;
    }
    const steps = 14;
    const stepMs = durationMs / steps;
    let i = 0;
    stampFadeTimer = setInterval(() => {
      i++;
      el.volume = Math.max(0, Math.min(1, start + diff * (i / steps)));
      if (i >= steps) {
        clearInterval(stampFadeTimer);
        stampFadeTimer = null;
      }
    }, stepMs);
  }

  function triggerStampOverlay() {
    const cfg = window.LQ_CONFIG || {};
    if (!cfg.STAMP_AUDIO_URL || state.stampTriggered) return;
    state.stampTriggered = true;

    // Agacha el volumen de la canción (no la pausa: sigue sonando de fondo, bajita).
    state.stampPrevVolume = audio.volume;
    fadeAudioVolume(audio, cfg.STAMP_DUCK_VOLUME ?? 0.25, cfg.STAMP_FADE_MS ?? 350);

    // El sello se reproduce en un <audio> aparte, así suena ENCIMA de la canción.
    if (!stampAudioEl) stampAudioEl = new Audio();
    stampAudioEl.src = cfg.STAMP_AUDIO_URL;
    stampAudioEl.volume = 1;
    stampAudioEl.currentTime = 0;
    stampAudioEl.onended = restoreVolumeAfterStamp;
    stampAudioEl.play().catch(() => { /* si el navegador lo bloquea, seguimos sin el sello */ });
  }

  function restoreVolumeAfterStamp() {
    if (state.stampPrevVolume !== null) {
      fadeAudioVolume(audio, state.stampPrevVolume, (window.LQ_CONFIG || {}).STAMP_FADE_MS ?? 350);
      state.stampPrevVolume = null;
    }
  }

  function stopStampOverlay() {
    if (stampFadeTimer) { clearInterval(stampFadeTimer); stampFadeTimer = null; }
    if (stampAudioEl) {
      stampAudioEl.onended = null;
      stampAudioEl.pause();
    }
    if (state.stampPrevVolume !== null) {
      audio.volume = state.stampPrevVolume; // restaura de golpe, sin fundido, al cambiar de tema
      state.stampPrevVolume = null;
    }
  }

  function togglePlayPause() {
    if (!state.currentSong) return;
    if (audio.paused) {
      audio.play();
      state.isPlaying = true;
    } else {
      audio.pause();
      state.isPlaying = false;
    }
    updatePlayIcons();
  }

  function playNext() {
    if (state.queue.length === 0) return;
    let next;
    if (state.nextQueueIndex !== null && state.nextQueueIndex !== undefined) {
      // Ya lo precargamos mientras sonaba la canción anterior: se usa directo.
      next = state.nextQueueIndex;
    } else if (state.shuffle && state.queue.length > 1) {
      do {
        next = Math.floor(Math.random() * state.queue.length);
      } while (next === state.queueIndex);
    } else {
      next = (state.queueIndex + 1) % state.queue.length;
    }
    playSongAtQueueIndex(next);
  }

  function playPrev() {
    if (state.queue.length === 0) return;
    // Si llevamos más de 3s de la canción, reinicia en vez de retroceder
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    const prev = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
    playSongAtQueueIndex(prev);
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !state.currentSong) return;
    const song = state.currentSong;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist,
      album: song.album,
      artwork: [
        { src: song.cover, sizes: '400x400', type: 'image/jpeg' },
        { src: song.cover, sizes: '96x96', type: 'image/jpeg' }
      ]
    });
    navigator.mediaSession.setActionHandler('play', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('pause', () => togglePlayPause());
    navigator.mediaSession.setActionHandler('previoustrack', () => playPrev());
    navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) audio.currentTime = details.seekTime;
    });
  }

  function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startAleatorio() {
    if (state.songs.length === 0) return;
    const shuffledIds = shuffleArray(state.songs.map((s) => s.id));

    state.shuffle = false;
    dom.shuffleBtn.classList.remove('active');

    // El sello ya no es una pista aparte en la cola: se activa el modo "aleatorio"
    // y el sello se superpone automáticamente cerca del final de cada N-ésima canción
    // (ver triggerStampOverlay, disparado desde el evento 'timeupdate' del audio).
    state.aleatorioActive = true;
    state.songsSinceStamp = 0;
    playQueue(shuffledIds, 0, true);
  }

  document.getElementById('aleatorioBtn').addEventListener('click', startAleatorio);

  function updatePlaybackState() {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
    }
  }

  // ---------------------------------------------------------------------
  // Eventos del elemento <audio>
  // ---------------------------------------------------------------------
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;

    // ¿Toca superponer el sello LQ Producciones antes de que termine esta canción?
    if (state.stampDueForCurrent && !state.stampTriggered && isFinite(audio.duration)) {
      const cfg = window.LQ_CONFIG || {};
      const lead = cfg.STAMP_LEAD_SECONDS ?? 4;
      if (audio.duration - audio.currentTime <= lead) {
        triggerStampOverlay();
      }
    }

    const pct = (audio.currentTime / audio.duration) * 100;
    dom.seekBar.value = pct;
    dom.seekBar.style.setProperty('--seek-progress', pct + '%');
    dom.miniProgressFill.style.width = pct + '%';
    dom.timeElapsed.textContent = formatTime(audio.currentTime);
    dom.timeRemaining.textContent = '-' + formatTime(audio.duration - audio.currentTime);
    if ('mediaSession' in navigator && audio.duration) {
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: audio.currentTime
        });
      } catch (e) { /* algunos WebView antiguos no soportan setPositionState */ }
    }
  });

  audio.addEventListener('ended', playNext);
  audio.addEventListener('play', () => { state.isPlaying = true; updatePlayIcons(); updatePlaybackState(); });
  audio.addEventListener('pause', () => { state.isPlaying = false; updatePlayIcons(); updatePlaybackState(); });

  // ---------------------------------------------------------------------
  // Referencias DOM
  // ---------------------------------------------------------------------
  const dom = {
    quickGrid: document.getElementById('quickGrid'),
    recentRow: document.getElementById('recentRow'),
    artistsRow: document.getElementById('artistsRow'),
    albumsRow: document.getElementById('albumsRow'),
    exploreGrid: document.getElementById('exploreGrid'),
    exploreTabs: document.getElementById('exploreTabs'),
    searchResults: document.getElementById('searchResults'),

    homeFavoritesSection: document.getElementById('homeFavoritesSection'),
    favoritesRow: document.getElementById('favoritesRow'),
    favoritosGrid: document.getElementById('favoritosGrid'),
    playAllFavoritesBtn: document.getElementById('playAllFavoritesBtn'),

    detailBack: document.getElementById('detailBack'),
    detailCover: document.getElementById('detailCover'),
    detailKicker: document.getElementById('detailKicker'),
    detailTitle: document.getElementById('detailTitle'),
    detailSubtitle: document.getElementById('detailSubtitle'),
    trackList: document.getElementById('trackList'),
    playAllBtn: document.getElementById('playAllBtn'),

    miniPlayer: document.getElementById('miniPlayer'),
    miniCover: document.getElementById('miniCover'),
    miniTitle: document.getElementById('miniTitle'),
    miniArtist: document.getElementById('miniArtist'),
    miniPlayPause: document.getElementById('miniPlayPause'),
    miniPlayIcon: document.getElementById('miniPlayIcon'),
    miniProgressFill: document.getElementById('miniProgressFill'),

    fullPlayer: document.getElementById('fullPlayer'),
    fullCover: document.getElementById('fullCover'),
    fullTitle: document.getElementById('fullTitle'),
    fullArtist: document.getElementById('fullArtist'),
    fullFavBtn: document.getElementById('fullFavBtn'),
    fullPlayPause: document.getElementById('fullPlayPause'),
    fullPlayIcon: document.getElementById('fullPlayIcon'),
    seekBar: document.getElementById('seekBar'),
    timeElapsed: document.getElementById('timeElapsed'),
    timeRemaining: document.getElementById('timeRemaining'),
    collapsePlayer: document.getElementById('collapsePlayer'),
    shuffleBtn: document.getElementById('shuffleBtn'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),

    bottomNav: document.getElementById('bottomNav'),
    searchToggle: document.getElementById('searchToggle'),
    searchInput: document.getElementById('searchInput')
  };

  // ---------------------------------------------------------------------
  // Render: tarjetas reutilizables
  // ---------------------------------------------------------------------
  function songCardHTML(song) {
    return `<div class="card" data-action="play-song" data-id="${song.id}">
      ${favBtnHTML(song.id)}
      <img src="${song.cover}" alt="${song.title}" loading="lazy" />
      <div class="card-title">${song.title}</div>
      <div class="card-sub">${song.artist}</div>
    </div>`;
  }

  function artistCardHTML(artist) {
    return `<div class="card" data-action="open-agrupacion" data-name="${artist.name}">
      <img src="${artist.cover}" alt="${artist.name}" loading="lazy" />
      <div class="card-title">${artist.name}</div>
      <div class="card-sub">${artist.count} tema${artist.count > 1 ? 's' : ''}</div>
    </div>`;
  }

  function albumCardHTML(album) {
    return `<div class="card" data-action="open-album" data-name="${album.name}">
      <img src="${album.cover}" alt="${album.name}" loading="lazy" />
      <div class="card-title">${album.name}</div>
      <div class="card-sub">${album.artist}</div>
    </div>`;
  }

  // ---------------------------------------------------------------------
  // Render: vista Inicio
  // ---------------------------------------------------------------------
  function renderGreeting() {
    const hour = new Date().getHours();
    let text = 'Buenas tardes';
    if (hour < 12) text = 'Buenos días';
    else if (hour >= 19) text = 'Buenas noches';
    const el = document.getElementById('greeting');
    if (el) el.textContent = text;
  }

  // Elige `count` canciones al azar de `pool`, evitando repetir agrupación
  // mientras se pueda, para que "Recién agregado" no quede copado por un
  // solo artista aunque haya subido varios temas juntos.
  function pickVariedSample(pool, count) {
    const shuffled = shuffleArray(pool);
    const result = [];
    const usedArtists = new Set();
    for (const song of shuffled) {
      if (result.length >= count) break;
      if (usedArtists.has(song.artist)) continue;
      usedArtists.add(song.artist);
      result.push(song);
    }
    // Si no alcanzan agrupaciones distintas para completar el cupo,
    // rellenamos con lo que quede (aunque se repita alguna).
    if (result.length < count) {
      for (const song of shuffled) {
        if (result.length >= count) break;
        if (!result.includes(song)) result.push(song);
      }
    }
    return result;
  }

  function renderHome() {
    renderGreeting();

    // "Recién agregado": partimos de las canciones subidas más recientemente
    // según R2, y de esa cantera elegimos al azar sin repetir agrupación, así
    // no queda siempre el mismo artista y además varía en cada reinicio.
    const byRecent = [...state.songs].sort((a, b) => {
      const da = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
      const db = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
      return db - da;
    });
    const recentPool = byRecent.slice(0, 24);
    const recent = pickVariedSample(recentPool, 6);

    const topArtists = shuffleArray(state.agrupaciones).slice(0, 8);
    const albums = state.albumes.slice(0, 8);

    dom.quickGrid.innerHTML = topArtists.slice(0, 4).map((a) => `
      <div class="quick-card" data-action="open-agrupacion" data-name="${a.name}">
        <img src="${a.cover}" alt="${a.name}" />
        <span>${a.name}</span>
      </div>`).join('');

    dom.recentRow.innerHTML = recent.map(songCardHTML).join('');
    dom.artistsRow.innerHTML = topArtists.map(artistCardHTML).join('');
    dom.albumsRow.innerHTML = albums.map(albumCardHTML).join('');
  }

  function renderHomeFavorites() {
    const favSongs = getFavoriteSongs();
    dom.homeFavoritesSection.hidden = favSongs.length === 0;
    dom.favoritesRow.innerHTML = favSongs.map(songCardHTML).join('');
  }

  function renderFavoritosView() {
    const favSongs = getFavoriteSongs();
    dom.favoritosGrid._ids = favSongs.map((s) => s.id);
    dom.favoritosGrid.innerHTML = favSongs.length
      ? favSongs.map(songCardHTML).join('')
      : `<p class="empty-state">Toca el corazón ♥ de cualquier tema para agregarlo aquí.</p>`;
    dom.playAllFavoritesBtn.hidden = favSongs.length === 0;
  }

  // ---------------------------------------------------------------------
  // Render: vista Explorar
  // ---------------------------------------------------------------------
  let exploreFilter = 'agrupacion';

  function renderExplore() {
    dom.exploreGrid.classList.toggle('agrupacion', exploreFilter === 'agrupacion');
    let html = '';
    if (exploreFilter === 'agrupacion') {
      html = state.agrupaciones.map(artistCardHTML).join('');
    } else if (exploreFilter === 'album') {
      html = state.albumes.map(albumCardHTML).join('');
    } else {
      // "playlist" reutiliza álbumes como listas de reproducción de ejemplo
      html = state.albumes.map(albumCardHTML).join('');
    }
    dom.exploreGrid.innerHTML = html || `<p class="empty-state">Nada por aquí todavía.</p>`;
  }

  dom.exploreTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    dom.exploreTabs.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    exploreFilter = btn.dataset.filter;
    renderExplore();
  });

  // ---------------------------------------------------------------------
  // Render: vista Detalle (álbum / agrupación)
  // ---------------------------------------------------------------------
  function openAlbum(name) {
    const album = state.albumes.find((a) => a.name === name);
    if (!album) return;
    state.detailContext = { type: 'album', key: name };
    dom.detailKicker.textContent = 'Álbum';
    dom.detailCover.src = album.cover;
    dom.detailTitle.textContent = album.name;
    dom.detailSubtitle.textContent = `${album.artist} · ${album.songIds.length} tema${album.songIds.length > 1 ? 's' : ''}`;
    renderTrackList(album.songIds);
    goToView('detail');
  }

  function openAgrupacion(name) {
    const songs = state.songs.filter((s) => s.artist === name);
    if (songs.length === 0) return;
    state.detailContext = { type: 'agrupacion', key: name };
    dom.detailKicker.textContent = 'Agrupación';
    dom.detailCover.src = songs[0].cover;
    dom.detailTitle.textContent = name;
    dom.detailSubtitle.textContent = `${songs.length} tema${songs.length > 1 ? 's' : ''}`;
    renderTrackList(songs.map((s) => s.id));
    goToView('detail');
  }

  function renderTrackList(ids) {
    dom.trackList.innerHTML = ids.map((id, i) => {
      const s = findSong(id);
      const playing = state.currentSong && state.currentSong.id === id;
      return `<li class="track-row${playing ? ' playing' : ''}" data-action="play-from-list" data-id="${id}" data-index="${i}">
        <span class="track-num">${playing ? '♪' : i + 1}</span>
        <div class="track-info">
          <div class="track-name">${s.title}</div>
          <div class="track-artist">${s.artist}</div>
        </div>
        <span class="track-dur">${formatTime(s.duration)}</span>
        ${favBtnHTML(s.id)}
      </li>`;
    }).join('');
    dom.trackList._ids = ids; // guardamos la cola asociada a esta lista
  }

  dom.playAllBtn.addEventListener('click', () => {
    const ids = dom.trackList._ids || [];
    if (ids.length) playQueue(ids, 0);
  });

  dom.detailBack.addEventListener('click', () => history.back());

  // ---------------------------------------------------------------------
  // Búsqueda
  // ---------------------------------------------------------------------
  function runSearch(query) {
    const q = normalize(query.trim());
    if (!q) {
      dom.searchResults.innerHTML = `<p class="empty-state">Escribe para buscar una agrupación, álbum o tema.</p>`;
      return;
    }
    const songMatches = state.songs.filter((s) =>
      normalize(s.title).includes(q) || normalize(s.artist).includes(q) || normalize(s.album).includes(q)
    );
    if (songMatches.length === 0) {
      dom.searchResults.innerHTML = `<p class="empty-state">Sin resultados para "${query}".</p>`;
      return;
    }
    dom.searchResults.innerHTML = songMatches.map(songCardHTML).join('');
  }

  dom.searchToggle.addEventListener('click', () => {
    goToView('search');
    dom.searchInput.focus();
  });

  // El acceso a Favoritos ahora vive en la barra inferior (ver dom.bottomNav más abajo).

  dom.playAllFavoritesBtn.addEventListener('click', () => {
    const ids = dom.favoritosGrid._ids || [];
    if (ids.length) playQueue(ids, 0);
  });

  dom.searchInput.addEventListener('input', () => {
    runSearch(dom.searchInput.value);
  });

  // ---------------------------------------------------------------------
  // Navegación entre vistas
  // ---------------------------------------------------------------------
  let currentView = 'home';
  let lastListView = 'home'; // recuerda de dónde venimos al entrar a "detail"

  function goToView(name, opts) {
    opts = opts || {};
    if (name !== 'detail' && name !== 'search') lastListView = name;
    document.querySelectorAll('.view').forEach((v) => {
      v.hidden = v.dataset.view !== name;
    });
    document.querySelectorAll('.nav-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === name);
    });
    currentView = name;
    window.scrollTo(0, 0);

    // Registramos el cambio en el historial (salvo que venga del botón atrás
    // del teléfono, o de la carga inicial) para que "atrás" retroceda de a
    // un paso en vez de salir de la app de una sola vez.
    if (!opts.skipHistory) {
      history.pushState({ view: name, playerOpen: dom.fullPlayer.classList.contains('open') }, '');
    }
  }

  // ---------------------------------------------------------------------
  // Botón "atrás" del teléfono / navegador: navegación progresiva
  // ---------------------------------------------------------------------
  // Estado inicial, para que el primer "atrás" tenga algo contra qué comparar.
  history.replaceState({ view: currentView, playerOpen: false }, '');

  window.addEventListener('popstate', (e) => {
    const state = e.state || { view: 'home', playerOpen: false };

    if (state.playerOpen) {
      dom.fullPlayer.classList.add('open');
    } else {
      dom.fullPlayer.classList.remove('open');
    }

    if (state.view && state.view !== currentView) {
      goToView(state.view, { skipHistory: true });
    }
  });

  dom.bottomNav.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (!btn) return;
    goToView(btn.dataset.view);
    if (btn.dataset.view === 'search') dom.searchInput.focus();
    if (btn.dataset.view === 'aleatorio') startAleatorio();
    if (btn.dataset.view === 'favoritos') renderFavoritosView();
  });

  // ---------------------------------------------------------------------
  // Delegación de eventos: clicks en tarjetas de canción/álbum/agrupación
  // ---------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;

    if (action === 'toggle-favorite') {
      e.stopPropagation();
      toggleFavorite(target.dataset.id);
      return;
    }

    if (action === 'play-song') {
      const id = target.dataset.id;
      const allIds = state.songs.map((s) => s.id);
      playQueue(allIds, allIds.indexOf(id));
    } else if (action === 'open-album') {
      openAlbum(target.dataset.name);
    } else if (action === 'open-agrupacion') {
      openAgrupacion(target.dataset.name);
    } else if (action === 'play-from-list') {
      const ids = dom.trackList._ids || [];
      const index = parseInt(target.dataset.index, 10);
      playQueue(ids, index);
      renderTrackList(ids); // refresca el indicador "reproduciendo"
    }
  });

  // ---------------------------------------------------------------------
  // Controles del reproductor (mini + full)
  // ---------------------------------------------------------------------
  function updatePlayIcons() {
    const playSvg = `<path fill="currentColor" d="M8 5v14l11-7z"/>`;
    const pauseSvg = `<path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/>`;
    dom.miniPlayIcon.innerHTML = state.isPlaying ? pauseSvg : playSvg;
    dom.fullPlayIcon.innerHTML = state.isPlaying ? pauseSvg : playSvg;
  }

  function updateNowPlayingUI() {
    const s = state.currentSong;
    if (!s) return;
    dom.miniCover.src = s.cover;
    dom.miniTitle.textContent = s.title;
    dom.miniArtist.textContent = s.artist;
    dom.fullCover.src = s.cover;
    dom.fullTitle.textContent = s.title;
    dom.fullArtist.textContent = s.artist;
    dom.fullFavBtn.dataset.id = s.id;
    dom.fullFavBtn.classList.toggle('active', isFavorite(s.id));
    dom.seekBar.value = 0;
    dom.seekBar.style.setProperty('--seek-progress', '0%');
  }

  function showPlayers() {
    dom.miniPlayer.hidden = false;
  }

  dom.miniPlayPause.addEventListener('click', (e) => { e.stopPropagation(); togglePlayPause(); });
  dom.fullPlayPause.addEventListener('click', togglePlayPause);
  dom.prevBtn.addEventListener('click', playPrev);
  dom.nextBtn.addEventListener('click', playNext);

  dom.shuffleBtn.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    dom.shuffleBtn.classList.toggle('active', state.shuffle);
  });

  dom.miniPlayer.addEventListener('click', (e) => {
    if (e.target.closest('#miniPlayPause')) return;
    dom.fullPlayer.classList.add('open');
    history.pushState({ view: currentView, playerOpen: true }, '');
  });
  dom.collapsePlayer.addEventListener('click', () => {
    if (dom.fullPlayer.classList.contains('open')) history.back();
  });

  dom.seekBar.addEventListener('input', () => {
    dom.seekBar.style.setProperty('--seek-progress', dom.seekBar.value + '%');
    if (!audio.duration) return;
    audio.currentTime = (dom.seekBar.value / 100) * audio.duration;
  });

  // ---------------------------------------------------------------------
  // Inicialización
  // ---------------------------------------------------------------------
  async function init() {
    loadFavorites();
    dom.recentRow.innerHTML = `<p class="empty-state">Cargando…</p>`;

    let catalogOk = false;
    try {
      await loadSongs();
      catalogOk = true;
    } catch (err) {
      console.error('LQ MÚSICA SUREÑA — error al cargar el catálogo:', err);

      // Sin catálogo en vivo (típicamente: sin conexión): reconstruimos al
      // menos los favoritos ya descargados, usando la ficha que se guardó de
      // cada uno al marcarlos, para que Favoritos siga funcionando offline.
      const meta = loadFavoritesMeta();
      state.songs = Array.from(state.favorites).map((id) => meta[id]).filter(Boolean);
      state.agrupaciones = [];
      state.albumes = [];

      let msg = 'No se pudo cargar el catálogo completo. Revisa tu conexión.';
      if (err.message === 'CONFIG_MISSING') {
        msg = 'Falta configurar Cloudflare: revisa ROOT_PREFIX, PUBLIC_BUCKET_URL y WORKER_URL en js/config.js.';
      } else if (state.songs.length) {
        msg = 'Sin conexión: no se pudo traer el catálogo completo, pero tus favoritos descargados sí están disponibles (pestaña Favoritos).';
      } else if (err.message) {
        msg = `Error al cargar el catálogo: ${err.message}`;
      }
      dom.recentRow.innerHTML = '';
      dom.artistsRow.innerHTML = '';
      dom.albumsRow.innerHTML = '';
      dom.quickGrid.innerHTML = `<p class="empty-state">${msg}</p>`;
    }

    // Red de seguridad: cualquier favorito que no haya quedado en el catálogo
    // recién cargado (por ejemplo, esa agrupación en particular falló al
    // traerse) se completa con su "ficha" guardada, para que Favoritos nunca
    // se quede sin mostrar algo que ya se había descargado antes.
    if (state.favorites.size > 0) {
      const meta = loadFavoritesMeta();
      state.favorites.forEach((id) => {
        if (!state.songs.some((s) => s.id === id) && meta[id]) {
          state.songs.push(meta[id]);
        }
      });
    }

    if (catalogOk) {
      renderHome();
      renderExplore();
      runSearch('');
    }
    renderHomeFavorites();
    if (currentView === 'favoritos') renderFavoritosView();
    goToView(currentView, { skipHistory: true });

    // Esto corre SIEMPRE, haya o no catálogo en vivo: solo lee IndexedDB
    // (ya descargado antes), así que funciona perfecto sin conexión y es lo
    // que deja el audio de los favoritos realmente listo para sonar offline.
    ensureOfflineFavorites();

    if (catalogOk) {
      prefetchAllCovers(); // sin "await": deja TODOS los íconos listos para offline
    }
  }

  document.getElementById('refreshBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('spinning');
    // Refrescar es la única acción que "olvida" las portadas guardadas,
    // por si algún artista cambió de foto. El resto del tiempo no se tocan.
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_IMAGE_CACHE' });
    }
    await init();
    btn.classList.remove('spinning');
  });

  init();
})();
