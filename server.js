const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Pool }  = require('pg');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');

require('dotenv').config();

const PORT_ADMIN  = process.env.PORT_ADMIN  || 3000;
const PORT_PUBLIC = process.env.PORT_PUBLIC || 3001;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_NAME   = process.env.OWNER_NAME || 'hunter';
const OWNER_PASS   = process.env.OWNER_PASS || 'cha_Hunter@01';

if (!DATABASE_URL) {
  console.error('DATABASE_URL manquant dans .env');
  process.exit(1);
}

const DATA_DIR   = path.join(__dirname, 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const PUB_ADMIN  = path.join(__dirname, 'public', 'admin');
const PUB_PUBLIC = path.join(__dirname, 'public', 'gallery');
[DATA_DIR, PHOTOS_DIR, PUB_ADMIN, PUB_PUBLIC].forEach(d => fs.mkdirSync(d, { recursive: true }));

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

function q(sql, params = []) {
  let i = 0;
  const pgSql = sql.replace(/\?/g, () => `$${++i}`);
  return pool.query(pgSql, params).then(r => [r.rows, r]);
}

const sessions = new Map();
const TTL = 8 * 60 * 60 * 1000;
function createSession(u) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { ...u, expiresAt: Date.now() + TTL });
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); return null; }
  s.expiresAt = Date.now() + TTL;
  return s;
}
setInterval(() => { const now = Date.now(); for (const [t, s] of sessions) if (now > s.expiresAt) sessions.delete(t); }, 3600000);

function mwAuth(req, res, next) {
  const s = getSession(req.headers['x-auth-token']);
  if (!s) return res.status(401).json({ error: 'Non authentifie' });
  req.s = s; next();
}
function mwOwner(req, res, next) {
  const s = getSession(req.headers['x-auth-token']);
  if (!s || s.role !== 'owner') return res.status(403).json({ error: 'Reserve a ' + OWNER_NAME });
  req.s = s; next();
}

async function initDB() {
  await pool.query('SELECT 1');
  console.log('PostgreSQL Supabase connecte');

  await pool.query(`CREATE TABLE IF NOT EXISTS pv_users (
    id VARCHAR(36) PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL, role TEXT DEFAULT 'user' CHECK (role IN ('owner','user')),
    created_at TIMESTAMPTZ DEFAULT NOW())`);

  await pool.query(`CREATE TABLE IF NOT EXISTS albums (
    id VARCHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL, description TEXT,
    cover_id VARCHAR(36) DEFAULT NULL, owner_id VARCHAR(36) DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW())`);

  await pool.query(`CREATE TABLE IF NOT EXISTS photos (
    id VARCHAR(36) PRIMARY KEY, album_id VARCHAR(36) DEFAULT NULL,
    owner_id VARCHAR(36) DEFAULT NULL, filename VARCHAR(255) NOT NULL,
    filename_hover VARCHAR(255) DEFAULT NULL,
    original VARCHAR(255) NOT NULL, title VARCHAR(255) DEFAULT '',
    description TEXT, size BIGINT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE SET NULL)`);

  await pool.query(`ALTER TABLE photos ADD COLUMN IF NOT EXISTS filename_hover VARCHAR(255) DEFAULT NULL`).catch(() => {});

  await pool.query(`CREATE TABLE IF NOT EXISTS comments (
    id VARCHAR(36) PRIMARY KEY, photo_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL, username VARCHAR(64) NOT NULL,
    content TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(),
    FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE)`);

  const { rows: ou } = await pool.query('SELECT id FROM pv_users WHERE username=$1', [OWNER_NAME]);
  if (!ou.length) {
    const hash = await bcrypt.hash(OWNER_PASS, 10);
    await pool.query("INSERT INTO pv_users(id,username,password,role) VALUES($1,$2,$3,'owner')", [uuidv4(), OWNER_NAME, hash]);
    console.log('Compte owner "' + OWNER_NAME + '" cree');
  }

  const { rows: da } = await pool.query("SELECT id FROM albums WHERE id='default'");
  if (!da.length) await pool.query("INSERT INTO albums(id,name) VALUES('default','Galerie generale')");

  console.log('Tables pretes.');
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, PHOTOS_DIR),
  filename:    (_, f, cb)  => cb(null, uuidv4() + path.extname(f.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50*1024*1024 }, fileFilter: (_, f, cb) => cb(null, /image\/(jpeg|png|gif|webp|bmp|tiff|avif)/.test(f.mimetype)) });

