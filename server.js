require('dotenv').config();
/*
Enhanced Duty Scheduler — single-file Node.js app
Anime UI, mobile adaptation, roles/permissions for admins
*/

const express = require('express');
const path = require('path');
const dayjs = require('dayjs');
const weekday = require('dayjs/plugin/weekday');
const localizedFormat = require('dayjs/plugin/localizedFormat');
require('dayjs/locale/ru');
const cookieSession = require('cookie-session');
const bcrypt = require('bcrypt');
const readline = require('readline');

dayjs.extend(weekday);
dayjs.extend(localizedFormat);
dayjs.locale('ru');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieSession({ name: 'session', keys: [process.env.SESSION_KEY || 'supersecret'], maxAge: 2 * 60 * 60 * 1000 }));

(async () => {
  // Всегда MySQL
  const mysql = require('mysql2/promise');
  const db = mysql.createPool({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  // --- Функции работы с БД
  function runAsync(sql, params=[]) {
    return db.execute(sql, params).then(([result]) => result);
  }
  function allAsync(sql, params=[]) {
    return db.execute(sql, params).then(([rows]) => rows);
  }
  function getAsync(sql, params=[]) {
    return db.execute(sql, params).then(([rows]) => rows[0]);
  }

  // --- Инициализация БД
  async function initDb() {
    await runAsync(`CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(255) PRIMARY KEY,
      value TEXT
    )`);
    await runAsync(`CREATE TABLE IF NOT EXISTS people (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      notes TEXT,
      weight INT DEFAULT 1,
      active TINYINT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await runAsync(`CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      active TINYINT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await runAsync(`CREATE TABLE IF NOT EXISTS assignments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      date DATE NOT NULL,
      slot_index INT NOT NULL,
      person_id INT,
      UNIQUE KEY uniq_date_slot (date,slot_index),
      FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE SET NULL
    )`);
    await runAsync(`CREATE TABLE IF NOT EXISTS person_exceptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      person_id INT NOT NULL,
      date DATE NOT NULL,
      reason TEXT,
      FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
    )`);
    await runAsync(`CREATE TABLE IF NOT EXISTS person_weekday_off (
      id INT AUTO_INCREMENT PRIMARY KEY,
      person_id INT NOT NULL,
      weekday INT NOT NULL,
      FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
    )`);
    await runAsync(`CREATE TABLE IF NOT EXISTS replacements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      schedule_id INT NOT NULL,
      replaced_id INT,
      replacement_id INT,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (schedule_id) REFERENCES assignments(id) ON DELETE CASCADE
    )`);
    await runAsync(`CREATE TABLE IF NOT EXISTS attendance (
      id INT AUTO_INCREMENT PRIMARY KEY,
      schedule_id INT NOT NULL,
      person_id INT NOT NULL,
      status VARCHAR(32) NOT NULL,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await runAsync(`CREATE TABLE IF NOT EXISTS logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      actor VARCHAR(255),
      action VARCHAR(255),
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await runAsync(`CREATE TABLE IF NOT EXISTS roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL
    )`);
    await runAsync(`CREATE TABLE IF NOT EXISTS permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      role_id INT NOT NULL,
      permission VARCHAR(255) NOT NULL,
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    )`);
    await runAsync(`CREATE TABLE IF NOT EXISTS admin_roles (
      admin_id INT NOT NULL,
      role_id INT NOT NULL,
      PRIMARY KEY(admin_id, role_id),
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    )`);
    await runAsync(`CREATE TABLE IF NOT EXISTS admin_permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      permission VARCHAR(255) NOT NULL,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    )`);

    // Сидирование ролей, админа и настроек — оставить как есть, только через MySQL
    const roleCount = await getAsync(`SELECT COUNT(*) as c FROM roles`);
    if (!roleCount || roleCount.c === 0) {
      await runAsync(`INSERT INTO roles(name) VALUES ('superadmin'), ('moderator')`);
      const superadmin = await getAsync(`SELECT id FROM roles WHERE name='superadmin'`);
      const moderator = await getAsync(`SELECT id FROM roles WHERE name='moderator'`);
      const basePermissions = [
        'view_people', 'edit_people', 'view_schedule', 'edit_schedule',
        'view_logs', 'manage_admins', 'view_exceptions', 'edit_exceptions',
        'view_settings', 'edit_settings'
      ];
      for (const perm of basePermissions) {
        await runAsync(`INSERT INTO permissions(role_id, permission) VALUES (?, ?)`, [superadmin.id, perm]);
      }
      await runAsync(`INSERT INTO permissions(role_id, permission) VALUES (?, 'view_people')`, [moderator.id]);
      await runAsync(`INSERT INTO permissions(role_id, permission) VALUES (?, 'edit_people')`, [moderator.id]);
      await runAsync(`INSERT INTO permissions(role_id, permission) VALUES (?, 'view_schedule')`, [moderator.id]);
      await runAsync(`INSERT INTO permissions(role_id, permission) VALUES (?, 'edit_schedule')`, [moderator.id]);
    }

    // Сидирование админа
    const adminCount = await getAsync(`SELECT COUNT(*) as c FROM admins`);
    if (!adminCount || adminCount.c === 0) {
      const defUser = process.env.ADMIN_USER || 'admin';
      const defPass = process.env.ADMIN_PASSWORD || 'admin123';
      const hash = bcrypt.hashSync(defPass, 10);
      await runAsync(`INSERT INTO admins(username,password,active) VALUES (?,?,1)`, [defUser, hash]);
      const adminRow = await getAsync(`SELECT id FROM admins WHERE username=?`, [defUser]);
      const superadmin = await getAsync(`SELECT id FROM roles WHERE name='superadmin'`);
      if (adminRow && superadmin) {
        await runAsync(`INSERT INTO admin_roles(admin_id, role_id) VALUES (?, ?)`, [adminRow.id, superadmin.id]);
      }
      console.log(`[INFO] Default admin: ${defUser} / ${defPass}`);
    }

    // Сидирование настроек
    const slots = await getAsync(`SELECT value FROM settings WHERE \`key\`=?`, ['slots_per_day']);
    if (!slots) await runAsync(`INSERT INTO settings(\`key\`,value) VALUES (?,?)`, ['slots_per_day','2']);
  }

  // --- Helpers
  function escapeHtml(str){ return String(str||'').replace(/[&<>'"]/g, s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[s])); }
  async function getSetting(key, fallback=null){
    const r = await getAsync(`SELECT value FROM settings WHERE \`key\`=?`, [key]).catch(()=>null);
    return r? r.value : fallback;
  }
  async function setSetting(key, value) {
    return runAsync(
      "INSERT INTO settings(`key`,value) VALUES (?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
      [key, String(value)]
    );
  }
  async function logAction(actor, action, detail='') {
    await runAsync(`INSERT INTO logs(actor, action, detail) VALUES (?,?,?)`, [actor, action, detail]);
  }
  async function hasPermission(adminId, permission) {
    const perms = await getEffectivePermissions(adminId);
    return perms.has(permission);
  }

  // --- Middleware
  app.use('/admin', (req,res,next)=>{
    if(req.method === 'POST' && req.session?.user){
      logAction(req.session.user, `${req.method} ${req.path}`, JSON.stringify(req.body)).catch(console.error);
    }
    next();
  });
  const requireAuth = async (req, res, next) => {
    if (!req.session || !req.session.authenticated || !req.session.user) {
      req.session = null;
      return res.redirect('/admin/login');
    }
    // Проверка, что админ существует и активен
    const admin = await getAsync(`SELECT id, active FROM admins WHERE username=?`, [req.session.user]);
    if (!admin || !admin.active) {
      req.session = null;
      return res.send(renderPage('Ошибка', '<div class="card">Ваша учётная запись отключена или удалена. Обратитесь к супер-администратору.</div>'));
    }
    req.adminId = admin.id; // можно использовать в других middleware
    next();
  };

  const requirePermission = perm => async (req, res, next) => {
    // Проверка, что админ существует и активен (дополнительно)
    const admin = await getAsync(`SELECT id, active FROM admins WHERE username=?`, [req.session.user]);
    if (!admin || !admin.active) {
      req.session = null;
      return res.send(renderPage('Ошибка', '<div class="card">Ваша учётная запись отключена или удалена. Обратитесь к супер-администратору.</div>'));
    }
    if (await hasPermission(admin.id, perm)) return next();
    return res.status(403).send(renderPage('Нет доступа', '<div class="card">У вас нет прав для этого действия.</div>'));
  };

  // --- Render function (Anime UI + адаптация)
  function renderPage(title, content, extraHead='', withContainer=true){
    return `<!doctype html>
  <html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&family=Zen+Kurenaido&display=swap" rel="stylesheet">
    <style>
      body { margin:0; font-family:'Zen Kurenaido', 'Montserrat', system-ui, Arial, sans-serif; background: url('https://i.pinimg.com/originals/3f/7d/97/3f7d974d52a937883e45991a28a38a72.jpg') center/cover no-repeat fixed, linear-gradient(180deg,#0f1115,#0c1017); color: #e7ecf4; min-height:100vh; transition: background 0.5s; }
      .container { max-width:1200px; margin:0 auto; padding:24px; background:rgba(30,34,44,0.85); border-radius:18px; box-shadow:0 8px 32px rgba(0,0,0,0.25); animation: fadeIn 0.8s; }
      @keyframes fadeIn { from{opacity:0;transform:translateY(20px);} to{opacity:1;transform:none;} }
      h2,h3 { font-family:'Montserrat',sans-serif; color:#ffb6c1; text-shadow:0 2px 8px #222; margin-top:0; }
      a { color:#7aa3ff; text-decoration:none; transition:color .2s; }
      a:hover { color:#ffb6c1; text-shadow:0 0 8px #ffb6c1; }
      .card { background:rgba(44,48,64,0.95); border:2px solid #ffb6c1; border-radius:16px; padding:18px; margin-bottom:18px; box-shadow:0 4px 16px rgba(255,182,193,0.08); transition:box-shadow 0.3s; }
      .card:hover { box-shadow:0 8px 32px rgba(255,182,193,0.18); }
      input,select,textarea { font:inherit; padding:10px; border-radius:10px; background:#1c2332; border:1.5px solid #ffb6c1; color:#fff; width:100%; margin-bottom:8px; transition:box-shadow 0.2s; }
      input:focus,select:focus,textarea:focus { box-shadow:0 0 8px #ffb6c1; outline:none; }
      button { font:inherit; padding:10px 18px; border-radius:10px; background:linear-gradient(90deg,#ffb6c1,#7aa3ff); border:none; color:#fff; cursor:pointer; font-weight:700; box-shadow:0 2px 8px #222; transition:background .2s,transform .2s; }
      button:hover { background:linear-gradient(90deg,#7aa3ff,#ffb6c1); transform:scale(1.07); box-shadow:0 4px 16px #ffb6c1; }
      table { width:100%; border-collapse:collapse; font-size:1em; }
      th,td { padding:10px; border-bottom:1px solid #ffb6c1; text-align:left; }
      th { color:#7aa3ff; font-weight:700; background:rgba(255,182,193,0.08); }
      .muted { color:#8b95a7; font-size:0.95em; }
      .row { display:flex; flex-wrap:wrap; gap:16px; }
      .col { flex:1; min-width:260px; }
      .pill { background:linear-gradient(90deg,#ffb6c1,#7aa3ff); border-radius:999px; padding:8px 16px; display:inline-block; margin:2px; font-size:1em; color:#222; font-weight:700; box-shadow:0 2px 8px #222; transition:background 0.2s; }
      .pill:hover { background:linear-gradient(90deg,#7aa3ff,#ffb6c1); color:#fff; }
      form.inline { display:inline-flex; gap:4px; align-items:center; }
      .card form label { display:block; margin-top:8px; margin-bottom:4px; font-weight:500; color:#ffb6c1; }
      .card table tr:hover { background:rgba(255,182,193,0.08); transition:background 0.2s; }
      .card div.slot { margin-bottom:8px; }
      .card div.slot select { width:auto; display:inline-block; margin-right:8px; }
      @media (max-width: 700px) {
        .container { padding:8px; max-width:98vw; }
        .row { flex-direction:column; gap:8px; }
        .col { min-width:unset; width:100%; }
        .card { padding:10px; margin-bottom:12px; }
        table, th, td { font-size:0.95em; padding:6px; }
        .day-card { width:98vw !important; min-width:unset !important; margin-bottom:8px; }
        .calendar-grid { flex-direction:column, gap:8px; }
      }
      .anime-glow { animation: animeGlow 1.5s infinite alternate; }
      @keyframes animeGlow { from { box-shadow:0 0 8px #ffb6c1; } to { box-shadow:0 0 24px #7aa3ff; } }
    </style>
    ${extraHead}
  </head>
  <body>
    ${withContainer?'<div class="container anime-glow">':''}
    ${content}
    ${withContainer?'</div>':''}
  </body>
  </html>`;
  }

  // --- Auth routes
  app.get('/admin/login', async (req,res)=>{ const c=`<div class="card" style="max-width:480px;margin:24px auto"><h3>Вход администратора</h3><form method="post" action="/admin/login"><label>Логин</label><input name="user" required/><label>Пароль</label><input type="password" name="pass" required/><div style="margin-top:8px"><a href="/">На главную</a><button style="float:right">Войти</button></div></form></div>`; res.send(renderPage('Login', c)); });
  app.post('/admin/login', async (req,res)=>{
    const {user, pass} = req.body;
    try {
      const row = await getAsync(`SELECT * FROM admins WHERE username=?`, [user]);
      if(row && row.active && await bcrypt.compare(pass, row.password)){
        req.session.authenticated = true;
        req.session.user = row.username;
        await logAction(user, 'login', 'успешный вход');
        return res.redirect('/admin');
      }
      req.session = null;
      res.send(renderPage('Login', '<div class="card"><div class="muted">Неверный логин, пароль или учётка отключена</div></div>') + '<meta http-equiv="refresh" content="2;url=/admin/login">');
    } catch(e){
      console.error(e);
      res.status(500).send('Ошибка');
    }
  });

  app.get('/admin/logout',(req,res)=>{ req.session = null; res.redirect('/'); });

  // --- Admin dashboard
  app.get('/admin', requireAuth, async (req, res) => {
    const menu = await adminMenuHtml(req.session.user);
    const ym = dayjs().format('YYYY-MM');
    const c = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h2>Панель администратора</h2><div><a class="pill" href="/">Публичный просмотр</a> <a class="pill" href="/admin/logout">Выйти</a></div></div>
      <div class="row"><div class="col card"><h3>Управление</h3>${menu}</div>
      <div class="col card"><h3>Быстрые действия</h3><form id="gen" method="post" action="/admin/api/generate"><label>Месяц (YYYY-MM)</label><input name="ym" value="${ym}" pattern="\\d{4}-\\d{2}" required/><label style="display:block;margin-top:8px;"><input type="checkbox" name="overwrite"/> Перезаписать существующие</label><div style="margin-top:8px"><button type="submit">Сгенерировать</button></div></form></div></div>`;
    res.send(renderPage('Admin', c));
  });
  app.get('/admin/admins', requireAuth, requirePermission('manage_admins'), async (req,res)=>{
    const admins = await allAsync(`SELECT id,username,active,created_at FROM admins ORDER BY id`);
    const rows = admins.map(a=>`
      <tr>
        <td>${a.id}</td>
        <td>${escapeHtml(a.username)}</td>
        <td>${a.active? 'Да':'Нет'}</td>
        <td>${a.created_at}</td>
        <td>
          <form method="post" action="/admin/admins/toggle" class="inline">
            <input type="hidden" name="id" value="${a.id}"/>
            <button>${a.active? 'Отключить':'Включить'}</button>
          </form>
          <form method="post" action="/admin/admins/delete" class="inline" onsubmit="return confirm('Удалить?')">
            <input type="hidden" name="id" value="${a.id}"/>
            <button>Удалить</button>
          </form>
          <a class="pill" href="/admin/admins/roles?id=${a.id}">Права</a>
          <a class="pill" href="/admin/admins/permissions?id=${a.id}">Индив. права</a>
        </td>
      </tr>`).join('');
    const c = `<div class="card"><h3>Администраторы</h3>
      <form method="post" action="/admin/admins/add">
        <label>Логин</label><input name="username" required/>
        <label>Пароль</label><input type="password" name="password" required/>
        <div style="margin-top:8px"><button>Добавить</button> <a href="/admin">Назад</a></div>
      </form></div>
      <div class="card" style="margin-top:12px">
        <table><thead><tr><th>ID</th><th>Логин</th><th>Активен</th><th>Создан</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    res.send(renderPage('Админы', c));
  });
  app.post('/admin/admins/add', requireAuth, requirePermission('manage_admins'), async (req,res)=>{
    const {username, password} = req.body;
    if(!username || !password) return res.redirect('/admin/admins');
    const hash = await bcrypt.hash(password, 10);
    await runAsync(`INSERT INTO admins(username,password,active) VALUES (?,?,1)`, [username,hash]);
    await logAction(req.session.user,'admin.add',username);
    res.redirect('/admin/admins');
  });
  app.post('/admin/admins/toggle', requireAuth, requirePermission('manage_admins'), async (req,res)=>{
    const id = parseInt(req.body.id,10);
    const row = await getAsync(`SELECT active FROM admins WHERE id=?`, [id]);
    if(row){
      const nv = row.active?0:1;
      await runAsync(`UPDATE admins SET active=? WHERE id=?`, [nv,id]);
      await logAction(req.session.user,'admin.toggle',`id:${id} -> ${nv}`);
    }
    res.redirect('/admin/admins');
  });
  app.post('/admin/admins/delete', requireAuth, requirePermission('manage_admins'), async (req,res)=>{
    const id = parseInt(req.body.id,10);
    await runAsync(`DELETE FROM admins WHERE id=?`, [id]);
    await logAction(req.session.user,'admin.delete',`id:${id}`);
    res.redirect('/admin/admins');
  });
  app.get('/admin/people', requireAuth, requirePermission('view_people'), async (req,res)=>{
    const people = await allAsync(`SELECT * FROM people ORDER BY active DESC, name ASC`);
    const rows = people.map(p=>`<tr><td>${p.id}</td><td><form method="post" action="/admin/people/edit" style="display:flex;gap:6px;align-items:center"><input name="id" type="hidden" value="${p.id}"/><input name="name" value="${escapeHtml(p.name)}" style="width:200px"/><input name="weight" value="${p.weight}" style="width:60px"/><button>Сохранить</button></form></td><td>${p.notes||''}</td><td>${p.active? 'Да':'Нет'}</td><td><form method="post" action="/admin/people/toggle" class="inline"><input type="hidden" name="id" value="${p.id}"/><button>${p.active? 'Отключить':'Включить'}</button></form> <form method="post" action="/admin/people/delete" class="inline" onsubmit="return confirm('Удалить?')"><input type="hidden" name="id" value="${p.id}"/><button>Удалить</button></form></td></tr>`).join('');
    const c = `<div class="card"><h3>Люди</h3><form method="post" action="/admin/people/add"><label>Имя</label><input name="name" required/><label>Вес</label><input name="weight" value="1"/><label>Примечание</label><input name="notes"/><div style="margin-top:8px"><button>Добавить</button> <a href="/admin">Назад</a></div></form></div><div class="card" style="margin-top:12px"><table><thead><tr><th>ID</th><th>Редактировать</th><th>Примечание</th><th>Активен</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    res.send(renderPage('People', c));
  });
  app.post('/admin/people/add', requireAuth, requirePermission('edit_people'), async (req,res)=>{ const name=(req.body.name||'').trim(); const weight=parseInt(req.body.weight||'1')||1; const notes=(req.body.notes||'').trim(); if(!name) return res.redirect('/admin/people'); await runAsync(`INSERT INTO people(name,notes,weight,active) VALUES (?,?,?,1)`, [name,notes,weight]).catch(()=>{}); await logAction(req.session.user,'people.add',name); res.redirect('/admin/people'); });
  app.post('/admin/people/edit', requireAuth, requirePermission('edit_people'), async (req,res)=>{ const id=parseInt(req.body.id,10); const name=(req.body.name||'').trim(); const weight=parseInt(req.body.weight||'1')||1; if(!id||!name) return res.redirect('/admin/people'); await runAsync(`UPDATE people SET name=?, weight=? WHERE id=?`, [name,weight,id]); await logAction(req.session.user,'people.edit',`id:${id} name:${name}`); res.redirect('/admin/people'); });
  app.post('/admin/people/toggle', requireAuth, requirePermission('edit_people'), async (req,res)=>{ const id=parseInt(req.body.id,10); const row=await getAsync(`SELECT active FROM people WHERE id=?`, [id]); if(!row) return res.redirect('/admin/people'); const nv = row.active?0:1; await runAsync(`UPDATE people SET active=? WHERE id=?`, [nv,id]); await logAction(req.session.user,'people.toggle',`id:${id} -> ${nv}`); res.redirect('/admin/people'); });
  app.post('/admin/people/delete', requireAuth, requirePermission('edit_people'), async (req,res)=>{ const id=parseInt(req.body.id,10); await runAsync(`DELETE FROM people WHERE id=?`, [id]); await logAction(req.session.user,'people.delete',`id:${id}`); res.redirect('/admin/people'); });
  app.get('/admin/exceptions', requireAuth, requirePermission('view_exceptions'), async (req,res)=>{
    const people = await allAsync(`SELECT id,name FROM people ORDER BY name`);
    const exc = await allAsync(`SELECT e.id,e.person_id,e.date,e.reason,p.name FROM person_exceptions e LEFT JOIN people p ON p.id=e.person_id ORDER BY e.date DESC`);
    const rows = exc.map(r=>`<tr><td>${r.id}</td><td>${escapeHtml(r.name||'—')}</td><td>${r.date}</td><td>${escapeHtml(r.reason||'')}</td><td><form method="post" action="/admin/exceptions/delete" onsubmit="return confirm('Удалить?')"><input type="hidden" name="id" value="${r.id}"/><button>Удалить</button></form></td></tr>`).join('');
    const opts = people.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    const c = `<div class="card"><h3>Заметки о дежурных (отпуска / не могу / не хочу и т.д)</h3><form method="post" action="/admin/exceptions/add"><label>Человек</label><select name="person_id">${opts}</select><label>Дата (YYYY-MM-DD)</label><input name="date" placeholder="2025-09-01" required/><label>Причина</label><input name="reason"/><div style="margin-top:8px"><button>Добавить</button> <a href="/admin">Назад</a></div></form></div><div class="card" style="margin-top:12px"><table><thead><tr><th>ID</th><th>Человек</th><th>Дата</th><th>Причина</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    res.send(renderPage('Exceptions', c));
  });
  app.post('/admin/exceptions/add', requireAuth, requirePermission('edit_exceptions'), async (req,res)=>{ const pid=parseInt(req.body.person_id,10); const date=(req.body.date||'').trim(); const reason=(req.body.reason||'').trim(); if(!pid||!/\d{4}-\d{2}-\d{2}/.test(date)) return res.redirect('/admin/exceptions'); await runAsync(`INSERT INTO person_exceptions(person_id,date,reason) VALUES (?,?,?)`, [pid,date,reason]).catch(()=>{}); await logAction(req.session.user,'exceptions.add',`pid:${pid} date:${date}`); res.redirect('/admin/exceptions'); });
  app.post('/admin/exceptions/delete', requireAuth, requirePermission('edit_exceptions'), async (req,res)=>{ const id=parseInt(req.body.id,10); await runAsync(`DELETE FROM person_exceptions WHERE id=?`, [id]); await logAction(req.session.user,'exceptions.delete',`id:${id}`); res.redirect('/admin/exceptions'); });
  app.get('/admin/weekday-offs', requireAuth, requirePermission('view_exceptions'), async (req,res)=>{
    const people = await allAsync(`SELECT id,name FROM people ORDER BY name`);
    const offs = await allAsync(`SELECT w.id,w.person_id,w.weekday,p.name FROM person_weekday_off w LEFT JOIN people p ON p.id=w.person_id ORDER BY p.name`);
    const rows = offs.map(r=>`<tr><td>${r.id}</td><td>${escapeHtml(r.name||'')}</td><td>${r.weekday}</td><td><form method="post" action="/admin/weekday-offs/delete"><input type="hidden" name="id" value="${r.id}"/><button>Удалить</button></form></td></tr>`).join('');
    const opts = people.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    const c = `<div class="card"><h3>Постоянные выходные (weekday off)</h3><form method="post" action="/admin/weekday-offs/add"><label>Человек</label><select name="person_id">${opts}</select><label>День недели (0 Sun .. 6 Sat)</label><input name="weekday" value="1"/><div style="margin-top:8px"><button>Добавить</button></div></form></div><div class="card" style="margin-top:12px"><table><thead><tr><th>ID</th><th>Человек</th><th>День</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    res.send(renderPage('Weekday offs', c));
  });
  app.post('/admin/weekday-offs/add', requireAuth, requirePermission('edit_exceptions'), async (req,res)=>{ const pid=parseInt(req.body.person_id,10); const wd=parseInt(req.body.weekday,10); if(isNaN(pid)||isNaN(wd)) return res.redirect('/admin/weekday-offs'); await runAsync(`INSERT INTO person_weekday_off(person_id,weekday) VALUES (?,?)`, [pid,wd]).catch(()=>{}); await logAction(req.session.user,'weekday.add',`pid:${pid} wd:${wd}`); res.redirect('/admin/weekday-offs'); });
  app.post('/admin/weekday-offs/delete', requireAuth, requirePermission('edit_exceptions'), async (req,res)=>{ const id=parseInt(req.body.id,10); await runAsync(`DELETE FROM person_weekday_off WHERE id=?`, [id]); await logAction(req.session.user,'weekday.delete',`id:${id}`); res.redirect('/admin/weekday-offs'); });
  app.get('/admin/settings', requireAuth, requirePermission('view_settings'), async (req,res)=>{
    // Получаем текущего пользователя
    const adminRow = await getAsync(`SELECT username FROM admins WHERE id=?`, [req.adminId]);
    const adminUser = adminRow ? adminRow.username : '';
    const slots = await getSetting('slots_per_day','2');
    const days = await getSetting('workdays','1,2,3,4,5');
    const isSuperadmin = await hasPermission(req.adminId, 'manage_admins');

    let c = `<div class="card"><h3>Настройки</h3>
      <form method="post" action="/admin/settings/save">
        <label>Логин пользователя</label>
        <input name="admin_user" value="${escapeHtml(adminUser)}" required/>
        <label>Новый пароль (оставьте пустым чтобы не менять)</label>
        <input name="admin_pass" type="password"/>`;

    if (isSuperadmin) {
      c += `<label>Дежурных в день (slots_per_day)</label>
        <input name="slots_per_day" value="${escapeHtml(slots)}"/>
        <label>Рабочие дни (через запятую 0..6, default 1..5)</label>
        <input name="workdays" value="${escapeHtml(days)}"/>`;
    } else {
      c += `<label>Дежурных в день (slots_per_day)</label>
        <div class="muted">${escapeHtml(slots)}</div>
        <label>Рабочие дни (через запятую 0..6, default 1..5)</label>
        <div class="muted">${escapeHtml(days)}</div>`;
    }

    c += `<div style="margin-top:8px"><button>Сохранить</button> <a href="/admin">Назад</a></div>
      </form></div>`;

    res.send(renderPage('Settings', c));
  });
  app.post('/admin/settings/save', requireAuth, requirePermission('edit_settings'), async (req,res)=>{
    const { admin_user, admin_pass, slots_per_day, workdays } = req.body;
    // Обновляем логин и пароль текущего пользователя
    if(admin_user && admin_user.trim()) {
      await runAsync(`UPDATE admins SET username=? WHERE id=?`, [admin_user.trim(), req.adminId]);
      req.session.user = admin_user.trim(); // обновляем сессию
    }
    if(admin_pass && admin_pass.trim()){
      const h = await bcrypt.hash(admin_pass.trim(), 10);
      await runAsync(`UPDATE admins SET password=? WHERE id=?`, [h, req.adminId]);
    }
    const isSuperadmin = await hasPermission(req.adminId, 'manage_admins');
    if(isSuperadmin) {
      if(slots_per_day) await setSetting('slots_per_day', String(parseInt(slots_per_day,10)||2));
      if(workdays) await setSetting('workdays', workdays);
    }
    await logAction(req.session.user,'settings.update',JSON.stringify(req.body));
    res.redirect('/admin/settings');
  });
  app.get('/admin/schedule', requireAuth, requirePermission('view_schedule'), async (req,res)=>{
    const ym = (req.query.ym || dayjs().format('YYYY-MM')).slice(0,7);
    const start = dayjs(ym+'-01');
    const daysInMonth = start.daysInMonth();
    const slotsPerDay = parseInt(await getSetting('slots_per_day','2'),10) || 2;
    const people = await allAsync(`SELECT id,name FROM people WHERE active=1 ORDER BY name`);
    const startDate = start.format('YYYY-MM-01');
    const endDate = start.format('YYYY-MM-') + String(daysInMonth).padStart(2,'0');

    // Подгружаем все назначения
    const rows = await allAsync(
      `SELECT * FROM assignments WHERE date BETWEEN ? AND ? ORDER BY date, slot_index`,
      [startDate,endDate]
    );
    const existing = {};
    rows.forEach(r=>{
      const ds = dayjs(r.date).format('YYYY-MM-DD');
      if(!existing[ds]) existing[ds] = {};
      existing[ds][r.slot_index] = r;
    });

    // функция генерации <option> с выделенным выбранным
    const buildOptions = (sel)=>people.map(p=>
      `<option value="${p.id}" ${p.id==sel?'selected':''}>${escapeHtml(p.name)}</option>`
    ).join('');

    // Генерация HTML для дней
    const grid = [];
    for(let d=1; d<=daysInMonth; d++){
      const date = start.date(d);
      const ds = date.format('YYYY-MM-DD');
      const weekend = (date.day()===0||date.day()===6);
      let slotsHtml='';

      for(let s=1;s<=slotsPerDay;s++){
        const sel = existing[ds] && existing[ds][s] ? existing[ds][s].person_id : '';
        slotsHtml+=`<div class="slot">
          <label>Дежурный ${s}</label>
          <select name="${ds}-slot${s}" ${weekend?'disabled':''} data-day="${ds}" class="slot-select">
            <option value="">—</option>${buildOptions(sel)}
          </select>
          <button type="button" class="replace-btn" data-day="${ds}" data-slot="${s}">Заменить</button>
        </div>`;
      }

      grid.push(`<div class="day-card ${weekend?'weekend':''}">
        <div class="day-title">${date.format('D dddd')}</div>
        ${slotsHtml}
      </div>`);
    }

    const c = `<div><a href="/admin">Назад</a></div>
    <form method="post" action="/admin/schedule/save">
      <input type="hidden" name="ym" value="${ym}"/>
      <div class="calendar-grid">${grid.join('')}</div>
      <div style="margin-top:12px">
        <button>Сохранить</button>
        <a href="/admin/api/generate?ym=${ym}" onclick="return confirm('Сгенерировать? Существующие значения не трогаются.')">Сгенерировать авто</a>
      </div>
    </form>
    <style>
      .calendar-grid{display:flex;flex-wrap:wrap;gap:12px}
      .day-card{background:#161a22;border:1px solid #222;border-radius:8px;padding:8px;flex:1 1 160px;min-width:120px;max-width:220px;box-shadow:0 2px 6px rgba(0,0,0,0.4)}
      .day-card.weekend{background:#1a1422;color:#d08b8b}
      .day-title{font-weight:600;margin-bottom:6px;color:#9db1d1}
      .slot{margin-bottom:6px}
      .slot select{width:100%}
      .replace-btn{margin-top:4px;padding:4px 6px;font-size:0.85em;background:#5b8cff;color:#fff;border:none;border-radius:6px;cursor:pointer;transition:0.2s}
      .replace-btn:hover{background:#7aa3ff}
    </style>
    <script>
      document.querySelector('.calendar-grid').addEventListener('change', function(e) {
        if (e.target.classList.contains('slot-select')) {
          if (e.target.value) e.target.style.background = '#1a2332';
          else e.target.style.background = '#0d1118';
        }
      });
      document.querySelector('.calendar-grid').addEventListener('click', function(e) {
        if (e.target.classList.contains('replace-btn')) {
          const day = e.target.dataset.day;
          const slot = e.target.dataset.slot;
          const select = document.querySelector("select[name='" + day + "-slot" + slot + "']");
          if (select && select.value) {
            alert('Заменить на: ' + select.options[select.selectedIndex].text);
          } else {
            alert('Выберите человека!');
          }
        }
      });
    </script>`;

    res.send(renderPage('Schedule', c));
  });
  app.post('/admin/schedule/save', requireAuth, requirePermission('edit_schedule'), async (req,res)=>{
    const ym = (req.body.ym||'').slice(0,7);
    const entries = Object.entries(req.body).filter(([k])=>/-slot\d+$/.test(k));
    for(const [k,v] of entries){ const [date,slot]=k.split('-slot'); const slotIndex=parseInt(slot,10); const pid = v? parseInt(v,10): null; if(!/\d{4}-\d{2}-\d{2}/.test(date) || isNaN(slotIndex)) continue; await runAsync(`INSERT INTO assignments(date,slot_index,person_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE person_id=VALUES(person_id)`, [date,slotIndex,pid]).catch(()=>{}); }
    await logAction(req.session.user,'schedule.save',`ym:${ym}`);
    res.redirect('/admin/schedule?ym='+ym);
  });
  app.post('/admin/schedule/replace', requireAuth, requirePermission('edit_schedule'), async (req,res)=>{
    const key = req.body.replace_action; // format date-slot
    if(!key) return res.redirect('/admin/schedule');
    const [date, slot] = key.split('-'); const slotIndex = parseInt(slot,10);
    const people = await allAsync(`SELECT id,name FROM people WHERE active=1 ORDER BY name`);
    const opts = people.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    const c = `<div class="card"><h3>Замена для ${date} slot ${slotIndex}</h3><form method="post" action="/admin/schedule/replace/confirm"><input type="hidden" name="date" value="${date}"/><input type="hidden" name="slot" value="${slotIndex}"/><label>Заменить на</label><select name="replacement_id">${opts}</select><label>Причина</label><input name="reason"/><div style="margin-top:8px"><button>Заменить</button> <a href="/admin/schedule?ym=${date.slice(0,7)}">Отмена</a></div></form></div>`;
    res.send(renderPage('Replace', c));
  });
  app.post('/admin/schedule/replace/confirm', requireAuth, requirePermission('edit_schedule'), async (req,res)=>{
    const { date, slot, replacement_id, reason } = req.body; const slotIndex = parseInt(slot,10); const pid = parseInt(replacement_id,10)||null;
    // find assignment id
    const asg = await getAsync(`SELECT id, person_id FROM assignments WHERE date=? AND slot_index=?`, [date, slotIndex]);
    if(asg){ await runAsync(`UPDATE assignments SET person_id=? WHERE id=?`, [pid, asg.id]); await runAsync(`INSERT INTO replacements(schedule_id,replaced_id,replacement_id,reason) VALUES (?,?,?,?)`, [asg.id, asg.person_id, pid, reason||'']); await logAction(req.session.user,'schedule.replace',`date:${date} slot:${slot} from:${asg.person_id} to:${pid}`); }
    else { await runAsync(`INSERT INTO assignments(date,slot_index,person_id) VALUES (?,?,?)`, [date,slotIndex,pid]); const newA = await getAsync(`SELECT id FROM assignments WHERE date=? AND slot_index=?`, [date,slotIndex]); await runAsync(`INSERT INTO replacements(schedule_id,replaced_id,replacement_id,reason) VALUES (?,?,?,?)`, [newA.id, null, pid, reason||'']); await logAction(req.session.user,'schedule.replace',`date:${date} slot:${slot} created -> ${pid}`); }
    res.redirect('/admin/schedule?ym='+date.slice(0,7));
  });
  app.post('/admin/attendance', requireAuth, requirePermission('edit_schedule'), async (req,res)=>{
    // body: schedule_id, person_id, status, note
    const { schedule_id, person_id, status, note } = req.body;
    if(!schedule_id || !person_id || !status) return res.status(400).json({ok:false});
    await runAsync(`INSERT INTO attendance(schedule_id,person_id,status,note) VALUES (?,?,?,?)`, [schedule_id, person_id, status, note||'']); await logAction(req.session.user,'attendance.mark',`sched:${schedule_id} pid:${person_id} status:${status}`);
    res.json({ ok:true });
  });
  app.post('/admin/api/generate', requireAuth, async (req,res)=>{
    const ym = (req.body.ym || dayjs().format('YYYY-MM')).slice(0,7); const overwrite = !!req.body.overwrite;
    try{ const cnt = await generateMonth(ym, overwrite); await logAction(req.session.user,'generate',`ym:${ym} overwrite:${overwrite}`); res.json({ok:true, message:`Сгенерировано дней: ${cnt}`}); }catch(e){ console.error(e); res.status(500).json({ok:false, message:'Ошибка генерации'}); }
  });
  app.get('/admin/api/generate', requireAuth, async (req,res)=>{ try{ const cnt = await generateMonth(req.query.ym, false); res.redirect('/admin/schedule?ym='+(req.query.ym||dayjs().format('YYYY-MM'))); }catch(e){ console.error(e); res.status(500).send('Ошибка'); } });
  async function generateMonth(ymArg, overwrite){
    const ym = (ymArg || dayjs().format('YYYY-MM')).slice(0,7); const start = dayjs(ym + '-01'); const daysInMonth = start.daysInMonth();
    const people = await allAsync(`SELECT id,name,weight FROM people WHERE active=1 ORDER BY id`);
    if(!people.length) throw new Error('Нет активных людей');
    const pool = [];
    people.forEach(p=>{ for(let i=0;i<(p.weight||1);i++) pool.push(p.id); });
    const usedCounts = new Map(people.map(p=>[p.id,0]));
    const slotsPerDay = parseInt(await getSetting('slots_per_day','2'),10) || 2;
    // load existing assignments
    const startDate = start.format('YYYY-MM-01'); const endDate = start.format('YYYY-MM-') + String(daysInMonth).padStart(2,'0');
    const existing = await allAsync(`SELECT * FROM assignments WHERE date BETWEEN ? AND ?`, [startDate, endDate]);
    existing.forEach(r=>{ if(r.person_id) usedCounts.set(r.person_id, (usedCounts.get(r.person_id)||0)+1); });
    // exceptions
    const exRows = await allAsync(`SELECT person_id,date FROM person_exceptions`);
    const excByDate = new Map(); exRows.forEach(r=>{ const s=excByDate.get(r.date)||new Set(); s.add(String(r.person_id)); excByDate.set(r.date,s); });
    const wdRows = await allAsync(`SELECT person_id,weekday FROM person_weekday_off`);
    const wdMap = new Map(); wdRows.forEach(r=>{ const s=wdMap.get(String(r.person_id))||new Set(); s.add(parseInt(r.weekday,10)); wdMap.set(String(r.person_id), s); });
    const existingMap = new Map(); existing.forEach(r=>{ const m = existingMap.get(r.date)|| {}; m[r.slot_index]=r; existingMap.set(r.date, m); });
    let prevDay = [];
    let generated = 0;
    for(let d=1; d<=daysInMonth; d++){
      const date = start.date(d); const ds = date.format('YYYY-MM-DD'); if(date.day()===0||date.day()===6) continue; // skip weekends
      const exForDate = existingMap.get(ds) || {};
      const hasAny = Object.keys(exForDate).length>0;
      if(!overwrite && hasAny){ prevDay = Object.values(exForDate).map(x=>x.person_id).filter(Boolean); continue; }
      // build candidates
      const candidates = [...new Set(pool)].filter(id=>{
        if(excByDate.get(ds) && excByDate.get(ds).has(String(id))) return false;
        const wd = wdMap.get(String(id)); if(wd && wd.has(date.day())) return false;
        return true;
      });
      if(!candidates.length){ // create empty slots
        for(let s=1;s<=slotsPerDay;s++){ await runAsync(`INSERT INTO assignments(date,slot_index,person_id) VALUES (?,?,?) ON CONFLICT(date,slot_index) DO UPDATE SET person_id=excluded.person_id`, [ds,s,null]); }
        prevDay = []; continue;
      }
      candidates.sort((a,b)=>{ const ua=usedCounts.get(a)||0; const ub=usedCounts.get(b)||0; if(ua!==ub) return ua-ub; return a-b; });
      const picks = [];
      const avoid = new Set(prevDay||[]);
      for(let s=1;s<=slotsPerDay;s++){ let pick = candidates.find(id=>!avoid.has(id) && !picks.includes(id)); if(!pick) pick = candidates.find(id=>!picks.includes(id)); if(!pick) pick=null; picks.push(pick); if(pick) { usedCounts.set(pick, (usedCounts.get(pick)||0)+1); avoid.add(pick); } }
      for(let s=1;s<=slotsPerDay;s++){
        const pid = picks[s-1] || null;
        await runAsync(
          `INSERT INTO assignments(date,slot_index,person_id) VALUES (?,?,?) ON DUPLICATE KEY UPDATE person_id=VALUES(person_id)`,
          [ds,s,pid]
        );
      }
      prevDay = picks.filter(Boolean); generated++; }
    return generated;
  }

  // --- Public view
  app.get('/', async (req,res)=>{
  const ym = (req.query.ym || dayjs().format('YYYY-MM')).slice(0,7);
  const start = dayjs(ym+'-01');
  const daysInMonth = start.daysInMonth();
  const slotsPerDay = parseInt(await getSetting('slots_per_day','2'),10) || 2;
  const plist = await allAsync(`SELECT id,name FROM people`);
  const ppl = new Map((plist||[]).map(p=>[String(p.id), p.name]));
  const startDate = start.format('YYYY-MM-01');
  const endDate = start.format('YYYY-MM-') + String(daysInMonth).padStart(2,'0');
  const rows = await allAsync(`SELECT * FROM assignments WHERE date BETWEEN ? AND ? ORDER BY date, slot_index`, [startDate, endDate]);
  let grid='';
  const byDate = new Map();
  rows.forEach(r=>{
    const dstr = dayjs(r.date).format('YYYY-MM-DD');
    const m = byDate.get(dstr) || {};
    m[r.slot_index]=r.person_id;
    byDate.set(dstr, m);
  });

  // --- Добавляем навигацию по месяцам ---
  const prevMonth = start.subtract(1, 'month').format('YYYY-MM');
  const nextMonth = start.add(1, 'month').format('YYYY-MM');
  const monthTitle = start.format('MMMM YYYY');

  for(let d=1; d<=daysInMonth; d++){
    const date=start.date(d);
    const ds=date.format('YYYY-MM-DD');
    const weekend = (date.day()===0||date.day()===6);
    let slotHtml='';
    for(let s=1;s<=slotsPerDay;s++){
      const pid = (byDate.get(ds)||{})[s] || null;
      const name = pid? escapeHtml(ppl.get(String(pid))||'—') : '—';
      slotHtml += `<div class="pill">Дежурный ${s}: ${name}</div>`;
    }
    grid += `<div class="public-day-card${weekend?' weekend':''}"><div style="color:#9db1d1">${date.format('D dddd')}</div>${slotHtml}</div>`;
  }
  const c = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <h2>
      <a href="/?ym=${prevMonth}" style="margin-right:16px;font-size:1.5em;text-decoration:none;">&#8592;</a>
      ${monthTitle}
      <a href="/?ym=${nextMonth}" style="margin-left:16px;font-size:1.5em;text-decoration:none;">&#8594;</a>
    </h2>
    <div><a class="pill" href="/admin">Админ</a></div>
  </div>
  <div class="card">
    <div class="public-calendar-grid">${grid}</div>
  </div>
  <style>
    .public-calendar-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: flex-start;
    }
    .public-day-card {
      display: inline-block;
      width: calc(14% - 12px);
      margin: 6px;
      padding: 8px;
      border: 1px solid #222;
      border-radius: 8px;
      background: #111;
      vertical-align: top;
      box-sizing: border-box;
    }
    .public-day-card.weekend {
      background: #1a1422;
      color: #d08b8b;
    }
    @media (max-width: 900px) {
      .public-day-card { width: calc(33% - 12px); }
    }
    @media (max-width: 700px) {
      .public-calendar-grid { flex-direction: column; gap: 8px; }
      .public-day-card { width: 98vw !important; min-width: unset !important; margin: 0 0 8px 0; }
    }
  </style>
  `;
  res.send(renderPage('Public', c));
});
  app.get('/admin/logs', requireAuth, requirePermission('view_logs'), async (req,res)=>{
    const rows = await allAsync(`SELECT * FROM logs ORDER BY id DESC LIMIT 200`);
    const items = rows.map(r=>
      `<tr><td>${r.id}</td><td>${escapeHtml(r.actor||'')}</td><td>${escapeHtml(r.action||'')}</td><td>${escapeHtml(r.detail||'')}</td><td>${r.created_at}</td></tr>`
    ).join('');
    const c = `<div class="card"><h3>Логи</h3>
      <table>
        <thead><tr><th>ID</th><th>Кто</th><th>Действие</th><th>Детали</th><th>Время</th></tr></thead>
        <tbody>${items}</tbody>
      </table>
      <div style="margin-top:12px"><a href="/admin">Назад</a></div>
    </div>`;
    res.send(renderPage('Логи', c));
  });
  app.get('/admin/admins/roles', requireAuth, requirePermission('manage_admins'), async (req, res) => {
    const adminId = parseInt(req.query.id, 10);
    const admin = await getAsync(`SELECT id,username FROM admins WHERE id=?`, [adminId]);
    if (!admin) return res.send(renderPage('Права', '<div class="card">Админ не найден</div>'));
    const roles = await allAsync(`SELECT id,name FROM roles`);
    const adminRoles = await allAsync(`SELECT role_id FROM admin_roles WHERE admin_id=?`, [adminId]);
    const assigned = new Set(adminRoles.map(r=>r.role_id));
    const rows = roles.map(r=>`
      <form method="post" action="/admin/admins/roles/update" class="inline" style="margin-bottom:8px">
        <input type="hidden" name="admin_id" value="${adminId}"/>
        <input type="hidden" name="role_id" value="${r.id}"/>
        <button style="background:${assigned.has(r.id)?'#7aa3ff':'#ffb6c1'}">
          ${assigned.has(r.id)?'Убрать':'Назначить'} роль: ${escapeHtml(r.name)}
        </button>
      </form>
    `).join('');
    const c = `<div class="card"><h3>Права для ${escapeHtml(admin.username)}</h3>
      ${rows}
      <div style="margin-top:12px"><a href="/admin/admins">Назад</a></div>
    </div>`;
    res.send(renderPage('Права', c));
  });

  app.post('/admin/admins/roles/update', requireAuth, requirePermission('manage_admins'), async (req, res) => {
    const adminId = parseInt(req.body.admin_id, 10);
    const roleId = parseInt(req.body.role_id, 10);
    const hasRole = await getAsync(`SELECT 1 FROM admin_roles WHERE admin_id=? AND role_id=?`, [adminId, roleId]);
    if (hasRole) {
      await runAsync(`DELETE FROM admin_roles WHERE admin_id=? AND role_id=?`, [adminId, roleId]);
      await logAction(req.session.user, 'role.remove', `admin:${adminId} role:${roleId}`);
    } else {
      await runAsync(`INSERT INTO admin_roles(admin_id, role_id) VALUES (?, ?)`, [adminId, roleId]);
      await logAction(req.session.user, 'role.assign', `admin:${adminId} role:${roleId}`);
    }
    res.redirect(`/admin/admins/roles?id=${adminId}`);
  });

  // Страница управления группами (ролями) и их правами
  app.get('/admin/roles', requireAuth, requirePermission('manage_admins'), async (req, res) => {
    const roles = await allAsync(`SELECT id, name FROM roles ORDER BY id`);
    const permissions = await allAsync(`SELECT * FROM permissions`);
    const allPerms = [
      'view_people', 'edit_people', 'view_schedule', 'edit_schedule',
      'view_logs', 'manage_admins', 'view_exceptions', 'edit_exceptions',
      'view_settings', 'edit_settings'
    ];

    // Форма создания новой группы
    let html = `<div class="card"><h3>Группы (Роли)</h3>
      <form method="post" action="/admin/roles/add">
        <label>Название группы (роли)</label>
        <input name="name" required/>
        <div style="margin-top:8px"><button>Создать</button> <a href="/admin">Назад</a></div>
      </form>
    </div>`;
    
    // Таблица групп и их прав
    html += `<div class="card" style="margin-top:12px">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Название</th>
            <th>Права</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>`;

    for (const role of roles) {
      const perms = permissions.filter(p => p.role_id === role.id).map(p => p.permission);
      html += `<tr>
        <td>${role.id}</td>
        <td>${escapeHtml(role.name)}</td>
        <td>${perms.length ? perms.map(p => `<span class="pill">${escapeHtml(p)}</span>`).join(' ') : '<span class="muted">Нет</span>'}</td>
        <td>
          <a class="pill" href="/admin/roles/edit?id=${role.id}">Настроить</a>
          <form method="post" action="/admin/roles/delete" class="inline" style="display:inline" onsubmit="return confirm('Удалить группу?')">
            <input type="hidden" name="id" value="${role.id}"/>
            <button style="background:#d08b8b">Удалить</button>
          </form>
        </td>
      </tr>`;
    }

    html += `</tbody></table></div>`;
    res.send(renderPage('Группы', html));
  });
  // Добавление новой группы
  app.post('/admin/roles/add', requireAuth, requirePermission('manage_admins'), async (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.redirect('/admin/roles');
    await runAsync(`INSERT INTO roles(name) VALUES (?)`, [name]).catch(()=>{});
    res.redirect('/admin/roles');
  });
  // Удаление группы
  app.post('/admin/roles/delete', requireAuth, requirePermission('manage_admins'), async (req, res) => {
    const id = parseInt(req.body.id, 10);
    if (!id) return res.redirect('/admin/roles');
    await runAsync(`DELETE FROM roles WHERE id=?`, [id]).catch(()=>{});
    res.redirect('/admin/roles');
  });
  // Страница редактирования группы
  app.get('/admin/roles/edit', requireAuth, requirePermission('manage_admins'), async (req, res) => {
    const id = parseInt(req.query.id, 10);
    if (!id) return res.redirect('/admin/roles');
    const role = await getAsync(`SELECT * FROM roles WHERE id=?`, [id]);
    if (!role) return res.redirect('/admin/roles');
    // Используем фиксированный список всех прав
    const allPerms = [
      'view_people', 'edit_people', 'view_schedule', 'edit_schedule',
      'view_logs', 'manage_admins', 'view_exceptions', 'edit_exceptions',
      'view_settings', 'edit_settings'
    ];
    const assignedPermissions = await allAsync(`SELECT permission FROM permissions WHERE role_id=?`, [id]);
    const assigned = new Set(assignedPermissions.map(p=>p.permission));
    const c = `<div class="card"><h3>Редактирование группы</h3>
      <form method="post" action="/admin/roles/edit/save">
        <input type="hidden" name="id" value="${role.id}"/>
        <label>Название группы</label>
        <input name="name" value="${escapeHtml(role.name)}" required/>
        <label>Права</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
          ${allPerms.map(p=>
  `<label style="background:${assigned.has(p)?'#7aa3ff':'#333'};padding:8px;border-radius:4px;color:#fff;cursor:pointer">
    <input type="checkbox" name="permissions" value="${escapeHtml(p)}" ${assigned.has(p)?'checked':''}/>
    ${escapeHtml(p)}
  </label>`
).join('')}
        </div>
        <div style="margin-top:12px">
          <button>Сохранить</button>
          <a href="/admin/roles" style="color:#ffb6c1">Отмена</a>
        </div>
      </form>
    </div>`;
    res.send(renderPage('Редактирование группы', c));
  });
  app.post('/admin/roles/edit/save', requireAuth, requirePermission('manage_admins'), async (req, res) => {
    const id = parseInt(req.body.id, 10);
    const name = (req.body.name || '').trim();
    const permissions = req.body.permissions || [];
    if (!id || !name) return res.redirect('/admin/roles');
    await runAsync(`UPDATE roles SET name=? WHERE id=?`, [name, id]).catch(()=>{});
    await runAsync(`DELETE FROM permissions WHERE role_id=?`, [id]).catch(()=>{});
    for (const perm of permissions) {
      await runAsync(`INSERT INTO permissions(role_id, permission) VALUES (?, ?)`, [id, perm]).catch(()=>{});
    }
    res.redirect('/admin/roles');
  });

  // Страница профиля пользователя (админа)
  app.get('/admin/profile', requireAuth, async (req, res) => {
    const admin = await getAsync(`SELECT id, username, active, created_at FROM admins WHERE id=?`, [req.adminId]);
    if (!admin) return res.send(renderPage('Профиль', '<div class="card">Пользователь не найден</div>'));
    // Можно добавить больше информации и действий
    const roles = await allAsync(`
      SELECT r.name FROM admin_roles ar
      JOIN roles r ON ar.role_id = r.id
      WHERE ar.admin_id = ?
    `, [admin.id]);
    const rolesList = roles.length ? roles.map(r=>`<span class="pill">${escapeHtml(r.name)}</span>`).join(' ') : '<span class="muted">Нет ролей</span>';
    const c = `<div class="card"><h3>Профиль администратора</h3>
      <table>
        <tr><th>ID</th><td>${admin.id}</td></tr>
        <tr><th>Логин</th><td>${escapeHtml(admin.username)}</td></tr>
        <tr><th>Активен</th><td>${admin.active ? 'Да' : 'Нет'}</td></tr>
        <tr><th>Создан</th><td>${admin.created_at}</td></tr>
        <tr><th>Роли</th><td>${rolesList}</td></tr>
      </table>
      <div style="margin-top:12px">
        <a class="pill" href="/admin/settings">Изменить логин/пароль</a>
        <a class="pill" href="/admin">Назад</a>
      </div>
    </div>`;
    res.send(renderPage('Профиль', c));
  });

  async function adminMenuHtml(username) {
    const admin = await getAsync(`SELECT id FROM admins WHERE username=?`, [username]);
    if (!admin) return '';
    const links = [];
    links.push(`<li><a href='/admin/profile'>Профиль</a></li>`); // <-- новая ссылка
    if (await hasPermission(admin.id, 'manage_admins')) links.push(`<li><a href='/admin/admins'>Админы</a></li>`);
    if (await hasPermission(admin.id, 'view_people')) links.push(`<li><a href='/admin/people'>Люди</a></li>`);
    if (await hasPermission(admin.id, 'view_schedule')) links.push(`<li><a href='/admin/schedule'>Календарь</a></li>`);
    if (await hasPermission(admin.id, 'view_exceptions')) links.push(`<li><a href='/admin/exceptions'>Заметки о дежурных</a></li>`);
    if (await hasPermission(admin.id, 'view_exceptions')) links.push(`<li><a href='/admin/weekday-offs'>Постоянные выходные</a></li>`);
    if (await hasPermission(admin.id, 'view_settings')) links.push(`<li><a href='/admin/settings'>Настройки</a></li>`);
    if (await hasPermission(admin.id, 'view_logs')) links.push(`<li><a href="/admin/logs">Логи</a></li>`);
    if (await hasPermission(admin.id, 'manage_admins')) links.push(`<li><a href='/admin/roles'>Группы</a></li>`);
    return `<ul style="list-style:none;padding:0;margin:0;">${links.join('')}</ul>`;
  }

  // --- ДОБАВИТЬ: Таблица наследования ролей при инициализации БД
  await runAsync(`CREATE TABLE IF NOT EXISTS role_inheritance (
    role_id INT NOT NULL,
    parent_role_id INT NOT NULL,
    PRIMARY KEY(role_id, parent_role_id),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_role_id) REFERENCES roles(id) ON DELETE CASCADE
  )`);

  // --- ДОБАВИТЬ: Получение всех ролей с учётом наследования
  async function getAllRoles(adminId) {
    const directRoles = await allAsync(`SELECT role_id FROM admin_roles WHERE admin_id=?`, [adminId]);
    const roleIds = new Set(directRoles.map(r => r.role_id));
    const stack = [...roleIds];
    while (stack.length) {
      const rid = stack.pop();
      const parents = await allAsync(`SELECT parent_role_id FROM role_inheritance WHERE role_id=?`, [rid]);
      for (const p of parents) {
        if (!roleIds.has(p.parent_role_id)) {
          roleIds.add(p.parent_role_id);
          stack.push(p.parent_role_id);
        }
      }
    }
    return Array.from(roleIds);
  }

  // --- ДОБАВИТЬ: Получение итоговых прав пользователя
  async function getEffectivePermissions(adminId) {
    // Индивидуальные права
    const indPerms = await allAsync(`SELECT permission FROM admin_permissions WHERE admin_id=?`, [adminId]);
    const indSet = new Set(indPerms.map(p => p.permission));
    // Ролевые права (с учётом наследования)
    const allRoles = await getAllRoles(adminId);
    let rolePerms = [];
    if (allRoles.length) {
      rolePerms = await allAsync(
        `SELECT permission FROM permissions WHERE role_id IN (${allRoles.map(()=>'?').join(',')})`,
        allRoles
      );
    }
    const roleSet = new Set(rolePerms.map(p => p.permission));
    // Итог: индивидуальные права имеют приоритет (можно доработать под deny/allow)
    return new Set([...roleSet, ...indSet]);
  }

  // --- ЗАМЕНИТЬ функцию hasPermission на новую
  async function hasPermission(adminId, permission) {
    const perms = await getEffectivePermissions(adminId);
    return perms.has(permission);
  }

  // --- ДОБАВИТЬ: Интерфейс управления наследованием ролей
  app.get('/admin/roles/inheritance', requireAuth, requirePermission('manage_admins'), async (req, res) => {
    const roles = await allAsync(`SELECT id, name FROM roles ORDER BY id`);
    const inh = await allAsync(`SELECT * FROM role_inheritance`);
    const inhMap = new Map();
    inh.forEach(r => {
      if (!inhMap.has(r.role_id)) inhMap.set(r.role_id, []);
      inhMap.get(r.role_id).push(r.parent_role_id);
    });
    let html = `<div class="card"><h3>Наследование ролей</h3>
      <form method="post" action="/admin/roles/inheritance/add">
        <label>Роль</label>
        <select name="role_id">${roles.map(r=>`<option value="${r.id}">${escapeHtml(r.name)}</option>`)}</select>
        <label>Наследует от</label>
        <select name="parent_role_id">${roles.map(r=>`<option value="${r.id}">${escapeHtml(r.name)}</option>`)}</select>
        <button>Добавить</button>
        <a href="/admin/roles">Назад</a>
      </form>
    </div>
    <div class="card" style="margin-top:12px">
      <table><thead><tr><th>Роль</th><th>Наследует от</th><th></th></tr></thead><tbody>`;
    for (const r of roles) {
      const parents = inhMap.get(r.id) || [];
      for (const pid of parents) {
        const pname = roles.find(x=>x.id===pid)?.name || pid;
        html += `<tr>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(pname)}</td>
          <td>
            <form method="post" action="/admin/roles/inheritance/delete" class="inline">
              <input type="hidden" name="role_id" value="${r.id}"/>
              <input type="hidden" name="parent_role_id" value="${pid}"/>
              <button>Удалить</button>
            </form>
          </td>
        </tr>`;
      }
    }
    html += `</tbody></table></div>`;
    res.send(renderPage('Наследование ролей', html));
  });

  app.post('/admin/roles/inheritance/add', requireAuth, requirePermission('manage_admins'), async (req, res) => {
    const role_id = parseInt(req.body.role_id, 10);
    const parent_role_id = parseInt(req.body.parent_role_id, 10);
    if (role_id && parent_role_id && role_id !== parent_role_id) {
      await runAsync(`INSERT IGNORE INTO role_inheritance(role_id, parent_role_id) VALUES (?, ?)`, [role_id, parent_role_id]);
    }
    res.redirect('/admin/roles/inheritance');
  });

  app.post('/admin/roles/inheritance/delete', requireAuth, requirePermission('manage_admins'), async (req, res) => {
    const role_id = parseInt(req.body.role_id, 10);
    const parent_role_id = parseInt(req.body.parent_role_id, 10);
    if (role_id && parent_role_id) {
      await runAsync(`DELETE FROM role_inheritance WHERE role_id=? AND parent_role_id=?`, [role_id, parent_role_id]);
    }
    res.redirect('/admin/roles/inheritance');
  });

  // --- ДОБАВИТЬ ссылку на наследование ролей в меню ролей
  // Внутри app.get('/admin/roles', ...) после формы создания группы:
  


  await initDb();
  app.listen(PORT, HOST, ()=> console.log(`Duty Scheduler running: http://${HOST}:${PORT} [mysql]`));
})();
