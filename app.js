// 博樂居家系統
// 直接呼叫 Supabase 的 REST API（不需要額外套件）。

const CFG = window.BOLE_CONFIG || {};
const BASE = (CFG.url || '').replace(/\/+$/, '');
const KEY = CFG.anonKey || '';

/* ================= 小工具 ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 無法儲存時略過 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* 略過 */ } },
};
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const rocYear = (iso) => (iso ? Number(iso.slice(0, 4)) - 1911 : null);
const fmtDate = (iso) => (iso ? `${rocYear(iso)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}` : '');
const fmtMD = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '');
const fmtTime = (ts) => { if (!ts) return ''; const d = new Date(ts); return `${d.getFullYear() - 1911}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const opt = (v, label, sel) => `<option value="${esc(v)}"${String(v) === String(sel ?? '') ? ' selected' : ''}>${esc(label)}</option>`;
const REGIONS = ['新莊', '淡水'];
const STATUSES = ['問案中', '成案', '未成案'];

function toast(msg, isErr = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = ''; }, isErr ? 5000 : 2500);
}

function modal(html, onMount) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('.modal-bg', root).addEventListener('click', (e) => { if (e.target.classList.contains('modal-bg')) close(); });
  onMount?.($('.modal', root), close);
  $('.modal input, .modal select, .modal textarea, .modal button', root)?.focus();
  return close;
}

function confirmBox(text, okLabel = '確定', danger = false) {
  return new Promise((resolve) => {
    modal(`<p style="margin:0">${esc(text)}</p><div class="acts"><button type="button" class="btn" data-no>取消</button><button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okLabel)}</button></div>`,
      (m, close) => {
        $('[data-no]', m).onclick = () => { close(); resolve(false); };
        $('[data-yes]', m).onclick = () => { close(); resolve(true); };
      });
  });
}

/* ================= 登入 ================= */
let session = store.get('bole.session');
const LOGIN_DOMAIN = 'bole-inquiry.local';
const codeToEmail = (code) => `${code.trim().toLowerCase()}@${LOGIN_DOMAIN}`;

async function authCall(path, body, bearer) {
  const res = await fetch(`${BASE}/auth/v1/${path}`, {
    method: path === 'user' ? 'PUT' : 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error_description || data.msg || data.message || data.error || `登入服務錯誤（${res.status}）`);
  return data;
}

function keepSession(d) {
  session = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600), user: d.user };
  store.set('bole.session', session);
}

async function signIn(email, password) {
  keepSession(await authCall('token?grant_type=password', { email, password }));
}

async function accessToken() {
  if (!session) throw new AuthError();
  if (session.expires_at * 1000 - Date.now() < 60_000) {
    try { keepSession(await authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token })); }
    catch { signOutLocal(); throw new AuthError(); }
  }
  return session.access_token;
}

function signOutLocal() { session = null; store.del('bole.session'); }
async function signOut() {
  try { if (session) await authCall('logout', {}, session.access_token); } catch { /* 已失效也沒關係 */ }
  signOutLocal(); me = null; location.hash = '#/'; render();
}

class AuthError extends Error { constructor() { super('請重新登入'); } }

/* ================= 資料存取 ================= */
async function rest(method, path, { params, body, prefer, headers } = {}) {
  const tok = await accessToken();
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const res = await fetch(`${BASE}/rest/v1/${path}${qs}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { signOutLocal(); throw new AuthError(); }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const m = data?.message || `資料庫錯誤（${res.status}）`;
    throw new Error(/row-level security|permission denied/.test(m) ? '你的帳號沒有這個操作的權限'
      : /inquiries_case_no_uniq/.test(m) ? '這個仁寶案號已經連結到另一筆問案了'
      : m);
  }
  return data;
}

const db = {
  get: (table, params) => rest('GET', table, { params }),
  async all(table, params = {}) {
    const out = []; const size = 1000;
    for (let off = 0; ; off += size) {
      const page = await rest('GET', table, { params: { ...params, limit: size, offset: off } });
      out.push(...page);
      if (page.length < size) return out;
    }
  },
  insert: (table, body) => rest('POST', table, { body, prefer: 'return=representation' }).then((r) => r[0]),
  insertMany: (table, rows) => rest('POST', table, { body: rows, prefer: 'return=minimal' }),
  upsert: (table, body, onConflict) => rest('POST', table, { params: { on_conflict: onConflict }, body, prefer: 'resolution=merge-duplicates,return=representation' }).then((r) => r[0]),
  upsertMany: (table, rows, onConflict) => rest('POST', table, { params: { on_conflict: onConflict }, body: rows, prefer: 'resolution=merge-duplicates,return=minimal' }),
  update: (table, id, body) => rest('PATCH', table, { params: { id: `eq.${id}` }, body, prefer: 'return=representation' }).then((r) => {
    if (!r.length) throw new Error('你的帳號沒有這個操作的權限');
    return r[0];
  }),
  async remove(table, id) {
    const r = await rest('DELETE', table, { params: { id: `eq.${id}` }, prefer: 'return=representation' });
    if (!r.length) throw new Error('你的帳號沒有這個操作的權限');
  },
};

/* ================= 目前使用者與選項 ================= */
let me = null;            // 登入者在 staff 表的資料
let L = null;             // 下拉選項
const isDirector = () => me && (me.role === 'director' || me.role === 'admin');

async function loadMe() {
  const rows = await db.get('staff', { user_id: `eq.${session.user.id}`, active: 'eq.true', select: '*' });
  me = rows[0] || null;
}

async function loadLookups() {
  const [units, nc, rj, cond, sc, cg, staff] = await Promise.all([
    db.all('referral_units', { order: 'sort,name' }), db.all('nc_reasons', { order: 'sort,name' }),
    db.all('reject_reasons', { order: 'sort,name' }), db.all('special_conditions', { order: 'sort,name' }),
    db.all('service_codes', { order: 'sort,name' }),
    db.all('caregivers', { order: 'name' }), db.all('staff', { order: 'name' }),
  ]);
  const byId = (a) => Object.fromEntries(a.map((x) => [x.id, x]));
  L = { units, nc, rj, cond, sc, cg, staff, unitById: byId(units), ncById: byId(nc), rjById: byId(rj), condById: byId(cond), scById: byId(sc), cgById: byId(cg), staffById: byId(staff) };
}

// 下拉選單：只列啟用中的，但目前已選的值即使停用也保留
const activeOr = (list, cur) => list.filter((x) => x.active || String(x.id) === String(cur ?? ''));

/* ================= 外框與導覽 ================= */
let pendingJudge = 0;
async function refreshJudgeCount() {
  if (!isDirector()) return;
  try {
    const rows = await db.all('matches', { select: 'id', result: 'eq.拒絕', judgement: 'is.null' });
    pendingJudge = rows.length;
  } catch { pendingJudge = 0; }
  drawNav();
}