function buildAPI(app) {
  app.use(cors()); app.use(express.json());
  app.use('/photos', express.static(PHOTOS_DIR));

  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username||!password) return res.status(400).json({ error:'Identifiants manquants' });
    const [rows] = await q('SELECT * FROM pv_users WHERE username=?', [username]);
    if (!rows.length) return res.status(401).json({ error:'Utilisateur introuvable' });
    const u = rows[0];
    if (!await bcrypt.compare(password, u.password)) return res.status(401).json({ error:'Mot de passe incorrect' });
    const token = createSession({ userId:u.id, username:u.username, role:u.role });
    res.json({ token, username:u.username, role:u.role, userId:u.id });
  });

  app.get('/api/auth/check', (req, res) => {
    const s = getSession(req.headers['x-auth-token']);
    res.json(s ? { valid:true, username:s.username, role:s.role, userId:s.userId } : { valid:false });
  });

  app.post('/api/auth/logout', (req, res) => { sessions.delete(req.headers['x-auth-token']); res.json({ ok:true }); });

  app.get('/api/users', mwOwner, async (_, res) => {
    const [r] = await q("SELECT id,username,role,created_at FROM pv_users ORDER BY role DESC, created_at ASC");
    res.json(r);
  });

  app.post('/api/users', mwOwner, async (req, res) => {
    const { username, password } = req.body;
    if (!username?.trim()||!password) return res.status(400).json({ error:'Champs requis' });
    if (username.trim()===OWNER_NAME) return res.status(400).json({ error:'Nom reserve' });
    const [ex] = await q('SELECT id FROM pv_users WHERE username=?', [username.trim()]);
    if (ex.length) return res.status(409).json({ error:'Nom deja utilise' });
    const id = uuidv4(), hash = await bcrypt.hash(password, 10);
    await q("INSERT INTO pv_users(id,username,password,role) VALUES(?,'user')", [id, username.trim(), hash]);
    res.json({ id, username:username.trim(), role:'user' });
  });

  app.delete('/api/users/:id', mwOwner, async (req, res) => {
    const [rows] = await q('SELECT role FROM pv_users WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:'Introuvable' });
    if (rows[0].role==='owner') return res.status(403).json({ error:'Impossible de supprimer owner' });
    await q('DELETE FROM pv_users WHERE id=?', [req.params.id]);
    res.json({ ok:true });
  });

  app.put('/api/users/:id/password', mwOwner, async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error:'Mot de passe requis' });
    await q('UPDATE pv_users SET password=? WHERE id=?', [await bcrypt.hash(password,10), req.params.id]);
    res.json({ ok:true });
  });

  app.get('/api/albums', async (_, res) => {
    const [r] = await q(`
      SELECT a.*, COUNT(p.id)::int AS photo_count,
        (SELECT filename FROM photos WHERE id=a.cover_id LIMIT 1) AS cover_filename,
        u.username AS owner_name
      FROM albums a LEFT JOIN photos p ON p.album_id=a.id LEFT JOIN pv_users u ON u.id=a.owner_id
      GROUP BY a.id, u.username ORDER BY a.created_at ASC`);
    res.json(r);
  });

  app.post('/api/albums', mwAuth, async (req, res) => {
    const { name, description='' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error:'Nom requis' });
    const id = uuidv4();
    await q('INSERT INTO albums(id,name,description,owner_id) VALUES(?,?,?,?)', [id,name.trim(),description,req.s.userId]);
    const [rows] = await q('SELECT * FROM albums WHERE id=?', [id]);
    res.json(rows[0]);
  });

  app.put('/api/albums/:id', mwAuth, async (req, res) => {
    const [rows] = await q('SELECT owner_id FROM albums WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && rows[0].owner_id!==req.s.userId) return res.status(403).json({ error:'Non autorise' });
    const { name, description } = req.body;
    await q('UPDATE albums SET name=COALESCE(?,name),description=COALESCE(?,description) WHERE id=?', [name||null,description||null,req.params.id]);
    const [upd] = await q('SELECT * FROM albums WHERE id=?', [req.params.id]);
    res.json(upd[0]);
  });

  app.delete('/api/albums/:id', mwAuth, async (req, res) => {
    if (req.params.id==='default') return res.status(400).json({ error:'Album par defaut non supprimable' });
    const [rows] = await q('SELECT owner_id FROM albums WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && rows[0].owner_id!==req.s.userId) return res.status(403).json({ error:'Non autorise' });
    await q("UPDATE photos SET album_id='default' WHERE album_id=?", [req.params.id]);
    await q('DELETE FROM albums WHERE id=?', [req.params.id]);
    res.json({ ok:true });
  });

  app.get('/api/photos', async (req, res) => {
    const { album_id, search, sort='created_at', order='DESC', owner_id } = req.query;
    const ss = ['created_at','title','size'].includes(sort)?sort:'created_at';
    const so = order==='ASC'?'ASC':'DESC';
    let sql = `SELECT p.*, u.username AS owner_name FROM photos p LEFT JOIN pv_users u ON u.id=p.owner_id WHERE 1=1`;
    const params = [];
    if (album_id) { params.push(album_id); sql+=` AND p.album_id=$${params.length}`; }
    if (owner_id) { params.push(owner_id); sql+=` AND p.owner_id=$${params.length}`; }
    if (search) {
      const s=`%${search}%`; params.push(s,s,s);
      sql+=` AND (p.title ILIKE $${params.length-2} OR p.description ILIKE $${params.length-1} OR p.original ILIKE $${params.length})`;
    }
    sql+=` ORDER BY p.${ss} ${so}`;
    const [r] = await pool.query(sql, params).then(r=>[r.rows]);
    res.json(r);
  });

  app.post('/api/photos/upload', mwAuth, upload.array('photos',100), async (req, res) => {
    if (!req.files?.length) return res.status(400).json({ error:'Aucune photo' });
    const album_id = req.body.album_id||'default';
    const inserted = [];
    for (const file of req.files) {
      const id=uuidv4(), title=path.basename(file.originalname,path.extname(file.originalname));
      await q('INSERT INTO photos(id,album_id,owner_id,filename,original,title,size) VALUES(?,?,?,?,?,?,?)',
        [id,album_id,req.s.userId,file.filename,file.originalname,title,file.size]);
      const [al] = await q('SELECT cover_id FROM albums WHERE id=?', [album_id]);
      if (al[0]&&!al[0].cover_id) await q('UPDATE albums SET cover_id=? WHERE id=?', [id,album_id]);
      const [p] = await q('SELECT * FROM photos WHERE id=?', [id]);
      inserted.push(p[0]);
    }
    res.json(inserted);
  });

  app.post('/api/photos/:id/hover', mwAuth, upload.single('hover'), async (req, res) => {
    const [rows] = await q('SELECT owner_id, filename_hover FROM photos WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && rows[0].owner_id!==req.s.userId) return res.status(403).json({ error:'Non autorise' });
    if (!req.file) return res.status(400).json({ error:'Aucun fichier' });
    if (rows[0].filename_hover) { const old=path.join(PHOTOS_DIR,rows[0].filename_hover); if(fs.existsSync(old))fs.unlinkSync(old); }
    await q('UPDATE photos SET filename_hover=? WHERE id=?', [req.file.filename, req.params.id]);
    const [ph] = await q('SELECT * FROM photos WHERE id=?', [req.params.id]);
    res.json(ph[0]);
  });

  app.delete('/api/photos/:id/hover', mwAuth, async (req, res) => {
    const [rows] = await q('SELECT owner_id, filename_hover FROM photos WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && rows[0].owner_id!==req.s.userId) return res.status(403).json({ error:'Non autorise' });
    if (rows[0].filename_hover) {
      const fp=path.join(PHOTOS_DIR,rows[0].filename_hover);
      if(fs.existsSync(fp))fs.unlinkSync(fp);
      await q('UPDATE photos SET filename_hover=NULL WHERE id=?', [req.params.id]);
    }
    res.json({ ok:true });
  });

  app.put('/api/photos/:id', mwAuth, async (req, res) => {
    const [rows] = await q('SELECT owner_id FROM photos WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && rows[0].owner_id!==req.s.userId) return res.status(403).json({ error:'Non autorise' });
    const { title, description, album_id } = req.body;
    await q('UPDATE photos SET title=COALESCE(?,title),description=COALESCE(?,description),album_id=COALESCE(?,album_id) WHERE id=?',
      [title||null,description||null,album_id||null,req.params.id]);
    const [ph] = await q('SELECT * FROM photos WHERE id=?', [req.params.id]);
    res.json(ph[0]);
  });

  app.delete('/api/photos/:id', mwAuth, async (req, res) => {
    const [rows] = await q('SELECT filename,filename_hover,album_id,owner_id FROM photos WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:'Introuvable' });
    const p = rows[0];
    if (req.s.role!=='owner' && p.owner_id!==req.s.userId)
      return res.status(403).json({ error:'Vous ne pouvez supprimer que vos propres photos' });
    [p.filename, p.filename_hover].filter(Boolean).forEach(fn => { const fp=path.join(PHOTOS_DIR,fn); if(fs.existsSync(fp))fs.unlinkSync(fp); });
    await q('DELETE FROM photos WHERE id=?', [req.params.id]);
    const [r] = await q('SELECT id FROM photos WHERE album_id=? LIMIT 1', [p.album_id]);
    await q('UPDATE albums SET cover_id=? WHERE id=?', [r[0]?.id||null, p.album_id]);
    res.json({ ok:true });
  });

  app.get('/api/photos/:id/comments', async (req, res) => {
    const [r] = await q('SELECT * FROM comments WHERE photo_id=? ORDER BY created_at ASC', [req.params.id]);
    res.json(r);
  });

  app.post('/api/photos/:id/comments', mwAuth, async (req, res) => {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error:'Commentaire vide' });
    const id = uuidv4();
    await q('INSERT INTO comments(id,photo_id,user_id,username,content) VALUES(?,?,?,?,?)',
      [id,req.params.id,req.s.userId,req.s.username,content.trim()]);
    const [c] = await q('SELECT * FROM comments WHERE id=?', [id]);
    res.json(c[0]);
  });

  app.delete('/api/comments/:id', mwAuth, async (req, res) => {
    const [rows] = await q('SELECT user_id FROM comments WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && rows[0].user_id!==req.s.userId) return res.status(403).json({ error:'Non autorise' });
    await q('DELETE FROM comments WHERE id=?', [req.params.id]);
    res.json({ ok:true });
  });

  app.get('/api/stats', async (_, res) => {
    const [ph] = await q('SELECT COUNT(*)::int AS n, SUM(size) AS s FROM photos');
    const [al] = await q('SELECT COUNT(*)::int AS n FROM albums');
    const [us] = await q("SELECT COUNT(*)::int AS n FROM pv_users WHERE role='user'");
    res.json({ photos:ph[0].n, albums:al[0].n, users:us[0].n, size:ph[0].s||0 });
  });
}

const appAdmin  = express();
const appPublic = express();
buildAPI(appAdmin);
buildAPI(appPublic);
appAdmin.use(express.static(PUB_ADMIN));
appPublic.use(express.static(PUB_PUBLIC));

initDB().then(() => {
  const { networkInterfaces } = require('os');
  const ip = Object.values(networkInterfaces()).flat().find(n=>n.family==='IPv4'&&!n.internal)?.address||'localhost';
  appAdmin.listen(PORT_ADMIN, '0.0.0.0', () => console.log(`Admin  -> http://localhost:${PORT_ADMIN}  |  http://${ip}:${PORT_ADMIN}`));
  appPublic.listen(PORT_PUBLIC, '0.0.0.0', () => console.log(`Public -> http://localhost:${PORT_PUBLIC}  |  http://${ip}:${PORT_PUBLIC}`));
}).catch(err => { console.error('Supabase :', err.message); process.exit(1); });
