const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const mysql    = require('mysql2/promise');
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');

const PORT_ADMIN  = 3000;
const PORT_PUBLIC = 3001;

const DATA_DIR   = path.join(__dirname, 'data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
const PUB_ADMIN  = path.join(__dirname, 'public', 'admin');
const PUB_PUBLIC = path.join(__dirname, 'public', 'gallery');
[DATA_DIR, PHOTOS_DIR, PUB_ADMIN, PUB_PUBLIC].forEach(d => fs.mkdirSync(d, { recursive: true }));

const DB = { host:'localhost', port:3306, user:'hunter', password:'cha_Hunter@01', database:'photovault', waitForConnections:true, connectionLimit:10, charset:'utf8mb4' };
const OWNER_NAME = 'hunter';
let pool;

// Sessions
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
setInterval(() => { const now=Date.now(); for(const[t,s]of sessions)if(now>s.expiresAt)sessions.delete(t); }, 3600000);

function mwAuth(req, res, next) {
  const s = getSession(req.headers['x-auth-token']);
  if (!s) return res.status(401).json({ error: 'Non authentifié' });
  req.s = s; next();
}
function mwOwner(req, res, next) {
  const s = getSession(req.headers['x-auth-token']);
  if (!s || s.role !== 'owner') return res.status(403).json({ error: 'Réservé à ' + OWNER_NAME });
  req.s = s; next();
}

async function initDB() {
  pool = mysql.createPool(DB);
  const conn = await pool.getConnection(); console.log('✅  MySQL connecté'); conn.release();

  await pool.execute(`CREATE TABLE IF NOT EXISTS pv_users (
    id VARCHAR(36) PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL, role ENUM('owner','user') DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.execute(`CREATE TABLE IF NOT EXISTS albums (
    id VARCHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL, description TEXT,
    cover_id VARCHAR(36) DEFAULT NULL, owner_id VARCHAR(36) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await pool.execute(`CREATE TABLE IF NOT EXISTS photos (
    id VARCHAR(36) PRIMARY KEY, album_id VARCHAR(36) DEFAULT NULL,
    owner_id VARCHAR(36) DEFAULT NULL, filename VARCHAR(255) NOT NULL,
    filename_hover VARCHAR(255) DEFAULT NULL,
    original VARCHAR(255) NOT NULL, title VARCHAR(255) DEFAULT '',
    description TEXT, size BIGINT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Migration : ajouter filename_hover si la table existait déjà
  await pool.execute(`ALTER TABLE photos ADD COLUMN IF NOT EXISTS filename_hover VARCHAR(255) DEFAULT NULL`)
    .catch(() => {});

  await pool.execute(`CREATE TABLE IF NOT EXISTS comments (
    id VARCHAR(36) PRIMARY KEY, photo_id VARCHAR(36) NOT NULL,
    user_id VARCHAR(36) NOT NULL, username VARCHAR(64) NOT NULL,
    content TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Compte owner
  const [ou] = await pool.execute("SELECT id FROM pv_users WHERE username=?", [OWNER_NAME]);
  if (!ou.length) {
    const hash = await bcrypt.hash('cha_Hunter@01', 10);
    await pool.execute("INSERT INTO pv_users(id,username,password,role) VALUES(?,?,?,'owner')", [uuidv4(), OWNER_NAME, hash]);
    console.log(`✅  Compte owner "${OWNER_NAME}" créé`);
  }

  // Album par défaut
  const [da] = await pool.execute("SELECT id FROM albums WHERE id='default'");
  if (!da.length) await pool.execute("INSERT INTO albums(id,name) VALUES('default','📷 Galerie générale')");

  console.log('✅  Tables prêtes.');
}

// Multer
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, PHOTOS_DIR),
  filename:    (_, f, cb)  => cb(null, uuidv4() + path.extname(f.originalname))
});
const upload = multer({ storage, limits:{fileSize:50*1024*1024}, fileFilter:(_, f, cb)=>cb(null,/image\/(jpeg|png|gif|webp|bmp|tiff|avif)/.test(f.mimetype)) });

function buildAPI(app) {
  app.use(cors()); app.use(express.json());
  app.use('/photos', express.static(PHOTOS_DIR));

  // AUTH
  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username||!password) return res.status(400).json({ error:'Identifiants manquants' });
    const [rows] = await pool.execute("SELECT * FROM pv_users WHERE username=?", [username]);
    if (!rows.length) return res.status(401).json({ error:'Utilisateur introuvable' });
    const u = rows[0];
    if (!await bcrypt.compare(password, u.password)) return res.status(401).json({ error:'Mot de passe incorrect' });
    const token = createSession({ userId:u.id, username:u.username, role:u.role });
    console.log(`🔐  Connexion : ${u.username} (${u.role})`);
    res.json({ token, username:u.username, role:u.role, userId:u.id });
  });

  app.get('/api/auth/check', (req, res) => {
    const s = getSession(req.headers['x-auth-token']);
    res.json(s ? { valid:true, username:s.username, role:s.role, userId:s.userId } : { valid:false });
  });

  app.post('/api/auth/logout', (req, res) => { sessions.delete(req.headers['x-auth-token']); res.json({ ok:true }); });

  // USERS (owner only)
  app.get('/api/users', mwOwner, async (_, res) => {
    const [r] = await pool.execute("SELECT id,username,role,created_at FROM pv_users ORDER BY role DESC, created_at ASC");
    res.json(r);
  });

  app.post('/api/users', mwOwner, async (req, res) => {
    const { username, password } = req.body;
    if (!username?.trim()||!password) return res.status(400).json({ error:'Champs requis' });
    if (username.trim()===OWNER_NAME) return res.status(400).json({ error:'Nom réservé' });
    const [ex] = await pool.execute("SELECT id FROM pv_users WHERE username=?", [username.trim()]);
    if (ex.length) return res.status(409).json({ error:'Nom déjà utilisé' });
    const id = uuidv4(), hash = await bcrypt.hash(password, 10);
    await pool.execute("INSERT INTO pv_users(id,username,password,role) VALUES(?,?,?,'user')", [id,username.trim(),hash]);
    res.json({ id, username:username.trim(), role:'user' });
  });

  app.delete('/api/users/:id', mwOwner, async (req, res) => {
    const [[u]] = await pool.execute("SELECT role FROM pv_users WHERE id=?", [req.params.id]);
    if (!u) return res.status(404).json({ error:'Introuvable' });
    if (u.role==='owner') return res.status(403).json({ error:'Impossible de supprimer owner' });
    await pool.execute("DELETE FROM pv_users WHERE id=?", [req.params.id]);
    res.json({ ok:true });
  });

  app.put('/api/users/:id/password', mwOwner, async (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error:'Mot de passe requis' });
    await pool.execute("UPDATE pv_users SET password=? WHERE id=?", [await bcrypt.hash(password,10), req.params.id]);
    res.json({ ok:true });
  });

  // ALBUMS
  app.get('/api/albums', async (_, res) => {
    const [r] = await pool.execute(`
      SELECT a.*, COUNT(p.id) AS photo_count,
        (SELECT filename FROM photos WHERE id=a.cover_id LIMIT 1) AS cover_filename,
        u.username AS owner_name
      FROM albums a LEFT JOIN photos p ON p.album_id=a.id LEFT JOIN pv_users u ON u.id=a.owner_id
      GROUP BY a.id ORDER BY a.created_at ASC`);
    res.json(r);
  });

  app.post('/api/albums', mwAuth, async (req, res) => {
    const { name, description='' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error:'Nom requis' });
    const id = uuidv4();
    await pool.execute('INSERT INTO albums(id,name,description,owner_id) VALUES(?,?,?,?)', [id,name.trim(),description,req.s.userId]);
    const [[a]] = await pool.execute('SELECT * FROM albums WHERE id=?', [id]);
    res.json(a);
  });

  app.put('/api/albums/:id', mwAuth, async (req, res) => {
    const [[al]] = await pool.execute('SELECT owner_id FROM albums WHERE id=?', [req.params.id]);
    if (!al) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && al.owner_id!==req.s.userId) return res.status(403).json({ error:'Non autorisé' });
    const { name, description } = req.body;
    await pool.execute('UPDATE albums SET name=COALESCE(?,name),description=COALESCE(?,description) WHERE id=?', [name||null,description||null,req.params.id]);
    const [[a]] = await pool.execute('SELECT * FROM albums WHERE id=?', [req.params.id]);
    res.json(a);
  });

  app.delete('/api/albums/:id', mwAuth, async (req, res) => {
    if (req.params.id==='default') return res.status(400).json({ error:'Album par défaut non supprimable' });
    const [[al]] = await pool.execute('SELECT owner_id FROM albums WHERE id=?', [req.params.id]);
    if (!al) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && al.owner_id!==req.s.userId) return res.status(403).json({ error:'Non autorisé' });
    await pool.execute("UPDATE photos SET album_id='default' WHERE album_id=?", [req.params.id]);
    await pool.execute('DELETE FROM albums WHERE id=?', [req.params.id]);
    res.json({ ok:true });
  });

  // PHOTOS
  app.get('/api/photos', async (req, res) => {
    const { album_id, search, sort='created_at', order='DESC', owner_id } = req.query;
    const ss = ['created_at','title','size'].includes(sort)?sort:'created_at';
    const so = order==='ASC'?'ASC':'DESC';
    let sql = `SELECT p.*, u.username AS owner_name FROM photos p LEFT JOIN pv_users u ON u.id=p.owner_id WHERE 1=1`;
    const params = [];
    if (album_id) { sql+=' AND p.album_id=?'; params.push(album_id); }
    if (owner_id) { sql+=' AND p.owner_id=?'; params.push(owner_id); }
    if (search)   { sql+=' AND (p.title LIKE ? OR p.description LIKE ? OR p.original LIKE ?)'; const s=`%${search}%`; params.push(s,s,s); }
    sql+=` ORDER BY p.${ss} ${so}`;
    const [r] = await pool.execute(sql, params);
    res.json(r);
  });

  app.post('/api/photos/upload', mwAuth, upload.array('photos',100), async (req, res) => {
    if (!req.files?.length) return res.status(400).json({ error:'Aucune photo' });
    const album_id = req.body.album_id||'default';
    const inserted = [];
    for (const file of req.files) {
      const id=uuidv4(), title=path.basename(file.originalname,path.extname(file.originalname));
      await pool.execute('INSERT INTO photos(id,album_id,owner_id,filename,original,title,size) VALUES(?,?,?,?,?,?,?)',
        [id,album_id,req.s.userId,file.filename,file.originalname,title,file.size]);
      const [[al]] = await pool.execute('SELECT cover_id FROM albums WHERE id=?', [album_id]);
      if (!al?.cover_id) await pool.execute('UPDATE albums SET cover_id=? WHERE id=?', [id,album_id]);
      const [[p]] = await pool.execute('SELECT * FROM photos WHERE id=?', [id]);
      inserted.push(p);
    }
    res.json(inserted);
  });

  // Upload photo hover (image secondaire)
  app.post('/api/photos/:id/hover', mwAuth, upload.single('hover'), async (req, res) => {
    const [[p]] = await pool.execute('SELECT owner_id, filename_hover FROM photos WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && p.owner_id!==req.s.userId) return res.status(403).json({ error:'Non autorisé' });
    if (!req.file) return res.status(400).json({ error:'Aucun fichier' });
    // Supprimer l'ancienne hover si elle existe
    if (p.filename_hover) {
      const old = path.join(PHOTOS_DIR, p.filename_hover);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }
    await pool.execute('UPDATE photos SET filename_hover=? WHERE id=?', [req.file.filename, req.params.id]);
    const [[ph]] = await pool.execute('SELECT * FROM photos WHERE id=?', [req.params.id]);
    res.json(ph);
  });

  // Supprimer photo hover
  app.delete('/api/photos/:id/hover', mwAuth, async (req, res) => {
    const [[p]] = await pool.execute('SELECT owner_id, filename_hover FROM photos WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && p.owner_id!==req.s.userId) return res.status(403).json({ error:'Non autorisé' });
    if (p.filename_hover) {
      const fp = path.join(PHOTOS_DIR, p.filename_hover);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      await pool.execute('UPDATE photos SET filename_hover=NULL WHERE id=?', [req.params.id]);
    }
    res.json({ ok:true });
  });

  app.put('/api/photos/:id', mwAuth, async (req, res) => {
    const [[p]] = await pool.execute('SELECT owner_id FROM photos WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && p.owner_id!==req.s.userId) return res.status(403).json({ error:'Non autorisé' });
    const { title, description, album_id } = req.body;
    await pool.execute('UPDATE photos SET title=COALESCE(?,title),description=COALESCE(?,description),album_id=COALESCE(?,album_id) WHERE id=?',
      [title||null,description||null,album_id||null,req.params.id]);
    const [[ph]] = await pool.execute('SELECT * FROM photos WHERE id=?', [req.params.id]);
    res.json(ph);
  });

  app.delete('/api/photos/:id', mwAuth, async (req, res) => {
    const [[p]] = await pool.execute('SELECT filename,album_id,owner_id FROM photos WHERE id=?', [req.params.id]);
    if (!p) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && p.owner_id!==req.s.userId)
      return res.status(403).json({ error:'Vous ne pouvez supprimer que vos propres photos' });
    const fp=path.join(PHOTOS_DIR,p.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    await pool.execute('DELETE FROM photos WHERE id=?', [req.params.id]);
    const [[r]] = await pool.execute('SELECT id FROM photos WHERE album_id=? LIMIT 1', [p.album_id]);
    await pool.execute('UPDATE albums SET cover_id=? WHERE id=?', [r?.id||null,p.album_id]);
    res.json({ ok:true });
  });

  // COMMENTAIRES
  app.get('/api/photos/:id/comments', async (req, res) => {
    const [r] = await pool.execute('SELECT * FROM comments WHERE photo_id=? ORDER BY created_at ASC', [req.params.id]);
    res.json(r);
  });

  app.post('/api/photos/:id/comments', mwAuth, async (req, res) => {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error:'Commentaire vide' });
    const id = uuidv4();
    await pool.execute('INSERT INTO comments(id,photo_id,user_id,username,content) VALUES(?,?,?,?,?)',
      [id,req.params.id,req.s.userId,req.s.username,content.trim()]);
    const [[c]] = await pool.execute('SELECT * FROM comments WHERE id=?', [id]);
    res.json(c);
  });

  app.delete('/api/comments/:id', mwAuth, async (req, res) => {
    const [[c]] = await pool.execute('SELECT user_id FROM comments WHERE id=?', [req.params.id]);
    if (!c) return res.status(404).json({ error:'Introuvable' });
    if (req.s.role!=='owner' && c.user_id!==req.s.userId) return res.status(403).json({ error:'Non autorisé' });
    await pool.execute('DELETE FROM comments WHERE id=?', [req.params.id]);
    res.json({ ok:true });
  });

  // STATS
  app.get('/api/stats', async (_, res) => {
    const [[ph]] = await pool.execute('SELECT COUNT(*) AS n, SUM(size) AS s FROM photos');
    const [[al]] = await pool.execute('SELECT COUNT(*) AS n FROM albums');
    const [[us]] = await pool.execute("SELECT COUNT(*) AS n FROM pv_users WHERE role='user'");
    res.json({ photos:ph.n, albums:al.n, users:us.n, size:ph.s||0 });
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
  appAdmin.listen(PORT_ADMIN, '0.0.0.0', () => {
    console.log(`\n🔐  Admin  → http://localhost:${PORT_ADMIN}  |  http://${ip}:${PORT_ADMIN}`);
  });
  appPublic.listen(PORT_PUBLIC, '0.0.0.0', () => {
    console.log(`🌐  Public → http://localhost:${PORT_PUBLIC}  |  http://${ip}:${PORT_PUBLIC}\n`);
  });
}).catch(err => { console.error('❌  MySQL :', err.message); process.exit(1); });
