/* =========================================================================
   LQ Música Sureña — config.js
   Configuración de Cloudflare R2 (almacenamiento) + Worker (listado en vivo).
   ========================================================================= */

window.LQ_CONFIG = {
  // Carpeta raíz dentro del bucket (tal cual está escrita en R2, con tildes exactas).
  ROOT_PREFIX: 'Musica Sureña/',

  // URL pública del bucket R2 (Ajustes → URL de Desarrollo Público).
  PUBLIC_BUCKET_URL: 'https://pub-f6447b6d6fc5410586efec4c7dd0f894.r2.dev',

  // URL del Worker que lista el contenido del bucket.
  WORKER_URL: 'https://fragrant-boat-9648.djluiz-kandela.workers.dev',

  // Sello de audio "LQ Producciones" que suena DENTRO de la mezcla Aleatoria,
  // superpuesto sobre el final de la canción (no como pista aparte).
  STAMP_AUDIO_URL: 'https://pub-f6447b6d6fc5410586efec4c7dd0f894.r2.dev/sello/SELLO%20LQ%20PRODUCCIONES%20.wav',

  // Cada cuántas canciones suena el sello (2 = suena hacia el final de la 2ª, 4ª, 6ª... canción).
  STAMP_INTERVAL: 2,

  // Cuántos segundos antes de que termine la canción entra el sello, superpuesto.
  STAMP_LEAD_SECONDS: 4,

  // A qué volumen se agacha ("duck") la canción mientras suena el sello encima (0 a 1).
  STAMP_DUCK_VOLUME: 0.25,

  // Duración del fundido (fade) al agachar/restaurar el volumen, en milisegundos.
  STAMP_FADE_MS: 350
};