function drawNav() {
  const h = location.hash || '#/';
  const items = [['#/', '問案', /^#\/($|i\/|new)/], ['#/cases', '個案清單', /^#\/cases/], ['#/report', '派案紀錄', /^#\/report/], ['#/stats', '統計', /^#\/stats/], ['#/casecheck', '個案比對', /^#\/casecheck/]];
  if (isDirector()) {
    items.push(['#/judge', `拒案判定${pendingJudge ? `<span class="badge-n">${pendingJudge}</span>` : ''}`, /^#\/judge/]);
    items.push(['#/admin', '管理', /^#\/admin/]);
  }
  $('#nav').innerHTML = items.map(([href, label, re]) => `<a href="${href}" class="${re.test(h) ? 'on' : ''}">${label}</a>`).join('');
  $('#whoami').textContent = me ? `${me.name}${me.region ? ' · ' + me.region : ''}${isDirector() ? ' · ' + (me.role === 'admin' ? '管理者' : '主任') : ''}` : '';
}

/* ================= 路由 ================= */
async function render() {
  const main = $('#main');
  if (!BASE || BASE.includes('你的專案')) {
    $('#topbar').hidden = true;
    main.innerHTML = '<div class="card login"><h1>尚未設定</h1><p>請在 config.js 填入 Supabase 的網址與 anon key。</p></div>';
    return;
  }
  if (!session) { $('#topbar').hidden = true; return renderLogin(); }
  try {
    if (!me) { await loadMe(); }
    if (!me) {
      $('#topbar').hidden = true;
      main.innerHTML = `<div class="card login stack"><h1>帳號尚未啟用</h1><p>這個帳號還沒有連到人員名單，或已被停用。請聯絡管理者。</p><button type="button" class="btn" id="lo">登出</button></div>`;
      $('#lo').onclick = signOut; return;
    }
    if (!L) { await loadLookups(); refreshJudgeCount(); }
    $('#topbar').hidden = false; drawNav();
    const h = location.hash || '#/';
    let m;
    if (h === '#/' || h === '#' || h === '') await viewList();
    else if (h === '#/new') await viewForm(null);
    else if ((m = h.match(/^#\/i\/(\d+)\/edit(?:\?status=(.+))?$/))) await viewForm(Number(m[1]), m[2] ? decodeURIComponent(m[2]) : null);
    else if ((m = h.match(/^#\/i\/(\d+)$/))) await viewDetail(Number(m[1]));
    else if (h === '#/judge' && isDirector()) await viewJudge();
    else if (h === '#/casecheck') await viewCaseCheck();
    else if (h === '#/cases') await viewCases();
    else if (h === '#/report') await viewReport();
    else if (h === '#/stats') await viewStats();
    else if ((m = h.match(/^#\/admin(?:\/(\w+))?$/)) && isDirector()) await viewAdmin(m[1] || 'units');
    else main.innerHTML = '<div class="card empty">找不到這個頁面。<a href="#/">回問案列表</a></div>';
  } catch (e) {
    if (e instanceof AuthError) { render(); return; }
    main.innerHTML = `<div class="card"><p class="err-text">${esc(e.message)}</p><button type="button" class="btn" onclick="location.reload()">重新整理</button></div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);

/* ================= 登入頁 ================= */
function renderLogin() {
  $('#main').innerHTML = `
  <form class="card login stack" id="login">
    <div><h1>博樂居家系統</h1><p class="muted small" style="margin:4px 0 0">請用管理者給你的帳號登入</p></div>
    <label class="f">員工編號<input type="text" name="code" autocomplete="username" required></label>
    <label class="f">密碼<input type="password" name="password" autocomplete="current-password" required></label>
    <p class="err-text" id="lerr" hidden></p>
    <button class="btn primary" type="submit">登入</button>
    <p class="small faint" style="margin:0">忘記密碼請找管理者重設。</p>
  </form>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; const b = $('button', f); b.disabled = true;
    try {
      await signIn(codeToEmail(f.code.value), f.password.value);
      me = null; L = null; render();
    } catch (err) {
      const msg = /invalid/i.test(err.message) ? '帳號或密碼錯誤' : err.message;
      $('#lerr').textContent = msg; $('#lerr').hidden = false; b.disabled = false;
    }
  };
}

function changePassword() {
  modal(`<h2>修改密碼</h2>
    <label class="f">新密碼（至少 8 碼）<input type="password" id="pw1" autocomplete="new-password" minlength="8"></label>
    <label class="f">再輸入一次<input type="password" id="pw2" autocomplete="new-password"></label>
    <p class="err-text" id="pwerr" hidden></p>
    <div class="acts"><button type="button" class="btn" data-no>取消</button><button type="button" class="btn primary" data-yes>儲存</button></div>`,
  (m, close) => {
    $('[data-no]', m).onclick = close;
    $('[data-yes]', m).onclick = async () => {
      const a = $('#pw1', m).value, b = $('#pw2', m).value, er = $('#pwerr', m);
      if (a.length < 8) { er.textContent = '密碼至少要 8 碼'; er.hidden = false; return; }
      if (a !== b) { er.textContent = '兩次輸入的密碼不一樣'; er.hidden = false; return; }
      try { await authCall('user', { password: a }, await accessToken()); close(); toast('密碼已更新'); }
      catch (e) { er.textContent = e.message; er.hidden = false; }
    };
  });
}

/* ================= 問案列表 ================= */
const listState = store.get('bole.list') || { region: null, status: '全部', year: '全部', month: '全部', q: '', mine: false, dateSort: 'desc' };
if (!listState.dateSort) listState.dateSort = 'desc';
if (!listState.month) listState.month = '全部';
let listShow = 100;

async function viewList() {
  if (listState.region === null) listState.region = me.region || '全部';
  const rows = await db.all('inquiries_v', {
    select: 'id,code,region,inquiry_date,unit_name,case_manager,client_name,address,service_detail,condition_names,intake_staff_id,lead_staff_id,intake_name,status,match_total,match_rejected,match_accepted,match_pending',
    order: 'inquiry_date.desc.nullslast,code.desc',
  });
  const years = [...new Set(rows.map((r) => rocYear(r.inquiry_date)).filter(Boolean))].sort((a, b) => b - a);
  const draw = () => {
    store.set('bole.list', listState);
    const q = listState.q.trim().toLowerCase();
    const base = rows.filter((r) => (listState.region === '全部' || r.region === listState.region)
      && (listState.year === '全部' || String(rocYear(r.inquiry_date)) === String(listState.year))
      && (listState.month === '全部' || (r.inquiry_date && Number(r.inquiry_date.slice(5, 7)) === Number(listState.month)))
      && (!listState.mine || r.intake_staff_id === me.id || r.lead_staff_id === me.id)
      && (!q || [r.code, r.client_name, r.unit_name, r.case_manager, r.address, r.service_detail].some((x) => (x || '').toLowerCase().includes(q))));
    const shown = base.filter((r) => listState.status === '全部' || r.status === listState.status)
      .sort((a, b) => {
        if (!a.inquiry_date && !b.inquiry_date) return 0;
        if (!a.inquiry_date) return 1;
        if (!b.inquiry_date) return -1;
        return listState.dateSort === 'asc' ? a.inquiry_date.localeCompare(b.inquiry_date) : b.inquiry_date.localeCompare(a.inquiry_date);
      });
    const count = (s) => base.filter((r) => s === '全部' || r.status === s).length;
    const sortIcon = listState.dateSort === 'asc' ? '▲' : '▼';
    $('#main').innerHTML = `
    <div class="head"><div><h1>問案</h1><div class="muted small" style="margin-top:4px">共 ${shown.length} 筆</div></div>
      <div class="right"><a class="btn primary" href="#/new">＋ 新增問案</a></div></div>
    <div class="card filters">
      <div class="seg" role="group" aria-label="區域">${['全部', ...REGIONS].map((r) => `<button type="button" data-region="${r}" class="${listState.region === r ? 'on' : ''}">${r}</button>`).join('')}</div>
      <div class="pills" role="group" aria-label="狀態">${['全部', ...STATUSES].map((s) => `<button type="button" data-status="${s}" class="${listState.status === s ? 'on' : ''}">${s}<span>${count(s)}</span></button>`).join('')}</div>
      <label class="inline-check">年度 <select id="fyear">${opt('全部', '全部', listState.year)}${years.map((y) => opt(y, `${y} 年`, listState.year)).join('')}</select></label>
      <label class="inline-check">月份 <select id="fmonth" ${listState.year === '全部' ? 'disabled' : ''}>${opt('全部', '全部', listState.month)}${Array.from({ length: 12 }, (_, i) => opt(i + 1, `${i + 1} 月`, listState.month)).join('')}</select></label>
      <label class="inline-check"><input type="checkbox" id="fmine" ${listState.mine ? 'checked' : ''}>我負責的</label>
      <input type="search" class="grow" id="fq" placeholder="搜尋個案、單位、地址、編號" value="${esc(listState.q)}" aria-label="搜尋">
    </div>
    <div class="tbox"><table class="t" style="min-width:1000px">
      <thead><tr><th>編號</th><th id="th-date" style="cursor:pointer;user-select:none" title="點擊排序">問案日期 <span class="small muted">${sortIcon}</span></th><th>區域</th><th>轉介單位</th><th>個案</th><th>服務需求</th><th>特殊條件</th><th>收案督導</th><th>媒合</th><th>狀態</th></tr></thead>
      <tbody>${shown.slice(0, listShow).map((r) => `
        <tr class="click" data-id="${r.id}">
          <td class="nowrap"><a href="#/i/${r.id}">${esc(r.code)}</a></td>
          <td class="nowrap">${fmtDate(r.inquiry_date)}</td>
          <td>${esc(r.region)}</td>
          <td class="nowrap">${esc(r.unit_name)}${r.case_manager ? `<div class="sub">個管 ${esc(r.case_manager)}</div>` : ''}</td>
          <td class="nowrap">${esc(r.client_name || '—')}<div class="sub">${esc(r.address || '')}</div></td>
          <td class="mono" style="max-width:240px">${esc(r.service_detail || '')}</td>
          <td>${(r.condition_names || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</td>
          <td class="nowrap">${esc(r.intake_name || '')}</td>
          <td class="nowrap small">${matchSummary(r)}</td>
          <td><span class="st s-${r.status}">${r.status}</span></td>
        </tr>`).join('') || '<tr><td colspan="10" class="empty">沒有符合條件的問案</td></tr>'}</tbody>
    </table>${shown.length > listShow ? `<div class="more"><button type="button" class="btn" id="more">再顯示 100 筆（還有 ${shown.length - listShow} 筆）</button></div>` : ''}</div>`;
    $$('[data-region]').forEach((b) => (b.onclick = () => { listState.region = b.dataset.region; listShow = 100; draw(); }));
    $$('[data-status]').forEach((b) => (b.onclick = () => { listState.status = b.dataset.status; listShow = 100; draw(); }));
    $('#fyear').onchange = (e) => { listState.year = e.target.value; if (listState.year === '全部') listState.month = '全部'; listShow = 100; draw(); };
    $('#fmonth').onchange = (e) => { listState.month = e.target.value; listShow = 100; draw(); };
    $('#fmine').onchange = (e) => { listState.mine = e.target.checked; listShow = 100; draw(); };
    $('#fq').oninput = (e) => { listState.q = e.target.value; listShow = 100; clearTimeout(draw._t); draw._t = setTimeout(() => { draw(); const i = $('#fq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
    $('#more')?.addEventListener('click', () => { listShow += 100; draw(); });
    $('#th-date').onclick = () => { listState.dateSort = listState.dateSort === 'asc' ? 'desc' : 'asc'; listShow = 100; draw(); };
    $$('tr.click').forEach((tr) => (tr.onclick = (e) => { if (e.target.closest('a')) return; location.hash = `#/i/${tr.dataset.id}`; }));
  };
  draw();
}

function matchSummary(r) {
  if (!r.match_total) return '<span class="faint">尚未媒合</span>';
  const parts = [`已問 ${r.match_total} 位`];
  if (r.match_accepted) parts.push(`${r.match_accepted} 接受`);
  if (r.match_rejected) parts.push(`${r.match_rejected} 拒絕`);
  if (r.match_pending) parts.push(`${r.match_pending} 待回覆`);
  return parts.join(' · ');
}

/* ================= 問案表單（新增／編輯） ================= */
async function viewForm(id, presetStatus) {
  let r = { region: me.region || '新莊', inquiry_date: todayISO(), intake_staff_id: me.id, status: '問案中', condition_ids: [] };
  if (id) { const rows = await db.get('inquiries', { id: `eq.${id}`, select: '*' }); if (!rows.length) throw new Error('找不到這筆問案'); r = rows[0]; }
  if (presetStatus) r.status = presetStatus;
  const staffOpts = (cur) => opt('', '請選擇', cur) + activeOr(L.staff, cur).map((s) => opt(s.id, s.name + (s.region ? `（${s.region}）` : ''), cur)).join('');
  $('#main').innerHTML = `
  <a href="${id ? `#/i/${id}` : '#/'}" class="small" style="text-decoration:none">← ${id ? '回問案明細' : '回問案列表'}</a>
  <div class="head" style="margin-top:10px"><h1>${id ? `編輯問案 ${esc(r.code)}` : '新增問案'}</h1></div>
  <form class="card stack" id="f" novalidate>
    <div class="grid3">
      <label class="f">區域 <span class="req">*</span><select name="region">${REGIONS.map((x) => opt(x, x, r.region)).join('')}</select></label>
      <label class="f">問案日期 <span class="req">*</span><input type="date" name="inquiry_date" value="${esc(r.inquiry_date || '')}"></label>
      <label class="f">收案督導 <span class="req">*</span><select name="intake_staff_id">${staffOpts(r.intake_staff_id)}</select></label>
      <label class="f">轉介單位 <span class="req">*</span><select name="unit_id">${opt('', '請選擇', r.unit_id)}${activeOr(L.units, r.unit_id).map((u) => opt(u.id, u.name, r.unit_id)).join('')}</select></label>
      <label class="f">個管師<input type="text" name="case_manager" value="${esc(r.case_manager || '')}" placeholder="姓氏即可"></label>
      <label class="f">個案姓名 <span class="req">*</span><input type="text" name="client_name" value="${esc(r.client_name || '')}"></label>
      <label class="f spanall">地址（區／路名即可） <span class="req">*</span><input type="text" name="address" value="${esc(r.address || '')}"></label>
      ${id ? `<label class="f spanall">個案細項與安排 <span class="req">*</span><textarea name="service_detail" placeholder="頻次、時段、碼別，例：W1.3.5 BA16">${esc(r.service_detail || '')}</textarea></label>` : `
      <fieldset class="spanall" id="svc-builder">
        <legend>個案細項與安排 <span class="req">*</span></legend>
        <p class="small muted" style="margin:0 0 6px">勾選星期、時段、碼別，系統會自動組成統一格式，例如：W135 08:00-09:00 BA13/BA20*2</p>
        <div class="checks">${['一', '二', '三', '四', '五', '六', '日'].map((d, i) => `<label><input type="checkbox" name="svc_day" value="${i + 1}">週${d}</label>`).join('')}</div>
        <div class="grid3" style="margin-top:8px">
          <label class="f">開始時間<input type="time" name="svc_start"></label>
          <label class="f">結束時間<input type="time" name="svc_end"></label>
        </div>
        <div class="checks" style="margin-top:8px">${activeOr(L.sc, null).map((c) => `<label class="svc-code"><input type="checkbox" name="svc_code" value="${c.id}" data-code="${esc(c.code || '')}">${esc(c.code ? c.code + ' ' : '')}${esc(c.name)}<input type="number" name="svc_qty" data-for="${c.id}" min="1" value="1" style="width:48px;margin-left:4px" hidden></label>`).join('')}</div>
        <label class="f spanall" style="margin-top:8px">補充說明<input type="text" name="svc_note" placeholder="其他安排細節（選填）"></label>
        <div class="small muted" style="margin-top:6px">預覽：<span id="svc-preview" class="mono">（尚未填寫）</span></div>
        <textarea name="service_detail" hidden></textarea>
      </fieldset>`}
      <fieldset class="spanall"><legend>特殊條件</legend><div class="checks">${activeOr(L.cond, null).concat(L.cond.filter((c) => !c.active && (r.condition_ids || []).includes(c.id))).map((c) => `<label><input type="checkbox" name="cond" value="${c.id}" data-other="${c.name === '其他' ? '1' : ''}" ${(r.condition_ids || []).includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('')}</div>
        <label class="f" id="cond-other-note" hidden>其他說明<input type="text" name="condition_other_note" value="${esc(r.condition_other_note || '')}"></label>
      </fieldset>
    </div>
    <hr style="border:0;border-top:1px solid var(--line2);margin:4px 0">
    <div class="grid3">
      <label class="f">狀態<select name="status" id="fstatus">${(id ? STATUSES : STATUSES.filter((s) => s !== '成案')).map((s) => opt(s, s, r.status)).join('')}</select></label>
      <label class="f">預計主責居服<input type="text" name="expected_caregiver" list="cglist" value="${esc(r.expected_caregiver || '')}" placeholder="媒合接受後會自動帶入"></label>
      <datalist id="cglist">${L.cg.filter((c) => c.active).map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
      <label class="f" data-for="成案">主責督導 <span class="req">*</span><select name="lead_staff_id">${staffOpts(r.lead_staff_id)}</select></label>
      <label class="f" data-for="成案">照會日期 <span class="req">*</span><input type="date" name="referral_date" value="${esc(r.referral_date || '')}"></label>
      <label class="f" data-for="成案">簽約日 <span class="req">*</span><input type="date" name="contract_date" value="${esc(r.contract_date || '')}"></label>
      <label class="f" data-for="成案">仁寶案號<input type="text" name="case_no" value="${esc(r.case_no || '')}" placeholder="選填，之後也能用個案比對批次帶入"></label>
      <label class="f" data-for="未成案">未成案原因 <span class="req">*</span><select name="nc_reason_id">${opt('', '請選擇', r.nc_reason_id)}${activeOr(L.nc, r.nc_reason_id).map((x) => opt(x.id, x.name, r.nc_reason_id)).join('')}</select></label>
      <label class="f span2" data-for="未成案">未成案說明<input type="text" name="nc_note" value="${esc(r.nc_note || '')}"></label>
      <label class="f spanall">特殊事項<textarea name="remarks" style="min-height:60px">${esc(r.remarks || '')}</textarea></label>
    </div>
    <p class="err-text" id="ferr" hidden></p>
    <div style="display:flex;gap:8px;justify-content:flex-end"><a class="btn" href="${id ? `#/i/${id}` : '#/'}">取消</a><button type="submit" class="btn primary">儲存</button></div>
  </form>`;
  const f = $('#f');
  const sync = () => { $$('[data-for]', f).forEach((el) => { el.hidden = el.dataset.for !== f.status.value; }); };
  f.status.onchange = sync; sync();
  const syncOther = () => { $('#cond-other-note').hidden = !$('input[data-other="1"]', f)?.checked; };
  $$('input[name=cond]', f).forEach((c) => (c.onchange = syncOther)); syncOther();
  if (!id) {
    const syncSvc = () => {
      $$('input[name=svc_code]', f).forEach((cb) => { const q = $(`input[name=svc_qty][data-for="${cb.value}"]`, f); if (q) q.hidden = !cb.checked; });
      const days = $$('input[name=svc_day]:checked', f).map((c) => c.value);
      const codes = $$('input[name=svc_code]:checked', f).map((c) => {
        const qty = Number($(`input[name=svc_qty][data-for="${c.value}"]`, f)?.value || 1);
        return c.dataset.code + (qty > 1 ? `*${qty}` : '');
      });
      const start = f.svc_start.value, end = f.svc_end.value;
      const note = f.svc_note.value.trim();
      const parts = [];
      if (days.length) parts.push('W' + days.join(''));
      if (start && end) parts.push(`${start}-${end}`);
      if (codes.length) parts.push(codes.join('/'));
      let s = parts.join(' ');
      if (note) s += (s ? '　' : '') + note;
      f.service_detail.value = s;
      $('#svc-preview').textContent = s || '（尚未填寫）';
    };
    $('#svc-builder').addEventListener('input', syncSvc);
    $('#svc-builder').addEventListener('change', syncSvc);
    syncSvc();
  }
  if (presetStatus) $(`[data-for="${presetStatus}"] select, [data-for="${presetStatus}"] input`, f)?.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = (n) => f[n].value.trim() || null;
    const num = (n) => (f[n].value ? Number(f[n].value) : null);
    const body = {
      region: v('region'), inquiry_date: v('inquiry_date'), intake_staff_id: num('intake_staff_id'), unit_id: num('unit_id'),
      case_manager: v('case_manager'), client_name: v('client_name'), address: v('address'), service_detail: v('service_detail'),
      condition_ids: $$('input[name=cond]:checked', f).map((c) => Number(c.value)),
      condition_other_note: $('input[data-other="1"]', f)?.checked ? v('condition_other_note') : null,
      status: v('status'), expected_caregiver: v('expected_caregiver'), remarks: v('remarks'),
      lead_staff_id: num('lead_staff_id'), referral_date: v('referral_date'), contract_date: v('contract_date'),
      case_no: v('case_no'),
      nc_reason_id: num('nc_reason_id'), nc_note: v('nc_note'),
    };
    const miss = [];
    if (!body.region) miss.push('區域'); if (!body.inquiry_date) miss.push('問案日期'); if (!body.intake_staff_id) miss.push('收案督導');
    if (!body.unit_id) miss.push('轉介單位'); if (!body.client_name) miss.push('個案姓名'); if (!body.address) miss.push('地址');
    if (!body.service_detail) miss.push('個案細項與安排');
    if (body.status === '成案') { if (!body.lead_staff_id) miss.push('主責督導'); if (!body.referral_date) miss.push('照會日期'); if (!body.contract_date) miss.push('簽約日'); }
    if (body.status === '未成案' && !body.nc_reason_id) miss.push('未成案原因');
    const er = $('#ferr');
    if (miss.length) { er.textContent = `請填寫：${miss.join('、')}`; er.hidden = false; return; }
    const btn = $('button[type=submit]', f); btn.disabled = true;
    try {
      const saved = id ? await db.update('inquiries', id, body) : await db.insert('inquiries', body);
      toast(id ? '已儲存' : `已新增問案 ${saved.code}`);
      location.hash = `#/i/${saved.id}`;
    } catch (err) { er.textContent = err.message; er.hidden = false; btn.disabled = false; }
  };
}

/* ================= 問案明細 ================= */
const FIELD_LABEL = {
  region: '區域', inquiry_date: '問案日期', unit_id: '轉介單位', case_manager: '個管師', client_name: '個案姓名', address: '地址',
  service_detail: '個案細項與安排', condition_ids: '特殊條件', condition_other_note: '特殊條件其他說明', intake_staff_id: '收案督導', status: '狀態', expected_caregiver: '預計主責居服',
  lead_staff_id: '主責督導', referral_date: '照會日期', contract_date: '簽約日', case_no: '仁寶案號', nc_reason_id: '未成案原因', nc_note: '未成案說明', remarks: '特殊事項',
  contact_date: '聯絡日期', caregiver_id: '居服員', staff_id: '問案督導', within_7km: '7 公里內', result: '結果', reject_reason_ids: '拒絕原因',
  reject_note: '拒絕說明', judgement: '是否列為拒案', judge_note: '判定備註',
};
const HIDDEN_FIELDS = new Set(['id', 'code', 'created_at', 'created_by', 'updated_at', 'updated_by', 'inquiry_id', 'judged_by', 'judged_at', 'legacy_ref']);
function showVal(k, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return '（空）';
  if (k === 'unit_id') return L.unitById[v]?.name || v;
  if (k === 'intake_staff_id' || k === 'lead_staff_id' || k === 'staff_id') return L.staffById[v]?.name || v;
  if (k === 'caregiver_id') return L.cgById[v]?.name || v;
  if (k === 'nc_reason_id') return L.ncById[v]?.name || v;
  if (k === 'condition_ids') return v.map((x) => L.condById[x]?.name || x).join('、');
  if (k === 'reject_reason_ids') return v.map((x) => L.rjById[x]?.name || x).join('、');
  if (k === 'within_7km') return v ? '是' : '否';
  if (/_date$/.test(k)) return fmtDate(v);
  return String(v);
}
function describeLog(a) {
  const what = a.table_name === 'inquiries' ? '問案' : '媒合紀錄';
  if (a.action === 'insert') {
    if (a.table_name === 'matches') return `新增媒合紀錄：${showVal('caregiver_id', a.changes.caregiver_id)}（${a.changes.result}）`;
    return '建立問案';
  }
  if (a.action === 'delete') return a.table_name === 'matches' ? `刪除媒合紀錄：${showVal('caregiver_id', a.changes.caregiver_id)}` : '刪除問案';
  const parts = Object.entries(a.changes).filter(([k]) => !HIDDEN_FIELDS.has(k)).map(([k, [o, n]]) => `${FIELD_LABEL[k] || k}：${showVal(k, o)} → ${showVal(k, n)}`);
  return parts.length ? `修改${what}｜${parts.join('；')}` : null;
}

async function viewDetail(id) {
  const [rows, matches, logs] = await Promise.all([
    db.get('inquiries_v', { id: `eq.${id}`, select: '*' }),
    db.all('matches_v', { inquiry_id: `eq.${id}`, order: 'contact_date.desc,id.desc' }),
    db.all('audit_log', { inquiry_id: `eq.${id}`, order: 'at.desc' }),
  ]);
  if (!rows.length) throw new Error('找不到這筆問案');
  const r = rows[0];
  const dd = (label, val, wide) => `<div class="${wide ? 'wide' : ''}"><dt>${label}</dt><dd>${val || '<span class="faint">—</span>'}</dd></div>`;
  const nRej = matches.filter((m) => m.result === '拒絕').length, nAcc = matches.filter((m) => m.result === '接受').length, nWait = matches.filter((m) => m.result === '待回覆').length;
  const logItems = logs.map((a) => { const d = describeLog(a); return d ? `<li>${fmtTime(a.at)} ${esc(a.actor_name || '')}｜${esc(d)}</li>` : ''; }).join('');

  $('#main').innerHTML = `
  <a href="#/" class="small" style="text-decoration:none">← 回問案列表</a>
  <div class="head" style="margin-top:10px">
    <h1>${esc(r.client_name || '（未填姓名）')}</h1>
    <span class="st s-${r.status}">${r.status}</span>
    <span class="muted small">${esc(r.code)} · ${esc(r.region)} · ${fmtDate(r.inquiry_date)} 問案</span>
    <div class="right">
      ${isDirector() ? '<button type="button" class="btn ghost-danger" id="del">刪除</button>' : ''}
      <a class="btn" href="#/i/${id}/edit">編輯</a>
      ${r.status !== '未成案' ? `<a class="btn" href="#/i/${id}/edit?status=${encodeURIComponent('未成案')}">標記未成案</a>` : ''}
      ${r.status !== '成案' ? `<a class="btn primary" href="#/i/${id}/edit?status=${encodeURIComponent('成案')}">標記成案</a>` : ''}
    </div>
  </div>
  <div class="cols">
    <section class="card side stack">
      <h2>問案資料</h2>
      <dl class="data">
        ${dd('轉介單位', esc(r.unit_name))}${dd('個管師', esc(r.case_manager))}
        ${dd('收案督導', esc(r.intake_name))}${dd('主責督導', esc(r.lead_name))}
        ${dd('地址', esc(r.address), true)}
        ${dd('個案細項與安排', r.service_detail ? `<span class="mono">${esc(r.service_detail)}</span>` : '', true)}
        ${dd('特殊條件', (r.condition_names || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('') + (r.condition_other_note ? ` <span class="small muted">${esc(r.condition_other_note)}</span>` : ''), true)}
        ${dd('預計主責居服', esc(r.expected_caregiver))}${dd('照會日期／簽約日', [fmtDate(r.referral_date), fmtDate(r.contract_date)].filter(Boolean).join(' ／ '))}
        ${dd('仁寶案號', esc(r.case_no))}
        ${r.status === '未成案' ? dd('未成案原因', esc(r.nc_reason_name)) + dd('未成案說明', esc(r.nc_note)) : ''}
        ${dd('特殊事項', esc(r.remarks), true)}
        ${r.legacy_ref ? dd('舊資料來源', `<span class="small muted">${esc(r.legacy_ref)}</span>`, true) : ''}
      </dl>
    </section>
    <section class="main stack">
      <div class="card">
        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:6px">
          <h2>媒合紀錄</h2>
          <span class="muted small">${matches.length ? `已問 ${matches.length} 位${nAcc ? ` · ${nAcc} 接受` : ''}${nRej ? ` · ${nRej} 拒絕` : ''}${nWait ? ` · ${nWait} 待回覆` : ''}` : '尚未媒合'}</span>
        </div>
        ${matches.map(matchItem).join('') || '<p class="muted small" style="margin:8px 0 0">還沒有媒合紀錄，從下方新增。</p>'}
      </div>
      <div class="card" id="mform-box"></div>
    </section>
  </div>
  <details class="card log" style="margin-top:20px"><summary>修改紀錄（${logs.length}）</summary>
    ${logItems ? `<ul>${logItems}</ul>` : '<p class="muted small">沒有修改紀錄（匯入的舊資料不會產生紀錄）。</p>'}
  </details>`;

  drawMatchForm(r, null);
  $$('[data-edit-match]').forEach((b) => (b.onclick = () => { drawMatchForm(r, matches.find((m) => m.id === Number(b.dataset.editMatch))); $('#mform-box').scrollIntoView({ behavior: 'smooth' }); }));
  $$('[data-del-match]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('確定要刪除這筆媒合紀錄嗎？', '刪除', true))) return;
    try { await db.remove('matches', Number(b.dataset.delMatch)); toast('已刪除'); render(); } catch (e) { toast(e.message, true); }
  }));
  $$('[data-judge]').forEach((b) => (b.onclick = async () => {
    const [mid, val] = b.dataset.judge.split(':');
    try { await db.update('matches', Number(mid), { judgement: val || null }); toast('已判定'); refreshJudgeCount(); render(); } catch (e) { toast(e.message, true); }
  }));
  $('#del')?.addEventListener('click', async () => {
    if (!(await confirmBox(`確定要刪除問案 ${r.code} 嗎？底下的媒合紀錄也會一起刪除，無法復原。`, '刪除', true))) return;
    try { await db.remove('inquiries', id); toast('已刪除'); location.hash = '#/'; } catch (e) { toast(e.message, true); }
  });
}

function judgeBadge(m) {
  if (m.result !== '拒絕') return '';
  if (m.judgement === 'V') return '<span class="st j-V">列為拒案 V</span>';
  if (m.judgement === 'X') return '<span class="st j-X">不列為拒案 X</span>';
  return '<span class="st j-pending">待主任判定</span>';
}

function matchItem(m) {
  return `<article class="match">
    <div class="date">${fmtDate(m.contact_date)}</div>
    <div class="body">
      <div class="top"><strong>${esc(m.caregiver_name)}</strong><span class="st r-${m.result}">${m.result}</span>
        <span class="small muted">7 公里內：${m.within_7km === null ? '—' : m.within_7km ? '是' : '否'}${m.staff_name ? ` · 問案督導 ${esc(m.staff_name)}` : ''}</span></div>
      ${(m.reject_reason_names || []).length ? `<div>${m.reject_reason_names.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : ''}
      ${m.reject_note ? `<div class="small" style="color:var(--ink2)">${esc(m.reject_note)}</div>` : ''}
      <div class="acts">${judgeBadge(m)}${m.judge_note ? `<span class="small muted">備註：${esc(m.judge_note)}</span>` : ''}${m.judged_by_name ? `<span class="small faint">${esc(m.judged_by_name)} ${fmtTime(m.judged_at)}</span>` : ''}</div>
      <div class="acts">
        <button type="button" class="link" data-edit-match="${m.id}">編輯</button>
        ${isDirector() && m.result === '拒絕' ? `${m.judgement !== 'V' ? `<button type="button" class="btn small" data-judge="${m.id}:V">列為拒案 V</button>` : ''}${m.judgement !== 'X' ? `<button type="button" class="btn small" data-judge="${m.id}:X">不列為拒案 X</button>` : ''}${m.judgement ? `<button type="button" class="link" data-judge="${m.id}:">清除判定</button>` : ''}` : ''}
        ${isDirector() ? `<button type="button" class="link" style="color:var(--bad)" data-del-match="${m.id}">刪除</button>` : ''}
      </div>
    </div></article>`;
}

function drawMatchForm(inq, m) {
  const box = $('#mform-box');
  const cur = m || { contact_date: todayISO(), result: '拒絕', within_7km: true, reject_reason_ids: [] };
  const cgs = L.cg.filter((c) => (c.active && (!c.region || c.region === inq.region)) || c.id === cur.caregiver_id);
  const others = L.cg.filter((c) => c.active && c.region && c.region !== inq.region && c.id !== cur.caregiver_id);
  box.innerHTML = `<form class="stack" id="mf" novalidate>
    <h2>${m ? `編輯媒合紀錄：${esc(m.caregiver_name)}` : '新增媒合紀錄'}</h2>
    <div class="grid2">
      <label class="f">居服員 <span class="req">*</span><select name="caregiver_id">${opt('', '請選擇', cur.caregiver_id)}
        <optgroup label="${esc(inq.region)}">${cgs.map((c) => opt(c.id, c.name + (c.code ? ` ${c.code}` : ''), cur.caregiver_id)).join('')}</optgroup>
        ${others.length ? `<optgroup label="其他區">${others.map((c) => opt(c.id, `${c.name}（${c.region}）`, cur.caregiver_id)).join('')}</optgroup>` : ''}</select></label>
      <label class="f">聯絡日期 <span class="req">*</span><input type="date" name="contact_date" value="${esc(cur.contact_date)}"></label>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:12px 32px">
      <fieldset><legend>前後案距離皆在 7 公里內</legend><div class="radios">
        <label><input type="radio" name="km" value="1" ${cur.within_7km === true ? 'checked' : ''}>是</label>
        <label><input type="radio" name="km" value="0" ${cur.within_7km === false ? 'checked' : ''}>否</label></div></fieldset>
      <fieldset><legend>結果</legend><div class="radios">${['接受', '拒絕', '待回覆'].map((x) => `<label><input type="radio" name="result" value="${x}" ${cur.result === x ? 'checked' : ''}>${x}</label>`).join('')}</div></fieldset>
    </div>
    <div id="rj-part" class="stack">
      <fieldset><legend>拒絕原因（可複選） <span style="color:var(--bad-strong)">*</span></legend><div class="checks">
        ${L.rj.filter((x) => x.active || (cur.reject_reason_ids || []).includes(x.id)).map((x) => `<label><input type="checkbox" name="rj" value="${x.id}" data-other="${x.name === '其他' ? '1' : ''}" ${(cur.reject_reason_ids || []).includes(x.id) ? 'checked' : ''}>${esc(x.name)}</label>`).join('')}
      </div></fieldset>
      <label class="f">拒絕說明<span class="req" id="rj-other-req" hidden> *</span><textarea name="reject_note" style="min-height:60px" placeholder="居服員原話或細節">${esc(cur.reject_note || '')}</textarea></label>
    </div>
    <p class="err-text" id="merr" hidden></p>
    <div style="display:flex;gap:8px;justify-content:flex-end">${m ? '<button type="button" class="btn" id="mcancel">取消編輯</button>' : ''}<button type="submit" class="btn primary">${m ? '儲存修改' : '儲存紀錄'}</button></div>
  </form>`;
  const f = $('#mf');
  const sync = () => { $('#rj-part').hidden = f.result.value !== '拒絕'; };
  $$('input[name=result]', f).forEach((x) => (x.onchange = sync)); sync();
  const syncOtherRj = () => { $('#rj-other-req').hidden = !$('input[name=rj][data-other="1"]', f)?.checked; };
  $$('input[name=rj]', f).forEach((x) => (x.onchange = syncOtherRj)); syncOtherRj();
  $('#mcancel')?.addEventListener('click', () => drawMatchForm(inq, null));
  f.onsubmit = async (e) => {
    e.preventDefault();
    const er = $('#merr');
    const km = $('input[name=km]:checked', f)?.value;
    const body = {
      caregiver_id: f.caregiver_id.value ? Number(f.caregiver_id.value) : null, contact_date: f.contact_date.value || null,
      within_7km: km === undefined ? null : km === '1', result: f.result.value,
      reject_reason_ids: f.result.value === '拒絕' ? $$('input[name=rj]:checked', f).map((x) => Number(x.value)) : [],
      reject_note: f.result.value === '拒絕' ? (f.reject_note.value.trim() || null) : null,
    };
    const otherChecked = $('input[name=rj][data-other="1"]', f)?.checked;
    const miss = [];
    if (!body.caregiver_id) miss.push('居服員'); if (!body.contact_date) miss.push('聯絡日期');
    if (body.within_7km === null) miss.push('7 公里內');
    if (body.result === '拒絕' && !body.reject_reason_ids.length) miss.push('拒絕原因');
    if (body.result === '拒絕' && otherChecked && !body.reject_note) miss.push('拒絕說明（勾選其他時必填）');
    if (miss.length) { er.textContent = `請填寫：${miss.join('、')}`; er.hidden = false; return; }
    const btn = $('button[type=submit]', f); btn.disabled = true;
    try {
      if (m) await db.update('matches', m.id, body);
      else await db.insert('matches', { ...body, inquiry_id: inq.id, staff_id: me.id });
      if (body.result === '接受' && inq.status !== '成案') await promptAcceptCase(inq);
      toast('已儲存媒合紀錄'); refreshJudgeCount(); render();
    } catch (err) { er.textContent = err.message; er.hidden = false; btn.disabled = false; }
  };
}

/* 居服員接受媒合後，詢問是否直接標記成案並補齊進階欄位 */
function promptAcceptCase(inq) {
  return new Promise((resolve) => {
    const staffOpts = (cur) => opt('', '請選擇', cur) + activeOr(L.staff, cur).map((s) => opt(s.id, s.name + (s.region ? `（${s.region}）` : ''), cur)).join('');
    modal(`<h2>居服員已接受，要標記成案嗎？</h2>
      <p class="muted small" style="margin:0 0 8px">確定承接才需要填寫以下欄位，之後也可以在問案明細裡補填。</p>
      <div class="stack">
        <label class="f">主責督導 <span class="req">*</span><select name="lead_staff_id">${staffOpts(me.id)}</select></label>
        <label class="f">照會日期 <span class="req">*</span><input type="date" name="referral_date" value="${esc(todayISO())}"></label>
        <label class="f">簽約日 <span class="req">*</span><input type="date" name="contract_date"></label>
        <p class="err-text" id="acerr" hidden></p>
      </div>
      <div class="acts"><button type="button" class="btn" data-no>先不要</button><button type="button" class="btn primary" data-yes>標記成案</button></div>`,
    (box, close) => {
      $('[data-no]', box).onclick = () => { close(); resolve(); };
      $('[data-yes]', box).onclick = async () => {
        const lead_staff_id = $('[name=lead_staff_id]', box).value ? Number($('[name=lead_staff_id]', box).value) : null;
        const referral_date = $('[name=referral_date]', box).value || null;
        const contract_date = $('[name=contract_date]', box).value || null;
        const er = $('#acerr', box);
        const miss = [];
        if (!lead_staff_id) miss.push('主責督導'); if (!referral_date) miss.push('照會日期'); if (!contract_date) miss.push('簽約日');
        if (miss.length) { er.textContent = `請填寫：${miss.join('、')}`; er.hidden = false; return; }
        try {
          await db.update('inquiries', inq.id, { status: '成案', lead_staff_id, referral_date, contract_date });
          close(); resolve();
        } catch (e) { er.textContent = e.message; er.hidden = false; }
      };
    });
  });
}

/* ================= 拒案判定（主任） ================= */
const judgeState = { tab: '待判定', region: '全部', year: '全部', month: '全部' };
async function viewJudge() {
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const [list, vThisYear] = await Promise.all([
    db.all('matches_v', { result: 'eq.拒絕', judgement: judgeState.tab === '待判定' ? 'is.null' : 'not.is.null', order: judgeState.tab === '待判定' ? 'contact_date.desc,id.desc' : 'judged_at.desc.nullslast,contact_date.desc' }),
    db.all('matches', { select: 'caregiver_id', judgement: 'eq.V', contact_date: `gte.${yearStart}` }),
  ]);
  const vCount = {}; vThisYear.forEach((x) => { vCount[x.caregiver_id] = (vCount[x.caregiver_id] || 0) + 1; });
  const years = [...new Set(list.map((m) => rocYear(m.contact_date)).filter(Boolean))].sort((a, b) => b - a);
  const shown = list.filter((m) => (judgeState.region === '全部' || m.region === judgeState.region)
    && (judgeState.year === '全部' || String(rocYear(m.contact_date)) === String(judgeState.year))
    && (judgeState.month === '全部' || (m.contact_date && Number(m.contact_date.slice(5, 7)) === Number(judgeState.month))))
    .slice(0, judgeState.tab === '待判定' ? 500 : 200);
  $('#main').innerHTML = `
  <div class="head"><div><h1>拒案判定</h1><div class="muted small" style="margin-top:4px">督導記錄居服員「拒絕」後會出現在這裡。只有主任與管理者看得到這一頁。</div></div></div>
  <div class="filters">
    <div class="seg" role="group" aria-label="判定狀態">${['待判定', '已判定'].map((t) => `<button type="button" data-tab="${t}" class="${judgeState.tab === t ? 'on' : ''}">${t}${t === '待判定' ? `（${pendingJudge}）` : ''}</button>`).join('')}</div>
    <div class="seg" role="group" aria-label="區域">${['全部', ...REGIONS].map((r) => `<button type="button" data-region="${r}" class="${judgeState.region === r ? 'on' : ''}">${r}</button>`).join('')}</div>
    <label class="inline-check">年度 <select id="jyear">${opt('全部', '全部', judgeState.year)}${years.map((y) => opt(y, `${y} 年`, judgeState.year)).join('')}</select></label>
    <label class="inline-check">月份 <select id="jmonth" ${judgeState.year === '全部' ? 'disabled' : ''}>${opt('全部', '全部', judgeState.month)}${Array.from({ length: 12 }, (_, i) => opt(i + 1, `${i + 1} 月`, judgeState.month)).join('')}</select></label>
    ${judgeState.tab === '已判定' ? '<span class="small muted">顯示最近 200 筆</span>' : ''}
  </div>
  <div class="stack">${shown.map((m) => `
    <article class="card jcard">
      <div class="info">
        <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 10px">
          <strong style="font-size:16px">${esc(m.caregiver_name)}</strong>
          <span class="small" style="color:var(--ink2)">拒絕 <a href="#/i/${m.inquiry_id}">${esc(m.client_name || m.inquiry_code)}</a>（${esc(m.unit_name)} · ${esc(m.region)}）</span>
          <span class="small muted">${fmtDate(m.contact_date)}${m.staff_name ? ` · 記錄 ${esc(m.staff_name)}` : ''} · 7 公里內：${m.within_7km === null ? '—' : m.within_7km ? '是' : '否'}</span>
        </div>
        ${m.service_detail ? `<div class="mono" style="color:var(--ink2)">${esc(m.service_detail)}</div>` : ''}
        <div>${(m.reject_reason_names || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>
        ${m.reject_note ? `<div class="small" style="color:var(--ink2)">${esc(m.reject_note)}</div>` : ''}
        <div class="small muted">此居服員今年已被列為拒案 ${vCount[m.caregiver_id] || 0} 次</div>
      </div>
      <div class="do">${m.judgement ? `
        <div>${judgeBadge(m)}</div>
        ${m.judge_note ? `<div class="small">備註：${esc(m.judge_note)}</div>` : ''}
        <div class="small muted">${esc(m.judged_by_name || '')} ${fmtTime(m.judged_at)}</div>
        <div><button type="button" class="link" data-undo="${m.id}" style="padding-left:0">改判</button></div>` : `
        <div class="two"><button type="button" class="btn danger" data-v="${m.id}">列為拒案 V</button><button type="button" class="btn" data-x="${m.id}">不列為拒案 X</button></div>
        <label class="f">判定備註（選填）<input type="text" data-note="${m.id}" placeholder="例：前後案確實超過 7 公里"></label>`}
      </div>
    </article>`).join('') || `<div class="card empty">${judgeState.tab === '待判定' ? '目前沒有待判定的拒絕紀錄。' : '還沒有判定過的紀錄。'}</div>`}</div>`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => { judgeState.tab = b.dataset.tab; render(); }));
  $$('[data-region]').forEach((b) => (b.onclick = () => { judgeState.region = b.dataset.region; render(); }));
  $('#jyear').onchange = (e) => { judgeState.year = e.target.value; if (judgeState.year === '全部') judgeState.month = '全部'; render(); };
  $('#jmonth').onchange = (e) => { judgeState.month = e.target.value; render(); };
  const act = async (id, val) => {
    const note = $(`[data-note="${id}"]`)?.value.trim() || null;
    try { await db.update('matches', id, { judgement: val, judge_note: val ? note : null }); toast(val ? `已判定：${val}` : '已清除判定，回到待判定'); await refreshJudgeCount(); render(); }
    catch (e) { toast(e.message, true); }
  };
  $$('[data-v]').forEach((b) => (b.onclick = () => act(Number(b.dataset.v), 'V')));
  $$('[data-x]').forEach((b) => (b.onclick = () => act(Number(b.dataset.x), 'X')));
  $$('[data-undo]').forEach((b) => (b.onclick = () => act(Number(b.dataset.undo), null)));
}

/* ================= 派案紀錄 ================= */
const repState = { year: new Date().getFullYear() - 1911, region: null };
async function viewReport() {
  if (repState.region === null) repState.region = me.region || '淡水';
  const y = repState.year + 1911;
  const rows = await db.all('matches_v', { contact_date: `gte.${y}-01-01`, and: `(contact_date.lte.${y}-12-31)`, order: 'contact_date,id' });
  const mine = rows.filter((m) => m.region === repState.region);
  const by = new Map();
  for (const m of mine) {
    if (!by.has(m.caregiver_id)) by.set(m.caregiver_id, { name: m.caregiver_name, code: m.caregiver_code, months: Array.from({ length: 12 }, () => []), acc: 0, v: 0, rej: 0 });
    const g = by.get(m.caregiver_id);
    g.months[Number(m.contact_date.slice(5, 7)) - 1].push(m);
    if (m.result === '接受') g.acc++; if (m.result === '拒絕') g.rej++; if (m.judgement === 'V') g.v++;
  }
  const groups = [...by.values()].sort((a, b) => (a.code || 'zz').localeCompare(b.code || 'zz') || a.name.localeCompare(b.name));
  const label = (m) => `${fmtMD(m.contact_date)} ${m.unit_name}${m.client_name && !m.client_name.startsWith(m.unit_name) ? m.client_name.slice(0, 1) : ''}`;
  const mark = (m) => m.result === '接受' ? ['ok', 'v'] : m.result === '待回覆' ? ['wait', '?'] : m.judgement === 'V' ? ['bad', 'X'] : ['gray', 'X'];
  const years = []; for (let k = new Date().getFullYear() - 1911; k >= 114; k--) years.push(k);
  $('#main').innerHTML = `
  <div class="head"><div><h1>居服員派案紀錄</h1><div class="muted small" style="margin-top:4px">由媒合紀錄自動產生</div></div>
    <div class="right"><button type="button" class="btn" id="csv">匯出 Excel（CSV）</button></div></div>
  <div class="filters">
    <div class="seg" role="group" aria-label="區域">${REGIONS.map((r) => `<button type="button" data-region="${r}" class="${repState.region === r ? 'on' : ''}">${r}</button>`).join('')}</div>
    <label class="inline-check">年度 <select id="ryear">${years.map((k) => opt(k, `${k} 年`, repState.year)).join('')}</select></label>
  </div>
  <div class="legend"><span><span class="mk ok">v</span> 接受</span><span><span class="mk bad">X</span> 拒絕，主任判定列為拒案</span><span><span class="mk gray">X</span> 拒絕，不列為拒案或待判定</span><span><span class="mk wait">?</span> 待回覆</span></div>
  <div class="tbox"><table class="t" style="min-width:1500px">
    <thead><tr><th>居服員</th>${Array.from({ length: 12 }, (_, i) => `<th>${i + 1} 月</th>`).join('')}<th class="num">接受</th><th class="num">拒絕</th><th class="num">拒案 V</th></tr></thead>
    <tbody>${groups.map((g) => `<tr><td class="nowrap"><strong>${esc(g.name)}</strong><div class="sub">${esc(g.code || '')}</div></td>
      ${g.months.map((ms) => `<td style="min-width:96px">${ms.map((m) => { const [c, t] = mark(m); return `<a href="#/i/${m.inquiry_id}" class="mk ${c}" style="text-decoration:none;display:block;width:max-content" title="${esc(m.inquiry_code)}">${esc(label(m))} ${t}</a>`; }).join('')}</td>`).join('')}
      <td class="num">${g.acc}</td><td class="num">${g.rej}</td><td class="num"><strong>${g.v}</strong></td></tr>`).join('') || '<tr><td colspan="16" class="empty">這個年度與區域沒有媒合紀錄</td></tr>'}</tbody>
  </table></div>`;
  $$('[data-region]').forEach((b) => (b.onclick = () => { repState.region = b.dataset.region; render(); }));
  $('#ryear').onchange = (e) => { repState.year = Number(e.target.value); render(); };
  $('#csv').onclick = () => {
    const lines = [['員編', '居服員', ...Array.from({ length: 12 }, (_, i) => `${i + 1}月`), '接受', '拒絕', '拒案V']];
    groups.forEach((g) => lines.push([g.code || '', g.name, ...g.months.map((ms) => ms.map((m) => `${label(m)}(${mark(m)[1]})`).join('\n')), g.acc, g.rej, g.v]));
    download(`${repState.year}年${repState.region}居服員派案紀錄.csv`, lines);
  };
}

function download(name, lines) {
  const csv = '﻿' + lines.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ================= 統計 ================= */
const statState = { year: new Date().getFullYear() - 1911, region: '全部' };
async function viewStats() {
  const y = statState.year + 1911;
  const range = { inquiry_date: `gte.${y}-01-01`, and: `(inquiry_date.lte.${y}-12-31)` };
  const [inqs, ms] = await Promise.all([
    db.all('inquiries_v', { select: 'id,region,status,unit_name,nc_reason_name', ...range }),
    db.all('matches_v', { select: 'caregiver_id,caregiver_name,region,result,judgement,reject_reason_names', contact_date: `gte.${y}-01-01`, and: `(contact_date.lte.${y}-12-31)` }),
  ]);
  const inR = (x) => statState.region === '全部' || x.region === statState.region;
  const I = inqs.filter(inR), M = ms.filter(inR);
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const bar = (n, max) => `<div class="bar-cell"><div class="b" style="width:${max ? Math.max(2, Math.round((n / max) * 140)) : 0}px"></div><span>${n}</span></div>`;
  const tally = (arr, key) => { const c = {}; arr.forEach((x) => { const k = key(x) || '未填'; c[k] = (c[k] || 0) + 1; }); return Object.entries(c).sort((a, b) => b[1] - a[1]); };
  const done = I.filter((x) => x.status === '成案').length, fail = I.filter((x) => x.status === '未成案').length, open = I.filter((x) => x.status === '問案中').length;
  const ncT = tally(I.filter((x) => x.status === '未成案'), (x) => x.nc_reason_name);
  const unitMap = {}; I.forEach((x) => { const u = (unitMap[x.unit_name] ||= { n: 0, ok: 0, no: 0 }); u.n++; if (x.status === '成案') u.ok++; if (x.status === '未成案') u.no++; });
  const units = Object.entries(unitMap).sort((a, b) => b[1].n - a[1].n);
  const rjT = {}; M.filter((m) => m.result === '拒絕').forEach((m) => (m.reject_reason_names || []).forEach((n) => { rjT[n] = (rjT[n] || 0) + 1; }));
  const rjList = Object.entries(rjT).sort((a, b) => b[1] - a[1]);
  const cgMap = {}; M.forEach((m) => { const c = (cgMap[m.caregiver_id] ||= { name: m.caregiver_name, n: 0, acc: 0, rej: 0, v: 0 }); c.n++; if (m.result === '接受') c.acc++; if (m.result === '拒絕') c.rej++; if (m.judgement === 'V') c.v++; });
  const cgs = Object.values(cgMap).sort((a, b) => b.v - a.v || b.rej - a.rej || b.n - a.n);
  const years = []; for (let k = new Date().getFullYear() - 1911; k >= 114; k--) years.push(k);
  const maxNc = Math.max(0, ...ncT.map((x) => x[1])), maxRj = Math.max(0, ...rjList.map((x) => x[1]));
  $('#main').innerHTML = `
  <div class="head"><h1>統計</h1></div>
  <div class="filters">
    <div class="seg" role="group" aria-label="區域">${['全部', ...REGIONS].map((r) => `<button type="button" data-region="${r}" class="${statState.region === r ? 'on' : ''}">${r}</button>`).join('')}</div>
    <label class="inline-check">年度 <select id="syear">${years.map((k) => opt(k, `${k} 年`, statState.year)).join('')}</select></label>
  </div>
  <div class="card" style="margin-bottom:16px"><div style="display:flex;flex-wrap:wrap;gap:16px 40px">
    ${[['問案', I.length], ['成案', done], ['未成案', fail], ['問案中', open], ['成案率', pct(done, done + fail)]].map(([k, v]) => `<div><div class="small muted">${k}</div><div style="font-size:26px;font-weight:700;font-variant-numeric:tabular-nums">${v}</div></div>`).join('')}
  </div><p class="small faint" style="margin:10px 0 0">成案率 = 成案 ÷（成案＋未成案），不含問案中。</p></div>
  <div class="cols">
    <div class="side stack">
      <div class="tbox"><table class="t"><thead><tr><th>未成案原因</th><th>筆數</th></tr></thead><tbody>${ncT.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${bar(v, maxNc)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">無資料</td></tr>'}</tbody></table></div>
      <div class="tbox"><table class="t"><thead><tr><th>拒絕原因</th><th>次數</th></tr></thead><tbody>${rjList.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${bar(v, maxRj)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">無資料</td></tr>'}</tbody></table></div>
      <p class="small faint" style="margin:0">一筆拒絕可能有多個原因，所以次數加總會大於拒絕筆數。</p>
    </div>
    <div class="main stack">
      <div class="tbox"><table class="t"><thead><tr><th>轉介單位</th><th class="num">問案</th><th class="num">成案</th><th class="num">未成案</th><th class="num">成案率</th></tr></thead>
        <tbody>${units.map(([k, u]) => `<tr><td>${esc(k)}</td><td class="num">${u.n}</td><td class="num">${u.ok}</td><td class="num">${u.no}</td><td class="num">${pct(u.ok, u.ok + u.no)}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">無資料</td></tr>'}</tbody></table></div>
      <div class="tbox"><table class="t"><thead><tr><th>居服員</th><th class="num">詢問</th><th class="num">接受</th><th class="num">拒絕</th><th class="num">列為拒案 V</th></tr></thead>
        <tbody>${cgs.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.n}</td><td class="num">${c.acc}</td><td class="num">${c.rej}</td><td class="num"><strong>${c.v}</strong></td></tr>`).join('') || '<tr><td colspan="5" class="empty">無資料</td></tr>'}</tbody></table></div>
    </div>
  </div>`;
  $$('[data-region]').forEach((b) => (b.onclick = () => { statState.region = b.dataset.region; render(); }));
  $('#syear').onchange = (e) => { statState.year = Number(e.target.value); render(); };
}

/* ================= 個案比對（RK 匯入） ================= */
const RK_COLS = {
  case_no: '案號', welfare_case_no: '衛福案號', name: '姓名', national_id: '身分證字號',
  lead_supervisor: '主責督導', lead_caregiver: '主責居服員', status: '目前狀態',
  case_source: '個案來源', category: '分類',
  city: '個案居住縣市', district: '鄉鎮區__2', address: '個案居住地址',
  service_start_date: '服務開始時間',
};
// 選填欄位：缺少不擋匯入（優雅降級），只在預覽畫面提醒。
const RK_OPTIONAL_COLS = { pause_date: '暫停日期', end_date: '結案日期' };
const normName = (s) => String(s || '').replace(/[\s　]/g, '').replace(/[（(].*?[）)]/g, '').replace(/[、,，.。·\-－_]/g, '').trim();
const normAddr = (s) => String(s || '').replace(/[\s　]/g, '').replace(/臺/g, '台').replace(/[,，、.。]/g, '')
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).trim();
function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (!out.size && s.length) out.add(s);
  return out;
}
function diceScore(a, b) {
  if (!a || !b) return 0;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return a === b ? 1 : 0;
  let inter = 0; for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}
function toISODate(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  if (typeof v === 'string') { const m = v.match(/(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; }
  return null;
}

async function parseRkFile(file, cols = RK_COLS) {
  const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const headerRow = aoa[2] || [];
  const seen = {};
  const headers = headerRow.map((h) => {
    const base = (h === undefined || h === null || h === '') ? '(空)' : String(h).trim();
    seen[base] = (seen[base] || 0) + 1;
    return seen[base] > 1 ? `${base}__${seen[base]}` : base;
  });
  const missingHeaders = Object.values(cols).filter((header) => !headers.includes(header));
  const foundOptional = Object.entries(RK_OPTIONAL_COLS).filter(([, h]) => headers.includes(h)).map(([k]) => k);
  const missingOptionalHeaders = Object.entries(RK_OPTIONAL_COLS).filter(([, h]) => !headers.includes(h)).map(([, h]) => h);
  const dataRows = aoa.slice(3).filter((row) => row.some((c) => c !== undefined && c !== '' && c !== null));
  const pickedHeaders = new Set([...Object.values(cols), ...foundOptional.map((k) => RK_OPTIONAL_COLS[k])]);
  const picked = dataRows.map((row) => {
    const obj = {}; headers.forEach((h, i) => { obj[h] = row[i]; });
    const out = {};
    for (const [key, header] of Object.entries(cols)) out[key] = obj[header] ?? null;
    for (const key of foundOptional) out[key] = toISODate(obj[RK_OPTIONAL_COLS[key]]);
    out.service_start_date = toISODate(out.service_start_date);
    out.name = out.name ? String(out.name).trim() : null;
    out.case_no = out.case_no ? String(out.case_no).trim() : null;
    const raw = {};
    headers.forEach((h) => { if (!pickedHeaders.has(h)) raw[h] = obj[h]; });
    out.raw = raw;
    return out;
  });
  const usable = picked.filter((r) => r.case_no);
  return { total: picked.length, usable, skipped: picked.length - usable.length, missingHeaders, missingOptionalHeaders };
}

/* ---- 個案清單（常態恆存的個案主檔，跟上面「個案比對」用的月快照欄位一樣，多一欄 A單位名稱） ---- */
const CASE_ROSTER_COLS = { ...RK_COLS, unit_name: 'A單位名稱' };
const parseCaseRosterFile = (file) => parseRkFile(file, CASE_ROSTER_COLS);

/* ---- 訪視紀錄總表（家電訪稽核用，跟個案總表是不同的匯出檔、不同的標頭列位置） ---- */
const RK_VISIT_COLS = {
  fill_date: '填表日期', visit_date: '訪視日期', name: '個案姓名',
  national_id: '身份證字號', // 注意：份，不是分（個案總表的欄位叫「身分證字號」，兩邊用字不同）
  visit_category: '訪視', service_staff: '服務員', location: '地點', mode: '方式',
  target: '對象', content: '訪視內容', follow_up: '追蹤處理', signer: '簽名',
  review_date: '核閱日期', reviewer: '核閱人', review_status: '核閱',
};

async function parseVisitLogFile(file) {
  const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const wsName = wb.SheetNames.includes('訪視總表') ? '訪視總表' : wb.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wsName], { header: 1 });
  const headerRow = aoa[1] || []; // 標頭在第 2 列（0-index row 1），比個案總表早一列
  const seen = {};
  const headers = headerRow.map((h) => {
    const base = (h === undefined || h === null || h === '') ? '(空)' : String(h).trim();
    seen[base] = (seen[base] || 0) + 1;
    return seen[base] > 1 ? `${base}__${seen[base]}` : base;
  });
  const missingHeaders = Object.values(RK_VISIT_COLS).filter((header) => !headers.includes(header));
  const dataRows = aoa.slice(2).filter((row) => row.some((c) => c !== undefined && c !== '' && c !== null));
  const pickedHeaders = new Set(Object.values(RK_VISIT_COLS));
  const picked = dataRows.map((row) => {
    const obj = {}; headers.forEach((h, i) => { obj[h] = row[i]; });
    const out = {};
    for (const [key, header] of Object.entries(RK_VISIT_COLS)) out[key] = obj[header] ?? null;
    out.fill_date = toISODate(out.fill_date);
    out.visit_date = toISODate(out.visit_date);
    out.review_date = toISODate(out.review_date);
    out.national_id = out.national_id ? String(out.national_id).trim() : null;
    out.name = out.name ? String(out.name).trim() : null;
    const modeStr = String(out.mode || '');
    out.is_home_visit = modeStr.includes('家訪');
    out.is_phone_visit = modeStr.includes('電訪');
    out.content = out.content ? String(out.content) : null;
    out.signer = out.signer ? String(out.signer).trim() : null;
    const raw = {};
    headers.forEach((h) => { if (!pickedHeaders.has(h)) raw[h] = obj[h]; });
    out.raw = raw;
    return out;
  });
  const usable = picked.filter((r) => r.national_id && r.visit_date);
  const monthsCovered = [...new Set(usable.map((r) => r.visit_date.slice(0, 7)))].sort();
  return { total: picked.length, usable, skipped: picked.length - usable.length, missingHeaders, monthsCovered };
}

function computeComparison(inquiries, rkRows) {
  const byCaseNo = new Map(rkRows.map((r) => [r.case_no, r]));
  const confirmed = [], suggested = [], missing = [], needsReview = [];
  const candidates = inquiries.filter((i) => i.status === '成案');
  const unlinked = candidates.filter((i) => !i.case_no);
  const linked = candidates.filter((i) => i.case_no);

  for (const inq of linked) {
    const rk = byCaseNo.get(inq.case_no);
    if (rk) confirmed.push({ inq, rk });
    else needsReview.push({ inq, reason: '案號在最新匯入中找不到（可能打錯或案號已變更）' });
  }

  for (const inq of unlinked) {
    let best = null, bestScore = 0;
    const nName = normName(inq.client_name), nAddr = normAddr(inq.address);
    for (const rk of rkRows) {
      const nameScore = diceScore(nName, normName(rk.name));
      if (nameScore < 0.5) continue;
      const addrScore = diceScore(nAddr, normAddr(`${rk.city || ''}${rk.district || ''}${rk.address || ''}`));
      const score = nameScore * 0.6 + addrScore * 0.4;
      if (score > bestScore) { bestScore = score; best = rk; }
    }
    if (best && bestScore >= 0.55) suggested.push({ inq, rk: best, score: bestScore, high: bestScore >= 0.8 });
  }
  const byRkCaseNo = new Map();
  suggested.forEach((s) => byRkCaseNo.set(s.rk.case_no, (byRkCaseNo.get(s.rk.case_no) || 0) + 1));
  suggested.forEach((s) => { s.ambiguous = byRkCaseNo.get(s.rk.case_no) > 1; });

  const linkedCaseNos = new Set(linked.map((i) => i.case_no));
  const suggestedCaseNos = new Set(suggested.map((s) => s.rk.case_no));
  for (const rk of rkRows) {
    if (!['服務中', '暫停'].includes(rk.status)) continue;
    if (linkedCaseNos.has(rk.case_no) || suggestedCaseNos.has(rk.case_no)) continue;
    missing.push(rk);
  }
  return { confirmed, suggested, missing, needsReview };
}

async function confirmMatches(pairs, onProgress) {
  for (let i = 0; i < pairs.length; i++) {
    await db.update('inquiries', pairs[i].inquiryId, { case_no: pairs[i].caseNo });
    onProgress?.(i + 1, pairs.length);
  }
}

/* ---- 家電訪稽核：月份小工具、匯入批次的「同月取最新一批」解析、稽核演算法 ---- */
const monthOf = (d) => (d ? String(d).slice(0, 7) : null);
function monthAdd(mkey, n) {
  const [y, m] = mkey.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const y2 = Math.floor(total / 12), m2 = total % 12;
  return `${String(y2).padStart(4, '0')}-${String(m2 + 1).padStart(2, '0')}`;
}
function monthRange(start, end) {
  const out = []; let cur = start;
  while (cur <= end) { out.push(cur); cur = monthAdd(cur, 1); }
  return out;
}

// 哪個月份該用哪一批匯入的訪視紀錄：依匯入時間排序，每個月份歸屬給涵蓋
// 該月份的「最新」一批（append-only 設計，不做刪除，見 sql/07_visit_audit.sql 說明）。
function resolveEffectiveVisitRecords(visits, batches) {
  const sorted = [...batches].sort((a, b) => new Date(b.imported_at) - new Date(a.imported_at));
  const monthOwner = new Map();
  for (const b of sorted) {
    for (const m of (b.months_covered || [])) {
      if (!monthOwner.has(m)) monthOwner.set(m, b.id);
    }
  }
  return visits.filter((v) => monthOwner.get(v.visit_month) === v.import_id);
}

// 忠實搬自 audit_engine.py 的 audit()：電訪每月、家訪每 3 個月（可提前、提前後
// 重新起算）各自獨立判定，內容需 >30 字才算合格，casesByNid（現在來自「個案清單」
// case_roster）是名單造冊標準。
function auditCases(casesByNid, records, asOfMonth) {
  const byCase = new Map();
  const getCase = (nid) => {
    if (!byCase.has(nid)) byCase.set(nid, { phone: new Map(), home: new Map(), name: '', phoneBlank: new Set(), homeBlank: new Set() });
    return byCase.get(nid);
  };
  const trackLatest = (map, month, date) => {
    if (!date) { if (!map.has(month)) map.set(month, null); return; }
    const cur = map.get(month);
    if (cur == null || date > cur) map.set(month, date);
  };
  for (const rec of records) {
    const c = getCase(rec.national_id);
    c.name = rec.name || c.name;
    const hasContent = (rec.content_length || 0) > 30;
    if (rec.is_phone_visit) {
      if (hasContent) trackLatest(c.phone, rec.visit_month, rec.visit_date);
      else c.phoneBlank.add(rec.visit_month);
    }
    if (rec.is_home_visit) {
      if (hasContent) trackLatest(c.home, rec.visit_month, rec.visit_date);
      else c.homeBlank.add(rec.visit_month);
    }
  }

  const allIds = Object.keys(casesByNid);
  const logMonths = records.map((r) => r.visit_month);
  if (!logMonths.length) return { results: new Map(), logMinMonth: null, logMaxMonth: null, excludedCount: 0 };
  const logMinMonth = logMonths.reduce((a, b) => (a < b ? a : b));
  const logMaxRaw = logMonths.reduce((a, b) => (a > b ? a : b));
  const logMaxMonth = logMaxRaw < asOfMonth ? logMaxRaw : asOfMonth;

  const rosterIds = new Set(allIds);
  const excludedCount = new Set(records.map((r) => r.national_id).filter((id) => !rosterIds.has(id))).size;

  const results = new Map();
  for (const nid of allIds) {
    const info = casesByNid[nid];
    const log = byCase.get(nid) || { phone: new Map(), home: new Map(), name: '', phoneBlank: new Set(), homeBlank: new Set() };

    const name = (info && info.name) || log.name || '(未知姓名)';
    const owner = (info && info.lead_supervisor) || '⚠ 個案清單未列名';
    const caseStartMonth = info ? monthOf(info.service_start_date) : null;
    const endMonth = info ? monthOf(info.end_date) : null;
    const statusNow = (info && info.status) || '';

    if (statusNow === '結案' && endMonth && endMonth < logMinMonth) continue;

    const preWindow = !!caseStartMonth && caseStartMonth < logMinMonth;
    const auditStart = caseStartMonth ? (caseStartMonth > logMinMonth ? caseStartMonth : logMinMonth) : logMinMonth;

    const caseEndMonth = (statusNow === '結案' && endMonth) ? (endMonth < logMaxMonth ? endMonth : logMaxMonth) : null;
    const effEnd = caseEndMonth || logMaxMonth;
    const months = effEnd < auditStart ? [] : monthRange(auditStart, effEnd);

    const monthStatus = {};
    let lastHomeMonth = null;
    for (const hm of log.home.keys()) { if (hm < auditStart && (lastHomeMonth === null || hm > lastHomeMonth)) lastHomeMonth = hm; }

    for (const m of months) {
      const homeDone = log.home.has(m);
      const phoneDone = log.phone.has(m);
      let homeState;
      if (homeDone) { homeState = '達標'; lastHomeMonth = m; }
      else if (lastHomeMonth === null) {
        homeState = preWindow ? '資料不足' : '缺漏(未收案家訪)';
      } else {
        const dueMonth = monthAdd(lastHomeMonth, 3);
        homeState = m >= dueMonth ? '逾期' : '未到期';
      }
      const phoneState = phoneDone ? '達標' : '缺漏';
      monthStatus[m] = { 家訪: homeState, 電訪: phoneState, 家訪日期: log.home.get(m) || null, 電訪日期: log.phone.get(m) || null };
    }

    let nextDue;
    if (lastHomeMonth) nextDue = monthAdd(lastHomeMonth, 3);
    else if (preWindow) nextDue = '尚無訪視歷史';
    else nextDue = caseStartMonth || auditStart;

    const blankMonths = [
      ...months.filter((m) => log.phoneBlank.has(m) && !log.phone.has(m)),
      ...months.filter((m) => log.homeBlank.has(m) && !log.home.has(m)),
    ];

    // lastHomeMonth 可能是 auditStart 之前的月份（資料範圍起點前就有的訪視，用來起算到期日），
    // 這種情況下 monthStatus 裡不會有這個月份的資料；日期另外從 log.home 直接取，確保永遠拿得到。
    const lastHomeDate = lastHomeMonth ? log.home.get(lastHomeMonth) : null;
    results.set(nid, {
      nationalId: nid, name, owner, caseNo: (info && info.case_no) || '',
      status: statusNow, inRoster: !!info,
      caseStartMonth: caseStartMonth || '未知', auditStart,
      preWindow, lastHomeMonth, lastHomeDate, nextDue,
      monthStatus, months, blankMonths, caseEndMonth,
    });
  }
  return { results, logMinMonth, logMaxMonth, excludedCount };
}

let caseCheckState = { tab: 'upload', visitsSub: 'list' };
async function viewCaseCheck() {
  $('#main').innerHTML = `
  <div class="head"><div><h1>個案比對</h1><div class="muted small" style="margin-top:4px">每月匯入仁寶系統的個案總表，跟博樂系統的問案資料交叉比對，避免漏填。</div></div></div>
  <div class="filters">
    <div class="seg" role="group" aria-label="頁籤">${[['upload', '上傳匯入'], ['report', '比對結果'], ['history', '匯入紀錄'], ['visits', '家電訪稽核']].map(([k, l]) => `<button type="button" data-cctab="${k}" class="${caseCheckState.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
  </div>
  <div id="cc-body"><p class="muted">載入中…</p></div>`;
  $$('[data-cctab]').forEach((b) => (b.onclick = () => { caseCheckState.tab = b.dataset.cctab; viewCaseCheck(); }));
  const box = $('#cc-body');
  if (caseCheckState.tab === 'upload') drawCcUpload(box);
  else if (caseCheckState.tab === 'report') await drawCcReport(box);
  else if (caseCheckState.tab === 'history') await drawCcHistory(box);
  else await drawCcVisits(box);
}

function drawCcUpload(box) {
  box.innerHTML = `<div class="card stack">
    <label class="f">匯入標籤（例：115年10月）<input type="text" id="ccPeriod" placeholder="115年10月"></label>
    <label class="f">選擇仁寶系統匯出的 Excel 檔<input type="file" id="ccFile" accept=".xlsx,.xls"></label>
    <p class="small muted" style="margin:0">系統只會讀取案號、姓名、身分證字號、主責督導、居服員、狀態、地址、服務起始日等必要欄位做比對用，其餘欄位會整批保留但不特別處理。身分證字號在職人員都看得到，是為了同姓名個案可以辨識，請勿外流。</p>
    <p class="err-text" id="ccerr" hidden></p>
    <div id="ccPreview"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button type="button" class="btn" id="ccAnalyze">分析檔案</button>
      <button type="button" class="btn primary" id="ccImport" hidden>確認匯入</button>
    </div>
  </div>`;
  let parsed = null;
  $('#ccAnalyze').onclick = async () => {
    const f = $('#ccFile').files[0];
    const er = $('#ccerr'); er.hidden = true; $('#ccImport').hidden = true;
    if (!f) { er.textContent = '請先選擇檔案'; er.hidden = false; return; }
    const btn = $('#ccAnalyze'); btn.disabled = true;
    try {
      parsed = await parseRkFile(f);
      if (parsed.missingHeaders.length) {
        er.textContent = `找不到欄位：${parsed.missingHeaders.join('、')}，請確認匯出格式是否正確`;
        er.hidden = false;
      } else {
        $('#ccPreview').innerHTML = `<div class="card small" style="margin-top:8px">
          共 ${parsed.total} 筆，可匯入 ${parsed.usable.length} 筆，略過 ${parsed.skipped} 筆（無案號）。
          ${parsed.missingOptionalHeaders.length ? `<p class="small" style="color:var(--warn);margin:6px 0 0">此次匯出沒有「${parsed.missingOptionalHeaders.join('、')}」欄位，相關判斷（例如結案後是否停止稽核）會優雅降級，不會擋匯入。</p>` : ''}
          <div class="tbox" style="margin-top:8px"><table class="t"><thead><tr><th>案號</th><th>姓名</th><th>狀態</th><th>主責督導</th></tr></thead>
          <tbody>${parsed.usable.slice(0, 15).map((r) => `<tr><td>${esc(r.case_no)}</td><td>${esc(r.name)}</td><td>${esc(r.status)}</td><td>${esc(r.lead_supervisor)}</td></tr>`).join('')}</tbody></table></div>
          ${parsed.usable.length > 15 ? '<p class="small muted" style="margin:6px 0 0">僅預覽前 15 筆</p>' : ''}
        </div>`;
        $('#ccImport').hidden = false;
      }
    } catch (e) { er.textContent = e.message; er.hidden = false; }
    btn.disabled = false;
  };
  $('#ccImport').onclick = async () => {
    const period = $('#ccPeriod').value.trim();
    const er = $('#ccerr'); er.hidden = true;
    if (!parsed) return;
    if (!period) { er.textContent = '請填寫匯入標籤'; er.hidden = false; return; }
    const btn = $('#ccImport'); btn.disabled = true;
    try {
      const batch = await db.insert('rk_imports', {
        imported_by_name: me.name, file_name: $('#ccFile').files[0]?.name || null,
        period, row_count: parsed.usable.length, skipped_count: parsed.skipped,
      });
      const chunkSize = 400;
      for (let i = 0; i < parsed.usable.length; i += chunkSize) {
        const chunk = parsed.usable.slice(i, i + chunkSize).map((r) => ({ ...r, import_id: batch.id }));
        await db.insertMany('rk_cases', chunk);
        toast(`已匯入 ${Math.min(i + chunkSize, parsed.usable.length)} / ${parsed.usable.length} 筆`);
      }
      toast('匯入完成');
      const uploadedFile = $('#ccFile').files[0];
      await offerRosterSync(uploadedFile, () => { caseCheckState.tab = 'report'; viewCaseCheck(); });
    } catch (e) { er.textContent = e.message; er.hidden = false; btn.disabled = false; }
  };
}

async function drawCcReport(box) {
  box.innerHTML = '<p class="muted">載入中…</p>';
  const [inqs, imports] = await Promise.all([
    db.all('inquiries', { select: 'id,code,client_name,address,region,status,case_no', status: 'eq.成案' }),
    db.all('rk_imports', { order: 'imported_at.desc', limit: 1 }),
  ]);
  if (!imports.length) { box.innerHTML = '<div class="card empty">還沒有匯入過仁寶系統的個案總表，請先到「上傳匯入」頁籤匯入。</div>'; return; }
  const latest = imports[0];
  const rkRows = await db.all('rk_cases', { import_id: `eq.${latest.id}` });
  const cmp = computeComparison(inqs, rkRows);
  box.innerHTML = `
  <p class="small muted">目前比對的批次：${esc(latest.period || '')}（${fmtTime(latest.imported_at)} 由 ${esc(latest.imported_by_name || '')} 匯入，共 ${latest.row_count} 筆）</p>
  <div class="card" style="margin:10px 0 16px"><div style="display:flex;flex-wrap:wrap;gap:16px 40px">
    ${[['已連結', cmp.confirmed.length], ['建議配對待確認', cmp.suggested.length], ['疑似漏填', cmp.missing.length], ['案號待確認', cmp.needsReview.length]].map(([k, v]) => `<div><div class="small muted">${k}</div><div style="font-size:26px;font-weight:700;font-variant-numeric:tabular-nums">${v}</div></div>`).join('')}
  </div></div>

  <div class="card" style="margin-bottom:16px">
    <h2>建議配對（${cmp.suggested.length}）</h2>
    <p class="small muted" style="margin:4px 0 10px">系統用姓名與地址自動比對出的建議，勾選後按「確認所選」才會寫入問案的仁寶案號。標示「有疑義」表示同一個仁寶案號被配對到多筆問案，需要個別確認。</p>
    ${cmp.suggested.length ? `
    <div class="tbox"><table class="t"><thead><tr><th><input type="checkbox" id="ccSelAll"></th><th>博樂問案</th><th>仁寶個案</th><th>相似度</th><th></th></tr></thead>
      <tbody>${cmp.suggested.map((s, i) => `<tr>
        <td><input type="checkbox" class="ccSugCb" data-i="${i}" ${s.ambiguous ? 'disabled' : ''}></td>
        <td><a href="#/i/${s.inq.id}">${esc(s.inq.code)}</a> ${esc(s.inq.client_name || '')}<div class="sub">${esc(s.inq.address || '')}</div></td>
        <td>${esc(s.rk.case_no)} ${esc(s.rk.name)}<div class="sub">${esc((s.rk.city || '') + (s.rk.district || '') + (s.rk.address || ''))}</div></td>
        <td>${Math.round(s.score * 100)}%${s.ambiguous ? ' <span class="tag">有疑義</span>' : ''}</td>
        <td><button type="button" class="link" data-ccreject="${i}">不是同一人</button></td>
      </tr>`).join('')}</tbody></table></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
      <button type="button" class="btn" id="ccSelHigh">勾選高信心（≥80%）</button>
      <button type="button" class="btn primary" id="ccConfirmSel">確認所選</button>
    </div>` : '<p class="muted small">目前沒有待確認的建議配對。</p>'}
  </div>

  <div class="card" style="margin-bottom:16px">
    <h2>疑似漏填（${cmp.missing.length}）</h2>
    <p class="small muted" style="margin:4px 0 10px">仁寶系統裡「服務中」或「暫停」的個案，在博樂系統找不到對應的成案問案，可能有人忘記建立問案。</p>
    ${cmp.missing.length ? `<div class="tbox"><table class="t"><thead><tr><th>案號</th><th>姓名</th><th>狀態</th><th>主責督導</th><th>主責居服員</th><th>地址</th><th>服務起始</th></tr></thead>
      <tbody>${cmp.missing.map((r) => `<tr><td>${esc(r.case_no)}</td><td>${esc(r.name)}</td><td>${esc(r.status)}</td><td>${esc(r.lead_supervisor)}</td><td>${esc(r.lead_caregiver)}</td><td>${esc((r.city || '') + (r.district || '') + (r.address || ''))}</td><td>${fmtDate(r.service_start_date)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">沒有發現漏填的個案。</p>'}
  </div>

  <div class="card">
    <h2>案號待確認（${cmp.needsReview.length}）</h2>
    <p class="small muted" style="margin:4px 0 10px">問案已經有仁寶案號，但在最新匯入的名單裡找不到，可能是案號打錯或已經異動。</p>
    ${cmp.needsReview.length ? `<div class="tbox"><table class="t"><thead><tr><th>博樂問案</th><th>仁寶案號</th><th>原因</th></tr></thead>
      <tbody>${cmp.needsReview.map((r) => `<tr><td><a href="#/i/${r.inq.id}">${esc(r.inq.code)}</a> ${esc(r.inq.client_name || '')}</td><td>${esc(r.inq.case_no)}</td><td class="small muted">${esc(r.reason)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">沒有需要確認的案號。</p>'}
  </div>`;

  $('#ccSelAll')?.addEventListener('change', (e) => { $$('.ccSugCb:not(:disabled)').forEach((cb) => (cb.checked = e.target.checked)); });
  $('#ccSelHigh')?.addEventListener('click', () => { $$('.ccSugCb').forEach((cb) => { const s = cmp.suggested[Number(cb.dataset.i)]; cb.checked = !cb.disabled && s.high; }); });
  $$('[data-ccreject]').forEach((b) => (b.onclick = () => { b.closest('tr').remove(); }));
  $('#ccConfirmSel')?.addEventListener('click', async () => {
    const chosen = $$('.ccSugCb:checked').map((cb) => cmp.suggested[Number(cb.dataset.i)]);
    if (!chosen.length) { toast('請先勾選要確認的配對', true); return; }
    if (!(await confirmBox(`確定要寫入 ${chosen.length} 筆仁寶案號連結嗎？`))) return;
    const pairs = chosen.map((s) => ({ inquiryId: s.inq.id, caseNo: s.rk.case_no }));
    try {
      await confirmMatches(pairs, (done, total) => { if (done % 20 === 0 || done === total) toast(`已連結 ${done} / ${total} 筆`); });
      toast('已完成'); viewCaseCheck();
    } catch (e) { toast(e.message, true); }
  });
}

async function drawCcHistory(box) {
  box.innerHTML = '<p class="muted">載入中…</p>';
  const rows = await db.all('rk_imports', { order: 'imported_at.desc' });
  box.innerHTML = `<div class="tbox"><table class="t"><thead><tr><th>匯入時間</th><th>標籤</th><th>匯入者</th><th>檔名</th><th class="num">筆數</th><th class="num">略過</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${fmtTime(r.imported_at)}</td><td>${esc(r.period || '')}</td><td>${esc(r.imported_by_name || '')}</td><td class="small muted">${esc(r.file_name || '')}</td><td class="num">${r.row_count}</td><td class="num">${r.skipped_count}</td><td>${isDirector() ? `<button type="button" class="link" style="color:var(--bad)" data-ccdel="${r.id}">刪除</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">還沒有匯入紀錄</td></tr>'}</tbody></table></div>`;
  $$('[data-ccdel]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('確定要刪除這批匯入紀錄嗎？底下的個案資料也會一起刪除，無法復原。', '刪除', true))) return;
    try { await db.remove('rk_imports', Number(b.dataset.ccdel)); toast('已刪除'); viewCaseCheck(); } catch (e) { toast(e.message, true); }
  }));
}

/* ================= 家電訪稽核 ================= */
// 稽核的個案名單改用「個案清單」（case_roster，常態恆存的主檔）而不是「個案比對」
// 每月上傳的 rk_cases 快照——case_roster 本來就是持續維護的最新名單，不需要使用者
// 每次都另外在「個案比對」頁籤重傳一次個案總表才能用家電訪稽核。
async function loadVisitAudit() {
  const [roster, visitBatches] = await Promise.all([
    db.all('case_roster', {}),
    db.all('rk_visit_imports', { order: 'imported_at.desc' }),
  ]);
  if (!roster.length || !visitBatches.length) return null;
  const allVisits = await db.all('rk_visits', {});
  const effective = resolveEffectiveVisitRecords(allVisits, visitBatches);
  const casesByNid = {};
  for (const c of roster) if (c.national_id) casesByNid[c.national_id] = c;
  const todayMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const logMonths = effective.map((r) => r.visit_month);
  const asOfMonth = logMonths.length ? [...logMonths, todayMonth].reduce((a, b) => (a > b ? a : b)) : todayMonth;
  return auditCases(casesByNid, effective, asOfMonth);
}

async function drawCcVisits(box) {
  box.innerHTML = `
  <div class="filters">
    <div class="seg" role="group" aria-label="家電訪子頁籤">${[['list', '缺漏清單'], ['stats', '統計'], ['import', '匯入與批次']].map(([k, l]) => `<button type="button" data-ccvsub="${k}" class="${caseCheckState.visitsSub === k ? 'on' : ''}">${l}</button>`).join('')}</div>
  </div>
  <div id="cc-visits-body"><p class="muted">載入中…</p></div>`;
  $$('[data-ccvsub]').forEach((b) => (b.onclick = () => { caseCheckState.visitsSub = b.dataset.ccvsub; drawCcVisits(box); }));
  const sub = $('#cc-visits-body');
  if (caseCheckState.visitsSub === 'import') { drawVisitImport(sub); return; }
  sub.innerHTML = '<p class="muted">載入中…</p>';
  const audit = await loadVisitAudit();
  if (!audit) { sub.innerHTML = '<div class="card empty">「個案清單」還沒有資料，或還沒有匯入過訪視紀錄總表。請先到「個案清單」頁面建立個案主檔，並在這裡的「匯入與批次」頁籤匯入訪視紀錄。</div>'; return; }
  if (!audit.results.size && !audit.logMinMonth) { sub.innerHTML = '<div class="card empty">目前還沒有任何有效的訪視紀錄。</div>'; return; }
  if (caseCheckState.visitsSub === 'stats') drawVisitStats(sub, audit);
  else await drawVisitList(sub, audit);
}

async function drawVisitList(box, audit) {
  const { results } = audit;
  const items = [];
  for (const r of results.values()) {
    for (const m of r.months) {
      const st = r.monthStatus[m];
      if (st.電訪 === '缺漏') items.push({ r, m, type: '電訪缺漏' });
      if (st.家訪 === '缺漏(未收案家訪)') items.push({ r, m, type: '家訪缺漏' });
      else if (st.家訪 === '逾期') items.push({ r, m, type: '家訪逾期' });
    }
  }
  items.sort((a, b) => a.r.owner.localeCompare(b.r.owner) || a.r.name.localeCompare(b.r.name) || a.m.localeCompare(b.m));
  const notes = await db.all('rk_visit_notes', {});
  const noteMap = new Map(notes.map((n) => [`${n.national_id}|${n.month}|${n.deficiency_type}`, n]));
  box.innerHTML = `
  <div class="muted small" style="margin-bottom:8px">電訪缺漏 ${items.filter((i) => i.type === '電訪缺漏').length} 筆　家訪缺漏 ${items.filter((i) => i.type === '家訪缺漏').length} 筆　家訪逾期 ${items.filter((i) => i.type === '家訪逾期').length} 筆</div>
  <div class="tbox"><table class="t"><thead><tr><th>主責督導</th><th>姓名</th><th>月份</th><th>缺漏類型</th><th>原因說明</th></tr></thead>
    <tbody>${items.map((it) => {
      const key = `${it.r.nationalId}|${it.m}|${it.type}`;
      const n = noteMap.get(key);
      return `<tr><td class="nowrap">${esc(it.r.owner)}</td><td class="nowrap">${esc(it.r.name)}</td><td class="nowrap">${it.m}</td>
        <td><span class="st ${it.type === '家訪逾期' ? 'r-拒絕' : 's-問案中'}">${it.type}</span></td>
        <td><input type="text" class="vnote" data-nid="${esc(it.r.nationalId)}" data-m="${it.m}" data-type="${esc(it.type)}" value="${esc(n?.note || '')}" placeholder="例：已電聯家屬確認" style="width:100%"></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">目前沒有缺漏項目。</td></tr>'}</tbody></table></div>`;
  $$('.vnote').forEach((input) => {
    input.onblur = async () => {
      try {
        await db.upsert('rk_visit_notes', {
          national_id: input.dataset.nid, month: input.dataset.m, deficiency_type: input.dataset.type,
          note: input.value.trim() || null, updated_by_name: me.name,
        }, 'national_id,month,deficiency_type');
        toast('已儲存');
      } catch (e) { toast(e.message, true); }
    };
  });
}

function drawVisitStats(box, audit) {
  const { results } = audit;
  const agg = new Map();
  for (const r of results.values()) {
    if (!agg.has(r.owner)) agg.set(r.owner, { cases: 0, phoneMissing: 0, homeMissing: 0, homeOverdue: 0, unlisted: 0 });
    const a = agg.get(r.owner);
    a.cases++;
    if (!r.inRoster) a.unlisted++;
    for (const m of r.months) {
      const st = r.monthStatus[m];
      if (st.電訪 === '缺漏') a.phoneMissing++;
      if (st.家訪 === '缺漏(未收案家訪)') a.homeMissing++;
      else if (st.家訪 === '逾期') a.homeOverdue++;
    }
  }
  const owners = [...agg.keys()].sort();
  box.innerHTML = `<div class="tbox"><table class="t"><thead><tr><th>主責督導</th><th class="num">列管個案數</th><th class="num">電訪缺漏筆數</th><th class="num">家訪缺漏筆數</th><th class="num">家訪逾期筆數</th><th class="num">個案清單未列名</th></tr></thead>
    <tbody>${owners.map((o) => { const a = agg.get(o); return `<tr><td>${esc(o)}</td><td class="num">${a.cases}</td><td class="num">${a.phoneMissing}</td><td class="num">${a.homeMissing}</td><td class="num">${a.homeOverdue}</td><td class="num">${a.unlisted}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">無資料</td></tr>'}</tbody></table></div>`;
}

function drawVisitImport(box) {
  box.innerHTML = `
  ${isDirector() ? `<div class="card stack" style="margin-bottom:16px">
    <label class="f">匯入標籤（例：115年10月）<input type="text" id="vPeriod" placeholder="115年10月"></label>
    <label class="f">選擇仁寶系統匯出的訪視紀錄總表<input type="file" id="vFile" accept=".xlsx,.xls"></label>
    <p class="small muted" style="margin:0">只有主任與管理者能匯入訪視紀錄總表；在職人員都能查看儀表板與統計。</p>
    <p class="err-text" id="verr" hidden></p>
    <div id="vPreview"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button type="button" class="btn" id="vAnalyze">分析檔案</button>
      <button type="button" class="btn primary" id="vImport" hidden>確認匯入</button>
    </div>
  </div>` : '<p class="muted small" style="margin-bottom:16px">匯入訪視紀錄總表限主任與管理者操作。</p>'}
  <div id="v-history"><p class="muted">載入中…</p></div>`;
  if (isDirector()) {
    let parsed = null;
    $('#vAnalyze').onclick = async () => {
      const f = $('#vFile').files[0];
      const er = $('#verr'); er.hidden = true; $('#vImport').hidden = true;
      if (!f) { er.textContent = '請先選擇檔案'; er.hidden = false; return; }
      const btn = $('#vAnalyze'); btn.disabled = true;
      try {
        parsed = await parseVisitLogFile(f);
        if (parsed.missingHeaders.length) {
          er.textContent = `找不到欄位：${parsed.missingHeaders.join('、')}，請確認匯出格式是否正確`;
          er.hidden = false;
        } else {
          $('#vPreview').innerHTML = `<div class="card small" style="margin-top:8px">
            共 ${parsed.total} 筆，可匯入 ${parsed.usable.length} 筆，略過 ${parsed.skipped} 筆（缺身分證字號或訪視日期）。涵蓋月份：${esc(parsed.monthsCovered.join('、') || '—')}
          </div>`;
          $('#vImport').hidden = false;
        }
      } catch (e) { er.textContent = e.message; er.hidden = false; }
      btn.disabled = false;
    };
    $('#vImport').onclick = async () => {
      const period = $('#vPeriod').value.trim();
      const er = $('#verr'); er.hidden = true;
      if (!parsed) return;
      if (!period) { er.textContent = '請填寫匯入標籤'; er.hidden = false; return; }
      const btn = $('#vImport'); btn.disabled = true;
      try {
        const batch = await db.insert('rk_visit_imports', {
          imported_by_name: me.name, file_name: $('#vFile').files[0]?.name || null,
          period, months_covered: parsed.monthsCovered, row_count: parsed.usable.length, skipped_count: parsed.skipped,
        });
        const chunkSize = 400;
        for (let i = 0; i < parsed.usable.length; i += chunkSize) {
          const chunk = parsed.usable.slice(i, i + chunkSize).map((r) => ({ ...r, import_id: batch.id }));
          await db.insertMany('rk_visits', chunk);
          toast(`已匯入 ${Math.min(i + chunkSize, parsed.usable.length)} / ${parsed.usable.length} 筆`);
        }
        toast('匯入完成'); caseCheckState.visitsSub = 'list'; viewCaseCheck();
      } catch (e) { er.textContent = e.message; er.hidden = false; btn.disabled = false; }
    };
  }
  drawVisitImportHistory($('#v-history'));
}

async function drawVisitImportHistory(box) {
  const rows = await db.all('rk_visit_imports', { order: 'imported_at.desc' });
  box.innerHTML = `<div class="tbox"><table class="t"><thead><tr><th>匯入時間</th><th>標籤</th><th>匯入者</th><th>檔名</th><th>涵蓋月份</th><th class="num">筆數</th><th class="num">略過</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${fmtTime(r.imported_at)}</td><td>${esc(r.period || '')}</td><td>${esc(r.imported_by_name || '')}</td><td class="small muted">${esc(r.file_name || '')}</td><td class="small">${esc((r.months_covered || []).join('、'))}</td><td class="num">${r.row_count}</td><td class="num">${r.skipped_count}</td><td>${isDirector() ? `<button type="button" class="link" style="color:var(--bad)" data-vdel="${r.id}">刪除</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">還沒有匯入紀錄</td></tr>'}</tbody></table></div>`;
  $$('[data-vdel]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('確定要刪除這批訪視紀錄嗎？無法復原。', '刪除', true))) return;
    try { await db.remove('rk_visit_imports', Number(b.dataset.vdel)); toast('已刪除'); viewCaseCheck(); } catch (e) { toast(e.message, true); }
  }));
}

/* ================= 個案清單（常態恆存的個案主檔） ================= */
// 同一機構常常有好幾種全名寫法（例如多一個「(A)」），全名完全比對優先；比對不到的話，
// 看 A單位名稱裡有沒有包含「轉介單位」裡啟用中的某個名稱，有的話直接套用那個短名稱當
// 縮寫——不用另外維護一份關鍵字清單，轉介單位名稱本身就是短、乾淨的版本。比對依名稱字數
// 由長到短檢查，比較具體（字數多）的名稱優先命中，避免被字數少、涵蓋範圍太廣的名稱誤比對。
function makeUnitLabelResolver(abbrs, referralUnits) {
  const exact = new Map(abbrs.filter((a) => a.abbr).map((a) => [a.full_name, a.abbr]));
  const keywords = referralUnits.filter((u) => u.active && u.name).map((u) => u.name).sort((a, b) => b.length - a.length);
  return (unitName) => {
    if (!unitName) return unitName;
    if (exact.has(unitName)) return exact.get(unitName);
    const hit = keywords.find((k) => unitName.includes(k));
    return hit || unitName;
  };
}

async function loadCaseRosterAudit() {
  const [roster, visitBatches, abbrs] = await Promise.all([
    db.all('case_roster', {}),
    db.all('rk_visit_imports', { order: 'imported_at.desc' }),
    db.all('unit_abbrs', {}),
  ]);
  const casesByNid = {};
  for (const c of roster) if (c.national_id) casesByNid[c.national_id] = c;
  const unitLabel = makeUnitLabelResolver(abbrs, L.units);
  const allVisits = visitBatches.length ? await db.all('rk_visits', {}) : [];
  const effective = resolveEffectiveVisitRecords(allVisits, visitBatches);
  const todayMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const logMonths = effective.map((r) => r.visit_month);
  const asOfMonth = logMonths.length ? [...logMonths, todayMonth].reduce((a, b) => (a > b ? a : b)) : todayMonth;
  const audit = effective.length ? auditCases(casesByNid, effective, asOfMonth) : { results: new Map(), logMinMonth: null, logMaxMonth: null, excludedCount: 0 };
  const latestVisitImportAt = visitBatches[0]?.imported_at || null;
  return { roster, casesByNid, audit, unitLabel, latestVisitImportAt };
}

async function viewCases() {
  $('#main').innerHTML = `
  <div class="head"><div><h1>個案清單</h1><div class="muted small" style="margin-top:4px">全系統個案主檔，跟「個案比對」每月匯入的快照分開，是持續維護的單一份資料。</div></div></div>
  <div id="cases-body"><p class="muted">載入中…</p></div>`;
  const box = $('#cases-body');
  let data;
  try { data = await loadCaseRosterAudit(); } catch (e) { box.innerHTML = `<div class="card"><p class="err-text">${esc(e.message)}</p></div>`; return; }
  drawCaseRosterTable(box, data);
}

const caseRosterState = { owner: '全部', unit: '全部', status: '全部', onlyIssues: false, q: '', sortBy: null, sortDir: 'asc' };
function drawCaseRosterTable(box, data) {
  const { roster, casesByNid, audit, unitLabel, latestVisitImportAt } = data;
  const activeStaffNames = new Set(L.staff.filter((s) => s.active).map((s) => s.name));
  // 督導下拉只留目前在職的人；已離職的督導要找，用搜尋框手動打名字（搜尋框有涵蓋督導員欄位，見下方 q 篩選）。
  const owners = [...new Set(roster.map((c) => c.lead_supervisor).filter(Boolean))].filter((o) => activeStaffNames.has(o)).sort();
  const units = [...new Set(roster.map((c) => c.unit_name).filter(Boolean))].sort();
  const rowIssue = (st) => !!st && (st.家訪 === '逾期' || st.家訪 === '缺漏(未收案家訪)' || st.電訪 === '缺漏');
  const sortIcon = (field) => caseRosterState.sortBy === field ? `<span class="small muted">${caseRosterState.sortDir === 'asc' ? '▲' : '▼'}</span>` : '';
  // 頁面最上方的家電訪統計摘要：不受下方篩選影響，永遠是全體個案清單的總覽。
  const lastStatusOf = (c) => {
    const r = c.national_id ? audit.results.get(c.national_id) : null;
    const lastMonth = r ? r.months[r.months.length - 1] : null;
    return lastMonth ? r.monthStatus[lastMonth] : null;
  };
  const summary = {
    total: roster.length,
    homeOverdue: roster.filter((c) => lastStatusOf(c)?.家訪 === '逾期').length,
    phoneMissing: roster.filter((c) => lastStatusOf(c)?.電訪 === '缺漏').length,
    fileMissing: roster.filter((c) => !c.file_status).length,
  };
  const draw = () => {
    const q = caseRosterState.q.trim().toLowerCase();
    const filtered = roster.filter((c) => (caseRosterState.owner === '全部' || c.lead_supervisor === caseRosterState.owner)
      && (caseRosterState.unit === '全部' || c.unit_name === caseRosterState.unit)
      && (caseRosterState.status === '全部' || c.status === caseRosterState.status)
      && (!q || [c.name, c.national_id, c.case_no, c.lead_supervisor].some((x) => (x || '').toLowerCase().includes(q))));
    const rowsData = filtered.map((c) => {
      const r = c.national_id ? audit.results.get(c.national_id) : null;
      const lastMonth = r ? r.months[r.months.length - 1] : null;
      const st = lastMonth ? r.monthStatus[lastMonth] : null;
      return { c, r, st };
    });
    let shown = caseRosterState.onlyIssues ? rowsData.filter(({ st }) => rowIssue(st)) : rowsData;
    if (caseRosterState.sortBy) {
      const field = caseRosterState.sortBy;
      shown = [...shown].sort((ra, rb) => {
        const av = ra.c[field], bv = rb.c[field];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;  // 空值固定排最後，不受正逆排序影響
        if (bv == null) return -1;
        const c = String(av).localeCompare(String(bv));
        return caseRosterState.sortDir === 'desc' ? -c : c;
      });
    }
    box.innerHTML = `
    ${roster.length ? `<div class="card" style="margin-bottom:16px"><div style="display:flex;flex-wrap:wrap;gap:16px 40px;align-items:flex-end">
      ${[['列管個案數', summary.total], ['家訪逾期', summary.homeOverdue], ['本月電訪缺漏', summary.phoneMissing], ['案本未繳交', summary.fileMissing]].map(([k, v]) => `<div><div class="small muted">${k}</div><div style="font-size:26px;font-weight:700;font-variant-numeric:tabular-nums">${v}</div></div>`).join('')}
      <div class="small muted" style="margin-left:auto">訪視紀錄資料更新於 ${latestVisitImportAt ? fmtTime(latestVisitImportAt) : '尚無匯入紀錄'}</div>
    </div></div>` : ''}
    ${!roster.length ? '' : (!audit.logMinMonth ? '<p class="small muted">還沒有匯入過訪視紀錄總表，「最近一次家訪／電訪」欄位暫時顯示尚無資料。到「個案比對」頁面的「家電訪稽核」頁籤可以匯入。</p>'
      : `<p class="small muted">訪視紀錄自 <strong>${audit.logMinMonth}</strong> 起開始匯入；此前月份不列入缺漏統計。</p>`)}
    <div class="card filters" style="margin:10px 0 16px">
      <label class="inline-check">主責督導 <select id="rfOwner">${opt('全部', '全部', caseRosterState.owner)}${owners.map((o) => opt(o, o, caseRosterState.owner)).join('')}</select></label>
      <label class="inline-check">A單位 <select id="rfUnit">${opt('全部', '全部', caseRosterState.unit)}${units.map((u) => opt(u, unitLabel(u), caseRosterState.unit)).join('')}</select></label>
      <label class="inline-check">狀態 <select id="rfStatus">${['全部', '服務中', '暫停', '結案'].map((s) => opt(s, s, caseRosterState.status)).join('')}</select></label>
      <label class="inline-check"><input type="checkbox" id="rfIssue" ${caseRosterState.onlyIssues ? 'checked' : ''}>只顯示有缺漏/逾期</label>
      <input type="search" class="grow" id="rfQ" placeholder="搜尋案號、姓名、身分證字號、督導員（含已離職）" value="${esc(caseRosterState.q)}">
    </div>
    <div class="muted small" style="margin-bottom:8px">共 ${shown.length} 筆${roster.length ? '' : '（個案清單還沒有資料，請管理者到下方「重新整理個案清單」匯入）'}</div>
    <div class="tbox"><table class="t"><thead><tr>
      <th id="th-caseno" style="cursor:pointer;user-select:none" title="點擊排序">案號 ${sortIcon('case_no')}</th>
      <th>姓名</th><th>身分證字號</th><th>督導員</th><th>A單位名稱</th>
      <th id="th-startdate" style="cursor:pointer;user-select:none" title="點擊排序">開始服務日 ${sortIcon('service_start_date')}</th>
      <th>結案日</th><th>狀態</th><th>最近一次家訪</th><th>下次應家訪日</th><th>最近一次電訪</th><th>案本</th></tr></thead>
      <tbody>${shown.map(({ c, r, st }) => {
        // 「最近一次家訪」要顯示實際上一次合格家訪的日期（r.lastHomeMonth），不是目前月份的到期狀態
        // ——目前月份狀態（達標/未到期/逾期）另外用小標籤附加在日期後面，不能取代日期本身。
        const homeCell = !audit.logMinMonth ? '<span class="faint">尚無訪視紀錄</span>'
          : !r ? '<span class="faint">—</span>'
          : r.lastHomeDate ? `${fmtDate(r.lastHomeDate)}${st?.家訪 === '逾期' ? ' <span class="st r-拒絕">逾期</span>' : ''}`
          : st?.家訪 === '資料不足' ? '<span class="chip">尚無訪視歷史</span>'
          : '<span class="st r-拒絕">未收案家訪</span>';
        const nextDueCell = !audit.logMinMonth || !r ? '<span class="faint">—</span>' : esc(r.nextDue);
        const phoneCell = !audit.logMinMonth ? '<span class="faint">尚無訪視紀錄</span>'
          : !st ? '<span class="faint">—</span>'
          : st.電訪 === '達標' ? fmtDate(st.電訪日期)
          : '<span class="st s-問案中">本月電訪缺漏</span>';
        const fileTitle = c.file_updated_by_name ? `最後更新：${esc(c.file_updated_by_name)} ${fmtTime(c.file_updated_at)}` : '尚未更新';
        const fileCell = isDirector()
          ? `<button type="button" class="link" data-ftoggle="${c.id}" style="color:${c.file_status ? 'var(--ok)' : 'var(--ink2)'}" title="${fileTitle}">${c.file_status ? '✓ 已繳交' : '未繳交'}</button>`
          : `<span class="st ${c.file_status ? 's-成案' : 's-未成案'}" title="${fileTitle}">${c.file_status ? '✓ 已繳交' : '未繳交'}</span>`;
        return `<tr class="click" data-crow="${esc(c.national_id || '')}" data-cid="${c.id}">
          <td class="nowrap">${esc(c.case_no)}</td>
          <td class="nowrap">${esc(c.name)}</td>
          <td class="nowrap">${esc(c.national_id)}</td>
          <td class="nowrap">${esc(c.lead_supervisor)}</td>
          <td class="nowrap"><span class="ellip" title="${esc(c.unit_name)}">${esc(unitLabel(c.unit_name))}</span></td>
          <td class="nowrap">${fmtDate(c.service_start_date)}</td>
          <td class="nowrap">${fmtDate(c.end_date)}</td>
          <td>${esc(c.status)}</td>
          <td class="nowrap">${homeCell}</td>
          <td class="nowrap small">${nextDueCell}</td>
          <td class="nowrap">${phoneCell}</td>
          <td class="nowrap">${fileCell}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="12" class="empty">沒有符合條件的個案</td></tr>'}</tbody></table></div>
    ${isDirector() ? `<details style="margin-top:20px"><summary class="btn" style="display:inline-flex;width:fit-content;cursor:pointer">重新整理個案清單（上傳最新個案總表）</summary><div id="cr-import" style="margin-top:12px"></div></details>` : ''}`;
    const toggleSort = (field) => {
      if (caseRosterState.sortBy === field) caseRosterState.sortDir = caseRosterState.sortDir === 'asc' ? 'desc' : 'asc';
      else { caseRosterState.sortBy = field; caseRosterState.sortDir = 'asc'; }
      draw();
    };
    $('#th-caseno').onclick = () => toggleSort('case_no');
    $('#th-startdate').onclick = () => toggleSort('service_start_date');
    $('#rfOwner').onchange = (e) => { caseRosterState.owner = e.target.value; draw(); };
    $('#rfUnit').onchange = (e) => { caseRosterState.unit = e.target.value; draw(); };
    $('#rfStatus').onchange = (e) => { caseRosterState.status = e.target.value; draw(); };
    $('#rfIssue').onchange = (e) => { caseRosterState.onlyIssues = e.target.checked; draw(); };
    $('#rfQ').oninput = (e) => { caseRosterState.q = e.target.value; clearTimeout(draw._t); draw._t = setTimeout(draw, 250); };
    $$('[data-crow]').forEach((tr) => (tr.onclick = (e) => {
      if (e.target.closest('[data-ftoggle]')) return;
      const c = casesByNid[tr.dataset.crow] || roster.find((x) => String(x.id) === tr.dataset.cid);
      openCaseDetailModal(c, c?.national_id ? audit.results.get(c.national_id) : null);
    }));
    $$('[data-ftoggle]').forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const c = roster.find((x) => String(x.id) === b.dataset.ftoggle);
      if (!c) return;
      try { await toggleFileStatus(c); viewCases(); } catch (err) { toast(err.message, true); }
    }));
    if (isDirector() && $('#cr-import')) drawCaseRosterImport($('#cr-import'), roster);
  };
  draw();
}

async function toggleFileStatus(c) {
  const next = !c.file_status;
  await db.update('case_roster', c.id, {
    file_status: next, file_updated_at: new Date().toISOString(),
    file_updated_by: session.user.id, file_updated_by_name: me.name,
  });
  toast(next ? '已標記案本已繳交' : '已標記案本未繳交');
}

function openCaseDetailModal(c, r) {
  if (!c) return;
  const monthsHtml = r ? `<div class="tbox" style="max-height:50vh;overflow:auto;margin-top:10px"><table class="t"><thead><tr><th>月份</th><th>家訪</th><th>電訪</th></tr></thead>
      <tbody>${r.months.map((m) => {
        const st = r.monthStatus[m];
        const homeText = st.家訪 === '達標' ? `達標（${fmtDate(st.家訪日期)}）` : st.家訪;
        const phoneText = st.電訪 === '達標' ? `達標（${fmtDate(st.電訪日期)}）` : st.電訪;
        return `<tr><td>${m}</td><td>${esc(homeText)}</td><td>${esc(phoneText)}</td></tr>`;
      }).join('')}</tbody></table></div>${r.blankMonths.length ? `<p class="small" style="color:var(--warn);margin-top:10px">以下月份有紀錄但內容不足 30 字、未採計：${esc(r.blankMonths.join('、'))}</p>` : ''}`
    : '<p class="small muted" style="margin-top:10px">還沒有訪視紀錄可供比對。</p>';
  modal(`<h2>${esc(c.name)}</h2>
    <p class="small muted" style="margin:4px 0 10px">案號 ${esc(c.case_no)}　身分證字號 ${esc(c.national_id)}　主責督導 ${esc(c.lead_supervisor)}　A單位 ${esc(c.unit_name)}　狀態 ${esc(c.status)}</p>
    <div class="inline-check">案本：<span id="cdFile">${c.file_status ? '✓ 已繳交' : '未繳交'}</span>${c.file_updated_by_name ? `<span class="small muted"> （${esc(c.file_updated_by_name)} ${fmtTime(c.file_updated_at)}）</span>` : ''}
      ${isDirector() ? '<button type="button" class="link" data-ftoggle2 style="margin-left:8px">切換</button>' : ''}</div>
    ${monthsHtml}
    <div class="acts"><button type="button" class="btn" data-no>關閉</button></div>`,
  (m, close) => {
    $('[data-no]', m).onclick = close;
    const tb = $('[data-ftoggle2]', m);
    if (tb) tb.onclick = async () => {
      tb.disabled = true;
      try { await toggleFileStatus(c); c.file_status = !c.file_status; $('#cdFile', m).textContent = c.file_status ? '✓ 已繳交' : '未繳交'; } catch (e) { toast(e.message, true); }
      tb.disabled = false;
    };
  });
}

function drawCaseRosterImport(box, roster) {
  const existingNos = new Set(roster.map((c) => c.case_no));
  box.innerHTML = `<div class="card stack">
    <p class="small muted" style="margin:0">上傳最新的個案總表，系統會用「案號」比對：既有案號會更新基本資料（不會動到「案本」勾選狀態），全新案號會新增。不會刪除既有名單裡的個案。</p>
    <label class="f">選擇個案總表 Excel 檔<input type="file" id="crFile" accept=".xlsx,.xls"></label>
    <p class="err-text" id="crerr" hidden></p>
    <div id="crPreview"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button type="button" class="btn" id="crAnalyze">分析檔案</button>
      <button type="button" class="btn primary" id="crImport" hidden>確認匯入</button>
    </div>
  </div>`;
  let parsed = null;
  $('#crAnalyze').onclick = async () => {
    const f = $('#crFile').files[0];
    const er = $('#crerr'); er.hidden = true; $('#crImport').hidden = true;
    if (!f) { er.textContent = '請先選擇檔案'; er.hidden = false; return; }
    const btn = $('#crAnalyze'); btn.disabled = true;
    try {
      parsed = await parseCaseRosterFile(f);
      if (parsed.missingHeaders.length) {
        er.textContent = `找不到欄位：${parsed.missingHeaders.join('、')}，請確認匯出格式是否正確`;
        er.hidden = false;
      } else {
        const newCount = parsed.usable.filter((r) => !existingNos.has(r.case_no)).length;
        const updateCount = parsed.usable.length - newCount;
        const uploadedNos = new Set(parsed.usable.map((r) => r.case_no));
        const untouched = roster.filter((c) => !uploadedNos.has(c.case_no));
        $('#crPreview').innerHTML = `<div class="card small" style="margin-top:8px">
          共 ${parsed.total} 筆，可匯入 ${parsed.usable.length} 筆，略過 ${parsed.skipped} 筆（無案號）。
          其中新增 ${newCount} 筆、更新 ${updateCount} 筆；本次未出現 ${untouched.length} 筆（保留不異動，清單裡的個案不會被刪除）。
          ${parsed.missingOptionalHeaders.length ? `<p class="small" style="color:var(--warn);margin:6px 0 0">此次匯出沒有「${parsed.missingOptionalHeaders.join('、')}」欄位，相關判斷會優雅降級，不會擋匯入。</p>` : ''}
          ${untouched.length ? `<details style="margin-top:8px"><summary style="cursor:pointer">看看是哪些個案本次未出現（可能已結案或轉出，案本/歸檔可以留意）</summary>
            <div class="tbox" style="margin-top:8px"><table class="t"><thead><tr><th>案號</th><th>姓名</th><th>原狀態</th></tr></thead>
              <tbody>${untouched.slice(0, 30).map((c) => `<tr><td>${esc(c.case_no)}</td><td>${esc(c.name)}</td><td>${esc(c.status)}</td></tr>`).join('')}</tbody></table></div>
            ${untouched.length > 30 ? `<p class="small muted" style="margin:6px 0 0">僅預覽前 30 筆，共 ${untouched.length} 筆</p>` : ''}
          </details>` : ''}
        </div>`;
        $('#crImport').hidden = false;
      }
    } catch (e) { er.textContent = e.message; er.hidden = false; }
    btn.disabled = false;
  };
  $('#crImport').onclick = async () => {
    const er = $('#crerr'); er.hidden = true;
    if (!parsed) return;
    const btn = $('#crImport'); btn.disabled = true;
    try {
      await upsertCaseRosterRows(parsed.usable, (done, total) => toast(`已更新 ${done} / ${total} 筆`));
      toast('匯入完成'); viewCases();
    } catch (e) { er.textContent = e.message; er.hidden = false; btn.disabled = false; }
  };
}

// 分批 upsert 進「個案清單」主檔；供「個案清單」頁面自己的匯入，以及下面
// 「個案比對」上傳完後順手同步用（兩處共用同一套邏輯，不要各寫一份）。
async function upsertCaseRosterRows(usableRows, onProgress) {
  const now = new Date().toISOString();
  const rows = usableRows.map((r) => ({ ...r, last_synced_at: now, last_synced_by_name: me.name }));
  const chunkSize = 400;
  for (let i = 0; i < rows.length; i += chunkSize) {
    await db.upsertMany('case_roster', rows.slice(i, i + chunkSize), 'case_no');
    onProgress?.(Math.min(i + chunkSize, rows.length), rows.length);
  }
  return rows.length;
}

// 「個案比對」每月上傳完後，順手問要不要用同一份檔案（已經在記憶體裡，不用使用者
// 重選一次）同步更新「個案清單」主檔——「個案清單」是持續維護的單一份資料，跟
// 「個案比對」每次匯入都是新快照的 rk_cases 分開，見 sql/08_case_roster.sql 的說明。
async function offerRosterSync(file, afterDone) {
  if (!isDirector() || !file) { afterDone?.(); return; }
  let parsed;
  try { parsed = await parseCaseRosterFile(file); } catch { afterDone?.(); return; }
  if (!parsed.usable.length) { afterDone?.(); return; }
  let existingNos;
  try { existingNos = new Set((await db.all('case_roster', { select: 'case_no' })).map((r) => r.case_no)); }
  catch { existingNos = new Set(); }
  const newCount = parsed.usable.filter((r) => !existingNos.has(r.case_no)).length;
  const updateCount = parsed.usable.length - newCount;
  modal(`<h2>同步到「個案清單」？</h2>
    <p class="small muted" style="margin:4px 0 0">用剛剛這份檔案比對「個案清單」（持續維護的個案主檔）：新增 ${newCount} 筆、更新 ${updateCount} 筆。只會更新基本資料，不會動到既有的「案本」勾選狀態，也不會刪除清單裡的任何個案。</p>
    <div class="acts"><button type="button" class="btn" data-no>不用，謝謝</button><button type="button" class="btn primary" data-yes>同步</button></div>`,
  (m, close) => {
    $('[data-no]', m).onclick = () => { close(); afterDone?.(); };
    $('[data-yes]', m).onclick = async () => {
      $('[data-yes]', m).disabled = true;
      try { await upsertCaseRosterRows(parsed.usable); toast('已同步到個案清單'); }
      catch (e) { toast(e.message, true); }
      close(); afterDone?.();
    };
  });
}

/* ================= 管理 ================= */
const ADMIN_TABS = {
  units: { label: '轉介單位', table: 'referral_units' }, nc: { label: '未成案原因', table: 'nc_reasons' },
  rj: { label: '拒絕原因', table: 'reject_reasons' }, cond: { label: '特殊條件', table: 'special_conditions' },
  sc: { label: '碼別', table: 'service_codes' },
  cg: { label: '居服員', table: 'caregivers' }, staff: { label: '督導與帳號', table: 'staff' },
};
async function viewAdmin(tab) {
  if (!ADMIN_TABS[tab]) tab = 'units';
  const T = ADMIN_TABS[tab];
  const rows = await db.all(T.table, { order: tab === 'cg' || tab === 'staff' ? 'active.desc,region,name' : 'active.desc,sort,name' });
  const isOpt = !['cg', 'staff', 'sc'].includes(tab);
  const regionSel = (name, cur) => `<select name="${name}">${opt('', '—', cur)}${REGIONS.map((r) => opt(r, r, cur)).join('')}</select>`;
  const roleSel = (cur) => `<select name="role">${[['supervisor', '督導'], ['director', '主任'], ['admin', '管理者']].map(([v, l]) => opt(v, l, cur)).join('')}</select>`;
  const head = isOpt ? '<th>名稱</th><th style="width:110px">排序</th>'
    : tab === 'sc' ? '<th style="width:110px">代碼</th><th>名稱</th><th style="width:110px">排序</th>'
      : tab === 'cg' ? '<th style="width:130px">員編</th><th>姓名</th><th style="width:130px">區域</th>' : '<th>姓名</th><th style="width:130px">區域</th><th style="width:130px">角色</th><th>登入帳號</th>';
  const cells = (r) => isOpt ? `<td><input type="text" name="name" value="${esc(r.name)}" aria-label="名稱"></td><td><input type="number" name="sort" value="${r.sort}" aria-label="排序"></td>`
    : tab === 'sc' ? `<td><input type="text" name="code" value="${esc(r.code || '')}" aria-label="代碼"></td><td><input type="text" name="name" value="${esc(r.name)}" aria-label="名稱"></td><td><input type="number" name="sort" value="${r.sort}" aria-label="排序"></td>`
      : tab === 'cg' ? `<td><input type="text" name="code" value="${esc(r.code || '')}" aria-label="員編"></td><td><input type="text" name="name" value="${esc(r.name)}" aria-label="姓名"></td><td>${regionSel('region', r.region)}</td>`
        : `<td><input type="text" name="name" value="${esc(r.name)}" aria-label="姓名"></td><td>${regionSel('region', r.region)}</td><td>${roleSel(r.role)}</td><td class="small">${r.user_id ? '已連結' : '<span class="faint">未連結</span>'}</td>`;
  $('#main').innerHTML = `
  <div class="head"><div><h1>管理</h1><div class="muted small" style="margin-top:4px">選項不刪除，不用的改成停用；停用後不會出現在下拉選單，但舊紀錄仍保留。</div></div></div>
  <nav class="tabs" aria-label="管理項目">${Object.entries(ADMIN_TABS).map(([k, v]) => `<a href="#/admin/${k}" class="${k === tab ? 'on' : ''}">${v.label}</a>`).join('')}</nav>
  ${tab === 'staff' ? '<div class="card small" style="margin-bottom:16px;color:var(--ink2)">新增登入帳號要在 Supabase 後台建立，再把帳號連到這裡的姓名，步驟見設定說明。主任與管理者可以判定拒案、刪除紀錄、管理選項。</div>' : ''}
  <div class="tbox"><table class="t" style="min-width:640px">
    <thead><tr>${head}<th style="width:80px">啟用</th><th style="width:90px"></th></tr></thead>
    <tbody>${rows.map((r) => `<tr data-id="${r.id}">${cells(r)}<td><input type="checkbox" name="active" ${r.active ? 'checked' : ''} aria-label="啟用" style="width:20px;height:20px;accent-color:var(--accent)"></td><td><button type="button" class="btn small" data-save>儲存</button></td></tr>`).join('')}
      <tr data-new>${cells({ name: '', sort: (rows.length ? Math.max(...rows.map((r) => r.sort || 0)) + 1 : 1), role: 'supervisor', region: tab === 'cg' || tab === 'staff' ? (me.region || '') : '' })}<td><input type="checkbox" name="active" checked aria-label="啟用" style="width:20px;height:20px;accent-color:var(--accent)"></td><td><button type="button" class="btn small primary" data-add>新增</button></td></tr>
    </tbody></table></div>
  <div id="ua-extra"></div>`;
  const read = (tr) => {
    const b = { name: $('[name=name]', tr).value.trim(), active: $('[name=active]', tr).checked };
    if (isOpt || tab === 'sc') b.sort = Number($('[name=sort]', tr).value) || 0;
    if (tab === 'sc') b.code = $('[name=code]', tr).value.trim() || null;
    if (tab === 'cg') { b.code = $('[name=code]', tr).value.trim() || null; b.region = $('[name=region]', tr).value || null; }
    if (tab === 'staff') { b.region = $('[name=region]', tr).value || null; b.role = $('[name=role]', tr).value; }
    return b;
  };
  $$('[data-save]').forEach((btn) => (btn.onclick = async () => {
    const tr = btn.closest('tr'); const b = read(tr);
    if (!b.name) { toast('名稱不能空白', true); return; }
    try { await db.update(T.table, Number(tr.dataset.id), b); await loadLookups(); toast('已儲存'); render(); } catch (e) { toast(e.message, true); }
  }));
  $('[data-add]').onclick = async () => {
    const b = read($('[data-new]'));
    if (!b.name) { toast('請輸入名稱', true); return; }
    try { await db.insert(T.table, b); await loadLookups(); toast('已新增'); render(); } catch (e) { toast(/duplicate|unique/.test(e.message) ? '這個名稱已經存在' : e.message, true); }
  };
  if (tab === 'units') await drawUnitAbbrSection($('#ua-extra'));
}

// 「轉介單位」管理頁的附加區塊：A單位縮寫（個案清單用）。轉介單位名稱本身就是短、
// 乾淨的單位名稱（佳耀、友福、博樂…），直接拿來當 A單位名稱的縮寫比對關鍵字，
// 不用另外維護一份關鍵字清單——新增/改轉介單位名稱，縮寫比對結果會自動跟著變。
async function drawUnitAbbrSection(box) {
  box.innerHTML = '<p class="muted">載入中…</p>';
  const [roster, abbrs] = await Promise.all([
    db.all('case_roster', { select: 'unit_name' }),
    db.all('unit_abbrs', { order: 'full_name' }),
  ]);
  const abbrByName = new Map(abbrs.map((a) => [a.full_name, a]));
  const unitLabel = makeUnitLabelResolver(abbrs, L.units);
  const names = new Set([...roster.map((r) => r.unit_name).filter(Boolean), ...abbrs.map((a) => a.full_name)]);
  const sorted = [...names].sort();

  box.innerHTML = `
  <div class="card stack" style="margin-top:16px">
    <div>
      <h2 style="margin:0">A單位縮寫（個案清單用）</h2>
      <p class="small muted" style="margin:4px 0 0">「個案清單」頁面的 A單位名稱常常是落落長的全名，且同一機構可能有好幾種寫法（例如多一個「(A)」）。系統會直接用上面「轉介單位」裡啟用中的名稱當關鍵字：A單位全名只要包含某個轉介單位名稱，就自動顯示那個短名稱；不用另外維護一份縮寫清單，新增/修改轉介單位就會同步生效。全名完全比對優先於關鍵字；比對不到的話，底下可以針對個別全名單獨設定。</p>
    </div>
    <div class="tbox"><table class="t"><thead><tr><th>A單位全名</th><th style="width:220px">縮寫</th><th style="width:70px"></th></tr></thead>
      <tbody>${sorted.map((n) => {
        const hasExact = abbrByName.has(n);
        const inherited = !hasExact ? unitLabel(n) : null;
        const inheritedHint = inherited && inherited !== n ? inherited : '例：佳耀';
        return `<tr><td>${esc(n)}</td><td><input type="text" class="uaInput" data-name="${esc(n)}" data-orig="${esc(abbrByName.get(n)?.abbr || '')}" value="${esc(abbrByName.get(n)?.abbr || '')}" placeholder="${esc(inheritedHint)}"></td>
        <td>${hasExact ? `<button type="button" class="link" style="color:var(--bad)" data-uadel="${abbrByName.get(n).id}">移除</button>` : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="3" class="empty">「個案清單」目前還沒有資料，沒有 A單位可以設定</td></tr>'}</tbody></table></div>
    <p class="small muted" style="margin:0">「移除」只會從這份個別覆蓋清單刪除，不會動到個案清單本身的資料；如果來源檔案的 A單位名稱寫法沒改，下次重新整理個案清單後這個全名可能會再出現。</p>
  </div>`;

  $$('.uaInput').forEach((input) => {
    input.onblur = async () => {
      const abbr = input.value.trim();
      if (abbr === input.dataset.orig) return; // 沒改過（含「本來就空白、還是空白」），不用存
      if (!abbr) { toast('留白不會覆蓋，要清除已設定的縮寫請按「移除」', true); return; }
      try {
        await db.upsert('unit_abbrs', { full_name: input.dataset.name, abbr, updated_by_name: me.name }, 'full_name');
        input.dataset.orig = abbr; toast('已儲存');
      } catch (e) { toast(e.message, true); }
    };
  });
  $$('[data-uadel]').forEach((btn) => (btn.onclick = async () => {
    if (!(await confirmBox('確定要從縮寫設定清單移除這一列嗎？', '移除', true))) return;
    try { await db.remove('unit_abbrs', Number(btn.dataset.uadel)); toast('已移除'); drawUnitAbbrSection(box); } catch (e) { toast(e.message, true); }
  }));
}

/* ================= 啟動 ================= */
$('#btn-logout').onclick = signOut;
$('#btn-pw').onclick = changePassword;
render();
