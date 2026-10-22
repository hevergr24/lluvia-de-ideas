const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
// Revisa el protocolo y host originales al desplegar detrás de un proxy HTTPS.
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const UPLOADS = path.join(PUBLIC, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', express.static(UPLOADS, { maxAge: '1d' }));
app.use(express.static(PUBLIC, { index: false }));

const db = new Database(process.env.DB_PATH || path.join(ROOT, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS codes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'unused',
 created_at TEXT NOT NULL, used_at TEXT, client_name TEXT, redemption_token TEXT
);
CREATE TABLE IF NOT EXISTS songs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, code_id INTEGER NOT NULL UNIQUE,
 client_name TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL, message TEXT NOT NULL,
 cover_path TEXT NOT NULL, audio_path TEXT NOT NULL, audio_type TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(code_id) REFERENCES codes(id)
);
`);
const setting = key => db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
if (!setting('admin_salt') || !setting('admin_hash')) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(process.env.ADMIN_PASSWORD || 'melodia2026', salt, 64).toString('hex');
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('admin_salt', salt);
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('admin_hash', hash);
}
if (!db.prepare('SELECT id FROM codes LIMIT 1').get()) {
  db.prepare('INSERT INTO codes(code,status,created_at) VALUES (?,?,?)').run('MELODIA-DEMO-2026', 'unused', new Date().toISOString());
}

const sessions = new Set();
const authTokens = new Set();
const scrypt = (password, salt) => crypto.scryptSync(password, salt, 64);
function adminOnly(req, res, next) {
  const token = req.headers.cookie?.match(/(?:^|; )mmx_admin=([^;]+)/)?.[1];
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  next();
}
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chunk = () => Array.from(crypto.randomBytes(4), b => alphabet[b % alphabet.length]).join('');
  return `MELODIA-${chunk()}-${chunk()}`;
}
function uniqueSlug() {
  let slug;
  do { slug = crypto.randomBytes(4).toString('hex'); }
  while (db.prepare('SELECT id FROM songs WHERE slug=?').get(slug));
  return slug;
}
const dateNow = () => new Date().toISOString();

app.post('/api/admin/login', (req, res) => {
  const pass = String(req.body.password || '');
  const salt = setting('admin_salt');
  const actual = scrypt(pass, salt);
  const expected = Buffer.from(setting('admin_hash'), 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.status(401).json({ error: 'La contraseña no coincide.' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  res.setHeader('Set-Cookie', `mmx_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', adminOnly, (req, res) => {
  const token = req.headers.cookie?.match(/(?:^|; )mmx_admin=([^;]+)/)?.[1];
  sessions.delete(token);
  res.setHeader('Set-Cookie', 'mmx_admin=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/admin/codes', adminOnly, (req, res) => {
  const rows = db.prepare(`SELECT c.code,c.status,c.created_at,c.used_at,c.client_name,s.slug FROM codes c LEFT JOIN songs s ON s.code_id=c.id ORDER BY c.id DESC`).all();
  res.json(rows);
});
app.post('/api/admin/codes', adminOnly, (req, res) => {
  const count = Number(req.body.count);
  if (!Number.isInteger(count) || count < 1 || count > 500) return res.status(400).json({ error: 'Elige una cantidad entre 1 y 500.' });
  const add = db.prepare('INSERT INTO codes(code,status,created_at) VALUES (?,?,?)');
  const codes = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      let code;
      do { code = makeCode(); } while (db.prepare('SELECT id FROM codes WHERE code=?').get(code));
      add.run(code, 'unused', dateNow()); codes.push(code);
    }
  });
  tx(); res.json({ codes });
});
app.post('/api/admin/codes/deactivate', adminOnly, (req, res) => {
  const code = String(req.body.code || '');
  const result = db.prepare("UPDATE codes SET status='deactivated' WHERE code=? AND status='unused'").run(code);
  if (!result.changes) return res.status(409).json({ error: 'Este código no existe o ya fue utilizado/desactivado.' });
  res.json({ ok: true });
});
app.get('/api/admin/codes.csv', adminOnly, (req, res) => {
  const rows = db.prepare('SELECT code,status,created_at,used_at,client_name FROM codes ORDER BY id DESC').all();
  const esc = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const csv = ['codigo,estado,fecha_creacion,fecha_uso,nombre_cliente', ...rows.map(r => [r.code,r.status,r.created_at,r.used_at,r.client_name].map(esc).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="codigos-mi-melodia.csv"'); res.send('\ufeff' + csv);
});

app.post('/api/redeem', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const clientName = String(req.body.clientName || '').trim().slice(0, 100);
  if (!clientName) return res.status(400).json({ error: 'Escribe tu nombre para personalizar la entrega.' });
  const row = db.prepare("SELECT id,status FROM codes WHERE code=?").get(code);
  if (!row) return res.status(404).json({ error: 'No encontramos ese código. Revisa que esté bien escrito.' });
  if (row.status !== 'unused') return res.status(409).json({ error: row.status === 'used' ? 'Este código ya fue utilizado.' : 'Este código está desactivado.' });
  const token = crypto.randomBytes(32).toString('hex');
  const result = db.prepare("UPDATE codes SET status='used',used_at=?,client_name=?,redemption_token=? WHERE id=? AND status='unused'").run(dateNow(), clientName, token, row.id);
  if (!result.changes) return res.status(409).json({ error: 'Este código ya fue utilizado.' });
  authTokens.add(token);
  res.json({ redemptionToken: token });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS),
  filename: (req, file, cb) => cb(null, `${crypto.randomBytes(14).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024, files: 2 }, fileFilter: (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowed = file.fieldname === 'cover'
    ? ['.jpg','.jpeg','.png','.webp']
    : ['.mp3','.wav','.m4a'];
  cb(allowed.includes(ext) ? null : new Error(`Formato no permitido para ${file.fieldname}.`), allowed.includes(ext));
}});
app.post('/api/songs', upload.fields([{ name: 'cover', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), (req, res) => {
  const token = String(req.body.redemptionToken || '');
  if (!token || !authTokens.has(token)) return res.status(401).json({ error: 'La sesión de creación no es válida. Canjea un código nuevo.' });
  const title = String(req.body.title || '').trim().slice(0, 120);
  const artist = String(req.body.artist || '').trim().slice(0, 120);
  const message = String(req.body.message || '').trim().slice(0, 1200);
  const clientName = String(req.body.clientName || '').trim().slice(0, 100);
  const files = req.files || {};
  const removeFiles = () => Object.values(files).flat().forEach(f => fs.existsSync(f.path) && fs.unlinkSync(f.path));
  if (!title || !artist || !message || !clientName || !files.cover?.[0] || !files.audio?.[0]) {
    removeFiles(); return res.status(400).json({ error: 'Completa todos los campos y selecciona una portada y una canción.' });
  }
  const codeRow = db.prepare("SELECT id,client_name FROM codes WHERE redemption_token=? AND status='used'").get(token);
  if (!codeRow || codeRow.client_name !== clientName) { removeFiles(); return res.status(401).json({ error: 'La sesión de creación venció o no corresponde a este nombre.' }); }
  const slug = uniqueSlug();
  try {
    db.prepare('INSERT INTO songs(slug,code_id,client_name,title,artist,message,cover_path,audio_path,audio_type,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(slug, codeRow.id, clientName, title, artist, message, `/uploads/${path.basename(files.cover[0].path)}`, `/uploads/${path.basename(files.audio[0].path)}`, files.audio[0].mimetype || 'audio/mpeg', dateNow());
    authTokens.delete(token);
    res.json({ slug, url: `${req.protocol}://${req.get('host')}/c/${slug}` });
  } catch (err) { removeFiles(); console.error(err); res.status(500).json({ error: 'No pudimos guardar tu página. Inténtalo de nuevo.' }); }
});

const templates = {
 birthday: name => `Hoy celebramos la alegría que traes a nuestras vidas. ${name} merece un día lleno de música, abrazos y momentos que se queden para siempre. Que esta canción te recuerde cuánto te queremos y todos los sueños bonitos que aún están por venir.`,
 xv: name => `Llegó un momento mágico: tus XV años, el comienzo de una etapa llena de sueños y posibilidades. ${name}, que nunca te falten razones para bailar, personas que te quieran cerca y la valentía de ser siempre tú. Esta canción es un abrazo para guardar en el corazón.`,
 anniversary: name => `Cada año a tu lado suma historias, aprendizajes y motivos para volver a elegirnos. ${name}, gracias por construir conmigo un amor que se siente en los pequeños detalles y crece con el tiempo. Que esta canción nos acompañe en todo lo que todavía nos espera.`,
 wedding: name => `Hoy comienza una aventura nueva, hecha de complicidad, paciencia y promesas compartidas. ${name}, que el amor que celebramos hoy encuentre hogar en cada día que venga. Esta canción guarda un pedacito de toda la felicidad que deseo para ustedes.`,
 love: name => `Hay personas que hacen que el mundo se sienta más bonito, y tú eres una de ellas. ${name}, quería regalarte algo que dijera lo que a veces no cabe en las palabras: me haces bien, te pienso con cariño y agradezco tenerte en mi vida.`,
 friendship: name => `La vida se disfruta más cuando se comparte con alguien como tú. ${name}, gracias por escuchar, por estar y por convertir cualquier momento sencillo en un recuerdo especial. Esta canción es para celebrar nuestra amistad y todo lo que aún nos falta vivir.`,
 thanks: name => `Quería encontrar una forma especial de decirte gracias. ${name}, tu generosidad y tu manera de estar presente significan más de lo que imaginas. Ojalá esta canción te recuerde el cariño y la gratitud que siento por ti.`
};
app.post('/api/suggestion', (req, res) => {
  const idea = String(req.body.idea || '').trim().slice(0, 500);
  const recipient = String(req.body.artist || 'esa persona especial').trim().slice(0, 100) || 'esa persona especial';
  if (!idea) return res.status(400).json({ error: 'Escribe una idea para inspirar el mensaje.' });
  const text = idea.toLowerCase();
  const category = /xv|15 años|quince/.test(text) ? 'xv' : /cumple|años|birthday/.test(text) ? 'birthday' : /aniversario|años juntos/.test(text) ? 'anniversary' : /boda|casamiento|matrimonio/.test(text) ? 'wedding' : /amor|pareja|novio|novia|espos[oa]/.test(text) ? 'love' : /amistad|amig[oa]/.test(text) ? 'friendship' : /gracias|agrade/.test(text) ? 'thanks' : 'love';
  res.json({ message: templates[category](recipient) });
});

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
app.get('/c/:slug', (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE slug=?').get(req.params.slug);
  if (!song) return res.status(404).sendFile(path.join(PUBLIC, 'no-encontrado.html'));
  const title = escapeHtml(song.title), artist = escapeHtml(song.artist), message = escapeHtml(song.message), cover = escapeHtml(song.cover_path), audio = escapeHtml(song.audio_path);
  const absoluteCover = `${req.protocol}://${req.get('host')}${song.cover_path}`;
  const description = escapeHtml(song.message.slice(0, 190));
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#07100d"><title>${title} — Mi Melodía MX</title><meta name="description" content="${description}"><meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:image" content="${escapeHtml(absoluteCover)}"><meta property="og:url" content="${escapeHtml(`${req.protocol}://${req.get('host')}${req.originalUrl}`)}"><meta name="twitter:card" content="summary_large_image"><link rel="stylesheet" href="/styles.css"></head><body class="song-body"><main class="player-shell"><a class="brand small-brand" href="/">mi melodía <span>mx</span></a><div class="song-art"><img src="${cover}" alt="Portada de ${title}"></div><div class="song-meta"><p class="overline">Una canción para ti</p><h1>${title}</h1><p class="song-artist">Para ${artist}</p></div><blockquote class="dedication">${message}</blockquote><audio id="audio" src="${audio}" preload="metadata"></audio><div class="controls"><div class="seek-wrap"><span id="current">0:00</span><input id="seek" aria-label="Posición de la canción" type="range" min="0" max="100" value="0"><span id="duration">0:00</span></div><button id="play" class="play-button" aria-label="Reproducir canción"><span id="play-icon">▶</span></button><p class="player-hint" id="player-hint">Toca para escuchar tu canción</p></div><footer class="made-with">Creado con <strong>Mi Melodía MX</strong><span>Hecho con cariño, en México · WhatsApp: <a href="https://wa.me/5210000000000">+52 1 000 000 0000</a></span></footer></main><script src="/player.js"></script></body></html>`);
});
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
app.get('/crear', (req, res) => res.sendFile(path.join(PUBLIC, 'crear.html')));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El audio y la portada deben pesar como máximo 20 MB.' : err.message });
  if (err) return res.status(400).json({ error: err.message || 'No pudimos procesar los archivos.' });
  next();
});
app.listen(PORT, '0.0.0.0', () => console.log(`Mi Melodía MX listo en http://localhost:${PORT}`));
