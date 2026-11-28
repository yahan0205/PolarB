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
// 系統內所有日期統一民國年；月份字串（YYYY-MM，例如 auditCases() 用的 visit_month/nextDue）轉成「民國年/MM」，
// 不是這個格式的字串（例如「尚無訪視歷史」這種文字狀態）原樣輸出，不強制轉換。
const fmtMonth = (ym) => { if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return ym || ''; const [y, m] = ym.split('-'); return `${Number(y) - 1911}/${m}`; };
const opt = (v, label, sel) => `<option value="${esc(v)}"${String(v) === String(sel ?? '') ? ' selected' : ''}>${esc(label)}</option>`;
// 00:00~24:00、每 5 分鐘一格的時間下拉選單（給個案細項與安排的時段用），避免原生 time 欄位跳出上午/下午選擇。
const TIME_OPTIONS = (() => {
  const out = ['<option value="">--:--</option>'];
  for (let m = 0; m <= 24 * 60; m += 5) {
    const v = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    out.push(`<option value="${v}">${v}</option>`);
  }
  return out.join('');
})();
const REGIONS = ['新莊', '淡水'];
const STATUSES = ['問案中', '成案', '未成案'];

function toast(msg, isErr = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = ''; }, isErr ? 5000 : 2500);
}

function modal(html, onMount, onClose) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  const close = () => { if (!root.firstElementChild) return; root.innerHTML = ''; document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('.modal-bg', root).addEventListener('click', (e) => { if (e.target.classList.contains('modal-bg')) close(); });
  onMount?.($('.modal', root), close);
  $('.modal input, .modal select, .modal textarea, .modal button', root)?.focus();
  return close;
}

function confirmBox(text, okLabel = '確定', danger = false) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value, close) => {
      if (settled) return;
      settled = true;
      close?.();
      resolve(value);
    };
    modal(`<p style="margin:0">${esc(text)}</p><div class="acts"><button type="button" class="btn" data-no>取消</button><button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okLabel)}</button></div>`,
      (m, close) => {
        $('[data-no]', m).onclick = () => finish(false, close);
        $('[data-yes]', m).onclick = () => finish(true, close);
      }, () => finish(false));
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
  // 大表（像 rk_visits 這種上萬筆的訪視歷史）分頁抓取：
  // 原本用「offset 分頁」實測發現 Postgres 底層會隨著 offset 越深越慢——offset=0 抓一頁約
  // 0.3~0.4 秒，offset=13000 抓同樣大小的一頁卻要 2.8 秒（要整批掃過＋丟棄前面 13000 筆才拿得到
  // 下一批），這是 OFFSET 分頁的已知通病，不是網路或併發的問題，之前改成「平行抓取」頂多是讓這些
  // 變慢的請求同時發生，總時間只有小幅改善（14 頁要 16~35 秒）。
  // 改成「id 遊標分頁」（下一頁用 id > 上一頁最後一筆的 id，直接走主鍵索引）後，不管第幾頁速度都
  // 差不多快，同樣 14 頁實測只要約 5 秒。只有在呼叫端沒有自訂 order 時才能這樣做（遊標分頁的前提
  // 是依 id 排序；系統裡少數幾個呼叫會自訂 order 做下拉選單/列表排序用，那些資料表都很小、
  // 用不到第二頁，所以維持原本的 offset 分頁，兩種情況分開處理，互不影響。
  async all(table, params = {}) {
    const size = 1000;
    if (params.order) {
      // 呼叫端指定了排序（通常是小型清單，一頁抓得完），用原本的 offset 分頁即可。
      const out = [];
      for (let off = 0; ; off += size) {
        const page = await rest('GET', table, { params: { ...params, limit: size, offset: off } });
        out.push(...page);
        if (page.length < size) return out;
      }
    }
    // 沒指定排序：用 id 遊標分頁，自動確保 select 裡有 id 可以當遊標（即使呼叫端的 select 沒寫 id）。
    const selectWithId = params.select && !params.select.split(',').includes('id') ? `id,${params.select}` : params.select;
    const pageParams = { ...params, ...(selectWithId ? { select: selectWithId } : {}), order: 'id' };
    const fetchPage = async (lastId, triesLeft = 3) => {
      try { return await rest('GET', table, { params: { ...pageParams, limit: size, ...(lastId === null ? {} : { id: `gt.${lastId}` }) } }); }
      catch (e) {
        if (triesLeft <= 1) throw e;
        await new Promise((r) => setTimeout(r, 400));
        return fetchPage(lastId, triesLeft - 1);
      }
    };
    const out = [];
    let lastId = null;
    for (;;) {
      const page = await fetchPage(lastId);
      out.push(...page);
      if (page.length < size) return out;
      lastId = page[page.length - 1].id;
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

// 管理後台「督導與帳號」的建立／重設密碼／刪除登入帳號，呼叫 admin-staff-account
// 這個 Edge Function（它持有 service role key，前端 anon key 做不到這些操作）。
async function callStaffAccount(action, staffId, extra) {
  const tok = await accessToken();
  const res = await fetch(`${BASE}/functions/v1/admin-staff-account`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, staff_id: staffId, ...(extra || {}) }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `帳號服務錯誤（${res.status}）`);
  return data;
}

// 建立／重設密碼都需要輸入密碼，共用這個小 modal。
function promptPassword(title, onSubmit) {
  modal(`<h2>${esc(title)}</h2>
    <label class="f">密碼（至少 8 碼）<input type="text" id="acctPw" autocomplete="off"></label>
    <p class="err-text" id="acctPwErr" hidden></p>
    <div class="acts"><button type="button" class="btn" data-no>取消</button><button type="button" class="btn primary" data-yes>確定</button></div>`,
  (m, close) => {
    $('[data-no]', m).onclick = close;
    $('[data-yes]', m).onclick = async () => {
      const pw = $('#acctPw', m).value;
      const er = $('#acctPwErr', m);
      if (pw.length < 8) { er.textContent = '密碼至少需要 8 碼'; er.hidden = false; return; }
      try { await onSubmit(pw); close(); } catch (e) { er.textContent = e.message; er.hidden = false; }
    };
  });
}

/* ================= 目前使用者與選項 ================= */
let me = null;            // 登入者在 staff 表的資料
let L = null;             // 下拉選項
const isDirector = () => me && (me.role === 'director' || me.role === 'admin');
const isAdmin = () => me && me.role === 'admin';
// 行政：只開放編輯個案清單的「結案箱年度」，其他主任／管理者專屬功能一律看不到、也不能動。
const isArchiveClerk = () => me && me.role === 'clerk';
const canEditArchiveBox = () => isDirector() || isArchiveClerk();

async function loadMe() {
  const rows = await db.get('staff', { user_id: `eq.${session.user.id}`, active: 'eq.true', select: '*' });
  me = rows[0] || null;
}

async function loadLookups() {
  const [units, nc, rj, cond, sc, cg, staff, permGrants, pagePerms] = await Promise.all([
    db.all('referral_units', { order: 'sort,name' }), db.all('nc_reasons', { order: 'sort,name' }),
    db.all('reject_reasons', { order: 'sort,name' }), db.all('special_conditions', { order: 'sort,name' }),
    db.all('service_codes', { order: 'sort,name' }),
    db.all('caregivers', { order: 'name' }), db.all('staff', { order: 'code,name' }),
    db.all('staff_permission_grants', { select: 'staff_id,permission_key' }),
    // role_page_permissions 是複合主鍵（role, page_key），沒有 id 欄位，db.all()
    // 沒指定 order 時預設的「id 遊標分頁」用不了，一定要指定 order（跟
    // todo_assignees 踩過同一個坑）。
    db.all('role_page_permissions', { order: 'role' }),
  ]);
  const byId = (a) => Object.fromEntries(a.map((x) => [x.id, x]));
  // 督導下拉選單順序：先新莊（依員編）、後淡水（依員編），跟 REGIONS 的區域順序一致；
  // 區域是 null 的（還沒設定區域）排最後。
  staff.sort((a, b) => {
    const ra = REGIONS.indexOf(a.region), rb = REGIONS.indexOf(b.region);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || (a.code || '').localeCompare(b.code || '') || a.name.localeCompare(b.name);
  });
  L = { units, nc, rj, cond, sc, cg, staff, unitById: byId(units), ncById: byId(nc), rjById: byId(rj), condById: byId(cond), scById: byId(sc), cgById: byId(cg), staffById: byId(staff) };
  // 通用業務權限：{staff_id}:{permission_key} 這種字串組成 Set，之後要加其他業務的
  // 授權判斷，程式裡只要多寫一個 permission_key 字串，不用改資料結構。
  L.permSet = new Set(permGrants.map((g) => `${g.staff_id}:${g.permission_key}`));
  // 頁面可見性矩陣：{role}:{page_key} → visible，以角色為單位，跟上面的業務權限
  // （以個人為單位）是兩種不同性質的授權，刻意分開存放。查無資料列（理論上不該
  // 發生，migration 已經把現有行為全部 seed 進去）時預設可見，不要因為資料庫
  // 一時查不到就把整個導覽列擋光。
  L.pagePermMap = new Map(pagePerms.map((p) => [`${p.role}:${p.page_key}`, p.visible]));
}
// 這個角色看不看得到某個頁面：查矩陣，查無資料時預設可見（fail-open，避免
// migration 還沒跑完或資料列意外缺漏時擋住所有人進不去任何頁面）。
const canSeePage = (pageKey) => { const v = L.pagePermMap?.get(`${me?.role}:${pageKey}`); return v !== false; };
// 主任/管理者一律視為有任何業務權限（跟資料庫端 is_director() 的判斷一致），
// 不用特別幫他們在 staff_permission_grants 裡勾選。
const hasPerm = (key, staffId = me?.id) => isDirector() || (staffId != null && L.permSet?.has(`${staffId}:${key}`));

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

// 待辦事項導覽列紅字提醒：比照拒案判定的作法，統計「被交辦給自己、還沒處理完」
// 的件數（不含每月範本本身，只算實際要做的事項），讓人一眼看出還有多少事沒做。
let pendingMyTodos = 0;
async function refreshMyTodoCount() {
  if (!me) return;
  try {
    const mine = await db.all('todo_assignees', { select: 'todo_id', staff_id: `eq.${me.id}`, order: 'todo_id' });
    const ids = mine.map((a) => a.todo_id);
    if (!ids.length) { pendingMyTodos = 0; }
    else {
      const rows = await db.all('todos', { select: 'id', id: `in.(${ids.join(',')})`, status: 'eq.待處理', is_monthly: 'eq.false' });
      pendingMyTodos = rows.length;
    }
  } catch { pendingMyTodos = 0; }
  drawNav();
}

function drawNav() {
  const h = location.hash || '#/';
  // 每個頁面的可見性改成查「頁面權限」矩陣（以角色為單位，管理頁面可調整），
  // 不再是寫死判斷角色；頁面裡面的細部操作權限（只有管理者能刪帳號之類）
  // 完全不受這裡影響，繼續維持原本寫死在各自功能裡的判斷。
  const allItems = [
    ['inquiries', '#/', '問案', /^#\/($|i\/|new)/],
    ['cases', '#/cases', '個案清單', /^#\/cases/],
    ['report', '#/report', '派案紀錄', /^#\/report/],
    ['stats', '#/stats', '統計', /^#\/stats/],
    ['visitaudit', '#/visitaudit', '家電訪稽核', /^#\/visitaudit/],
    ['todos', '#/todos', `待辦事項${pendingMyTodos ? `<span class="badge-n">${pendingMyTodos}</span>` : ''}`, /^#\/todos/],
    ['cgaudit', '#/cgaudit', '居服員稽核', /^#\/cgaudit/],
    ['cgsup', '#/cgsup', '個督檢核', /^#\/cgsup/],
    ['judge', '#/judge', `拒案判定${pendingJudge ? `<span class="badge-n">${pendingJudge}</span>` : ''}`, /^#\/judge/],
    ['synclog', '#/synclog', '同步紀錄', /^#\/synclog/],
    ['admin', '#/admin', '管理', /^#\/admin/],
  ];
  const items = allItems.filter(([key]) => canSeePage(key));
  // 「管理」改成下拉選單：滑鼠移過去／觸碰展開，分組直接列出帳號/權限/資料庫
  // 底下的子頁面，點了直接跳過去，不用先進管理頁面再點一次分頁。分組設定
  // 跟管理頁面內部的分頁列共用同一份 ADMIN_GROUPS，兩邊永遠一致。
  const navHtml = ([key, href, label, re]) => {
    if (key !== 'admin') return `<a href="${href}" class="${re.test(h) ? 'on' : ''}">${label}</a>`;
    const groupsHtml = ADMIN_GROUPS.map((g) => {
      const keys = g.keys.filter((k) => k !== 'rotation' || isAdmin());
      if (!keys.length) return '';
      return `<div class="nav-dropdown-group"><div class="nav-dropdown-group-label">${esc(g.label)}</div>${keys.map((k) => {
        const kLabel = k === 'rotation' ? '輪接' : ADMIN_TABS[k].label;
        const kHref = k === 'rotation' ? '#/admin/rotation' : `#/admin/${k}`;
        return `<a href="${kHref}">${esc(kLabel)}</a>`;
      }).join('')}</div>`;
    }).join('');
    return `<span class="nav-dropdown"><a href="${href}" class="${re.test(h) ? 'on' : ''}">${label}</a><div class="nav-dropdown-menu">${groupsHtml}</div></span>`;
  };
  $('#nav').innerHTML = items.map(navHtml).join('');
  $('#whoami').textContent = me ? `${me.name}${me.region ? ' · ' + me.region : ''}${isDirector() ? ' · ' + (me.role === 'admin' ? '管理者' : '主任') : isArchiveClerk() ? ' · 行政' : ''}` : '';
}

/* ================= 路由 ================= */
async function render() {
  const main = $('#main');
  if (!BASE || BASE.includes('你的專案') || BASE.includes('YOUR-TEST-PROJECT')) {
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
    if (!L) { await loadLookups(); refreshJudgeCount(); refreshMyTodoCount(); }
    $('#topbar').hidden = false; drawNav();
    const h = location.hash || '#/';
    let m;
    // 頁面可見性查「頁面權限」矩陣（canSeePage），跟導覽列用同一套判斷，不要
    // 讓人直接打網址繞過導覽列沒顯示的限制。#/admin/rotation 刻意額外多一層
    // isAdmin() 寫死檢查，不受矩陣影響——輪接設定是故意不開放彈性調整的。
    if ((h === '#/' || h === '#' || h === '') && canSeePage('inquiries')) await viewList();
    else if (h === '#/new' && canSeePage('inquiries')) await viewForm(null);
    else if ((m = h.match(/^#\/i\/(\d+)\/edit(?:\?status=(.+))?$/)) && canSeePage('inquiries')) await viewForm(Number(m[1]), m[2] ? decodeURIComponent(m[2]) : null);
    else if ((m = h.match(/^#\/i\/(\d+)$/)) && canSeePage('inquiries')) await viewDetail(Number(m[1]));
    else if (h === '#/judge' && canSeePage('judge')) await viewJudge();
    else if (h === '#/synclog' && canSeePage('synclog')) await viewSyncLog();
    else if (h === '#/visitaudit' && canSeePage('visitaudit')) await viewVisitAudit();
    else if (h === '#/todos' && canSeePage('todos')) await viewTodos();
    else if (h === '#/cgaudit' && canSeePage('cgaudit')) await viewCaregiverAuditList();
    else if ((m = h.match(/^#\/cgaudit\/(\d+)$/)) && canSeePage('cgaudit')) await viewCaregiverAuditDetail(Number(m[1]));
    else if (h === '#/cgsup' && canSeePage('cgsup')) await viewCgSupervisionList();
    else if ((m = h.match(/^#\/cgsup\/(\d+)$/)) && canSeePage('cgsup')) await viewCgSupervisionDetail(Number(m[1]));
    else if (h === '#/cases' && canSeePage('cases')) await viewCases();
    else if (h === '#/report' && canSeePage('report')) await viewReport();
    else if (h === '#/stats' && canSeePage('stats')) await viewStats();
    else if (h === '#/admin/rotation' && isAdmin()) await viewRotationAdmin();
    else if ((m = h.match(/^#\/admin(?:\/(\w+))?$/)) && canSeePage('admin')) await viewAdmin(m[1] || 'units');
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

/* ================= 居督輪接（資料庫為唯一正式分配來源） ================= */
const rotationRpc = (name, args) => rest('POST', `rpc/${name}`, { body: args });
// 輪接問案的建立、一般欄位修改及改派均以資料庫單一交易完成。
const rotationSave = (id, payload, overrideId = null, reason = null) =>
  rotationRpc('rotation_save_inquiry', { p_inquiry_id: id, p_payload: payload, p_override_staff_id: overrideId, p_reason: reason });
async function rotationState(region) {
  const cfgs = await db.get('rotation_regions', { region: `eq.${region}`, select: '*' });
  const cfg = cfgs[0];
  if (!cfg) return { enabled: false, slots: [], next: null };
  const slots = await db.get('rotation_slots', { region: `eq.${region}`, generation: `eq.${cfg.generation}`, select: 'id,position,staff_id', order: 'position' });
  if (!cfg.enabled || !slots.length) return { ...cfg, slots, next: null };
  const allocs = await db.all('rotation_allocations', { region: `eq.${region}`, generation: `eq.${cfg.generation}`, select: 'id,sequence_number,released_at' });
  const open = new Set(allocs.filter((a) => !a.released_at).map((a) => Number(a.sequence_number)));
  const freed = allocs.filter((a) => a.released_at && !open.has(Number(a.sequence_number))).map((a) => Number(a.sequence_number));
  const sequence = freed.length ? Math.min(...freed) : Number(cfg.next_sequence);
  return { ...cfg, slots, next: { sequence, staff_id: slots[(sequence - 1) % slots.length].staff_id, isBackfill: !!freed.length } };
}
// 輪接現況表：照「目前實際主責居督」判斷每個順位的人手上有沒有案子，不是照「原始分配到哪個順位」。
// 這樣人工改派進來的案子，會正確顯示在接收者名下；被改派走、或未成案／被刪除釋出的人則顯示待承接。
async function rotationStatusBoard(region) {
  const s = await rotationState(region);
  if (!s.enabled || !s.slots.length) return null;
  const allocs = await db.all('rotation_allocations', { region: `eq.${region}`, generation: `eq.${s.generation}`, select: 'inquiry_id' });
  const ids = [...new Set(allocs.map((a) => a.inquiry_id).filter(Boolean))];
  let byLead = {};
  if (ids.length) {
    const rows = await db.get('inquiries', { id: `in.(${ids.join(',')})`, select: 'id,code,client_name,lead_staff_id,status' });
    rows.filter((r) => r.status !== '未成案' && r.lead_staff_id).forEach((r) => {
      if (!byLead[r.lead_staff_id]) byLead[r.lead_staff_id] = `${r.code}${r.client_name ? '　' + r.client_name : ''}`;
    });
  }
  const rows = s.slots.map((sl) => {
    const label = byLead[sl.staff_id];
    return { position: sl.position, name: L.staffById[sl.staff_id]?.name || '未知人員', waiting: !label, label: label || '待承接' };
  });
  rows.sort((a, b) => (a.waiting === b.waiting ? a.position - b.position : (a.waiting ? -1 : 1)));
  return rows;
}
function rotationNames(s) { return (s.slots || []).map((x) => `${x.position}. ${L.staffById[x.staff_id]?.name || '未知人員'}`).join(' → '); }
async function rotationShow(region) {
  if (region === '全部') region = me.region || REGIONS[0];
  try {
    const s = await rotationState(region);
    modal(`<h2>${esc(region)}居督輪接順序</h2><p>${s.enabled ? '已啟用' : '未啟用'}</p>
      <p class="rotation-sequence">${s.slots.length ? esc(rotationNames(s)) : '尚未設定輪接名單'}</p>
      ${s.enabled && s.next ? `<p class="small muted">目前預覽下一順位：${esc(L.staffById[s.next.staff_id]?.name || '')}${s.next.isBackfill ? '（遞補未成案空缺）' : ''}。正式儲存時以資料庫即時分配結果為準。</p>` : ''}
      <div class="acts"><button type="button" class="btn" data-close>關閉</button></div>`, (box, close) => { $('[data-close]', box).onclick = close; });
  } catch(e) { toast(`無法讀取輪接設定：${e.message}`, true); }
}
async function rotationChanges(inquiryId) {
  return db.get('rotation_changes', { inquiry_id: `eq.${inquiryId}`, select: '*', order: 'changed_at.desc,id.desc' });
}
function rotationChangeLines(changes) {
  return changes.map((c) => `<li><span class="small muted">${fmtTime(c.changed_at)}</span> ${esc(L.staffById[c.previous_staff_id]?.name || '—')} → ${esc(L.staffById[c.new_staff_id]?.name || '—')}
     ${c.amendment_of ? '<span class="small muted">（原因更正）</span>' : ''}｜${esc(c.reason)}
     ${isAdmin() ? `<button class="btn small" type="button" data-amend="${c.id}">修正原因</button>` : ''}</li>`).join('');
}
function rotationAskReason(fromName, toName) {
  return new Promise((resolve) => {
    modal(`<h2>更換主責居督</h2><p>由「${esc(fromName)}」更換為「${esc(toName)}」</p>
      <label class="f">異動原因 <span class="req">*</span><textarea id="rotation-reason" rows="3" placeholder="請說明更換原因"></textarea></label>
      <p class="err-text" id="rotation-reason-error" hidden></p>
      <div class="acts"><button type="button" class="btn" data-cancel>取消</button><button type="button" class="btn primary" data-confirm>確認更換</button></div>`, (box, close) => {
      $('[data-cancel]', box).onclick = () => { close(); resolve(null); };
      $('[data-confirm]', box).onclick = () => {
        const reason = $('#rotation-reason',box).value.trim();
        if (!reason) { $('#rotation-reason-error',box).textContent = '請填寫異動原因'; $('#rotation-reason-error',box).hidden = false; return; }
        resolve(reason); close();
      };
    }, () => resolve(null));
  });
}
function rotationAskDeleteReason(code) {
  return new Promise((resolve) => {
    modal(`<h2>刪除有輪接歷程的問案</h2><p>問案「${esc(code)}」已有輪接歷程，刪除後輪接的順位分配與異動紀錄仍會保留，不會一併刪除。</p>
      <label class="f">刪除原因 <span class="req">*</span><textarea id="rotation-del-reason" rows="3" placeholder="請說明刪除原因"></textarea></label>
      <p class="err-text" id="rotation-del-reason-error" hidden></p>
      <div class="acts"><button type="button" class="btn" data-cancel>取消</button><button type="button" class="btn ghost-danger" data-confirm>確認刪除</button></div>`, (box, close) => {
      $('[data-cancel]', box).onclick = () => { close(); resolve(null); };
      $('[data-confirm]', box).onclick = () => {
        const reason = $('#rotation-del-reason',box).value.trim();
        if (!reason) { $('#rotation-del-reason-error',box).textContent = '請填寫刪除原因'; $('#rotation-del-reason-error',box).hidden = false; return; }
        resolve(reason); close();
      };
    }, () => resolve(null));
  });
}
async function rotationAmend(id) {
  if (!isAdmin()) { toast('僅管理者可以修正改派原因', true); return; }
  const reason = await rotationAskReason('原異動原因', '更正後原因');
  if (!reason) return;
  try { await rotationRpc('rotation_amend_reason', { p_change_id: id, p_reason: reason }); toast('原因已更正，原紀錄仍保留'); render(); }
  catch(e) { toast(e.message,true); }
}
async function viewRotationAdmin() {
  if (!isAdmin()) throw new Error('僅管理者可修改輪接設定');
  const configs = await Promise.all(REGIONS.map(rotationState));
  let region = me.region && REGIONS.includes(me.region) ? me.region : REGIONS[0];
  let choices = [];
  let enabledChoice=Boolean(configs[REGIONS.indexOf(region)].enabled);
  const main = $('#main');
  const draw = () => {
    const state = configs[REGIONS.indexOf(region)];
    const eligible = L.staff.filter((x) => x.region === region && x.active && x.role === 'supervisor');
    main.innerHTML = `<div class="head"><div><h1>管理 · 居督輪接</h1><div class="muted small">僅管理者可修改。每次啟用或儲存新順序都從第 1 順位重新開始，舊資料與異動紀錄保留。</div></div></div>
      <nav class="tabs"><a href="#/admin/staff">← 返回管理</a></nav>
      <section class="card stack"><label class="f">區域<select id="rotation-region">${REGIONS.map((x)=>opt(x,x,region)).join('')}</select></label>
      <p class="small muted">目前狀態：${state.enabled?'啟用':'停用'}；循環版本 ${state.generation}</p>
      <label class="inline-check"><input type="checkbox" id="rotation-enabled" ${enabledChoice?'checked':''}> 啟用輪接</label>
      <div id="rotation-edit-list" class="stack">${choices.map((staffId,i)=>`<div class="rotation-edit-row"><span>順位 ${i+1}</span><select data-slot="${i}">${eligible.map((x)=>opt(x.id,x.name,staffId)).join('')}</select>
       <button class="btn small" data-up="${i}" ${i===0?'disabled':''}>上移</button><button class="btn small" data-down="${i}" ${i===choices.length-1?'disabled':''}>下移</button><button class="btn small" data-remove="${i}">移除</button></div>`).join('')}</div>
      <div class="acts"><button class="btn" type="button" id="rotation-add" ${!eligible.length?'disabled':''}>＋ 增加順位</button><button class="btn primary" type="button" id="rotation-save">儲存設定</button></div>
      <p class="small muted">同一居督可重複選擇，例如甲－乙－甲－丙；異動順序會建立新的循環版本。若停用後重新啟用，請確認名單再儲存。</p></section>`;
    $('#rotation-region').onchange=(e)=>{ region=e.target.value; const next=configs[REGIONS.indexOf(region)];enabledChoice=Boolean(next.enabled); choices=next.slots.map((x)=>x.staff_id); draw(); };
    $('#rotation-enabled').onchange=(e)=>{enabledChoice=e.target.checked;};
    $$('[data-slot]').forEach((el)=>el.onchange=()=>{choices[Number(el.dataset.slot)]=Number(el.value);});
    $$('[data-up]').forEach((el)=>el.onclick=()=>{let i=Number(el.dataset.up); [choices[i-1],choices[i]]=[choices[i],choices[i-1]];draw();});
    $$('[data-down]').forEach((el)=>el.onclick=()=>{let i=Number(el.dataset.down); [choices[i+1],choices[i]]=[choices[i],choices[i+1]];draw();});
    $$('[data-remove]').forEach((el)=>el.onclick=()=>{choices.splice(Number(el.dataset.remove),1);draw();});
    $('#rotation-add').onclick=()=>{ choices.push(eligible[0].id);draw(); };
    $('#rotation-save').onclick=async()=>{
      const button=$('#rotation-save');
      const enabled=enabledChoice;
      const regionToSave=region;
      const oldGeneration=Number(configs[REGIONS.indexOf(regionToSave)].generation);
      const intendedSlots=[...choices].map(Number);
      if (enabled && intendedSlots.length===0) {toast('啟用時至少需要一個順位',true);return;}
      if (enabled && intendedSlots.some((id)=>!eligible.some((s)=>s.id===id))) {toast('輪接名單包含非本區在職居督，請重新選擇',true);return;}
      // 明列所有順位，避免使用者新增列後忘記更改預設人選（例如甲甲甲甲）。
      const summary=enabled ? intendedSlots.map((id,i)=>`${i+1}. ${L.staffById[id]?.name || '未知居督'}`).join(' → ') : '停用（不再自動分配新問案）';
      if (!await confirmBox(`確認儲存「${regionToSave}」輪接設定？\n${summary}\n每次儲存會從第 1 順位開啟新的輪接週期，歷史紀錄保留。`))return;
      button.disabled=true;
      try {
        await rotationRpc('rotation_configure',{p_region:regionToSave,p_enabled:enabled,p_staff_ids:enabled?intendedSlots:null});
        // 不能因 RPC 沒報錯就宣稱儲存完成；必須重新讀取 DB 並比對每一順位。
        const verified=await rotationState(regionToSave);
        const actualSlots=verified.slots.map((s)=>Number(s.staff_id));
        if (Number(verified.generation)<=oldGeneration || Boolean(verified.enabled)!==enabled || (enabled &&
          (actualSlots.length!==intendedSlots.length || actualSlots.some((id,i)=>id!==intendedSlots[i])))) {
          throw new Error('資料庫設定與畫面提交內容不一致；請重新整理確認，勿連續重複儲存。');
        }
        await viewRotationAdmin();
        toast(`已確認${regionToSave}輪接設定儲存成功（版本 ${verified.generation}）`);
      } catch(e) { toast(`輪接設定未確認成功：${e.message}`,true); }
      finally { if(button.isConnected) button.disabled=false; }
    };
  };
  choices=configs[REGIONS.indexOf(region)].slots.map((x)=>x.staff_id);
  draw();
}

/* ================= 問案列表 ================= */
const listState = store.get('bole.list') || { region: null, status: '全部', year: '全部', month: '全部', q: '', mine: false, dateSort: 'desc' };
if (!listState.dateSort) listState.dateSort = 'desc';
if (!listState.month) listState.month = '全部';
if (listState.needsFollowup === undefined) listState.needsFollowup = false;
let listShow = 100;

async function viewList() {
  if (listState.region === null) listState.region = me.region || '全部';
  const [rotationConfigs, rotationFlags] = await Promise.all([
    db.get('rotation_regions', { select:'region,enabled' }),
    db.all('rotation_changes',{select:'id,inquiry_id'})
  ]);
  const changedIds = new Set(rotationFlags.map((x)=>x.inquiry_id));
  const rows = await db.all('inquiries_v', {
    select: 'id,code,region,inquiry_date,unit_name,case_manager,client_name,address,service_detail,condition_names,intake_staff_id,lead_staff_id,intake_name,status,match_total,match_rejected,match_accepted,match_pending,referral_date,contract_date',
    order: 'inquiry_date.desc.nullslast,code.desc',
  });
  const years = [...new Set(rows.map((r) => rocYear(r.inquiry_date)).filter(Boolean))].sort((a, b) => b - a);
  // 照會日期／簽約日改成非必填後，成案當下可能還沒補齊，用這個判斷找出「已成案但
  // 兩個欄位至少有一個還沒填」的問案，讓主責督導可以篩選出來補登，取代原本「存檔
  // 時強制填寫」的做法。
  const needsFollowupCount = rows.filter((r) => r.status === '成案' && (!r.referral_date || !r.contract_date)).length;
  const draw = () => {
    store.set('bole.list', listState);
    const q = listState.q.trim().toLowerCase();
    const base = rows.filter((r) => (listState.region === '全部' || r.region === listState.region)
      && (listState.year === '全部' || String(rocYear(r.inquiry_date)) === String(listState.year))
      && (listState.month === '全部' || (r.inquiry_date && Number(r.inquiry_date.slice(5, 7)) === Number(listState.month)))
      && (!listState.mine || r.intake_staff_id === me.id || r.lead_staff_id === me.id)
      && (!listState.needsFollowup || (r.status === '成案' && (!r.referral_date || !r.contract_date)))
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
      <div class="right"><button type="button" class="btn" id="rotation-peek" ${rotationConfigs.some((x)=>x.enabled && (listState.region === '全部' || x.region === listState.region))?"":"hidden"}>查看輪接順序</button><a class="btn primary" href="#/new">＋ 新增問案</a></div></div>
    <div class="card filters">
      <div class="seg" role="group" aria-label="區域">${['全部', ...REGIONS].map((r) => `<button type="button" data-region="${r}" class="${listState.region === r ? 'on' : ''}">${r}</button>`).join('')}</div>
      <div class="pills" role="group" aria-label="狀態">${['全部', ...STATUSES].map((s) => `<button type="button" data-status="${s}" class="${listState.status === s ? 'on' : ''}">${s}<span>${count(s)}</span></button>`).join('')}</div>
      <label class="inline-check">年度 <select id="fyear">${opt('全部', '全部', listState.year)}${years.map((y) => opt(y, `${y} 年`, listState.year)).join('')}</select></label>
      <label class="inline-check">月份 <select id="fmonth" ${listState.year === '全部' ? 'disabled' : ''}>${opt('全部', '全部', listState.month)}${Array.from({ length: 12 }, (_, i) => opt(i + 1, `${i + 1} 月`, listState.month)).join('')}</select></label>
      <label class="inline-check"><input type="checkbox" id="fmine" ${listState.mine ? 'checked' : ''}>我負責的</label>
      <label class="inline-check" ${needsFollowupCount ? '' : 'style="color:var(--ink2)"'}><input type="checkbox" id="fneedsfollowup" ${listState.needsFollowup ? 'checked' : ''}>成案資料待補${needsFollowupCount ? ` <span class="badge-n">${needsFollowupCount}</span>` : ''}</label>
      <input type="search" class="grow" id="fq" placeholder="搜尋個案、單位、地址、編號" value="${esc(listState.q)}" aria-label="搜尋">
    </div>
    <div class="tbox"><table class="t" style="min-width:1000px">
      <thead><tr><th>編號</th><th id="th-date" style="cursor:pointer;user-select:none" title="點擊排序">問案日期 <span class="small muted">${sortIcon}</span></th><th>區域</th><th>轉介單位</th><th>個案</th><th>服務需求</th><th>特殊條件</th><th>收案督導</th><th>媒合</th><th>狀態</th></tr></thead>
      <tbody>${shown.slice(0, listShow).map((r) => `
        <tr class="click" data-id="${r.id}">
          <td class="nowrap"><a href="#/i/${r.id}">${esc(r.code)}</a>${changedIds.has(r.id)?` <span title="主責督導有異動紀錄" aria-label="有主責督導異動紀錄">✎</span>`:""}</td>
          <td class="nowrap">${fmtDate(r.inquiry_date)}</td>
          <td>${esc(r.region)}</td>
          <td class="nowrap">${esc(r.unit_name)}${r.case_manager ? `<div class="sub">個管 ${esc(r.case_manager)}</div>` : ''}</td>
          <td class="nowrap">${esc(r.client_name || '—')}<div class="sub">${esc(r.address || '')}</div></td>
          <td class="mono" style="max-width:240px">${esc(r.service_detail || '')}</td>
          <td>${(r.condition_names || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</td>
          <td class="nowrap">${esc(r.intake_name || '')}</td>
          <td class="nowrap small">${matchSummary(r)}</td>
          <td><span class="st s-${r.status}">${r.status}</span>${r.status === '成案' && (!r.referral_date || !r.contract_date) ? `<div class="sub" style="color:var(--warn)">⚠ ${[!r.referral_date && '照會日期', !r.contract_date && '簽約日'].filter(Boolean).join('、')}待補</div>` : ''}</td>
        </tr>`).join('') || '<tr><td colspan="10" class="empty">沒有符合條件的問案</td></tr>'}</tbody>
    </table>${shown.length > listShow ? `<div class="more"><button type="button" class="btn" id="more">再顯示 100 筆（還有 ${shown.length - listShow} 筆）</button></div>` : ''}</div>`;
    $('#rotation-peek')?.addEventListener('click',()=>rotationShow(listState.region));
    $$('[data-region]').forEach((b) => (b.onclick = () => { listState.region = b.dataset.region; listShow = 100; draw(); }));
    $$('[data-status]').forEach((b) => (b.onclick = () => { listState.status = b.dataset.status; listShow = 100; draw(); }));
    $('#fyear').onchange = (e) => { listState.year = e.target.value; if (listState.year === '全部') listState.month = '全部'; listShow = 100; draw(); };
    $('#fmonth').onchange = (e) => { listState.month = e.target.value; listShow = 100; draw(); };
    $('#fmine').onchange = (e) => { listState.mine = e.target.checked; listShow = 100; draw(); };
    // 「成案資料待補」篩選出來的一定是狀態=成案的問案；如果使用者之前把上面的狀態
    // 篩選停在「問案中」或「未成案」，兩個條件會互相打架，篩出 0 筆卻還顯示待補筆數
    // 的徽章，看起來像 bug。勾選時順手把狀態篩選重設回「全部」，避免這種衝突。
    $('#fneedsfollowup').onchange = (e) => {
      listState.needsFollowup = e.target.checked;
      if (listState.needsFollowup && listState.status !== '全部' && listState.status !== '成案') listState.status = '全部';
      listShow = 100; draw();
    };
    // 跟「個案清單」搜尋框同樣的問題：每次輸入都整個重畫表格（含搜尋框本身），框本身
    // 被換掉會讓焦點、游標位置跟著消失，打字打到一半畫面重畫就會感覺「被中斷」，中文
    // 注音/拼音輸入法選字選到一半被打斷更明顯。修法同個案清單：(1) 中文組字期間
    // （compositionstart~compositionend）完全不重畫，等選字完成才重畫；(2) 重畫完後
    // 自動把焦點、游標位置還原回搜尋框。
    const fq = $('#fq');
    let fqComposing = false;
    const scheduleFqDraw = () => {
      clearTimeout(draw._t);
      draw._t = setTimeout(() => {
        const cursor = fq.selectionStart;
        draw();
        const i = $('#fq');
        if (i) { i.focus(); i.setSelectionRange(cursor, cursor); }
      }, 250);
    };
    fq.addEventListener('compositionstart', () => { fqComposing = true; });
    fq.addEventListener('compositionend', () => { fqComposing = false; listState.q = fq.value; listShow = 100; scheduleFqDraw(); });
    fq.oninput = (e) => {
      listState.q = e.target.value; listShow = 100;
      if (fqComposing) return; // 組字過程中先不重畫，等 compositionend 再重畫
      scheduleFqDraw();
    };
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
  const rotation = await rotationState(r.region);
  const hadRotation = id ? (await db.get('rotation_allocations',{inquiry_id:`eq.${id}`,select:'id',limit:1})).length>0 : false;
  const originalLeadId = id ? r.lead_staff_id : null;
  if (!id && rotation.enabled && rotation.next && r.status !== '未成案') r.lead_staff_id=rotation.next.staff_id;
  // 輪接時只列出同區、在職督導；原主責若失去資格仍保留歷史顯示。
  const staffOpts = (cur, region=null, rotationOnly=false) => {
    const pool=L.staff.filter((s)=>(!region || s.region===region) && (!rotationOnly || (s.role==='supervisor' && s.active)));
    const available=rotationOnly ? pool : activeOr(pool,cur);
    const current=rotationOnly && cur && !available.some((s)=>String(s.id)===String(cur))
      ? L.staff.find((s)=>String(s.id)===String(cur) && s.region===region) : null;
    return opt('', '請選擇',cur) + available.map((s)=>opt(s.id,s.name+(s.region?`（${s.region}）`:''),cur)).join('')+
      (current ? `<option value="${Number(current.id)}" selected>${esc(current.name)}（歷史主責，已不符合輪接資格）</option>` : '');
  };
  $('#main').innerHTML = `
  <a href="${id ? `#/i/${id}` : '#/'}" class="small" style="text-decoration:none">← ${id ? '回問案明細' : '回問案列表'}</a>
  <div class="head" style="margin-top:10px"><h1>${id ? `編輯問案 ${esc(r.code)}` : '新增問案'}</h1></div>
  <form class="card stack" id="f" novalidate>
    <div class="grid3">
      <label class="f">區域 <span class="req">*</span><select name="region">${REGIONS.map((x) => opt(x, x, r.region)).join('')}</select></label>
      <label class="f">問案日期 <span class="req">*</span><input type="date" name="inquiry_date" value="${esc(r.inquiry_date || '')}"></label>
      <label class="f">收案督導 <span class="req">*</span><select name="intake_staff_id">${staffOpts(r.intake_staff_id)}</select></label>
      <label class="f">轉介單位 <span class="req">*</span><input type="text" name="unit_name" list="unitlist" autocomplete="off" value="${esc(L.unitById[r.unit_id]?.name || '')}" placeholder="輸入一個字搜尋">
      <datalist id="unitlist">${activeOr(L.units, r.unit_id).map((u) => `<option value="${esc(u.name)}">`).join('')}</datalist></label>
      <label class="f">個管師<input type="text" name="case_manager" value="${esc(r.case_manager || '')}" placeholder="姓氏即可"></label>
      <label class="f">個案姓名<input type="text" name="client_name" value="${esc(r.client_name || '')}" placeholder="選填，尚未知道可先留空"></label>
      <label class="f spanall">地址（區／路名即可） <span class="req">*</span><input type="text" name="address" value="${esc(r.address || '')}"></label>
      <fieldset class="spanall" id="svc-builder">
        <legend>個案細項與安排 <span class="req">*</span></legend>
        <p class="small muted" style="margin:0 0 6px">每個時段可各自勾選星期、選時間（24 小時制下拉選單）、選碼別並補充說明；同一個案不同天時段不同時，按「＋ 增加時段」多開一組。</p>
        <div id="svc-segments" class="stack"></div>
        <div class="acts" style="margin-top:8px"><button class="btn" type="button" id="svc-add">＋ 增加時段</button></div>
        <label class="f spanall" style="margin-top:8px">其他補充說明<textarea name="svc_extra" placeholder="不屬於單一時段的補充內容${id ? '（原始內容已帶入，可直接編輯）' : '（選填）'}"></textarea></label>
        <div class="small muted" style="margin-top:6px">預覽：<span id="svc-preview" class="mono">（尚未填寫）</span></div>
        <textarea name="service_detail" hidden></textarea>
      </fieldset>
      <fieldset class="spanall"><legend>特殊條件</legend><div class="checks">${activeOr(L.cond, null).concat(L.cond.filter((c) => !c.active && (r.condition_ids || []).includes(c.id))).map((c) => `<label><input type="checkbox" name="cond" value="${c.id}" data-other="${c.name === '其他' ? '1' : ''}" ${(r.condition_ids || []).includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('')}</div>
        <label class="f" id="cond-other-note" hidden>其他說明<input type="text" name="condition_other_note" value="${esc(r.condition_other_note || '')}"></label>
      </fieldset>
    </div>
    <hr style="border:0;border-top:1px solid var(--line2);margin:4px 0">
    <div class="grid3">
      <label class="f">狀態<select name="status" id="fstatus">${(id ? STATUSES : STATUSES.filter((s) => s !== '成案')).map((s) => opt(s, s, r.status)).join('')}</select></label>
      <label class="f">預計主責居服<input type="text" name="expected_caregiver" list="cglist" value="${esc(r.expected_caregiver || '')}" placeholder="媒合接受後會自動帶入"></label>
      <datalist id="cglist">${L.cg.filter((c) => c.active).map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
      <label class="f" id="rotation-lead" data-for="成案">主責督導 <span class="req">*</span><select name="lead_staff_id">${staffOpts(r.lead_staff_id,r.region)}</select></label>
      <div class="spanall small muted" id="rotation-note" hidden>輪接預覽僅供參考，實際分配以儲存時為準。若人工改派，必須填寫原因；新增問案與改派將在同一筆資料庫交易內完成。</div>
      ${!id ? `<div class="spanall card" id="rotation-board" hidden><h2 class="small" style="margin:0 0 8px">輪接現況（僅供查看）</h2><div id="rotation-board-body" class="small mono"></div></div>` : ''}
      <label class="f" data-for="成案">照會日期<input type="date" name="referral_date" value="${esc(r.referral_date || '')}"></label>
      <label class="f" data-for="成案">簽約日<input type="date" name="contract_date" value="${esc(r.contract_date || '')}"></label>
      <label class="f" data-for="成案">仁寶案號<input type="text" name="case_no" value="${esc(r.case_no || '')}" placeholder="選填"></label>
      <label class="f" data-for="未成案">未成案原因 <span class="req">*</span><select name="nc_reason_id">${opt('', '請選擇', r.nc_reason_id)}${activeOr(L.nc, r.nc_reason_id).map((x) => opt(x.id, x.name, r.nc_reason_id)).join('')}</select></label>
      <label class="f span2" data-for="未成案">未成案說明<input type="text" name="nc_note" value="${esc(r.nc_note || '')}"></label>
      <label class="f spanall">特殊事項<textarea name="remarks" style="min-height:60px">${esc(r.remarks || '')}</textarea></label>
    </div>
    <p class="err-text" id="ferr" hidden></p>
    <div style="display:flex;gap:8px;justify-content:flex-end"><a class="btn" href="${id ? `#/i/${id}` : '#/'}">取消</a><button type="submit" class="btn primary">儲存</button></div>
  </form>`;
  const f = $('#f');
  // 已建立輪接歷程的問案不可改區，避免更新時才被資料庫拒絕。
  if (id && hadRotation) {
    f.region.disabled = true;
    f.region.title = '已有輪接紀錄，不能變更問案區域；如需轉區請依機構正式轉案程序處理';
  }
  const rotationByRegion = { [r.region]: rotation };
  const syncRotation = async () => {
    const region=f.region.value;
    if (!rotationByRegion[region]) rotationByRegion[region]=await rotationState(region);
    const cfg=rotationByRegion[region];
    const rotated=cfg.enabled && f.status.value!=='未成案';
    const historical=id && hadRotation;
    $('#rotation-lead').hidden= !rotated && !historical && f.status.value!=='成案';
    $('#rotation-note').hidden= !rotated;
    const select=f.lead_staff_id;
    const previous=select.value;
    select.innerHTML=staffOpts(previous,region,rotated || historical);
    // 輪接問案僅管理者可人工改派；一般同仁可查看主責但不可變更。
    select.disabled=Boolean((historical || rotated) && !isAdmin());
    if (!id && rotated && cfg.next) select.value=String(cfg.next.staff_id);
    if (!id) {
      const board = $('#rotation-board');
      if (cfg.enabled) {
        const rows = await rotationStatusBoard(region);
        $('#rotation-board-body').innerHTML = (rows || []).map((x) => `${esc(x.name)} - ${esc(x.label)}`).join('<br>');
        board.hidden = false;
      } else { board.hidden = true; }
    }
  };
  const sync = () => { $$('[data-for]', f).forEach((el) => { el.hidden = el.dataset.for !== f.status.value; }); syncRotation().catch((e)=>toast(e.message,true)); };
  f.status.onchange = sync; f.region.onchange=()=>{rotationByRegion[f.region.value]=null;syncRotation().catch((e)=>toast(e.message,true));};sync();
  const syncOther = () => { $('#cond-other-note').hidden = !$('input[data-other="1"]', f)?.checked; };
  $$('input[name=cond]', f).forEach((c) => (c.onchange = syncOther)); syncOther();
  // 多時段建構工具：每個時段是獨立的卡片（DOM 直接是資料來源），新增/移除只動單一卡片，
  // 不整批重繪，才不會讓使用者正在打字的其他卡片被清空或失焦。
  const segLine = (card) => {
    const days = $$('.seg-day:checked', card).map((c) => c.value);
    const codes = $$('.seg-code:checked', card).map((c) => {
      const qty = Number($(`.seg-qty[data-for="${c.value}"]`, card)?.value || 1);
      return c.dataset.code + (qty > 1 ? `*${qty}` : '');
    });
    const start = $('.seg-start', card).value.trim(), end = $('.seg-end', card).value.trim();
    const note = $('.seg-note', card).value.trim();
    const parts = [];
    if (days.length) parts.push('W' + days.join(''));
    if (start && end) parts.push(`${start}-${end}`);
    if (codes.length) parts.push(codes.join('/'));
    let s = parts.join(' ');
    if (note) s += (s ? '　' : '') + note;
    return s;
  };
  const syncSvc = () => {
    $$('.svc-segment', f).forEach((card) => {
      $$('.seg-code', card).forEach((cb) => { const q = $(`.seg-qty[data-for="${cb.value}"]`, card); if (q) q.hidden = !cb.checked; });
    });
    const lines = $$('.svc-segment', f).map(segLine).filter(Boolean);
    const extra = f.svc_extra.value.trim();
    if (extra) lines.push(extra);
    const s = lines.join('\n');
    f.service_detail.value = s;
    $('#svc-preview').textContent = s || '（尚未填寫）';
  };
  const addSegmentCard = () => {
    const card = document.createElement('div');
    card.className = 'svc-segment card stack';
    card.innerHTML = `
      <div class="checks">${['一', '二', '三', '四', '五', '六', '日'].map((d, i) => `<label><input type="checkbox" class="seg-day" value="${i + 1}">週${d}</label>`).join('')}</div>
      <div class="grid3" style="margin-top:8px">
        <label class="f">開始時間<select class="seg-start">${TIME_OPTIONS}</select></label>
        <label class="f">結束時間<select class="seg-end">${TIME_OPTIONS}</select></label>
      </div>
      <div class="checks" style="margin-top:8px">${activeOr(L.sc, null).map((c) => `<label class="svc-code"><input type="checkbox" class="seg-code" value="${c.id}" data-code="${esc(c.code || '')}">${esc(c.code ? c.code + ' ' : '')}${esc(c.name)}<input type="number" class="seg-qty" data-for="${c.id}" min="1" value="1" style="width:48px;margin-left:4px" hidden></label>`).join('')}</div>
      <label class="f spanall" style="margin-top:8px">此時段說明<input type="text" class="seg-note" placeholder="（選填）"></label>
      <div class="acts" style="margin-top:6px"><button type="button" class="btn seg-remove">移除此時段</button></div>`;
    $('#svc-segments').appendChild(card);
    $('.seg-remove', card).onclick = () => { card.remove(); syncSvc(); };
  };
  $('#svc-builder').addEventListener('input', syncSvc);
  $('#svc-builder').addEventListener('change', syncSvc);
  $('#svc-add').onclick = addSegmentCard;
  if (id) {
    // 既有問案的舊格式無法可靠反解析回時段卡片，原文整段帶入「其他補充說明」，不遺失資料；
    // 使用者可以視需要另外用「＋ 增加時段」把部分內容拆成結構化時段。
    f.svc_extra.value = r.service_detail || '';
  } else {
    addSegmentCard();
  }
  syncSvc();
  if (presetStatus) $(`[data-for="${presetStatus}"] select, [data-for="${presetStatus}"] input`, f)?.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = (n) => f[n].value.trim() || null;
    const num = (n) => (f[n].value ? Number(f[n].value) : null);
    // 轉介單位改成輸入文字＋datalist 建議清單加速搜尋，存檔時用名稱精確比對回 unit_id
    // （啟用中、或目前已選但已停用的單位都算在建議清單內，所以已選的舊單位改別的狀態後還是比對得到）。
    const unitByName = new Map(activeOr(L.units, r.unit_id).map((u) => [u.name, u.id]));
    const unitNameRaw = v('unit_name');
    const unit_id = unitNameRaw ? (unitByName.get(unitNameRaw) ?? null) : null;
    const body = {
      region: v('region'), inquiry_date: v('inquiry_date'), intake_staff_id: num('intake_staff_id'), unit_id,
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
    if (!body.unit_id) miss.push(unitNameRaw ? '轉介單位（輸入的名稱不在清單裡，請從建議選單選擇）' : '轉介單位'); if (!body.address) miss.push('地址');
    if (!body.service_detail) miss.push('個案細項與安排');
    $$('.svc-segment', f).forEach((card, i) => {
      const s = $('.seg-start', card).value, en = $('.seg-end', card).value;
      if ((s && !en) || (!s && en)) miss.push(`第 ${i + 1} 個時段的起訖時間請選完整或都留空`);
    });
    // 照會日期／簽約日改成非必填（115/11/20 起）：督導有時來不及當下補齊，先讓成案
    // 流程不被卡住，缺漏的部分改用「問案」列表的「成案資料待補」篩選提醒補登，
    // 不在這裡擋存檔。主責督導仍是必填，沒有它輪接/派案邏輯會失去意義。
    if (body.status === '成案') { if (!body.lead_staff_id && !rotationByRegion[body.region]?.enabled) miss.push('主責督導'); }
    if (body.status === '未成案' && !body.nc_reason_id) miss.push('未成案原因');
    const er = $('#ferr');
    if (miss.length) { er.textContent = `請填寫：${miss.join('、')}`; er.hidden = false; return; }
    const btn = $('button[type=submit]', f); btn.disabled = true;
    try {
      const activeRotation = rotationByRegion[body.region]?.enabled && body.status!=='未成案';
      const manuallyChanged = Boolean(id && hadRotation && body.lead_staff_id !== originalLeadId);
      if ((manuallyChanged || (!id && activeRotation && body.lead_staff_id && Number(body.lead_staff_id) !== Number(rotationByRegion[body.region]?.next?.staff_id))) && !isAdmin()) throw new Error('僅管理者可以人工改派主責督導');
      const overrideOnCreate = !id && activeRotation && body.lead_staff_id && Number(body.lead_staff_id) !== Number(rotationByRegion[body.region]?.next?.staff_id);
      let reason=null;
      if (manuallyChanged || overrideOnCreate) {
        reason=await rotationAskReason(L.staffById[id ? originalLeadId : rotationByRegion[body.region]?.next?.staff_id]?.name||'未分配',L.staffById[body.lead_staff_id]?.name||'—');
        if (!reason) {btn.disabled=false;return;}
      }
      if (manuallyChanged && !body.lead_staff_id) throw new Error('主責督導不得清空，請選擇新主責督導並填寫原因');
      let saved;
      if (id && hadRotation) {
        // 不分輪接目前是否啟用，已有輪接歷程的問案一律走原子 RPC。
        saved=await rotationSave(id,body,manuallyChanged ? Number(body.lead_staff_id) : null,reason);
      } else if (!id && activeRotation) {
        // 只傳使用者主動選擇的改派；實際輪接預覽可能因他人搶先儲存而變動。
        // 帶入預覽時的原順位供資料庫核對；若其他問案先占用順位，需重新確認改派。
        const payload = overrideOnCreate
          ? { ...body, rotation_preview_staff_id: Number(rotationByRegion[body.region]?.next?.staff_id) }
          : body;
        saved=await rotationSave(null,payload,overrideOnCreate ? Number(body.lead_staff_id) : null,reason);
      } else if (id) {
        saved=await db.update('inquiries',id,body);
      } else {
        saved=await db.insert('inquiries',body);
      }
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
  const rotationHistory = await rotationChanges(id);
  // 判斷刪除時要不要走輪接專用流程，不能只看「有沒有改派紀錄」（rotation_changes）——
  // 只要透過輪接自動分配過，即使從沒被人工改派，rotation_allocations 也會有紀錄，
  // 資料庫的刪除保護是兩張表任一有紀錄就擋，這裡要跟資料庫判斷一致。
  const hasRotationAlloc = (await db.get('rotation_allocations', { inquiry_id: `eq.${id}`, select: 'id', limit: 1 })).length > 0;
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
        ${rotationHistory.length ? dd('主責異動', `<span title="已有異動紀錄">✎ 有 ${rotationHistory.length} 筆紀錄</span>`) : ''}
        ${dd('轉介單位', esc(r.unit_name))}${dd('個管師', esc(r.case_manager))}
        ${dd('收案督導', esc(r.intake_name))}${dd('主責督導', esc(r.lead_name))}
        ${dd('地址', esc(r.address), true)}
        ${dd('個案細項與安排', r.service_detail ? `<span class="mono">${esc(r.service_detail)}</span>` : '', true)}
        ${dd('特殊條件', (r.condition_names || []).map((c) => `<span class="chip">${esc(c)}</span>`).join('') + (r.condition_other_note ? ` <span class="small muted">${esc(r.condition_other_note)}</span>` : ''), true)}
        ${dd('預計主責居服', esc(r.expected_caregiver))}${dd('照會日期／簽約日', [fmtDate(r.referral_date), fmtDate(r.contract_date)].filter(Boolean).join(' ／ ') + (r.status === '成案' && (!r.referral_date || !r.contract_date) ? ` <span style="color:var(--warn)">⚠ 尚未補齊，請至編輯頁補登</span>` : ''))}
        ${dd('仁寶案號', esc(r.case_no))}
        ${r.status === '未成案' ? dd('未成案原因', esc(r.nc_reason_name)) + dd('未成案說明', esc(r.nc_note)) : ''}
        ${dd('特殊事項', esc(r.remarks), true)}
        ${r.legacy_ref ? dd('舊資料來源', `<span class="small muted">${esc(r.legacy_ref)}</span>`, true) : ''}
      </dl>
    </section>
    <section class="main stack">
      ${rotationHistory.length?`<div class="card"><h2>主責督導異動歷程</h2><ul class="rotation-history">${rotationChangeLines(rotationHistory)}</ul></div>`:''}
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

  $$('[data-amend]').forEach((b)=>b.onclick=()=>rotationAmend(Number(b.dataset.amend)));
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
    if (hasRotationAlloc || rotationHistory.length) {
      if (!isAdmin()) { toast('僅管理者可以刪除有輪接歷程的問案', true); return; }
      const reason = await rotationAskDeleteReason(r.code);
      if (!reason) return;
      try { await rotationRpc('rotation_delete_inquiry', { p_inquiry_id: id, p_reason: reason }); toast('已刪除'); location.hash = '#/'; }
      catch (e) { toast(e.message, true); }
      return;
    }
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
  // 居服員欄位改成文字輸入＋datalist（跟「轉介單位」同一套做法）：瀏覽器會依
  // 輸入的關鍵字自動比對清單裡最符合的選項（名字、員編都比對得到），不用再
  // 從「本區／其他區」兩組下拉選單裡自己慢慢找，找人更快。本區排前面、其他
  // 區排後面，都依員編遞增排序；沒有員編的排最後。目前已選的居服員（就算已
  // 停用）一定會出現在清單裡，不會因為停用而讓既有紀錄顯示不出名字。
  const byCode = (a, b) => { if (!a.code && !b.code) return 0; if (!a.code) return 1; if (!b.code) return -1; return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; };
  const cgs = L.cg.filter((c) => (c.active && (!c.region || c.region === inq.region)) || c.id === cur.caregiver_id).sort(byCode);
  const others = L.cg.filter((c) => c.active && c.region && c.region !== inq.region && c.id !== cur.caregiver_id).sort(byCode);
  const cgLabel = (c) => `${c.code ? `${c.code} ` : ''}${c.name}${c.region ? `（${c.region}）` : ''}`;
  const curCg = cur.caregiver_id ? [...cgs, ...others].find((c) => c.id === cur.caregiver_id) : null;
  box.innerHTML = `<form class="stack" id="mf" novalidate>
    <h2>${m ? `編輯媒合紀錄：${esc(m.caregiver_name)}` : '新增媒合紀錄'}</h2>
    <div class="grid2">
      <label class="f">居服員 <span class="req">*</span><input type="text" name="caregiver_name" list="mf-cglist" autocomplete="off" value="${esc(curCg ? cgLabel(curCg) : '')}" placeholder="輸入姓名或員編搜尋">
        <datalist id="mf-cglist">${[...cgs, ...others].map((c) => `<option value="${esc(cgLabel(c))}">`).join('')}</datalist></label>
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
    // 居服員改成文字輸入後，存檔時用輸入的文字精確比對回 caregiver_id（跟「轉介
    // 單位」同一套做法）；輸入的文字不在清單裡（打錯字、亂打）就當作沒選。
    const cgByLabel = new Map([...cgs, ...others].map((c) => [cgLabel(c), c.id]));
    const caregiverNameRaw = f.caregiver_name.value.trim();
    const caregiver_id = caregiverNameRaw ? (cgByLabel.get(caregiverNameRaw) ?? null) : null;
    const body = {
      caregiver_id, contact_date: f.contact_date.value || null,
      within_7km: km === undefined ? null : km === '1', result: f.result.value,
      reject_reason_ids: f.result.value === '拒絕' ? $$('input[name=rj]:checked', f).map((x) => Number(x.value)) : [],
      reject_note: f.result.value === '拒絕' ? (f.reject_note.value.trim() || null) : null,
    };
    const otherChecked = $('input[name=rj][data-other="1"]', f)?.checked;
    const miss = [];
    if (!body.caregiver_id) miss.push(caregiverNameRaw ? '居服員（輸入的名字不在清單裡，請從建議選單選擇）' : '居服員'); if (!body.contact_date) miss.push('聯絡日期');
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
async function promptAcceptCase(inq) {
  const hasRotation = (await db.get('rotation_allocations',{inquiry_id:`eq.${inq.id}`,select:'id',limit:1})).length>0;
  return new Promise((resolve) => {
    // 已輪接的問案只能從同區在職督導中選擇改派對象；避免跨區或非督導人員。
    const candidates = hasRotation
      ? L.staff.filter((s) => s.region === inq.region && s.active && s.role === 'supervisor')
      : activeOr(L.staff, inq.lead_staff_id);
    const currentLead = hasRotation ? inq.lead_staff_id : (inq.lead_staff_id || me.id);
    const staffOpts = opt('', '請選擇', currentLead) + candidates.map((s) => opt(s.id, s.name + (s.region ? `（${s.region}）` : ''), currentLead)).join('');
    modal(`<h2>居服員已接受，要標記成案嗎？</h2>
      <p class="muted small" style="margin:0 0 8px">確定承接才需要填寫以下欄位，之後也可以在問案明細裡補填。</p>
      <div class="stack">
        <label class="f">主責督導 <span class="req">*</span><select name="lead_staff_id" ${hasRotation && !isAdmin() ? 'disabled' : ''}>${staffOpts}</select></label>
        ${hasRotation ? `<label class="f" id="accept-reason-wrap" hidden>更換主責督導原因 <span class="req">*</span>
          <textarea name="rotation_reason" rows="3" placeholder="請說明更換原因，將保留異動歷程"></textarea></label>` : ''}
        <label class="f">照會日期<input type="date" name="referral_date" value="${esc(todayISO())}"></label>
        <label class="f">簽約日<input type="date" name="contract_date"></label>
        <p class="err-text" id="acerr" hidden></p>
      </div>
      <div class="acts"><button type="button" class="btn" data-no>先不要</button><button type="button" class="btn primary" data-yes>標記成案</button></div>`,
    (box, close) => {
      const lead = $('[name=lead_staff_id]', box);
      const reasonWrap = $('#accept-reason-wrap', box);
      const refreshReason = () => {
        if (reasonWrap) reasonWrap.hidden = Number(lead.value) === Number(inq.lead_staff_id);
      };
      lead.onchange = refreshReason; refreshReason();
      $('[data-no]', box).onclick = () => { close(); resolve(); };
      $('[data-yes]', box).onclick = async () => {
        const lead_staff_id = lead.value ? Number(lead.value) : null;
        const referral_date = $('[name=referral_date]', box).value || null;
        const contract_date = $('[name=contract_date]', box).value || null;
        if (hasRotation && !isAdmin() && lead_staff_id !== Number(inq.lead_staff_id)) { $('#acerr', box).textContent='僅管理者可以人工改派主責督導'; $('#acerr', box).hidden=false; return; }
        const reason = hasRotation && lead_staff_id !== Number(inq.lead_staff_id)
          ? $('[name=rotation_reason]', box).value.trim() : null;
        const er = $('#acerr', box);
        const miss = [];
        if (!lead_staff_id) miss.push('主責督導');
        if (hasRotation && lead_staff_id !== Number(inq.lead_staff_id) && !reason) miss.push('更換主責督導原因');
        if (miss.length) { er.textContent = `請填寫：${miss.join('、')}`; er.hidden = false; return; }
        const submit = $('[data-yes]', box);
        submit.disabled = true;
        try {
          if (hasRotation) {
            await rotationRpc('rotation_accept_case', {
              p_inquiry_id:inq.id, p_lead_staff_id:lead_staff_id,
              p_referral_date:referral_date, p_contract_date:contract_date, p_reason:reason
            });
          } else {
            await db.update('inquiries', inq.id, { status: '成案', lead_staff_id, referral_date, contract_date });
          }
          close(); resolve();
        } catch (e) { er.textContent = e.message; er.hidden = false; submit.disabled = false; }
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

// resolveEffectiveVisitRecords／auditCases 只會用到這幾個欄位；content（內容全文）、
// service_staff、signer 等其他欄位完全沒用到，卻佔了 rk_visits 絕大部分的資料量
// （訪視內容常常上百字），抓取時用這份清單限制欄位，大幅縮小下載量。
const RK_VISITS_AUDIT_FIELDS = 'import_id,national_id,name,visit_date,visit_month,content_length,is_phone_visit,is_home_visit';

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

// 家電訪稽核結果的共用快取（見 sql/25_visit_audit_cache.sql）：訪視紀錄一天只會
// 同步一次（或主任手動匯入時才變），同一天不管誰、開幾次頁面，算出來的結果都
// 一樣，不用每次都重抓全部 rk_visits、重算一次——改成先比對「這次的輸入特徵」
// 跟資料庫裡存的 signature 是否相同，一樣就直接用快取的算好結果，不一樣（有
// 新匯入訪視紀錄，或個案清單有異動——新增案件/案件結案等）才重算並寫回快取。
const VISIT_AUDIT_CACHE_ID = 1;
// signature 只需要「便宜就能算出來」的特徵，不需要完美：latestImport（最新一批
// 訪視紀錄匯入的 id+時間）涵蓋「有沒有新匯入訪視紀錄」；roster 筆數、結案筆數、
// 最大 id 涵蓋「個案清單有沒有新增/結案異動」。casesByNid 已經是個案清單本身
// 的資料，不用再額外查詢。
function computeAuditSignature(roster, visitBatches) {
  const latest = visitBatches[0];
  const closedCount = roster.filter((c) => c.status === '結案').length;
  const maxId = roster.reduce((m, c) => (c.id > m ? c.id : m), 0);
  return [latest?.id ?? 'none', latest?.imported_at ?? '', roster.length, closedCount, maxId].join('|');
}

async function getCachedOrComputeAudit(casesByNid, roster, visitBatches, todayMonth) {
  if (!visitBatches.length) return EMPTY_AUDIT;
  const signature = computeAuditSignature(roster, visitBatches);
  try {
    const rows = await db.all('visit_audit_cache', { id: `eq.${VISIT_AUDIT_CACHE_ID}`, select: 'signature,payload' });
    const cached = rows[0];
    if (cached && cached.signature === signature) {
      const p = cached.payload;
      return { results: new Map(p.results), logMinMonth: p.logMinMonth, logMaxMonth: p.logMaxMonth, excludedCount: p.excludedCount };
    }
  } catch { /* 快取表還沒建好，或讀取失敗，都直接往下重新計算，不擋畫面 */ }

  // 快取沒命中（第一次用、或輸入特徵變了）：照舊抓全部訪視紀錄、重算一次。
  const allVisits = await db.all('rk_visits', { select: RK_VISITS_AUDIT_FIELDS });
  const effective = resolveEffectiveVisitRecords(allVisits, visitBatches);
  const logMonths = effective.map((r) => r.visit_month);
  const asOfMonth = logMonths.length ? [...logMonths, todayMonth].reduce((a, b) => (a > b ? a : b)) : todayMonth;
  const audit = effective.length ? auditCases(casesByNid, effective, asOfMonth) : EMPTY_AUDIT;

  // 背景把算好的結果寫回共用快取，失敗也沒關係（下次還是會重算，不影響這次
  // 畫面顯示），不要讓寫入動作擋住使用者看結果。
  db.upsert('visit_audit_cache', {
    id: VISIT_AUDIT_CACHE_ID, signature,
    payload: { results: [...audit.results], logMinMonth: audit.logMinMonth, logMaxMonth: audit.logMaxMonth, excludedCount: audit.excludedCount },
    computed_at: new Date().toISOString(),
  }, 'id').catch(() => {});

  return audit;
}

// 忠實搬自 audit_engine.py 的 audit()：電訪每月、家訪每 3 個月（可提前、提前後
// 重新起算）各自獨立判定，內容需 >30 字才算合格，casesByNid（現在來自「個案清單」
// case_roster）是名單造冊標準。
//
// 同一人結案後重新開案（同一個身分證字號出現兩筆 case_roster，案號不同）時，
// 訪視紀錄（rk_visits）本身只有身分證字號、沒有案號，沒辦法直接知道一筆訪視
// 該算在哪一次服務期間名下。casesByNid 現在是「同一身分證字號底下的全部
// case_roster 列」陣列，這裡先依每一列的服務期間（service_start_date ~
// end_date，服務中/暫停視為持續到目前）切出時間窗，再把每一筆訪視紀錄依
// visit_month 分配到「服務期間包含這個月份」的那一列；找不到對應窗口的
// （理論上不該發生，資料缺漏或填錯時當保險）歸給服務期間起點離這個月份最近
// 的那一列。這樣舊的結案紀錄跟新開的案子才不會共用同一份「最近一次家訪/
// 電訪」，稽核結果依 case_roster 的列（c.id）分開計算、分開查詢，不再用身分
// 證字號去查（身分證字號在重新開案的情況下不是唯一的）。
function auditCases(rosterByNid, records, asOfMonth) {
  const logMonths = records.map((r) => r.visit_month);
  if (!logMonths.length) return { results: new Map(), logMinMonth: null, logMaxMonth: null, excludedCount: 0 };
  const logMinMonth = logMonths.reduce((a, b) => (a < b ? a : b));
  const logMaxRaw = logMonths.reduce((a, b) => (a > b ? a : b));
  const logMaxMonth = logMaxRaw < asOfMonth ? logMaxRaw : asOfMonth;

  const recordsByNid = new Map();
  for (const rec of records) {
    if (!recordsByNid.has(rec.national_id)) recordsByNid.set(rec.national_id, []);
    recordsByNid.get(rec.national_id).push(rec);
  }

  const rosterIds = new Set(rosterByNid.keys());
  const excludedCount = new Set(records.map((r) => r.national_id).filter((id) => !rosterIds.has(id))).size;

  // 單一（roster 列, 這一列分配到的訪視紀錄）配對，算出跟原本一模一樣的每月
  // 家訪/電訪狀態——這段邏輯完全沒改，只是從外層迴圈抽出來，每一筆 case_roster
  // 列各自呼叫一次，不再是整個身分證字號共用一份。
  const auditOneCase = (info, myRecords) => {
    // 結案當月不套用「內容字數要超過30字」的門檻：結案電訪/家訪本來就常常
    // 只是簡短寫「個案表示恢復良好，已無需居家服務，故予以結案」這類結案說明，
    // 字數門檻的設計初衷是過濾平時隨便填寫的訪視紀錄，不是要讓結案說明也被
    // 擋下來誤判成缺漏——只要結案當月確實有填寫紀錄，不論長短都算達標。
    const endMonth = info ? monthOf(info.end_date) : null;
    const statusNow = (info && info.status) || '';
    const isClosingMonth = statusNow === '結案' && endMonth;

    const phone = new Map(), home = new Map(), phoneBlank = new Set(), homeBlank = new Set();
    let recName = '';
    const trackLatest = (map, month, date) => {
      if (!date) { if (!map.has(month)) map.set(month, null); return; }
      const cur = map.get(month);
      if (cur == null || date > cur) map.set(month, date);
    };
    for (const rec of myRecords) {
      recName = rec.name || recName;
      const hasContent = (rec.content_length || 0) > 30 || (isClosingMonth && rec.visit_month === endMonth);
      if (rec.is_phone_visit) { if (hasContent) trackLatest(phone, rec.visit_month, rec.visit_date); else phoneBlank.add(rec.visit_month); }
      if (rec.is_home_visit) { if (hasContent) trackLatest(home, rec.visit_month, rec.visit_date); else homeBlank.add(rec.visit_month); }
    }

    const name = (info && info.name) || recName || '(未知姓名)';
    const owner = (info && info.lead_supervisor) || '⚠ 個案清單未列名';
    const caseStartMonth = info ? monthOf(info.service_start_date) : null;

    if (statusNow === '結案' && endMonth && endMonth < logMinMonth) return null;

    const preWindow = !!caseStartMonth && caseStartMonth < logMinMonth;
    const auditStart = caseStartMonth ? (caseStartMonth > logMinMonth ? caseStartMonth : logMinMonth) : logMinMonth;

    const caseEndMonth = (statusNow === '結案' && endMonth) ? (endMonth < logMaxMonth ? endMonth : logMaxMonth) : null;
    const effEnd = caseEndMonth || logMaxMonth;
    const months = effEnd < auditStart ? [] : monthRange(auditStart, effEnd);

    const monthStatus = {};
    let lastHomeMonth = null;
    for (const hm of home.keys()) { if (hm < auditStart && (lastHomeMonth === null || hm > lastHomeMonth)) lastHomeMonth = hm; }

    for (const m of months) {
      const homeDone = home.has(m);
      const phoneDone = phone.has(m);
      let homeState;
      if (homeDone) { homeState = '達標'; lastHomeMonth = m; }
      else if (lastHomeMonth === null) {
        homeState = preWindow ? '資料不足' : '缺漏(未收案家訪)';
      } else {
        const dueMonth = monthAdd(lastHomeMonth, 3);
        homeState = m >= dueMonth ? '逾期' : '未到期';
      }
      const phoneState = phoneDone ? '達標' : '缺漏';
      monthStatus[m] = { 家訪: homeState, 電訪: phoneState, 家訪日期: home.get(m) || null, 電訪日期: phone.get(m) || null };
    }

    let nextDue;
    if (lastHomeMonth) nextDue = monthAdd(lastHomeMonth, 3);
    else if (preWindow) nextDue = '尚無訪視歷史';
    else nextDue = caseStartMonth || auditStart;

    const blankMonths = [
      ...months.filter((m) => phoneBlank.has(m) && !phone.has(m)),
      ...months.filter((m) => homeBlank.has(m) && !home.has(m)),
    ];

    const lastHomeDate = lastHomeMonth ? home.get(lastHomeMonth) : null;
    return {
      nationalId: info?.national_id, name, owner, caseNo: (info && info.case_no) || '',
      status: statusNow, inRoster: !!info,
      caseStartMonth: caseStartMonth || '未知', auditStart,
      preWindow, lastHomeMonth, lastHomeDate, nextDue,
      monthStatus, months, blankMonths, caseEndMonth,
    };
  };

  const results = new Map();
  for (const [nid, rows] of rosterByNid) {
    const myRecords = recordsByNid.get(nid) || [];
    if (rows.length === 1) {
      const r = auditOneCase(rows[0], myRecords);
      if (r) results.set(rows[0].id, r);
      continue;
    }
    // 同一人有多筆 case_roster（結案後重新開案）：先算出每一列的服務期間窗口，
    // 再把這個人的訪視紀錄依月份分配進對應的窗口，找不到窗口的就近分給服務
    // 起始月最接近的那一列（通常是還在服務中、最新的那筆）。
    const windows = rows.map((c) => {
      const start = monthOf(c.service_start_date) || logMinMonth;
      const end = (c.status === '結案' && c.end_date) ? monthOf(c.end_date) : logMaxMonth;
      return { c, start, end: end && end < start ? start : end };
    });
    // "YYYY-MM" 轉成總月數，方便算「離哪個窗口最近」的實際距離（localeCompare
    // 只會回傳 -1/0/1，不能拿來當距離用）。
    const monthNum = (mkey) => { const [y, m] = mkey.split('-').map(Number); return y * 12 + (m - 1); };
    const perRow = new Map(windows.map((w) => [w.c.id, []]));
    for (const rec of myRecords) {
      const inWindow = windows.find((w) => rec.visit_month >= w.start && rec.visit_month <= w.end);
      const chosen = inWindow || windows.reduce((best, w) => (!best || Math.abs(monthNum(w.start) - monthNum(rec.visit_month)) < Math.abs(monthNum(best.start) - monthNum(rec.visit_month)) ? w : best), null);
      if (chosen) perRow.get(chosen.c.id).push(rec);
    }
    for (const w of windows) {
      const r = auditOneCase(w.c, perRow.get(w.c.id) || []);
      if (r) results.set(w.c.id, r);
    }
  }
  return { results, logMinMonth, logMaxMonth, excludedCount };
}

let visitListState = { owner: '全部', sortDir: 'asc' };

/* ================= 家電訪稽核（原本是「個案比對」裡的一個頁籤，拆成獨立頁面；
   「個案比對」其餘功能——手動上傳個案總表比對問案、疑似漏填/案號待確認——已經
   被每日自動同步＋「同步紀錄」頁面取代，見 sync/ 底下的自動化同步專案，故撤除，
   不用兩套機制同時維護。手動補上傳個案總表的功能仍保留在「個案清單」頁面。） ================= */
let visitAuditState = { sub: 'list' };
async function viewVisitAudit() {
  $('#main').innerHTML = `
  <div class="head"><div><h1>家電訪稽核</h1><div class="muted small" style="margin-top:4px">比對「個案清單」主檔與仁寶系統匯入的訪視紀錄，找出該家訪/電訪卻缺漏的個案。</div></div></div>
  <div class="filters">
    <div class="seg" role="group" aria-label="家電訪子頁籤">${[['list', '缺漏清單'], ['stats', '統計'], ['import', '匯入與批次']].map(([k, l]) => `<button type="button" data-ccvsub="${k}" class="${visitAuditState.sub === k ? 'on' : ''}">${l}</button>`).join('')}</div>
  </div>
  <div id="cc-visits-body"><p class="muted">載入中…</p></div>`;
  $$('[data-ccvsub]').forEach((b) => (b.onclick = () => { visitAuditState.sub = b.dataset.ccvsub; drawCcVisits($('#cc-visits-body')); }));
  await drawCcVisits($('#cc-visits-body'));
}

// 稽核的個案名單改用「個案清單」（case_roster，常態恆存的主檔），不是每月快照——
// case_roster 現在由每日自動同步（sync/scripts/daily-sync-case-summary.js）持續
// 維護最新名單，不需要使用者再手動上傳。
async function loadVisitAudit() {
  const [roster, visitBatches] = await Promise.all([
    db.all('case_roster', {}),
    db.all('rk_visit_imports', { order: 'imported_at.desc' }),
  ]);
  if (!roster.length || !visitBatches.length) return null;
  // 同一身分證字號可能有多筆 case_roster（結案後重新開案），收集成陣列而不是
  // 直接覆蓋，不然舊案子會憑空消失、新舊案子的訪視紀錄也會混在一起算。
  const casesByNid = new Map();
  for (const c of roster) { if (!c.national_id) continue; if (!casesByNid.has(c.national_id)) casesByNid.set(c.national_id, []); casesByNid.get(c.national_id).push(c); }
  const todayMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  // 改用共用快取（見 sql/25_visit_audit_cache.sql）：同一天內大家開頁面看到的
  // 都是同一份算好的結果，不用每個人每次都重抓全部 rk_visits、重算一次。
  return getCachedOrComputeAudit(casesByNid, roster, visitBatches, todayMonth);
}

async function drawCcVisits(box) {
  if (visitAuditState.sub === 'import') { drawVisitImport(box); return; }
  box.innerHTML = '<p class="muted">載入中…</p>';
  const audit = await loadVisitAudit();
  if (!audit) { box.innerHTML = '<div class="card empty">「個案清單」還沒有資料，或還沒有匯入過訪視紀錄總表。請先到「個案清單」頁面建立個案主檔，並在這裡的「匯入與批次」頁籤匯入訪視紀錄。</div>'; return; }
  if (!audit.results.size && !audit.logMinMonth) { box.innerHTML = '<div class="card empty">目前還沒有任何有效的訪視紀錄。</div>'; return; }
  const sub = box;
  if (visitAuditState.sub === 'stats') drawVisitStats(sub, audit);
  else await drawVisitList(sub, audit);
}

async function drawVisitList(box, audit) {
  const { results } = audit;
  const allItems = [];
  for (const r of results.values()) {
    for (const m of r.months) {
      const st = r.monthStatus[m];
      if (st.電訪 === '缺漏') allItems.push({ r, m, type: '電訪缺漏' });
      if (st.家訪 === '缺漏(未收案家訪)') allItems.push({ r, m, type: '家訪缺漏' });
      else if (st.家訪 === '逾期') allItems.push({ r, m, type: '家訪逾期' });
    }
  }
  // 下拉選單改成直接帶入人員名單裡「實際會列管個案的人」，不要只從「目前有缺漏的
  // 項目」裡反推——不然剛好這個月沒有任何缺漏的督導會從選單裡消失，看起來像選單
  // 沒更新。用「有沒有設定區域」判斷，不是單純用 role：有些管理者（例如陳冠文、
  // 邱羿綺）身兼某個區域的督導工作、也會是案件的主責督導，role 是 admin 但一樣有
  // 列管個案；真正的總部主任/管理者（region 是空的）跟系統同步帳號、測試帳號則都
  // 沒有設定區域，正好排除掉。用 L.staff 本來就依角色/員編排好的順序，不用再額外排序。
  const owners = L.staff.filter((s) => s.active && s.role !== 'clerk' && s.region).map((s) => s.name);
  const items = visitListState.owner === '全部' ? allItems : allItems.filter((i) => i.r.owner === visitListState.owner);
  const dir = visitListState.sortDir === 'desc' ? -1 : 1;
  items.sort((a, b) => dir * a.m.localeCompare(b.m) || a.r.owner.localeCompare(b.r.owner) || a.r.name.localeCompare(b.r.name));
  const notes = await db.all('rk_visit_notes', {});
  const noteMap = new Map(notes.map((n) => [`${n.national_id}|${n.month}|${n.deficiency_type}`, n]));
  const sortArrow = visitListState.sortDir === 'desc' ? '▼' : '▲';
  box.innerHTML = `
  <div class="muted small" style="margin-bottom:8px">電訪缺漏 ${allItems.filter((i) => i.type === '電訪缺漏').length} 筆　家訪缺漏 ${allItems.filter((i) => i.type === '家訪缺漏').length} 筆　家訪逾期 ${allItems.filter((i) => i.type === '家訪逾期').length} 筆</div>
  <div class="card filters" style="margin-bottom:10px">
    <label class="inline-check">主責督導 <select id="vlOwner">${opt('全部', '全部', visitListState.owner)}${owners.map((o) => opt(o, o, visitListState.owner)).join('')}</select></label>
  </div>
  <div class="tbox"><table class="t"><thead><tr><th>主責督導</th><th>姓名</th><th id="th-vmonth" style="cursor:pointer;user-select:none" title="點擊排序">月份 <span class="small muted">${sortArrow}</span></th><th>缺漏類型</th><th>原因說明</th></tr></thead>
    <tbody>${items.map((it) => {
      const key = `${it.r.nationalId}|${it.m}|${it.type}`;
      const n = noteMap.get(key);
      return `<tr><td class="nowrap">${esc(it.r.owner)}</td><td class="nowrap">${esc(it.r.name)}</td><td class="nowrap">${fmtMonth(it.m)}</td>
        <td><span class="st ${it.type === '家訪逾期' ? 'r-拒絕' : 's-問案中'}">${it.type}</span></td>
        <td><input type="text" class="vnote" data-nid="${esc(it.r.nationalId)}" data-m="${it.m}" data-type="${esc(it.type)}" value="${esc(n?.note || '')}" placeholder="例：已電聯家屬確認" style="width:100%"></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="empty">目前沒有缺漏項目。</td></tr>'}</tbody></table></div>`;
  $('#vlOwner').onchange = (e) => { visitListState.owner = e.target.value; drawVisitList(box, audit); };
  $('#th-vmonth').onclick = () => { visitListState.sortDir = visitListState.sortDir === 'desc' ? 'asc' : 'desc'; drawVisitList(box, audit); };
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
  const allMonthsSet = new Set();
  for (const r of results.values()) {
    if (!agg.has(r.owner)) agg.set(r.owner, { cases: 0, phoneMissing: 0, homeMissing: 0, homeOverdue: 0, unlisted: 0, byMonth: new Map() });
    const a = agg.get(r.owner);
    a.cases++;
    if (!r.inRoster) a.unlisted++;
    for (const m of r.months) {
      allMonthsSet.add(m);
      const st = r.monthStatus[m];
      const cell = a.byMonth.get(m) || { home: 0, phone: 0, homeItems: [], phoneItems: [] };
      // homeItems/phoneItems：記住這一格是哪些個案造成的，點數字可以列出名單，不用再去
      // 「缺漏清單」頁籤自己找哪個督導哪個月份。家訪缺漏跟逾期都算進「家訪」這一欄（跟
      // 上面小計表的邏輯一致），但個別項目的 type 還是分開記，名單裡看得出是哪一種。
      if (st.電訪 === '缺漏') { a.phoneMissing++; cell.phone++; cell.phoneItems.push({ nid: r.nationalId, name: r.name, caseNo: r.caseNo, type: '電訪缺漏' }); }
      if (st.家訪 === '缺漏(未收案家訪)') { a.homeMissing++; cell.home++; cell.homeItems.push({ nid: r.nationalId, name: r.name, caseNo: r.caseNo, type: '家訪缺漏' }); }
      else if (st.家訪 === '逾期') { a.homeOverdue++; cell.home++; cell.homeItems.push({ nid: r.nationalId, name: r.name, caseNo: r.caseNo, type: '家訪逾期' }); }
      if (cell.home || cell.phone) a.byMonth.set(m, cell);
    }
  }
  const owners = [...agg.keys()].sort();
  // 每個居督每年每月的缺漏情形：每月初核對上個月的狀況時，直接從這張表看哪個督導哪個月家訪、電訪各缺漏幾筆。
  // 家訪、電訪分開呈現（不加總），跟個案詳情視窗的逐月表格邏輯一致。
  const allMonths = [...allMonthsSet].sort();
  box.innerHTML = `
  <div class="tbox" style="margin-bottom:16px"><table class="t"><thead><tr><th>主責督導</th><th class="num">列管個案數</th><th class="num">電訪缺漏筆數</th><th class="num">家訪缺漏筆數</th><th class="num">家訪逾期筆數</th><th class="num">個案清單未列名</th></tr></thead>
    <tbody>${owners.map((o) => { const a = agg.get(o); return `<tr><td>${esc(o)}</td><td class="num">${a.cases}</td><td class="num">${a.phoneMissing}</td><td class="num">${a.homeMissing}</td><td class="num">${a.homeOverdue}</td><td class="num">${a.unlisted}</td></tr>`; }).join('') || '<tr><td colspan="6" class="empty">無資料</td></tr>'}</tbody></table></div>
  <div class="small muted" style="margin-bottom:8px">各督導每月缺漏情形（家訪缺漏／逾期、電訪缺漏分開呈現），方便每月初核對上個月狀況；點數字可以看名單</div>
  <div class="tbox"><table class="t"><thead>
    <tr><th rowspan="2" style="vertical-align:bottom">督導</th>${allMonths.map((m) => `<th colspan="2" class="num">${fmtMonth(m)}</th>`).join('')}</tr>
    <tr>${allMonths.map(() => '<th class="num">家訪</th><th class="num">電訪</th>').join('')}</tr>
  </thead>
    <tbody>${owners.map((o) => {
      const a = agg.get(o);
      return `<tr><td class="nowrap">${esc(o)}</td>${allMonths.map((m) => {
        const cell = a.byMonth.get(m);
        const home = cell?.home || 0, phone = cell?.phone || 0;
        const homeCell = home ? `<button type="button" class="link" data-vsowner="${esc(o)}" data-vsmonth="${m}" data-vskind="home" style="color:var(--bad);font-weight:600">${home}</button>` : '0';
        const phoneCell = phone ? `<button type="button" class="link" data-vsowner="${esc(o)}" data-vsmonth="${m}" data-vskind="phone" style="color:var(--bad);font-weight:600">${phone}</button>` : '0';
        return `<td class="num">${homeCell}</td><td class="num">${phoneCell}</td>`;
      }).join('')}</tr>`;
    }).join('') || `<tr><td colspan="${allMonths.length * 2 + 1}" class="empty">無資料</td></tr>`}</tbody></table></div>`;
  $$('[data-vsowner]').forEach((btn) => (btn.onclick = async () => {
    const { vsowner, vsmonth, vskind } = btn.dataset;
    const cell = agg.get(vsowner)?.byMonth.get(vsmonth);
    const items = (vskind === 'home' ? cell?.homeItems : cell?.phoneItems) || [];
    let notes = [];
    try { notes = await db.all('rk_visit_notes', {}); } catch (e) { /* 名單本身還是看得到，原因說明載入失敗就先留空 */ }
    const noteMap = new Map(notes.map((n) => [`${n.national_id}|${n.month}|${n.deficiency_type}`, n]));
    modal(`<h2>${esc(vsowner)}　${fmtMonth(vsmonth)}　${vskind === 'home' ? '家訪缺漏／逾期' : '電訪缺漏'}名單（${items.length}）</h2>
      <div class="tbox" style="margin-top:10px"><table class="t"><thead><tr><th>姓名</th><th>案號</th><th>類型</th><th>原因說明</th></tr></thead>
      <tbody>${items.map((it) => {
        const n = noteMap.get(`${it.nid}|${vsmonth}|${it.type}`);
        return `<tr><td class="nowrap">${esc(it.name)}</td><td class="nowrap">${esc(it.caseNo || '')}</td><td><span class="st ${it.type === '家訪逾期' ? 'r-拒絕' : 's-問案中'}">${esc(it.type)}</span></td><td>${esc(n?.note || '')}</td></tr>`;
      }).join('') || '<tr><td colspan="4" class="empty">無資料</td></tr>'}</tbody></table></div>
      <div class="acts"><button type="button" class="btn" data-no>關閉</button></div>`,
    (m, close) => { $('[data-no]', m).onclick = close; });
  }));
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
            共 ${parsed.total} 筆，可匯入 ${parsed.usable.length} 筆，略過 ${parsed.skipped} 筆（缺身分證字號或訪視日期）。涵蓋月份：${esc(parsed.monthsCovered.map(fmtMonth).join('、') || '—')}
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
        toast('匯入完成'); visitAuditState.sub = 'list'; viewVisitAudit();
      } catch (e) { er.textContent = e.message; er.hidden = false; btn.disabled = false; }
    };
  }
  drawVisitImportHistory($('#v-history'));
}

async function drawVisitImportHistory(box) {
  const rows = await db.all('rk_visit_imports', { order: 'imported_at.desc' });
  box.innerHTML = `<div class="tbox"><table class="t"><thead><tr><th>匯入時間</th><th>標籤</th><th>匯入者</th><th>檔名</th><th>涵蓋月份</th><th class="num">筆數</th><th class="num">略過</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${fmtTime(r.imported_at)}</td><td>${esc(r.period || '')}</td><td>${esc(r.imported_by_name || '')}</td><td class="small muted">${esc(r.file_name || '')}</td><td class="small">${esc((r.months_covered || []).map(fmtMonth).join('、'))}</td><td class="num">${r.row_count}</td><td class="num">${r.skipped_count}</td><td>${isDirector() ? `<button type="button" class="link" style="color:var(--bad)" data-vdel="${r.id}">刪除</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">還沒有匯入紀錄</td></tr>'}</tbody></table></div>`;
  $$('[data-vdel]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('確定要刪除這批訪視紀錄嗎？無法復原。', '刪除', true))) return;
    try { await db.remove('rk_visit_imports', Number(b.dataset.vdel)); toast('已刪除'); viewVisitAudit(); } catch (e) { toast(e.message, true); }
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

// 拆成兩階段：base（個案清單本身＋小表，約1.5秒）先抓先畫，讓使用者不用等到全部訪視紀錄
// 抓完就能先看清單、搜尋、點案件；稽核結果（要抓全部 rk_visits，約5秒）在背景另外抓，
// 算完後才補上最近一次家訪/下次應家訪/缺漏等需要稽核才能算出來的欄位，不擋住第一次畫面。
const EMPTY_AUDIT = { results: new Map(), logMinMonth: null, logMaxMonth: null, excludedCount: 0 };

async function loadCaseRosterBase() {
  const [roster, visitBatches, abbrs, confirmedInquiries] = await Promise.all([
    db.all('case_roster', {}),
    db.all('rk_visit_imports', { order: 'imported_at.desc' }),
    db.all('unit_abbrs', {}),
    db.all('inquiries', { status: 'eq.成案', select: 'lead_staff_id,contract_date' }),
  ]);
  // 同一身分證字號可能有多筆 case_roster（結案後重新開案），收集成陣列而不是
  // 直接覆蓋，見 auditCases() 開頭的說明。
  const casesByNid = new Map();
  for (const c of roster) { if (!c.national_id) continue; if (!casesByNid.has(c.national_id)) casesByNid.set(c.national_id, []); casesByNid.get(c.national_id).push(c); }
  const unitLabel = makeUnitLabelResolver(abbrs, L.units);
  const todayMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const latestVisitImportAt = visitBatches[0]?.imported_at || null;
  // 「當月簽約數」來源是問案功能（不是個案清單）：成案且簽約日落在本月的筆數，依主責督導歸戶。
  const newCaseCountByName = {};
  for (const r of confirmedInquiries) {
    if (!r.lead_staff_id || !r.contract_date || r.contract_date.slice(0, 7) !== todayMonth) continue;
    const name = L.staffById[r.lead_staff_id]?.name;
    if (name) newCaseCountByName[name] = (newCaseCountByName[name] || 0) + 1;
  }
  return { roster, casesByNid, unitLabel, latestVisitImportAt, newCaseCountByName, visitBatches, todayMonth };
}

async function loadCaseAudit(base) {
  const { casesByNid, roster, visitBatches, todayMonth } = base;
  // 改用共用快取（見 sql/25_visit_audit_cache.sql），理由同 loadVisitAudit()。
  return getCachedOrComputeAudit(casesByNid, roster, visitBatches, todayMonth);
}

async function viewCases() {
  $('#main').innerHTML = `
  <div class="head"><div><h1>個案清單</h1><div class="muted small" style="margin-top:4px">全系統個案主檔，每日由仁寶系統自動同步更新（見「同步紀錄」頁面），是持續維護的單一份資料。</div></div></div>
  <div id="cases-body"><p class="muted">載入中…</p></div>`;
  const box = $('#cases-body');
  let base;
  try { base = await loadCaseRosterBase(); } catch (e) { box.innerHTML = `<div class="card"><p class="err-text">${esc(e.message)}</p></div>`; return; }
  const stillOnThisPage = () => location.hash === '#/cases' && document.body.contains(box);
  drawCaseRosterTable(box, { ...base, audit: EMPTY_AUDIT, auditLoading: true });
  try {
    const audit = await loadCaseAudit(base);
    if (stillOnThisPage()) drawCaseRosterTable(box, { ...base, audit, auditLoading: false });
  } catch (e) {
    if (stillOnThisPage()) toast('缺漏稽核資料載入失敗：' + e.message, true);
  }
}

// 預設排序改成「案號遞減」（最新的案子排最前面）：之前沒指定排序時用的是
// 資料庫回傳的原始順序，剛好接近「依 id 遞增」，結果每次打開都固定從最舊
// 的案子開始列，看起來像卡住不動——督導實際上比較常需要看最新的案子。
const caseRosterState = { owner: '全部', unit: '全部', status: '全部', onlyIssues: false, q: '', sortBy: 'case_no', sortDir: 'desc', statsCollapsed: false };

// 個案清單欄位顯示設定：案號／姓名一定顯示，其他欄位可以勾選隱藏。設定記在這台電腦
// 的瀏覽器、依登入帳號分開（跟新北 A 個管系統那套邏輯一樣），不影響其他同仁、也不會
// 存進資料庫，預設全部顯示。
const ROSTER_COLUMNS = [
  { key: 'case_no', label: '案號', width: '90px', pinned: true },
  { key: 'name', label: '姓名', width: '80px', pinned: true },
  { key: 'national_id', label: '身分證字號', width: '110px' },
  { key: 'lead_supervisor', label: '督導員', width: '80px' },
  { key: 'unit_name', label: 'A單位名稱', width: '100px' },
  { key: 'service_start_date', label: '開始服務日', width: '100px' },
  { key: 'end_date', label: '結案日', width: '100px' },
  { key: 'status', label: '狀態', width: '70px' },
  { key: 'home_visit', label: '最近一次家訪', width: '130px' },
  { key: 'next_due', label: '下次應家訪日', width: '100px' },
  { key: 'phone_visit', label: '最近一次電訪', width: '120px' },
  { key: 'file_status', label: '案本', width: '90px' },
  { key: 'archive_box', label: '結案箱年度', width: '100px' },
];
const rosterColumnsKey = () => `bole.rosterColumns.${me?.id || 'anon'}`;
function loadRosterColumns() {
  const saved = store.get(rosterColumnsKey());
  const allKeys = ROSTER_COLUMNS.map((c) => c.key);
  if (!saved || !Array.isArray(saved)) return new Set(allKeys);
  const keep = new Set(saved.filter((k) => allKeys.includes(k)));
  ROSTER_COLUMNS.filter((c) => c.pinned).forEach((c) => keep.add(c.key));
  return keep;
}
function saveRosterColumns(visibleSet) {
  store.set(rosterColumnsKey(), [...visibleSet]);
}
function openRosterColumnPicker(visibleSet, onSave) {
  modal(`<h2>個案清單要顯示的欄位</h2>
    <p class="small muted" style="margin:4px 0 10px">勾選要在個案清單看到的欄位（姓名、案號一定會顯示），設定記在這台電腦的瀏覽器，依登入帳號分開，不影響其他同仁。</p>
    <div class="checks">${ROSTER_COLUMNS.map((c) => `<label${c.pinned ? ' title="一定會顯示"' : ''}><input type="checkbox" name="rc" value="${c.key}" ${visibleSet.has(c.key) ? 'checked' : ''} ${c.pinned ? 'checked disabled' : ''}>${esc(c.label)}</label>`).join('')}</div>
    <div class="acts" style="justify-content:space-between">
      <div><button type="button" class="link" data-all>全選</button> <button type="button" class="link" data-none>全不選</button> <button type="button" class="link" data-reset>恢復預設</button></div>
      <div><button type="button" class="btn" data-no>取消</button><button type="button" class="btn primary" data-yes>儲存</button></div>
    </div>`,
  (m, close) => {
    const boxes = () => $$('input[name=rc]', m);
    $('[data-all]', m).onclick = () => boxes().forEach((b) => { if (!b.disabled) b.checked = true; });
    $('[data-none]', m).onclick = () => boxes().forEach((b) => { if (!b.disabled) b.checked = false; });
    $('[data-reset]', m).onclick = () => boxes().forEach((b) => (b.checked = true));
    $('[data-no]', m).onclick = close;
    $('[data-yes]', m).onclick = () => {
      const next = new Set(boxes().filter((b) => b.checked).map((b) => b.value));
      saveRosterColumns(next);
      close();
      onSave(next);
    };
  });
}
function drawCaseRosterTable(box, data) {
  const { roster, casesByNid, audit, unitLabel, latestVisitImportAt, newCaseCountByName, auditLoading } = data;
  const activeStaffNames = new Set(L.staff.filter((s) => s.active).map((s) => s.name));
  // 督導下拉只留目前在職的人；已離職的督導要找，用搜尋框手動打名字（搜尋框有涵蓋督導員欄位，見下方 q 篩選）。
  const owners = [...new Set(roster.map((c) => c.lead_supervisor).filter(Boolean))].filter((o) => activeStaffNames.has(o)).sort();
  const units = [...new Set(roster.map((c) => c.unit_name).filter(Boolean))].sort();
  const rowIssue = (st) => !!st && (st.家訪 === '逾期' || st.家訪 === '缺漏(未收案家訪)' || st.電訪 === '缺漏');
  const sortIcon = (field) => caseRosterState.sortBy === field ? `<span class="small muted">${caseRosterState.sortDir === 'asc' ? '▲' : '▼'}</span>` : '';
  // 頁面最上方的家電訪統計摘要：不受下方篩選影響，永遠是（全體／個人／各督導）總覽，三種互相獨立。
  const lastStatusOf = (c) => {
    const r = audit.results.get(c.id);
    const lastMonth = r ? r.months[r.months.length - 1] : null;
    return lastMonth ? r.monthStatus[lastMonth] : null;
  };
  // 列管個案數（以及其他統計）只算服務中、暫停的案子，已結案的不列計——結案的個案不算「目前在管」。
  const computeStats = (cases) => {
    const active = cases.filter((c) => c.status === '服務中' || c.status === '暫停');
    return {
      total: active.length,
      homeOverdue: active.filter((c) => lastStatusOf(c)?.家訪 === '逾期').length,
      phoneMissing: active.filter((c) => lastStatusOf(c)?.電訪 === '缺漏').length,
      fileMissing: active.filter((c) => !c.file_status).length,
    };
  };
  const myCases = roster.filter((c) => c.lead_supervisor === me.name);
  const myStats = computeStats(myCases);
  // 各督導總覽依缺漏數量（家訪逾期+本月電訪缺漏）由多到少排序，缺漏越多的排越上面。
  const bySupervisor = owners.map((o) => ({ owner: o, newThisMonth: newCaseCountByName[o] || 0, ...computeStats(roster.filter((c) => c.lead_supervisor === o)) }))
    .sort((a, b) => (b.homeOverdue + b.phoneMissing) - (a.homeOverdue + a.phoneMissing));
  const draw = () => {
    const visibleCols = loadRosterColumns();
    const colVisible = (key) => visibleCols.has(key);
    const q = caseRosterState.q.trim().toLowerCase();
    const filtered = roster.filter((c) => (caseRosterState.owner === '全部' || c.lead_supervisor === caseRosterState.owner)
      && (caseRosterState.unit === '全部' || c.unit_name === caseRosterState.unit)
      && (caseRosterState.status === '全部' || c.status === caseRosterState.status)
      && (!q || [c.name, c.national_id, c.case_no, c.lead_supervisor].some((x) => (x || '').toLowerCase().includes(q))));
    const rowsData = filtered.map((c) => {
      const r = audit.results.get(c.id);
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
        // 加 numeric:true，不然案號「VIP2」「VIP10」會被當成純文字排序，
        // 排出「VIP10」在「VIP2」前面這種反直覺的順序（字串比較逐字元比對，
        // '1' 小於 '2'）。
        const c = String(av).localeCompare(String(bv), undefined, { numeric: true });
        return caseRosterState.sortDir === 'desc' ? -c : c;
      });
    }
    box.innerHTML = `
    ${!roster.length ? '' : `
    <div class="card" style="margin-bottom:16px;background:var(--accent-l);border:1px solid var(--accent)">
      <div class="small" style="margin-bottom:8px;color:var(--accent-d);font-weight:500">我的個案（${esc(me.name)}）</div>
      <div style="display:flex;flex-wrap:wrap;gap:16px 40px">
        ${[['列管個案數', myStats.total], ['家訪逾期', auditLoading ? '…' : myStats.homeOverdue], ['本月電訪缺漏', auditLoading ? '…' : myStats.phoneMissing], ['案本未繳交', myStats.fileMissing]].map(([k, v]) => `<div><div class="small" style="color:var(--accent-d)">${k}</div><div style="font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--accent-d)">${v}</div></div>`).join('')}
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-bottom:${caseRosterState.statsCollapsed ? '0' : '8px'}">
        <div class="small muted">各督導總覽</div>
        <div class="small muted" style="margin-left:auto">${auditLoading ? '缺漏稽核計算中…' : `訪視紀錄資料更新於 ${latestVisitImportAt ? fmtTime(latestVisitImportAt) : '尚無匯入紀錄'}`}</div>
        <button type="button" class="btn small" id="statsToggle" title="${caseRosterState.statsCollapsed ? '展開' : '縮小'}" style="min-height:auto;padding:2px 10px;font-size:16px;line-height:1">${caseRosterState.statsCollapsed ? '+' : '−'}</button>
      </div>
      ${caseRosterState.statsCollapsed ? '' : `<div class="tbox"><table class="t"><thead><tr><th>督導</th><th class="num">當月簽約數</th><th class="num">列管個案數</th><th class="num">家訪逾期</th><th class="num">本月電訪缺漏</th><th class="num">案本未繳交</th></tr></thead>
        <tbody>${bySupervisor.map((s) => `<tr${s.owner === me.name ? ' style="background:var(--accent-l)"' : ''}><td>${esc(s.owner)}</td><td class="num">${s.newThisMonth}</td><td class="num">${s.total}</td><td class="num">${auditLoading ? '…' : s.homeOverdue}</td><td class="num">${auditLoading ? '…' : s.phoneMissing}</td><td class="num">${s.fileMissing}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">無資料</td></tr>'}</tbody></table></div>`}
    </div>`}
    ${!roster.length ? '' : (auditLoading ? '<p class="small" style="color:var(--accent-d)">⏳ 缺漏稽核結果背景計算中…「最近一次家訪／電訪」等欄位會在算完後自動補上，不影響先搜尋、瀏覽個案清單。</p>'
      : !audit.logMinMonth ? '<p class="small muted">還沒有匯入過訪視紀錄總表，「最近一次家訪／電訪」欄位暫時顯示尚無資料。到「家電訪稽核」頁面的「匯入與批次」頁籤可以匯入。</p>'
      : `<p class="small muted">訪視紀錄自 <strong>${fmtMonth(audit.logMinMonth)}</strong> 起開始匯入；此前月份不列入缺漏統計。</p>`)}
    <div class="card filters" style="margin:10px 0 16px">
      <label class="inline-check">主責督導 <select id="rfOwner">${opt('全部', '全部', caseRosterState.owner)}${owners.map((o) => opt(o, o, caseRosterState.owner)).join('')}</select></label>
      <label class="inline-check">A單位 <select id="rfUnit">${opt('全部', '全部', caseRosterState.unit)}${units.map((u) => opt(u, unitLabel(u), caseRosterState.unit)).join('')}</select></label>
      <label class="inline-check">狀態 <select id="rfStatus">${['全部', '服務中', '暫停', '結案'].map((s) => opt(s, s, caseRosterState.status)).join('')}</select></label>
      <label class="inline-check"><input type="checkbox" id="rfIssue" ${caseRosterState.onlyIssues ? 'checked' : ''}>只顯示有缺漏/逾期</label>
      <input type="search" class="grow" id="rfQ" placeholder="搜尋案號、姓名、身分證字號、督導員（含已離職）" value="${esc(caseRosterState.q)}">
      <button type="button" class="btn small" id="rfColumns">⚙ 欄位</button>
      <button type="button" class="btn small" id="rfExportFile">⬇ 匯出案本審查狀況</button>
    </div>
    <div class="muted small" style="margin-bottom:8px">共 ${shown.length} 筆${roster.length ? '' : '（個案清單還沒有資料，請管理者到下方「重新整理個案清單」匯入）'}</div>
    <div class="tbox"><table class="t roster">
      <colgroup>${ROSTER_COLUMNS.filter((col) => colVisible(col.key)).map((col) => `<col style="width:${col.width}">`).join('')}</colgroup>
      <thead><tr>${ROSTER_COLUMNS.filter((col) => colVisible(col.key)).map((col) => {
        if (col.key === 'case_no') return `<th id="th-caseno" style="cursor:pointer;user-select:none" title="點擊排序">案號 ${sortIcon('case_no')}</th>`;
        if (col.key === 'service_start_date') return `<th id="th-startdate" style="cursor:pointer;user-select:none" title="點擊排序">開始服務日 ${sortIcon('service_start_date')}</th>`;
        return `<th>${esc(col.label)}</th>`;
      }).join('')}</tr></thead>
      <tbody>${shown.map(({ c, r, st }) => {
        // 「最近一次家訪」要顯示實際上一次合格家訪的日期（r.lastHomeMonth），不是目前月份的到期狀態
        // ——目前月份狀態（達標/未到期/逾期）另外用小標籤附加在日期後面，不能取代日期本身。
        // 逾期標籤用 position:absolute 靠右貼齊，脫離文字排版流程，讓日期本身不管有沒有標籤都維持置中。
        const homeCell = auditLoading ? '<span class="faint">計算中…</span>'
          : !audit.logMinMonth ? '<span class="faint">尚無訪視紀錄</span>'
          : !r ? '<span class="faint">—</span>'
          : r.lastHomeDate ? `${fmtDate(r.lastHomeDate)}${st?.家訪 === '逾期' ? '<span class="st r-拒絕" style="position:absolute;right:8px;top:50%;transform:translateY(-50%)">逾期</span>' : ''}`
          : st?.家訪 === '資料不足' ? '<span class="chip">尚無訪視歷史</span>'
          : '<span class="st r-拒絕">未收案家訪</span>';
        const nextDueCell = auditLoading ? '<span class="faint">計算中…</span>' : (!audit.logMinMonth || !r ? '<span class="faint">—</span>' : esc(fmtMonth(r.nextDue)));
        const phoneCell = auditLoading ? '<span class="faint">計算中…</span>'
          : !audit.logMinMonth ? '<span class="faint">尚無訪視紀錄</span>'
          : !st ? '<span class="faint">—</span>'
          : st.電訪 === '達標' ? fmtDate(st.電訪日期)
          : '<span class="st s-問案中">本月電訪缺漏</span>';
        const fileCell = fileCellHtml(c, r);
        const cellByKey = {
          case_no: `<td class="nowrap">${esc(c.case_no)}</td>`,
          name: `<td class="nowrap">${esc(c.name)}</td>`,
          national_id: `<td class="nowrap">${esc(c.national_id)}</td>`,
          lead_supervisor: `<td class="nowrap">${esc(c.lead_supervisor)}</td>`,
          unit_name: `<td class="nowrap"><span class="ellip" title="${esc(c.unit_name)}">${esc(unitLabel(c.unit_name))}</span></td>`,
          service_start_date: `<td class="nowrap">${fmtDate(c.service_start_date)}</td>`,
          end_date: `<td class="nowrap">${fmtDate(c.end_date)}</td>`,
          status: `<td>${esc(c.status)}</td>`,
          home_visit: `<td class="nowrap" style="position:relative">${homeCell}</td>`,
          next_due: `<td class="nowrap small">${nextDueCell}</td>`,
          phone_visit: `<td class="nowrap">${phoneCell}</td>`,
          file_status: `<td class="nowrap">${fileCell}</td>`,
          archive_box: `<td class="nowrap">${archiveBoxCellHtml(c)}</td>`,
        };
        return `<tr class="click" data-crow="${esc(c.national_id || '')}" data-cid="${c.id}">${ROSTER_COLUMNS.filter((col) => colVisible(col.key)).map((col) => cellByKey[col.key]).join('')}</tr>`;
      }).join('') || `<tr><td colspan="${ROSTER_COLUMNS.filter((col) => colVisible(col.key)).length}" class="empty">沒有符合條件的個案</td></tr>`}</tbody></table></div>
    ${isDirector() ? `<details style="margin-top:20px"><summary class="btn" style="display:inline-flex;width:fit-content;cursor:pointer">重新整理個案清單（上傳最新個案總表）</summary><div id="cr-import" style="margin-top:12px"></div></details>` : ''}`;
    const toggleSort = (field) => {
      if (caseRosterState.sortBy === field) caseRosterState.sortDir = caseRosterState.sortDir === 'asc' ? 'desc' : 'asc';
      else { caseRosterState.sortBy = field; caseRosterState.sortDir = 'asc'; }
      draw();
    };
    $('#rfColumns').onclick = () => openRosterColumnPicker(visibleCols, () => draw());
    $('#rfExportFile').onclick = () => exportFileReviewStatus(shown, unitLabel);
    $('#th-caseno')?.addEventListener('click', () => toggleSort('case_no'));
    $('#th-startdate')?.addEventListener('click', () => toggleSort('service_start_date'));
    $('#statsToggle')?.addEventListener('click', () => { caseRosterState.statsCollapsed = !caseRosterState.statsCollapsed; draw(); });
    $('#rfOwner').onchange = (e) => { caseRosterState.owner = e.target.value; draw(); };
    $('#rfUnit').onchange = (e) => { caseRosterState.unit = e.target.value; draw(); };
    $('#rfStatus').onchange = (e) => { caseRosterState.status = e.target.value; draw(); };
    $('#rfIssue').onchange = (e) => { caseRosterState.onlyIssues = e.target.checked; draw(); };
    // 搜尋框每次輸入都用 draw() 整個重畫表格（含輸入框本身），框本身會被整個換掉、
    // 焦點跟游標位置也會不見——打字打到一半畫面重畫，游標跑掉就會感覺「打字被中斷」，
    // 中文注音/拼音輸入法選字選到一半被打斷更明顯（組字過程中如果重畫，整個選字直接
    // 消失）。修法：(1) 中文組字期間（compositionstart~compositionend）完全不重畫，
    // 等選字完成才重畫；(2) 重畫完後自動把焦點、游標位置還原回搜尋框，讓使用者感覺
    // 畫面有換但打字沒有被打斷。
    const rfQ = $('#rfQ');
    let qComposing = false;
    const scheduleDraw = () => {
      clearTimeout(draw._t);
      draw._t = setTimeout(() => {
        const cursor = rfQ.selectionStart;
        draw();
        const el = $('#rfQ');
        if (el) { el.focus(); el.setSelectionRange(cursor, cursor); }
      }, 250);
    };
    rfQ.addEventListener('compositionstart', () => { qComposing = true; });
    rfQ.addEventListener('compositionend', () => { qComposing = false; caseRosterState.q = rfQ.value; scheduleDraw(); });
    rfQ.oninput = (e) => {
      caseRosterState.q = e.target.value;
      if (qComposing) return; // 組字過程中先不重畫，等 compositionend 再重畫
      scheduleDraw();
    };
    $$('[data-crow]').forEach((tr) => (tr.onclick = (e) => {
      if (e.target.closest('[data-ftoggle], [data-freview], [data-fbox]')) return;
      // 同一身分證字號可能對應多筆 case_roster（結案後重新開案），不能再用身分
      // 證字號當查找捷徑（會對不到是哪一筆），改用每一列唯一的 id 直接找。
      const c = roster.find((x) => String(x.id) === tr.dataset.cid);
      openCaseDetailModal(c, audit.results.get(c.id));
    }));
    $$('[data-ftoggle]').forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const c = roster.find((x) => String(x.id) === b.dataset.ftoggle);
      if (!c) return;
      try { await toggleFileStatus(c); viewCases(); } catch (err) { toast(err.message, true); }
    }));
    $$('[data-freview]').forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const c = roster.find((x) => String(x.id) === b.dataset.freview);
      if (c) openFileReviewEditor(c);
    }));
    $$('[data-fbox]').forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const c = roster.find((x) => String(x.id) === b.dataset.fbox);
      if (c) openArchiveBoxEditor(c);
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

// 案本欄位分兩排：上排「有/無」（案本這份文件存不存在），下排「審至幾年幾月」（審查到哪個家訪週期，
// 兩者是獨立概念，分開記錄）。審至落後最近一次合格家訪的月份，代表有新一期案本還沒送審，用紅字警示。
function fileCellHtml(c, r) {
  const fileTitle = c.file_updated_by_name ? `最後更新：${esc(c.file_updated_by_name)} ${fmtTime(c.file_updated_at)}` : '尚未更新';
  const line1 = isDirector()
    ? `<button type="button" class="link" data-ftoggle="${c.id}" style="color:${c.file_status ? 'var(--ok)' : 'var(--ink2)'}" title="${fileTitle}">${c.file_status ? '✓ 已繳交' : '未繳交'}</button>`
    : `<span class="st ${c.file_status ? 's-成案' : 's-未成案'}" title="${fileTitle}">${c.file_status ? '✓ 已繳交' : '未繳交'}</span>`;

  const reviewBehind = !!(r && r.lastHomeMonth && (!c.file_reviewed_through || c.file_reviewed_through < r.lastHomeMonth));
  const reviewText = c.file_reviewed_through ? `審至 ${fmtMonth(c.file_reviewed_through)}` : '未填審查進度';
  const reviewTitle = c.file_reviewed_by_name ? `最後更新：${esc(c.file_reviewed_by_name)} ${fmtTime(c.file_reviewed_at)}` : '尚未設定';
  const reviewStyle = reviewBehind ? 'color:var(--bad);font-weight:600' : 'color:var(--ink2)';
  const line2 = isDirector()
    ? `<button type="button" class="link" data-freview="${c.id}" style="${reviewStyle}" title="${reviewTitle}">${esc(reviewText)}${reviewBehind ? ' ⚠' : ''}</button>`
    : `<span class="small" style="${reviewBehind ? 'color:var(--bad);font-weight:600' : 'color:var(--muted)'}" title="${reviewTitle}">${esc(reviewText)}${reviewBehind ? ' ⚠' : ''}</span>`;

  return `<div>${line1}</div><div class="small" style="margin-top:2px">${line2}</div>`;
}

// afterSave：儲存成功後要做的事，預設是重新整理個案清單；若是從「個案詳情」視窗內點編輯進來的，
// 因為 modal() 共用同一個 #modal-root（不是堆疊式的），開啟這個編輯視窗會把底下的詳情視窗直接蓋掉，
// 存檔後單純 close() 會變成什麼視窗都沒有——所以改由呼叫端傳入 afterSave 決定存檔後要回到哪裡
// （例如重新開啟個案詳情視窗），而不是在這裡寫死 viewCases()。
function openFileReviewEditor(c, afterSave) {
  modal(`<h2>更新案本審查進度</h2>
    <p class="small muted" style="margin:4px 0 10px">${esc(c.name)}（案號 ${esc(c.case_no)}）</p>
    <label class="f">審至（年/月）<input type="month" id="reviewMonth" value="${esc(c.file_reviewed_through || '')}"></label>
    <p class="err-text" id="reviewErr" hidden></p>
    <div class="acts"><button type="button" class="btn" data-no>取消</button><button type="button" class="btn primary" data-yes>儲存</button></div>`,
  (m, close) => {
    $('[data-no]', m).onclick = close;
    $('[data-yes]', m).onclick = async () => {
      const val = $('#reviewMonth', m).value;
      const er = $('#reviewErr', m);
      if (!val) { er.textContent = '請選擇年月'; er.hidden = false; return; }
      try {
        const now = new Date().toISOString();
        await db.update('case_roster', c.id, {
          file_reviewed_through: val, file_reviewed_at: now,
          file_reviewed_by: session.user.id, file_reviewed_by_name: me.name,
        });
        c.file_reviewed_through = val; c.file_reviewed_at = now; c.file_reviewed_by_name = me.name;
        toast('已更新案本審查進度'); close();
        if (afterSave) afterSave(); else viewCases();
      } catch (e) { er.textContent = e.message; er.hidden = false; }
    };
  });
}

// 結案箱年度：個案結案後，紙本案本最後會歸檔到某一年度的結案箱（例如 115年），這個
// 欄位讓管理者登記歸檔到哪一箱，方便收到結案箱的同仁跟系統勾稽核對。只有「結案」的
// 案子還沒登記時才用紅字提醒（服務中/暫停的案子本來就還不會進結案箱，不用提醒）。
function archiveBoxCellHtml(c) {
  const title = c.archive_box_by_name ? `最後更新：${esc(c.archive_box_by_name)} ${fmtTime(c.archive_box_at)}` : '尚未設定';
  const needsArchive = c.status === '結案' && !c.archive_box_year;
  const text = c.archive_box_year ? `${c.archive_box_year}年結案箱` : (c.status === '結案' ? '未登記結案箱' : '—');
  const style = needsArchive ? 'color:var(--bad);font-weight:600' : 'color:var(--ink2)';
  return canEditArchiveBox()
    ? `<button type="button" class="link" data-fbox="${c.id}" style="${style}" title="${title}">${esc(text)}${needsArchive ? ' ⚠' : ''}</button>`
    : `<span class="small" style="${needsArchive ? 'color:var(--bad);font-weight:600' : 'color:var(--muted)'}" title="${title}">${esc(text)}${needsArchive ? ' ⚠' : ''}</span>`;
}

function openArchiveBoxEditor(c, afterSave) {
  // 這裡故意不用 <input type="number">：Chromium 的 number 輸入框在 Windows 中文輸入法
  // （尤其新注音）開啟的狀態下，瀏覽器原生的數字輸入攔截邏輯會把 Backspace 鍵吃掉、只剩
  // Delete 鍵能刪字，是已知相容性問題。改用 type="text" + inputmode="numeric" 並用 input
  // 事件把非數字字元過濾掉，繞開 number 輸入框的原生鍵盤處理，Backspace/Delete 都能正常用。
  modal(`<h2>登記結案箱年度</h2>
    <p class="small muted" style="margin:4px 0 10px">${esc(c.name)}（案號 ${esc(c.case_no)}）</p>
    <label class="f">結案箱年度（民國年，例如 115）<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" id="archiveYear" value="${c.archive_box_year || ''}"></label>
    <p class="err-text" id="archiveErr" hidden></p>
    <div class="acts"><button type="button" class="btn" data-no>取消</button><button type="button" class="btn primary" data-yes>儲存</button></div>`,
  (m, close) => {
    $('[data-no]', m).onclick = close;
    $('#archiveYear', m).addEventListener('input', (e) => { e.target.value = e.target.value.replace(/[^0-9]/g, ''); });
    $('[data-yes]', m).onclick = async () => {
      const raw = $('#archiveYear', m).value;
      const er = $('#archiveErr', m);
      const val = raw ? Number(raw) : null;
      if (raw && (!Number.isInteger(val) || val < 100 || val > 200)) { er.textContent = '請輸入正確的民國年（例如 115）'; er.hidden = false; return; }
      try {
        const now = new Date().toISOString();
        await db.update('case_roster', c.id, {
          archive_box_year: val, archive_box_at: now,
          archive_box_by: session.user.id, archive_box_by_name: me.name,
        });
        c.archive_box_year = val; c.archive_box_at = now; c.archive_box_by_name = me.name;
        toast('已更新結案箱年度'); close();
        if (afterSave) afterSave(); else viewCases();
      } catch (e) { er.textContent = e.message; er.hidden = false; }
    };
  });
}

// 匯出案本審查狀況：給管理者掌握「哪些個案案本還沒繳、哪些已經積欠很久」，用 CSV
// （UTF-8 BOM，Excel 可以直接開且中文不會亂碼）匯出目前畫面上篩選/搜尋後的清單，
// 讓管理者可以先用上面的篩選條件縮小範圍，再匯出，匯出後在 Excel 裡還能自由排序。
// 「未繳天數」只在案本未繳交時才算，用結案日（已結案）或開始服務日（服務中/暫停）
// 當起算點，天數越大代表這份案本積欠越久，方便管理者依此欄位排序找出最嚴重的案子。
function exportFileReviewStatus(shown, unitLabel) {
  // download() 只是靜默建立一個隱藏連結並自動點擊觸發瀏覽器下載，本身完全沒有任何畫面
  // 回饋（沒有 toast、畫面也不會變化）——檔案其實已經正常下載到「下載」資料夾，但使用者
  // 沒看到任何反應，很容易誤以為「按了沒反應」。這裡額外包一層 try/catch + toast，
  // 成功會明確提示「已匯出 N 筆」，萬一真的有例外（例如清單是空的、瀏覽器擋下載）也會
  // 跳出錯誤訊息，而不是整個無聲失敗。
  try {
    if (!shown.length) { toast('目前篩選條件下沒有可匯出的個案，請調整篩選條件'); return; }
    const today = new Date();
    const daysSince = (iso) => { if (!iso) return ''; const d = new Date(iso + 'T00:00:00'); const diff = Math.floor((today - d) / 86400000); return diff >= 0 ? diff : ''; };
    const header = ['案號', '姓名', '督導員', 'A單位', '狀態', '開始服務日', '結案日', '案本是否已繳交', '案本最後更新時間', '案本最後更新人', '審至（年/月）', '審至是否落後', '未繳天數', '結案箱年度'];
    const rows = shown.map(({ c, r }) => {
      const reviewBehind = !!(r && r.lastHomeMonth && (!c.file_reviewed_through || c.file_reviewed_through < r.lastHomeMonth));
      const refDate = c.status === '結案' ? c.end_date : c.service_start_date;
      return [
        c.case_no, c.name, c.lead_supervisor, unitLabel(c.unit_name), c.status,
        fmtDate(c.service_start_date), fmtDate(c.end_date),
        c.file_status ? '已繳交' : '未繳交',
        c.file_updated_at ? fmtTime(c.file_updated_at) : '',
        c.file_updated_by_name || '',
        c.file_reviewed_through ? fmtMonth(c.file_reviewed_through) : '',
        reviewBehind ? '是' : '否',
        c.file_status ? '' : daysSince(refDate),
        c.archive_box_year ? `${c.archive_box_year}年` : '',
      ];
    });
    download(`個案清單_案本審查狀況_${today.getFullYear() - 1911}年${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}.csv`, [header, ...rows]);
    toast(`已匯出 ${rows.length} 筆，請到瀏覽器「下載」資料夾查看`);
  } catch (e) {
    toast('匯出失敗：' + e.message, true);
  }
}

function openCaseDetailModal(c, r) {
  if (!c) return;
  // 警示：只要有任一個月家訪逾期/缺漏，或電訪缺漏，就在最上方用明顯的紅色提示條列出來，
  // 不用把整張逐月表格看完才發現有問題。
  const issueMonths = r ? r.months.filter((m) => {
    const st = r.monthStatus[m];
    return st.家訪 === '逾期' || st.家訪 === '缺漏(未收案家訪)' || st.電訪 === '缺漏';
  }) : [];
  const warningHtml = issueMonths.length
    ? `<p class="small" style="color:var(--bad);background:var(--bad-bg);padding:8px 12px;border-radius:8px;margin:8px 0 0">⚠ 開始服務後共有 ${issueMonths.length} 個月家訪逾期／缺漏或電訪缺漏，詳見下方逐月狀態</p>`
    : (r ? `<p class="small" style="color:var(--ok);background:var(--ok-bg);padding:8px 12px;border-radius:8px;margin:8px 0 0">✓ 開始服務後的家訪／電訪紀錄目前沒有缺漏或逾期</p>` : '');
  const reviewBehind = !!(r && r.lastHomeMonth && (!c.file_reviewed_through || c.file_reviewed_through < r.lastHomeMonth));
  const reviewText = c.file_reviewed_through ? fmtMonth(c.file_reviewed_through) : '未填審查進度';
  const monthsHtml = r ? `<div class="tbox" style="max-height:50vh;overflow:auto;margin-top:10px"><table class="t"><thead><tr><th>月份</th><th>家訪</th><th>電訪</th></tr></thead>
      <tbody>${r.months.map((m) => {
        const st = r.monthStatus[m];
        const homeIssue = st.家訪 === '逾期' || st.家訪 === '缺漏(未收案家訪)';
        const phoneIssue = st.電訪 === '缺漏';
        const homeText = st.家訪 === '達標' ? `達標（${fmtDate(st.家訪日期)}）` : st.家訪;
        const phoneText = st.電訪 === '達標' ? `達標（${fmtDate(st.電訪日期)}）` : st.電訪;
        const homeCellHtml = homeIssue ? `<span style="color:var(--bad);font-weight:600">${esc(homeText)}</span>` : esc(homeText);
        const phoneCellHtml = phoneIssue ? `<span style="color:var(--bad);font-weight:600">${esc(phoneText)}</span>` : esc(phoneText);
        return `<tr><td>${fmtMonth(m)}</td><td>${homeCellHtml}</td><td>${phoneCellHtml}</td></tr>`;
      }).join('')}</tbody></table></div>${r.blankMonths.length ? `<p class="small" style="color:var(--warn);margin-top:10px">以下月份有紀錄但內容不足 30 字、未採計：${esc(r.blankMonths.map(fmtMonth).join('、'))}</p>` : ''}`
    : '<p class="small muted" style="margin-top:10px">還沒有訪視紀錄可供比對。</p>';
  modal(`<h2>${esc(c.name)}</h2>
    <p class="small muted" style="margin:4px 0 10px">案號 ${esc(c.case_no)}　身分證字號 ${esc(c.national_id)}　主責督導 ${esc(c.lead_supervisor)}　A單位 ${esc(c.unit_name)}　狀態 ${esc(c.status)}</p>
    <div class="inline-check">案本：<span id="cdFile">${c.file_status ? '✓ 已繳交' : '未繳交'}</span>${c.file_updated_by_name ? `<span class="small muted"> （${esc(c.file_updated_by_name)} ${fmtTime(c.file_updated_at)}）</span>` : ''}
      ${isDirector() ? '<button type="button" class="link" data-ftoggle2 style="margin-left:8px">切換</button>' : ''}</div>
    <div class="inline-check" style="margin-top:4px">審至：<span id="cdReview" style="${reviewBehind ? 'color:var(--bad);font-weight:600' : ''}">${reviewText}${reviewBehind ? ' ⚠' : ''}</span>${c.file_reviewed_by_name ? `<span class="small muted"> （${esc(c.file_reviewed_by_name)} ${fmtTime(c.file_reviewed_at)}）</span>` : ''}
      ${isDirector() ? '<button type="button" class="link" data-freview2 style="margin-left:8px">編輯</button>' : ''}</div>
    <div class="inline-check" style="margin-top:4px">結案箱：<span id="cdArchive" style="${(c.status === '結案' && !c.archive_box_year) ? 'color:var(--bad);font-weight:600' : ''}">${c.archive_box_year ? esc(`${c.archive_box_year}年結案箱`) : (c.status === '結案' ? '未登記結案箱 ⚠' : '—')}</span>${c.archive_box_by_name ? `<span class="small muted"> （${esc(c.archive_box_by_name)} ${fmtTime(c.archive_box_at)}）</span>` : ''}
      ${canEditArchiveBox() ? '<button type="button" class="link" data-fbox2 style="margin-left:8px">編輯</button>' : ''}</div>
    ${warningHtml}
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
    const rb = $('[data-freview2]', m);
    if (rb) rb.onclick = () => openFileReviewEditor(c, () => { viewCases(); openCaseDetailModal(c, r); });
    const xb = $('[data-fbox2]', m);
    if (xb) xb.onclick = () => openArchiveBoxEditor(c, () => { viewCases(); openCaseDetailModal(c, r); });
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

// 分批 upsert 進「個案清單」主檔；供「個案清單」頁面自己的匯入使用。
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

/* ================= 同步紀錄（仁寶自動同步執行歷程） ================= */
// 對應 sync_runs 資料表（sql/18_sync_runs.sql），每次排程自動同步（個案總表／
// 督導訪視紀錄總表）都會在這裡留一筆記錄，讓主任/管理者不用跑去 Supabase
// 後台查，直接在系統裡看得到「跑了沒、成不成功、有沒有異常」。這張表的
// RLS 只開放主任/管理者讀取（is_director()），一般在職人員看不到，比照
// 其他系統維運性質的功能。
const SYNC_REPORT_TYPE_LABEL = { case_summary: '個案總表', supervisor_visit_record: '督導訪視紀錄總表' };
const SYNC_STATUS_LABEL = { running: '執行中', success: '成功', partial_failure: '部分成功（有異常）', failed: '失敗' };
const syncLogState = { reportType: '全部', status: '全部' };

async function viewSyncLog() {
  $('#main').innerHTML = `
  <div class="head"><div><h1>同步紀錄</h1><div class="muted small" style="margin-top:4px">仁寶系統自動同步（個案總表／督導訪視紀錄總表）的執行歷程，每天排程跑完都會留一筆紀錄。</div></div></div>
  <div id="synclog-body"><p class="muted">載入中…</p></div>`;
  const box = $('#synclog-body');
  let runs;
  try {
    runs = await db.all('sync_runs', { order: 'started_at.desc' });
  } catch (e) {
    box.innerHTML = `<div class="card"><p class="err-text">${esc(e.message)}</p></div>`;
    return;
  }

  const totalRuns = runs.length;
  const successCount = runs.filter((r) => r.status === 'success').length;
  const failedCount = runs.filter((r) => r.status === 'failed').length;
  const warningCount = runs.filter((r) => r.coverage_warning).length;
  const lastRun = runs[0];

  // 疑似漏填問案比對：個案總表每次自動同步時順便跑的比對結果（邏輯見
  // sync/shared/case-comparison.js），取「最近一次成功的個案總表同步」那筆的
  // 結果，因為這是快照式的比對（當下仁寶資料 vs 當下問案資料），不是累加的，
  // 只看最新一次就好，不用把歷史每一筆都疊加起來看。
  const latestCaseSummaryRun = runs.find((r) => r.report_type === 'case_summary' && r.status === 'success' && r.missing_inquiry_details != null);
  const missingList = latestCaseSummaryRun?.missing_inquiry_details || [];
  const needsReviewList = latestCaseSummaryRun?.needs_review_details || [];

  const draw = () => {
    const filtered = runs.filter((r) =>
      (syncLogState.reportType === '全部' || SYNC_REPORT_TYPE_LABEL[r.report_type] === syncLogState.reportType)
      && (syncLogState.status === '全部' || SYNC_STATUS_LABEL[r.status] === syncLogState.status));

    box.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;flex-wrap:wrap;gap:16px 40px">
        <div><div class="small muted">總執行次數</div><div style="font-size:26px;font-weight:700">${totalRuns}</div></div>
        <div><div class="small muted">成功</div><div style="font-size:26px;font-weight:700;color:var(--ok)">${successCount}</div></div>
        <div><div class="small muted">失敗</div><div style="font-size:26px;font-weight:700;color:${failedCount ? 'var(--bad)' : 'var(--ink2)'}">${failedCount}</div></div>
        <div><div class="small muted">涵蓋異常警告</div><div style="font-size:26px;font-weight:700;color:${warningCount ? 'var(--warn)' : 'var(--ink2)'}">${warningCount}</div></div>
        <div><div class="small muted">最近一次執行</div><div style="font-size:16px;font-weight:600;margin-top:4px">${lastRun ? `${fmtTime(lastRun.started_at)}　${esc(SYNC_REPORT_TYPE_LABEL[lastRun.report_type] || lastRun.report_type)}　${esc(SYNC_STATUS_LABEL[lastRun.status] || lastRun.status)}` : '尚無紀錄'}</div></div>
      </div>
    </div>
    <div class="card filters" style="margin-bottom:16px">
      <label class="inline-check">報表類型 <select id="slReportType">${['全部', ...Object.values(SYNC_REPORT_TYPE_LABEL)].map((v) => opt(v, v, syncLogState.reportType)).join('')}</select></label>
      <label class="inline-check">狀態 <select id="slStatus">${['全部', ...Object.values(SYNC_STATUS_LABEL)].map((v) => opt(v, v, syncLogState.status)).join('')}</select></label>
    </div>
    <div class="muted small" style="margin-bottom:8px">共 ${filtered.length} 筆</div>
    <div class="tbox"><table class="t">
      <thead><tr><th>執行時間</th><th>報表類型</th><th>狀態</th><th class="num">匯入筆數</th><th class="num">略過筆數</th><th>涵蓋異常</th><th>錯誤訊息</th><th>執行者</th></tr></thead>
      <tbody>${filtered.map((r) => {
        const statusColor = r.status === 'success' ? 'var(--ok)' : r.status === 'failed' ? 'var(--bad)' : r.status === 'partial_failure' ? 'var(--warn)' : 'var(--ink2)';
        return `<tr>
          <td class="nowrap">${fmtTime(r.started_at)}</td>
          <td class="nowrap">${esc(SYNC_REPORT_TYPE_LABEL[r.report_type] || r.report_type)}</td>
          <td><span style="color:${statusColor};font-weight:600">${esc(SYNC_STATUS_LABEL[r.status] || r.status)}</span></td>
          <td class="num">${r.rows_imported ?? '—'}</td>
          <td class="num">${r.rows_skipped ?? '—'}</td>
          <td>${r.coverage_warning ? '<span style="color:var(--warn);font-weight:600">⚠ 有異常</span>' : '—'}</td>
          <td class="small" style="max-width:320px">${r.error_detail ? `<span class="${r.status === 'failed' ? 'err-text' : 'muted'}">${esc(r.error_detail)}</span>` : '—'}</td>
          <td class="nowrap small muted">${esc(r.run_by_name || '')}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="8" class="empty">沒有符合條件的紀錄</td></tr>'}</tbody>
    </table></div>

    <div class="card" style="margin:24px 0 16px">
      <h2 style="margin:0 0 4px">疑似督導漏填（${missingList.length}）</h2>
      <p class="small muted" style="margin:4px 0 10px">仁寶系統裡「服務中」或「暫停」的個案，但問案系統完全找不到對應的問案紀錄——代表督導忘記建立問案，需要盡快補登。${latestCaseSummaryRun ? `資料來自 ${fmtTime(latestCaseSummaryRun.started_at)} 的個案總表同步。` : ''}</p>
      ${missingList.length ? `<div class="tbox"><table class="t"><thead><tr><th>案號</th><th>姓名</th><th>狀態</th><th>主責督導</th><th>服務起始</th></tr></thead>
        <tbody>${missingList.map((r) => `<tr><td>${esc(r.case_no)}</td><td>${esc(r.name)}</td><td>${esc(r.status)}</td><td>${esc(r.lead_supervisor)}</td><td>${fmtDate(r.service_start_date)}</td></tr>`).join('')}</tbody></table></div>`
        : `<p class="muted small">${latestCaseSummaryRun ? '目前沒有發現疑似漏填的個案。' : '尚無個案總表同步紀錄，無法顯示比對結果。'}</p>`}
    </div>

    <div class="card" style="margin-bottom:16px">
      <h2 style="margin:0 0 4px">案號待確認（${needsReviewList.length}）</h2>
      <p class="small muted" style="margin:4px 0 10px">問案已成案、也填了仁寶案號，但這個案號在仁寶最新匯入資料裡找不到——原因較多（案號打錯、案號異動、仁寶狀態已不同等），需要人工個別確認，不是單純漏填。</p>
      ${needsReviewList.length ? `<div class="tbox"><table class="t"><thead><tr><th>博樂問案</th><th>仁寶案號</th><th>原因</th></tr></thead>
        <tbody>${needsReviewList.map((r) => `<tr><td><a href="#/i/${r.inquiry_id}">${esc(r.inquiry_code)}</a> ${esc(r.client_name || '')}</td><td>${esc(r.case_no)}</td><td class="small muted">${esc(r.reason)}</td></tr>`).join('')}</tbody></table></div>`
        : `<p class="muted small">${latestCaseSummaryRun ? '目前沒有需要確認的案號。' : '尚無個案總表同步紀錄，無法顯示比對結果。'}</p>`}
    </div>`;

    $('#slReportType').onchange = (e) => { syncLogState.reportType = e.target.value; draw(); };
    $('#slStatus').onchange = (e) => { syncLogState.status = e.target.value; draw(); };
  };
  draw();
}

/* ================= 管理 ================= */
const ADMIN_TABS = {
  staff: { label: '督導與帳號', table: 'staff' }, cg: { label: '居服員', table: 'caregivers' },
  pageperm: { label: '頁面權限' }, perm: { label: '業務權限' },
  units: { label: '轉介單位', table: 'referral_units' }, nc: { label: '未成案原因', table: 'nc_reasons' },
  rj: { label: '拒絕原因', table: 'reject_reasons' }, cond: { label: '特殊條件', table: 'special_conditions' },
  sc: { label: '碼別', table: 'service_codes' },
};
// 管理頁面的分頁、以及頂部導覽列「管理」下拉選單，共用同一份分組設定：
// 帳號（督導/居服員帳號管理＋輪接設定）、權限（頁面權限＋業務權限）、
// 資料庫（各種下拉選項維護）。輪接不在 ADMIN_TABS 裡（獨立一個頁面、不是
// 通用選項表格），刻意維持只有管理者看得到、不受頁面權限矩陣影響。
const ADMIN_GROUPS = [
  { label: '帳號', keys: ['staff', 'cg', 'rotation'] },
  { label: '權限', keys: ['pageperm', 'perm'] },
  { label: '資料庫', keys: ['units', 'nc', 'rj', 'cond', 'sc'] },
];
function adminTabsHtml(activeKey) {
  return ADMIN_GROUPS.map((g) => {
    const keys = g.keys.filter((k) => k !== 'rotation' || isAdmin());
    if (!keys.length) return '';
    return `<span class="admin-tab-group"><span class="admin-tab-group-label">${esc(g.label)}</span>${keys.map((k) => {
      const label = k === 'rotation' ? '輪接' : ADMIN_TABS[k].label;
      const href = k === 'rotation' ? '#/admin/rotation' : `#/admin/${k}`;
      return `<a href="${href}" class="${k === activeKey ? 'on' : ''}">${esc(label)}</a>`;
    }).join('')}</span>`;
  }).join('');
}
async function viewAdmin(tab) {
  if (tab === 'rotation' && isAdmin()) return viewRotationAdmin();
  if (tab === 'pageperm') return viewPagePermAdmin();
  if (tab === 'perm') return viewBusinessPermAdmin();
  if (!ADMIN_TABS[tab]) tab = 'units';
  const T = ADMIN_TABS[tab];
  const rows = await db.all(T.table, { order: tab === 'cg' || tab === 'staff' ? 'active.desc,code,name' : 'active.desc,sort,name' });
  const isOpt = !['cg', 'staff', 'sc'].includes(tab);
  const regionSel = (name, cur) => `<select name="${name}">${opt('', '—', cur)}${REGIONS.map((r) => opt(r, r, cur)).join('')}</select>`;
  const roleSel = (cur) => `<select name="role">${[['supervisor', '督導'], ['director', '主任'], ['admin', '管理者'], ['clerk', '行政']].map(([v, l]) => opt(v, l, cur)).join('')}</select>`;
  // 主責居督下拉：列出在職、非行政角色的人員，跟家電訪稽核「主責督導」篩選
  // 用同一個條件（有設定區域的人，涵蓋兼任區域督導工作的管理者）。
  const leadSupSel = (cur) => `<select name="lead_supervisor_staff_id">${opt('', '—', cur || '')}${L.staff.filter((s) => s.active && s.role !== 'clerk' && s.region).map((s) => opt(s.id, s.name, cur || '')).join('')}</select>`;
  const head = isOpt ? '<th>名稱</th><th style="width:110px">排序</th>'
    : tab === 'sc' ? '<th style="width:110px">代碼</th><th>名稱</th><th style="width:110px">排序</th>'
      : tab === 'cg' ? '<th style="width:130px">員編</th><th>姓名</th><th style="width:130px">區域</th><th style="width:130px">到職日</th><th style="width:130px">離職日</th><th style="width:140px">主責居督</th>' : '<th style="width:130px">員編</th><th>姓名</th><th style="width:130px">區域</th><th style="width:130px">角色</th><th>登入帳號</th>';
  const cells = (r) => isOpt ? `<td><input type="text" name="name" value="${esc(r.name)}" aria-label="名稱"></td><td><input type="number" name="sort" value="${r.sort}" aria-label="排序"></td>`
    : tab === 'sc' ? `<td><input type="text" name="code" value="${esc(r.code || '')}" aria-label="代碼"></td><td><input type="text" name="name" value="${esc(r.name)}" aria-label="名稱"></td><td><input type="number" name="sort" value="${r.sort}" aria-label="排序"></td>`
      : tab === 'cg' ? `<td><input type="text" name="code" value="${esc(r.code || '')}" aria-label="員編"></td><td><input type="text" name="name" value="${esc(r.name)}" aria-label="姓名"></td><td>${regionSel('region', r.region)}</td><td><input type="date" name="hire_date" value="${esc(r.hire_date || '')}" aria-label="到職日"></td><td><input type="date" name="resign_date" value="${esc(r.resign_date || '')}" aria-label="離職日"></td><td>${leadSupSel(r.lead_supervisor_staff_id)}</td>`
        : `<td><input type="text" name="code" value="${esc(r.code || '')}" aria-label="員編"></td><td><input type="text" name="name" value="${esc(r.name)}" aria-label="姓名"></td><td>${regionSel('region', r.region)}</td><td>${roleSel(r.role)}</td><td class="small">${
            r.user_id
              ? `已連結${isDirector() ? ` <button type="button" class="link" data-acct="reset" data-id="${r.id}">重設密碼</button>` : ''}${isAdmin() ? ` <button type="button" class="link" style="color:var(--bad)" data-acct="delete" data-id="${r.id}">刪除帳號</button>` : ''}`
              : `<span class="faint">未連結</span>${isDirector() && r.id ? ` <button type="button" class="link" data-acct="create" data-id="${r.id}">建立帳號</button>` : ''}`
          }</td>`;
  // 居服員／督導帳號允許管理者（僅限 admin，不含主任）直接刪除——跟其他選項類表格
  // （轉介單位、未成案原因…）不一樣，那些刻意只能停用不能刪除，是因為舊紀錄會引用到。
  // 但居服員／督導如果是打錯名字（不是真的離職），留著停用只會一直卡在清單裡，應該要
  // 能真的刪掉。如果這個人其實已經被媒合紀錄/問案等資料引用，資料庫會因為外鍵限制擋下
  // 刪除、跳出錯誤訊息，不會真的刪出資料不一致。
  const canDelete = isAdmin() && (tab === 'cg' || tab === 'staff');
  // 人數動態儀表板：直接用這次已經撈回來的 rows 現場算，不用另外查資料庫或做
  // 快取——居服員＋督導加起來才一百人左右，這種分組計數本來就是毫秒等級的
  // 運算，開快取反而多一層要維護的架構，沒有實益。
  const regionDashboard = (tab === 'cg' || tab === 'staff')
    ? `<div class="card" style="margin-bottom:16px"><div style="display:flex;flex-wrap:wrap;gap:16px 40px">
        <div><div class="small muted">在職總人數</div><div style="font-size:26px;font-weight:700">${rows.filter((r) => r.active).length}</div></div>
        ${REGIONS.map((reg) => `<div><div class="small muted">${esc(reg)}</div><div style="font-size:26px;font-weight:700">${rows.filter((r) => r.active && r.region === reg).length}</div></div>`).join('')}
      </div></div>` : '';
  $('#main').innerHTML = `
  <div class="head"><div><h1>管理</h1><div class="muted small" style="margin-top:4px">選項不刪除，不用的改成停用；停用後不會出現在下拉選單，但舊紀錄仍保留。${canDelete ? '居服員／督導如果是輸入錯誤（非離職），管理者可以直接刪除。' : ''}</div></div></div>
  <nav class="tabs admin-tabs" aria-label="管理項目">${adminTabsHtml(tab)}</nav>
  ${regionDashboard}
  ${tab === 'staff' ? '<div class="card small" style="margin-bottom:16px;color:var(--ink2)">先新增人員資料並填好員編、儲存後，再用「建立帳號」設定密碼即可（登入帳號＝員編）。主任與管理者可以判定拒案、刪除紀錄、管理選項；行政僅能編輯個案清單的「結案箱年度」。</div>' : ''}
  <div class="tbox"><table class="t" style="min-width:640px">
    <thead><tr>${head}<th style="width:80px">啟用</th><th style="width:90px"></th>${canDelete ? '<th style="width:70px"></th>' : ''}</tr></thead>
    <tbody>${rows.map((r) => `<tr data-id="${r.id}">${cells(r)}<td><input type="checkbox" name="active" ${r.active ? 'checked' : ''} aria-label="啟用" style="width:20px;height:20px;accent-color:var(--accent)"></td><td><button type="button" class="btn small" data-save>儲存</button></td>${canDelete ? `<td><button type="button" class="link" style="color:var(--bad)" data-del="${r.id}">刪除</button></td>` : ''}</tr>`).join('')}
      <tr data-new>${cells({ name: '', sort: (rows.length ? Math.max(...rows.map((r) => r.sort || 0)) + 1 : 1), role: 'supervisor', region: tab === 'cg' || tab === 'staff' ? (me.region || '') : '' })}<td><input type="checkbox" name="active" checked aria-label="啟用" style="width:20px;height:20px;accent-color:var(--accent)"></td><td><button type="button" class="btn small primary" data-add>新增</button></td>${canDelete ? '<td></td>' : ''}</tr>
    </tbody></table></div>
  <div id="ua-extra"></div>`;
  const read = (tr) => {
    const b = { name: $('[name=name]', tr).value.trim(), active: $('[name=active]', tr).checked };
    if (isOpt || tab === 'sc') b.sort = Number($('[name=sort]', tr).value) || 0;
    if (tab === 'sc') b.code = $('[name=code]', tr).value.trim() || null;
    if (tab === 'cg') {
      b.code = $('[name=code]', tr).value.trim() || null; b.region = $('[name=region]', tr).value || null;
      b.hire_date = $('[name=hire_date]', tr).value || null; b.resign_date = $('[name=resign_date]', tr).value || null;
      b.lead_supervisor_staff_id = Number($('[name=lead_supervisor_staff_id]', tr).value) || null;
      // 填了離職日就自動連動停用，不用另外再去勾「啟用」——避免忘記同步兩個欄位，
      // 導致個督檢核等其他功能看到的在職狀態不一致。反過來（取消「啟用」）不會
      // 自動帶入離職日，因為停用常常是事後才補登，當下日期不一定是真正的離職日。
      if (b.resign_date) b.active = false;
    }
    if (tab === 'staff') { b.code = $('[name=code]', tr).value.trim() || null; b.region = $('[name=region]', tr).value || null; b.role = $('[name=role]', tr).value; }
    return b;
  };
  if (tab === 'cg') $$('[name=resign_date]').forEach((input) => (input.oninput = () => {
    if (input.value) { const tr = input.closest('tr'); const activeCb = $('[name=active]', tr); if (activeCb) activeCb.checked = false; }
  }));
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
  if (canDelete) $$('[data-del]').forEach((btn) => (btn.onclick = async () => {
    const tr = btn.closest('tr');
    const name = $('[name=name]', tr).value.trim();
    const ok = await confirmBox(`確定要刪除「${name}」嗎？這個動作無法復原。如果這個人已經有媒合紀錄或問案等資料引用，系統會拒絕刪除。`, '刪除', true);
    if (!ok) return;
    try { await db.remove(T.table, Number(btn.dataset.del)); await loadLookups(); toast('已刪除'); render(); }
    catch (e) { toast(/foreign key|violates/.test(e.message) ? '這個人已經有媒合紀錄或問案等資料引用，無法刪除，請改成停用' : e.message, true); }
  }));
  if (tab === 'staff') $$('[data-acct]').forEach((btn) => (btn.onclick = async () => {
    const staffId = Number(btn.dataset.id);
    const tr = btn.closest('tr');
    const name = $('[name=name]', tr).value.trim();
    const act = btn.dataset.acct;
    if (act === 'create') {
      promptPassword(`建立「${name}」的登入帳號`, async (pw) => {
        const r = await callStaffAccount('create', staffId, { password: pw });
        toast(`已建立帳號（${r.email}）`); render();
      });
    } else if (act === 'reset') {
      promptPassword(`重設「${name}」的密碼`, async (pw) => {
        await callStaffAccount('reset_password', staffId, { password: pw });
        toast('已重設密碼');
      });
    } else if (act === 'delete') {
      const ok = await confirmBox(`確定要刪除「${name}」的登入帳號嗎？刪除後這個人需要重新建立帳號才能登入。`, '刪除帳號', true);
      if (!ok) return;
      try { await callStaffAccount('delete', staffId); toast('已刪除帳號'); render(); }
      catch (e) { toast(e.message, true); }
    }
  }));
  if (tab === 'units') await drawUnitAbbrSection($('#ua-extra'));
}

// 「頁面權限」：以角色為單位的頁面可見性矩陣（role_page_permissions），只控制
// 「這個角色看不看得到、進不進得去某個頁面」，不碰頁面裡面寫死的細部操作權限
// （只有管理者能刪帳號、只有主任能跨區編輯那些，繼續維持原樣，不受這裡影響）。
// PAGE_LIST 要跟 drawNav()／render() 路由裡用的 page_key 保持一致，新增頁面時
// 兩邊都要記得加。
const PAGE_LIST = [
  { key: 'inquiries', label: '問案' }, { key: 'cases', label: '個案清單' }, { key: 'report', label: '派案紀錄' },
  { key: 'stats', label: '統計' }, { key: 'visitaudit', label: '家電訪稽核' }, { key: 'todos', label: '待辦事項' },
  { key: 'cgaudit', label: '居服員稽核' }, { key: 'cgsup', label: '個督檢核' }, { key: 'judge', label: '拒案判定' },
  { key: 'synclog', label: '同步紀錄' }, { key: 'admin', label: '管理' },
];
const PAGE_PERM_ROLES = [['supervisor', '督導'], ['director', '主任'], ['admin', '管理者'], ['clerk', '行政']];
async function viewPagePermAdmin() {
  const rows = await db.all('role_page_permissions', { order: 'role' });
  const visMap = new Map(rows.map((r) => [`${r.role}:${r.page_key}`, r.visible]));
  const canEdit = isAdmin();
  $('#main').innerHTML = `
  <h1>管理</h1>
  <nav class="tabs admin-tabs" aria-label="管理項目">${adminTabsHtml('pageperm')}</nav>
  <div class="muted small" style="margin:10px 0 16px">設定每個角色在導覽列能不能看到、能不能進入某個頁面；頁面裡面原本的細部操作權限（例如只有管理者能刪帳號）不受這裡影響。${canEdit ? '' : '　<span style="color:var(--warn)">只有管理者能修改這份設定。</span>'}</div>
  <div class="tbox"><table class="t">
    <thead><tr><th>頁面</th>${PAGE_PERM_ROLES.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead>
    <tbody>${PAGE_LIST.map((p) => `<tr data-page="${p.key}">
      <td>${esc(p.label)}</td>
      ${PAGE_PERM_ROLES.map(([role]) => `<td><input type="checkbox" data-role="${role}" ${visMap.get(`${role}:${p.key}`) !== false ? 'checked' : ''} ${canEdit ? '' : 'disabled'}></td>`).join('')}
    </tr>`).join('')}</tbody>
  </table></div>`;
  if (canEdit) $$('[data-role]').forEach((cb) => (cb.onchange = async () => {
    const role = cb.dataset.role, pageKey = cb.closest('tr').dataset.page;
    cb.disabled = true;
    try {
      await db.upsert('role_page_permissions', { role, page_key: pageKey, visible: cb.checked }, 'role,page_key');
      await loadLookups(); toast('已更新');
    } catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
    cb.disabled = false;
  }));
}

// 「業務權限」：通用的業務授權表（staff_permission_grants），目前只有一項
// 「個督紙本勾稽」，之後若有其他業務也要分權限，直接在 BUSINESS_PERMISSIONS
// 這個清單加一筆即可，不用動資料庫結構。只有管理者（isAdmin，不含主任）能
// 勾選/取消——跟 RLS 的 insert/delete 政策一致；主任看得到這頁但勾選框停用，
// 方便知道目前授權狀況，但不能自己改。
const BUSINESS_PERMISSIONS = [
  { key: 'cg_supervision_paper_check', label: '個督紙本勾稽' },
];
async function viewBusinessPermAdmin() {
  const [staff, grants] = await Promise.all([
    db.all('staff', { active: 'eq.true', order: 'code,name' }),
    db.all('staff_permission_grants', {}),
  ]);
  const grantSet = new Set(grants.map((g) => `${g.staff_id}:${g.permission_key}`));
  const canEdit = isAdmin();
  $('#main').innerHTML = `
  <h1>管理</h1>
  <nav class="tabs admin-tabs" aria-label="管理項目">${adminTabsHtml('perm')}</nav>
  <div class="muted small" style="margin:10px 0 16px">指派特定業務的管理權限給同仁，不分區域限制；主任與管理者不受此表限制，一律可操作全部業務。${canEdit ? '' : '　<span style="color:var(--warn)">只有管理者能修改這份授權清單。</span>'}</div>
  <div class="tbox"><table class="t">
    <thead><tr><th>員編</th><th>姓名</th><th>角色</th>${BUSINESS_PERMISSIONS.map((p) => `<th>${esc(p.label)}</th>`).join('')}</tr></thead>
    <tbody>${staff.map((s) => `<tr data-sid="${s.id}">
      <td class="nowrap">${esc(s.code || '')}</td><td>${esc(s.name)}</td><td>${esc({ supervisor: '督導', director: '主任', admin: '管理者', clerk: '行政' }[s.role] || s.role)}</td>
      ${BUSINESS_PERMISSIONS.map((p) => `<td><input type="checkbox" data-perm="${p.key}" ${grantSet.has(`${s.id}:${p.key}`) ? 'checked' : ''} ${canEdit ? '' : 'disabled'}></td>`).join('')}
    </tr>`).join('') || '<tr><td colspan="99" class="empty">沒有在職人員</td></tr>'}</tbody>
  </table></div>`;
  if (canEdit) $$('[data-perm]').forEach((cb) => (cb.onchange = async () => {
    const staffId = Number(cb.closest('tr').dataset.sid);
    const key = cb.dataset.perm;
    cb.disabled = true;
    try {
      if (cb.checked) await db.insert('staff_permission_grants', { staff_id: staffId, permission_key: key, granted_by: me.id });
      else {
        // 不信任頁面載入當下那份舊的 grants 陣列（同一次頁面停留可能勾了又取消好幾次，
        // 陣列裡不會有剛剛才新增的那筆），改成即時查一次目前的實際 id 再刪除。
        const rows = await db.all('staff_permission_grants', { staff_id: `eq.${staffId}`, permission_key: `eq.${key}` });
        if (rows[0]) await db.remove('staff_permission_grants', rows[0].id);
      }
      await loadLookups(); toast('已更新');
    } catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
    cb.disabled = false;
  }));
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

/* ================= 待辦事項 ================= */
// 四象限（每月/臨時 × 主管交辦/自己建立）純粹是前端分類方式，資料庫只有一張
// todos 表：source_template_id 有值＝每月範本自動產生的實例；created_by_staff_id
// 是不是自己＝主管交辦 vs 自己建立。範本（is_monthly=true）本身不是任務，不進
// 四象限，另外收在「每月範本設定」區塊管理。見 sql/22_todos.sql 的完整設計說明。
const todoRpc = (name, args) => rest('POST', `rpc/${name}`, { body: args || {} });
let todoState = { showTemplates: false, viewStaffId: null, q: '', expandedDone: {} };

async function viewTodos() {
  // 管理者/主任可以切換「檢視某位督導」，看他身上被指派的所有待辦事項（不限
  // 是誰建立的）；一般督導看不到這個切換，只能看自己相關的（RLS 本來就擋住了，
  // 這裡只是不顯示切換選單，不是另一層安全機制）。
  const viewOptions = isDirector()
    ? `<label class="inline-check">檢視 <select id="todoViewStaff">${opt('', '我自己', todoState.viewStaffId)}${L.staff.filter((s) => s.active && s.role !== 'clerk').map((s) => opt(s.id, `${s.name}${s.region ? `（${s.region}）` : ''}`, todoState.viewStaffId)).join('')}</select></label>`
    : '';
  $('#main').innerHTML = `
  <div class="head"><div><h1>待辦事項</h1><div class="muted small" style="margin-top:4px">${todoState.viewStaffId ? `正在檢視 ${esc(L.staffById[todoState.viewStaffId]?.name || '')} 的待辦事項（他建立的或被指派給他的）。` : '每月交辦與臨時待辦，主管與督導可以互相指派，只看得到自己建立或被指派的項目。'}</div></div>
    <div class="right">${viewOptions}<button type="button" class="btn primary" id="todoNew">＋ 新增待辦事項</button></div></div>
  <div class="card filters" style="margin-bottom:16px"><input type="search" class="grow" id="todoQ" placeholder="搜尋標題、內容關鍵字" value="${esc(todoState.q)}" aria-label="搜尋"></div>
  <div id="todo-body"><p class="muted">載入中…</p></div>`;
  $('#todoNew').onclick = () => openTodoEditor(null, [], () => viewTodos());
  $('#todoViewStaff')?.addEventListener('change', (e) => { todoState.viewStaffId = e.target.value ? Number(e.target.value) : null; viewTodos(); });
  const box = $('#todo-body');
  // 每次打開頁面先確保這個月該產生的每月任務都產生了，任何人打開都可以觸發，
  // 用資料庫那邊的 unique index 擋重複，併發也安全，失敗不擋顯示。
  try { await todoRpc('generate_due_monthly_todos'); } catch { /* 忽略，資料仍會正常顯示，只是可能少這個月的新實例 */ }
  let todos, assignees;
  try {
    [todos, assignees] = await Promise.all([
      db.all('todos', { order: 'due_date.asc.nullslast,id.desc' }),
      // todo_assignees 是複合主鍵（todo_id, staff_id），沒有 id 欄位，db.all() 沒指定
      // order 時預設的「id 遊標分頁」用不了，這裡用 offset 分頁（表很小，不用擔心效能）。
      db.all('todo_assignees', { order: 'todo_id' }),
    ]);
  } catch (e) { box.innerHTML = `<div class="card"><p class="err-text">${esc(e.message)}</p></div>`; return; }
  const assigneesByTodo = {};
  assignees.forEach((a) => { (assigneesByTodo[a.todo_id] ||= []).push(a.staff_id); });
  const namesOf = (id) => (assigneesByTodo[id] || []).map((sid) => L.staffById[sid]?.name).filter(Boolean).join('、') || '—';

  // 完成通知：我是建立者、對方已經標記完成但我還沒讀過的，列出來提醒（站內通知，
  // 沒有 email/簡訊管道，讀過之後按「知道了」清掉，對應 completed_ack_at）。
  const unacked = todos.filter((t) => t.created_by_staff_id === me.id && t.status === '已完成' && !t.completed_ack_at);

  const templates = todos.filter((t) => t.is_monthly);
  const canVisit = (t) => isDirector() || t.created_by_staff_id === me.id || (assigneesByTodo[t.id] || []).includes(me.id);
  // 管理者選了「檢視某位督導」時，viewerId 換成那位督導，四象限的分類基準跟著換；
  // 同時只留下「跟那個人有關」的（他建立的，或指派給他的），不然會看到一堆完全
  // 不相干的任務。
  const viewerId = todoState.viewStaffId || me.id;
  const viewingOther = Boolean(todoState.viewStaffId);
  const viewerName = viewingOther ? (L.staffById[viewerId]?.name || '未知') : null;
  const isAssignedToViewer = (t) => (assigneesByTodo[t.id] || []).includes(viewerId);
  // 分類基準改成「有沒有指派給檢視對象自己」，不是單純看「誰建立的」：自己建立、
  // 但指派對象裡也包含自己（或檢視對象自己）的任務，算「被指派」，不算「派出去」——
  // 這種情況代表這件事也是他自己要做的，不是單純丟給別人。只有「自己建立、指派
  // 名單裡完全沒有自己」才算純粹派出去的事項。
  const relevantToViewer = (t) => t.created_by_staff_id === viewerId || isAssignedToViewer(t);

  const renderRow = (t) => {
    const overdue = t.status === '待處理' && t.due_date && t.due_date < todayISO();
    return `<div class="card" style="margin-bottom:8px;padding:14px">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap">
        <div>
          <div>${t.is_urgent ? '<span style="color:var(--bad);font-weight:700">急</span> ' : ''}<strong>${esc(t.title)}</strong>${t.status === '已完成' ? ' <span class="small" style="color:var(--ok)">✓ 已完成</span>' : ''}</div>
          <div class="small muted" style="margin-top:2px">指派給：${esc(namesOf(t.id))}　建立：${esc(L.staffById[t.created_by_staff_id]?.name || '')}${t.due_date ? `　截止：${fmtDate(t.due_date)}${overdue ? ' <span style="color:var(--bad)">（已逾期）</span>' : ''}` : ''}</div>
          ${t.content ? `<div class="small" style="margin-top:6px;white-space:pre-wrap">${esc(t.content)}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          ${t.status === '待處理' ? `<button type="button" class="btn small" data-tcomplete="${t.id}">完成</button>` : `<button type="button" class="btn small" data-treopen="${t.id}">取消完成</button>`}
          ${(isDirector() || t.created_by_staff_id === me.id) ? `<button type="button" class="btn small" data-tedit="${t.id}">編輯</button><button type="button" class="btn small" style="color:var(--bad)" data-tdel="${t.id}">刪除</button>` : ''}
        </div>
      </div>
    </div>`;
  };

  const DONE_COLLAPSED_COUNT = 5;
  const drawTodoBody = () => {
    const q = todoState.q.trim().toLowerCase();
    // 搜尋關鍵字比對標題跟內容，沒有做分數排名，單純子字串比對，跟系統裡其他
    // 搜尋框（問案列表、個案清單等）同一套簡單風格，不用額外猜排序邏輯。
    const matchesQ = (t) => !q || t.title.toLowerCase().includes(q) || (t.content || '').toLowerCase().includes(q);
    const actionable = todos.filter((t) => !t.is_monthly && matchesQ(t));
    const quadrant = (assignedBucket, monthly) => actionable.filter((t) =>
      Boolean(t.source_template_id) === monthly && canVisit(t) && relevantToViewer(t)
      && (assignedBucket ? isAssignedToViewer(t) : (t.created_by_staff_id === viewerId && !isAssignedToViewer(t))));
    const quads = [
      ['monthly-assigned', `每月交辦（${viewingOther ? `${esc(viewerName)}被指派` : '被指派'}）`, quadrant(true, true)],
      ['monthly-out', `每月交辦（${viewingOther ? `${esc(viewerName)}指派出去` : '自己指派出去'}）`, quadrant(false, true)],
      ['adhoc-assigned', `臨時待辦（${viewingOther ? `${esc(viewerName)}被指派` : '被指派'}）`, quadrant(true, false)],
      ['adhoc-out', `臨時待辦（${viewingOther ? `${esc(viewerName)}指派出去` : '自己指派出去'}）`, quadrant(false, false)],
    ];

    box.innerHTML = `
    ${unacked.length ? `<div class="card" style="margin-bottom:16px;border-color:var(--ok)">
      <h2 style="margin:0 0 8px">完成通知（${unacked.length}）</h2>
      ${unacked.map((t) => `<div class="small" style="margin-bottom:6px">${esc(L.staffById[t.completed_by_staff_id]?.name || '（不明人員）')} 已完成你指派的「${esc(t.title)}」（${fmtTime(t.completed_at)}） <button type="button" class="link" data-tack="${t.id}">知道了</button></div>`).join('')}
    </div>` : ''}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      ${quads.map(([key, label, rows]) => {
        // 待處理跟已完成分開列，待處理永遠排前面，一眼就看得出還有什麼沒做完。
        // 已完成預設只顯示最近 5 筆（依完成時間新到舊排序），避免做完的事情越
        // 堆越多，把真正要看的待處理清單擠到畫面下面，有需要再展開看全部。
        const pending = rows.filter((t) => t.status === '待處理');
        const done = rows.filter((t) => t.status === '已完成').sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
        const expanded = Boolean(todoState.expandedDone[key]);
        const doneShown = expanded ? done : done.slice(0, DONE_COLLAPSED_COUNT);
        return `<div class="card">
        <h2 style="margin:0 0 10px">${label}（${rows.length}）</h2>
        <h3 class="small muted" style="margin:0 0 8px">待處理（${pending.length}）</h3>
        ${pending.length ? pending.map(renderRow).join('') : '<p class="muted small">目前沒有待處理的任務。</p>'}
        <h3 class="small muted" style="margin:16px 0 8px">已完成（${done.length}）</h3>
        ${doneShown.length ? doneShown.map(renderRow).join('') : '<p class="muted small">目前沒有已完成的任務。</p>'}
        ${done.length > DONE_COLLAPSED_COUNT ? `<button type="button" class="btn small" data-tdonetoggle="${key}">${expanded ? '收合' : `展開全部（${done.length}）`}</button>` : ''}
      </div>`;
      }).join('')}
    </div>
    <div class="card" style="margin-top:16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <h2 style="margin:0">每月範本設定（${templates.length}）</h2>
        <button type="button" class="btn small" id="todoTplToggle">${todoState.showTemplates ? '收合' : '展開'}</button>
      </div>
      ${todoState.showTemplates ? (templates.length ? templates.filter(canVisit).map((t) => `<div class="card" style="margin:10px 0 0">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div><strong>${esc(t.title)}</strong>${t.active ? '' : ' <span class="small muted">（已停用，不再產生新實例）</span>'}
            <div class="small muted">每月 ${t.monthly_day ? `${t.monthly_day} 號` : '月底'} 到期；指派給：${esc(namesOf(t.id))}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button type="button" class="btn small" data-tpltoggle="${t.id}">${t.active ? '停用' : '啟用'}</button>
            <button type="button" class="btn small" data-tedit="${t.id}">編輯</button>
            <button type="button" class="btn small" style="color:var(--bad)" data-tdel="${t.id}">刪除</button>
          </div>
        </div>
      </div>`).join('') : '<p class="muted small" style="margin:10px 0 0">還沒有設定每月範本。</p>') : ''}
    </div>`;

    $('#todoTplToggle')?.addEventListener('click', () => { todoState.showTemplates = !todoState.showTemplates; drawTodoBody(); });
    $$('[data-tdonetoggle]').forEach((b) => (b.onclick = () => { todoState.expandedDone[b.dataset.tdonetoggle] = !todoState.expandedDone[b.dataset.tdonetoggle]; drawTodoBody(); }));
    $$('[data-tack]').forEach((b) => (b.onclick = async () => {
      try { await db.update('todos', Number(b.dataset.tack), { completed_ack_at: new Date().toISOString() }); viewTodos(); }
      catch (e) { toast(e.message, true); }
    }));
    $$('[data-tcomplete]').forEach((b) => (b.onclick = async () => {
      try { await todoRpc('complete_todo', { p_todo_id: Number(b.dataset.tcomplete) }); toast('已標記完成'); refreshMyTodoCount(); viewTodos(); }
      catch (e) { toast(e.message, true); }
    }));
    $$('[data-treopen]').forEach((b) => (b.onclick = async () => {
      try { await todoRpc('reopen_todo', { p_todo_id: Number(b.dataset.treopen) }); toast('已重新開啟'); refreshMyTodoCount(); viewTodos(); }
      catch (e) { toast(e.message, true); }
    }));
    $$('[data-tpltoggle]').forEach((b) => (b.onclick = async () => {
      const t = templates.find((x) => x.id === Number(b.dataset.tpltoggle));
      try { await db.update('todos', t.id, { active: !t.active }); viewTodos(); } catch (e) { toast(e.message, true); }
    }));
    $$('[data-tedit]').forEach((b) => (b.onclick = () => {
      const t = todos.find((x) => x.id === Number(b.dataset.tedit));
      openTodoEditor(t, assigneesByTodo[t.id] || [], () => viewTodos());
    }));
    $$('[data-tdel]').forEach((b) => (b.onclick = async () => {
      if (!(await confirmBox('確定要刪除這筆待辦事項嗎？無法復原（如果是每月範本，之後也不會再自動產生新的）。', '刪除', true))) return;
      try { await db.remove('todos', Number(b.dataset.tdel)); toast('已刪除'); refreshMyTodoCount(); viewTodos(); } catch (e) { toast(e.message, true); }
    }));
  };
  // 中文注音/拼音輸入法組字期間先不重畫（不然選字選到一半畫面被打斷），等選字
  // 完成才重畫；重畫完後把焦點、游標位置還原回搜尋框，跟「問案」「個案清單」
  // 列表同一套處理方式。
  const todoQ = $('#todoQ');
  let todoQComposing = false;
  const scheduleTodoQDraw = () => {
    clearTimeout(drawTodoBody._t);
    drawTodoBody._t = setTimeout(() => {
      const cursor = todoQ.selectionStart;
      drawTodoBody();
      const i = $('#todoQ');
      if (i) { i.focus(); i.setSelectionRange(cursor, cursor); }
    }, 250);
  };
  todoQ.addEventListener('compositionstart', () => { todoQComposing = true; });
  todoQ.addEventListener('compositionend', () => { todoQComposing = false; todoState.q = todoQ.value; scheduleTodoQDraw(); });
  todoQ.oninput = (e) => {
    todoState.q = e.target.value;
    if (todoQComposing) return;
    scheduleTodoQDraw();
  };
  drawTodoBody();
}

function openTodoEditor(t, currentAssigneeIds, afterDone) {
  const isEdit = Boolean(t);
  t = t || { title: '', content: '', is_urgent: false, is_monthly: false, monthly_day: null, due_date: '' };
  // 指派對象：在職、非行政角色（行政只負責結案箱年度，不參與待辦事項）。
  const pool = L.staff.filter((s) => s.active && s.role !== 'clerk');
  modal(`<h2>${isEdit ? '編輯待辦事項' : '新增待辦事項'}</h2>
    <div class="stack">
      <label class="f">標題 <span class="req">*</span><input type="text" name="title" value="${esc(t.title)}"></label>
      <label class="f spanall">內容<textarea name="content" style="min-height:70px">${esc(t.content || '')}</textarea></label>
      <label class="inline-check"><input type="checkbox" name="is_urgent" ${t.is_urgent ? 'checked' : ''}>緊急事項（標題旁會顯示紅色「急」）</label>
      <label class="inline-check"><input type="checkbox" name="is_monthly" ${t.is_monthly ? 'checked' : ''}>每月交辦事項（每月自動產生一筆新任務，不用每月重新指定）</label>
      <label class="f" id="todo-due-wrap">截止日期<input type="date" name="due_date" value="${esc(t.due_date || '')}"></label>
      <label class="f" id="todo-monthly-wrap" hidden>每月第幾號到期<input type="number" name="monthly_day" min="1" max="31" value="${t.monthly_day || ''}" placeholder="留空＝每月最後一天"></label>
      <div class="f spanall">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span>指派對象</span>
          <span style="display:flex;gap:6px">
            <button type="button" class="btn small" data-selregion="新莊">全選新莊</button>
            <button type="button" class="btn small" data-selregion="淡水">全選淡水</button>
          </span>
        </div>
        <div class="checks" style="margin-top:6px">${pool.map((s) => `<label><input type="checkbox" class="todo-assignee" value="${s.id}" data-region="${esc(s.region || '')}" ${currentAssigneeIds.includes(s.id) ? 'checked' : ''}>${esc(s.name)}${s.region ? `（${esc(s.region)}）` : ''}</label>`).join('')}</div>
      </div>
      <p class="err-text" id="todoerr" hidden></p>
    </div>
    <div class="acts"><button type="button" class="btn" data-no>取消</button><button type="button" class="btn primary" data-yes>${isEdit ? '儲存' : '建立'}</button></div>`,
  (m, close) => {
    const syncDueMode = () => {
      const monthly = $('[name=is_monthly]', m).checked;
      $('#todo-due-wrap', m).hidden = monthly;
      $('#todo-monthly-wrap', m).hidden = !monthly;
    };
    $('[name=is_monthly]', m).onchange = syncDueMode; syncDueMode();
    $$('[data-selregion]', m).forEach((b) => (b.onclick = () => {
      $$('.todo-assignee', m).forEach((cb) => { if (cb.dataset.region === b.dataset.selregion) cb.checked = true; });
    }));
    $('[data-no]', m).onclick = close;
    $('[data-yes]', m).onclick = async () => {
      const er = $('#todoerr', m); er.hidden = true;
      const title = $('[name=title]', m).value.trim();
      const content = $('[name=content]', m).value.trim() || null;
      const is_urgent = $('[name=is_urgent]', m).checked;
      const is_monthly = $('[name=is_monthly]', m).checked;
      const monthly_day = is_monthly ? (Number($('[name=monthly_day]', m).value) || null) : null;
      const due_date = is_monthly ? null : ($('[name=due_date]', m).value || null);
      const assigneeIds = $$('.todo-assignee:checked', m).map((cb) => Number(cb.value));
      const miss = [];
      if (!title) miss.push('標題');
      if (!assigneeIds.length) miss.push('指派對象');
      if (miss.length) { er.textContent = `請填寫：${miss.join('、')}`; er.hidden = false; return; }
      const btn = $('[data-yes]', m); btn.disabled = true;
      try {
        let id;
        if (isEdit) {
          id = t.id;
          await db.update('todos', id, { title, content, is_urgent, is_monthly, monthly_day, due_date });
          await rest('DELETE', 'todo_assignees', { params: { todo_id: `eq.${id}` } });
        } else {
          const saved = await db.insert('todos', { title, content, is_urgent, is_monthly, monthly_day, due_date, created_by_staff_id: me.id });
          id = saved.id;
        }
        await db.insertMany('todo_assignees', assigneeIds.map((staff_id) => ({ todo_id: id, staff_id })));
        toast(isEdit ? '已儲存' : '已建立待辦事項');
        refreshMyTodoCount();
        close(); afterDone?.();
      } catch (e) { er.textContent = e.message; er.hidden = false; btn.disabled = false; }
    };
  });
}

/* ================= 居服員稽核 ================= */
// 紀錄每位居服員每年度的優良事項／改善事項（刻意不用「優/劣」這種評價字眼）。
// 督導只能編輯自己負責區域的居服員，管理者/主任不限區域；查看不限區域（跟
// 「問案」列表一樣，預設看自己的區域但可以切換看別區）。行政角色不開放使用。
// 見 sql/24_caregiver_audits.sql 的完整設計說明。
let cgAuditState = { region: null, q: '', showInactive: false, codeSort: 'asc' };
const canEditCgAudit = (cg) => isDirector() || (me.region && cg.region === me.region);

async function viewCaregiverAuditList() {
  if (cgAuditState.region === null) cgAuditState.region = me.region || '全部';
  const draw = () => {
    const q = cgAuditState.q.trim().toLowerCase();
    const dir = cgAuditState.codeSort === 'asc' ? 1 : -1;
    const rows = L.cg.filter((c) => (cgAuditState.region === '全部' || c.region === cgAuditState.region)
      && (cgAuditState.showInactive || c.active)
      && (!q || c.name.toLowerCase().includes(q) || (c.code || '').toLowerCase().includes(q)))
      // 照員編排序，點表頭可以切換遞增/遞減（不受 L.cg 原本的載入順序影響）。
      .sort((a, b) => dir * (a.code || '').localeCompare(b.code || '', undefined, { numeric: true }));
    const sortIcon = cgAuditState.codeSort === 'asc' ? '▲' : '▼';
    // 「新增紀錄」開放在列表頁直接點，不用先點進某個人的頁面——選單裡只列出
    // 自己有權限編輯的居服員（跟點進個人頁面後能不能新增的權限判斷一致），
    // 離職的也列進去（可能是要補記離職前的事項），不受上面「顯示離職」篩選器影響。
    const editableCgs = L.cg.filter(canEditCgAudit);
    $('#main').innerHTML = `
    <div class="head"><div><h1>居服員稽核</h1><div class="muted small" style="margin-top:4px">紀錄每位居服員每年度的優良事項／改善事項，督導只能編輯自己負責區域的居服員。</div></div>
      <div class="right">${editableCgs.length ? '<button type="button" class="btn primary" id="cgaListNew">＋ 新增紀錄</button>' : ''}</div></div>
    <div class="card filters">
      <div class="seg" role="group" aria-label="區域">${['全部', ...REGIONS].map((r) => `<button type="button" data-region="${r}" class="${cgAuditState.region === r ? 'on' : ''}">${r}</button>`).join('')}</div>
      <label class="inline-check"><input type="checkbox" id="cgaShowInactive" ${cgAuditState.showInactive ? 'checked' : ''}>顯示離職</label>
      <input type="search" class="grow" id="cgaQ" placeholder="搜尋居服員姓名、編號" value="${esc(cgAuditState.q)}" aria-label="搜尋">
    </div>
    <div class="tbox"><table class="t">
      <thead><tr><th id="th-cgacode" style="cursor:pointer;user-select:none" title="點擊排序">編號 <span class="small muted">${sortIcon}</span></th><th>姓名</th><th>區域</th><th>狀態</th><th></th></tr></thead>
      <tbody>${rows.map((c) => `<tr class="click" data-id="${c.id}">
        <td class="nowrap">${esc(c.code || '')}</td>
        <td>${esc(c.name)}</td>
        <td>${esc(c.region || '')}</td>
        <td>${c.active ? '在職' : '<span class="muted small">離職</span>'}</td>
        <td class="small muted">${canEditCgAudit(c) ? '' : '唯讀（非本區）'}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">沒有符合條件的居服員</td></tr>'}</tbody>
    </table></div>`;
    $$('[data-region]').forEach((b) => (b.onclick = () => { cgAuditState.region = b.dataset.region; draw(); }));
    $('#cgaShowInactive').onchange = (e) => { cgAuditState.showInactive = e.target.checked; draw(); };
    $('#cgaQ').oninput = (e) => { cgAuditState.q = e.target.value; draw(); };
    $('#th-cgacode').onclick = () => { cgAuditState.codeSort = cgAuditState.codeSort === 'asc' ? 'desc' : 'asc'; draw(); };
    $$('tr.click').forEach((tr) => (tr.onclick = () => { location.hash = `#/cgaudit/${tr.dataset.id}`; }));
    $('#cgaListNew')?.addEventListener('click', () => openCgAuditPicker(editableCgs));
  };
  draw();
}

// 列表頁的「新增紀錄」：先選居服員（文字輸入＋自動比對，跟媒合紀錄的居服員
// 欄位同一套模式），選定後開啟跟個人頁面一樣的 openCgAuditEditor()，新增完
// 直接導到那個人的頁面，方便接著看結果或繼續新增下一筆。
function openCgAuditPicker(editableCgs) {
  const cgLabel = (c) => `${c.code ? `${c.code} ` : ''}${c.name}${c.region ? `（${c.region}）` : ''}${c.active ? '' : '　離職'}`;
  modal(`<h2>新增紀錄：選擇居服員</h2>
    <div class="stack">
      <label class="f">居服員 <span class="req">*</span><input type="text" name="cg_name" list="cga-picklist" autocomplete="off" placeholder="輸入姓名或員編搜尋">
        <datalist id="cga-picklist">${editableCgs.map((c) => `<option value="${esc(cgLabel(c))}">`).join('')}</datalist></label>
      <p class="err-text" id="cgaperr" hidden></p>
    </div>
    <div class="acts"><button type="button" class="btn" data-no>取消</button><button type="button" class="btn primary" data-yes>下一步</button></div>`,
  (m, close) => {
    $('[data-no]', m).onclick = close;
    $('[data-yes]', m).onclick = () => {
      const byLabel = new Map(editableCgs.map((c) => [cgLabel(c), c]));
      const cg = byLabel.get($('[name=cg_name]', m).value.trim());
      const er = $('#cgaperr', m);
      if (!cg) { er.textContent = '請從建議選單選擇一位居服員'; er.hidden = false; return; }
      close();
      openCgAuditEditor(cg, null, () => { location.hash = `#/cgaudit/${cg.id}`; });
    };
  });
}

async function viewCaregiverAuditDetail(cgId) {
  const cg = L.cgById[cgId];
  if (!cg) { $('#main').innerHTML = '<div class="card empty">找不到這位居服員。</div>'; return; }
  const editable = canEditCgAudit(cg);
  $('#main').innerHTML = `
  <a href="#/cgaudit" class="small" style="text-decoration:none">← 回居服員稽核列表</a>
  <div class="head" style="margin-top:10px"><div><h1>${esc(cg.name)}</h1><div class="muted small" style="margin-top:4px">${esc(cg.code || '')}　${esc(cg.region || '')}${editable ? '' : '　<span style="color:var(--warn)">非本區，唯讀</span>'}</div></div>
    <div class="right">${editable ? '<button type="button" class="btn primary" id="cgaNew">＋ 新增紀錄</button>' : ''}</div></div>
  <div id="cga-body"><p class="muted">載入中…</p></div>`;
  $('#cgaNew')?.addEventListener('click', () => openCgAuditEditor(cg, null, () => viewCaregiverAuditDetail(cgId)));
  const box = $('#cga-body');
  let rows;
  try { rows = await db.all('caregiver_audits', { caregiver_id: `eq.${cgId}`, order: 'roc_year.desc,event_date.desc.nullslast' }); }
  catch (e) { box.innerHTML = `<div class="card"><p class="err-text">${esc(e.message)}</p></div>`; return; }
  if (!rows.length) { box.innerHTML = '<div class="card empty">還沒有任何紀錄。</div>'; return; }
  const byYear = {};
  rows.forEach((r) => { (byYear[r.roc_year] ||= []).push(r); });
  const years = Object.keys(byYear).map(Number).sort((a, b) => b - a);
  const renderEntry = (r) => `<div class="card" style="margin-bottom:8px;padding:14px">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap">
      <div>
        <strong>${esc(r.title)}</strong>
        <div class="small muted" style="margin-top:2px">${r.event_date ? `事件日期：${fmtDate(r.event_date)}　` : ''}記錄：${esc(L.staffById[r.created_by_staff_id]?.name || '')}　${fmtTime(r.created_at)}</div>
        ${r.content ? `<div class="small" style="margin-top:6px;white-space:pre-wrap">${esc(r.content)}</div>` : ''}
      </div>
      ${editable ? `<div style="display:flex;gap:6px;flex-shrink:0"><button type="button" class="btn small" data-cgaedit="${r.id}">編輯</button><button type="button" class="btn small" style="color:var(--bad)" data-cgadel="${r.id}">刪除</button></div>` : ''}
    </div>
  </div>`;
  box.innerHTML = years.map((y) => {
    const good = byYear[y].filter((r) => r.category === '優良事項');
    const bad = byYear[y].filter((r) => r.category === '改善事項');
    return `<div class="card" style="margin-bottom:16px">
      <h2 style="margin:0 0 10px">${y} 年</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div><h3 class="small muted" style="margin:0 0 8px">優良事項（${good.length}）</h3>${good.length ? good.map(renderEntry).join('') : '<p class="muted small">無紀錄。</p>'}</div>
        <div><h3 class="small muted" style="margin:0 0 8px">改善事項（${bad.length}）</h3>${bad.length ? bad.map(renderEntry).join('') : '<p class="muted small">無紀錄。</p>'}</div>
      </div>
    </div>`;
  }).join('');
  $$('[data-cgaedit]').forEach((b) => (b.onclick = () => {
    const r = rows.find((x) => x.id === Number(b.dataset.cgaedit));
    openCgAuditEditor(cg, r, () => viewCaregiverAuditDetail(cgId));
  }));
  $$('[data-cgadel]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('確定要刪除這筆紀錄嗎？無法復原。', '刪除', true))) return;
    try { await db.remove('caregiver_audits', Number(b.dataset.cgadel)); toast('已刪除'); viewCaregiverAuditDetail(cgId); }
    catch (e) { toast(e.message, true); }
  }));
}

function openCgAuditEditor(cg, r, afterDone) {
  const isEdit = Boolean(r);
  r = r || { roc_year: new Date().getFullYear() - 1911, category: '優良事項', title: '', content: '', event_date: '' };
  const thisRocYear = new Date().getFullYear() - 1911;
  const years = []; for (let y = thisRocYear + 1; y >= 114; y--) years.push(y);
  modal(`<h2>${isEdit ? '編輯紀錄' : '新增紀錄'}：${esc(cg.name)}</h2>
    <div class="stack">
      <div class="grid3">
        <label class="f">年度 <span class="req">*</span><select name="roc_year">${years.map((y) => opt(y, `${y} 年`, r.roc_year)).join('')}</select></label>
        <label class="f">類別 <span class="req">*</span><select name="category">${opt('優良事項', '優良事項', r.category)}${opt('改善事項', '改善事項', r.category)}</select></label>
        <label class="f">事件日期<input type="date" name="event_date" value="${esc(r.event_date || '')}"></label>
      </div>
      <label class="f spanall">標題 <span class="req">*</span><input type="text" name="title" value="${esc(r.title)}"></label>
      <label class="f spanall">內容說明<textarea name="content" style="min-height:80px">${esc(r.content || '')}</textarea></label>
      <p class="err-text" id="cgaerr" hidden></p>
    </div>
    <div class="acts"><button type="button" class="btn" data-no>取消</button><button type="button" class="btn primary" data-yes>${isEdit ? '儲存' : '建立'}</button></div>`,
  (m, close) => {
    $('[data-no]', m).onclick = close;
    $('[data-yes]', m).onclick = async () => {
      const er = $('#cgaerr', m); er.hidden = true;
      const title = $('[name=title]', m).value.trim();
      if (!title) { er.textContent = '請填寫：標題'; er.hidden = false; return; }
      const body = {
        roc_year: Number($('[name=roc_year]', m).value),
        category: $('[name=category]', m).value,
        title,
        content: $('[name=content]', m).value.trim() || null,
        event_date: $('[name=event_date]', m).value || null,
      };
      const btn = $('[data-yes]', m); btn.disabled = true;
      try {
        if (isEdit) await db.update('caregiver_audits', r.id, body);
        else await db.insert('caregiver_audits', { ...body, caregiver_id: cg.id, created_by_staff_id: me.id });
        toast(isEdit ? '已儲存' : '已建立');
        close(); afterDone?.();
      } catch (e) { er.textContent = e.message; er.hidden = false; btn.disabled = false; }
    };
  });
}

/* ================= 個督檢核 ================= */
// 取代原本單機作業的「個督檢核表.html」，排程演算法（新制/舊制、逐次個督的
// 應辦區間）直接照搬那份工具的邏輯，只是輸入來源換成資料庫（caregivers 的
// 到職日/離職日 + caregiver_supervisions 的個督完成紀錄），不是 localStorage。
//
// ROC（民國）月份用「總月數」（年*12+月）表示方便算區間，跟家電訪稽核的
// monthNum() 是同樣的手法。
const rocTotalMonth = (iso) => { if (!iso) return null; const y = rocYear(iso); const m = Number(iso.slice(5, 7)); return y * 12 + m; };
const rocMonthKeyOf = (total) => { const y = Math.floor((total - 1) / 12); const m = total - y * 12; return `${y}/${String(m).padStart(2, '0')}`; };
const CG_SUP_NEW_RULE_FROM = 115 * 12 + 6; // 115年6月起到職適用新制
const isCgSupNewRule = (hireTotal) => hireTotal >= CG_SUP_NEW_RULE_FROM;

// 舊制：到職後 1、2、3 個月各一次，接著第 6 個月一次，之後每半年一次。
// 新制：到職後次月一次，之後每半年一次。
function cgSupIntervals(isNew) {
  return Array.from({ length: 50 }, (_, i) => (isNew ? (i === 0 ? 1 : 6) : (i === 0 ? 1 : i === 1 ? 1 : i === 2 ? 1 : i === 3 ? 3 : 6)));
}

// doneRows：這個人全部的 caregiver_supervisions 紀錄（含紙本勾稽狀態）。
function evaluateCgSupervisions(cg, doneRows) {
  const hireTotal = rocTotalMonth(cg.hire_date);
  if (!hireTotal) return { slots: [], extraDone: [], hireTotal: null };
  const isNew = isCgSupNewRule(hireTotal);
  const intervals = cgSupIntervals(isNew);

  const doneByMonth = new Map();
  for (const r of doneRows) doneByMonth.set(r.roc_year * 12 + r.roc_month, r);
  const doneMos = [...doneByMonth.keys()].sort((a, b) => a - b);

  const todayIso = todayISO();
  const nowTotal = rocYear(todayIso) * 12 + Number(todayIso.slice(5, 7));
  const resignTotal = rocTotalMonth(cg.resign_date);
  const effNowTotal = resignTotal ? Math.min(nowTotal, resignTotal) : nowTotal;
  const limitTotal = resignTotal || effNowTotal + 12; // 沒離職的話，最多預先列到一年後

  const slots = [];
  const usedDone = new Set();
  let prevTotal = hireTotal;
  for (let i = 0; i < intervals.length; i++) {
    const dueBy = prevTotal + intervals[i];
    if (dueBy > limitTotal) break;
    let found = null;
    for (const mo of doneMos) { if (!usedDone.has(mo) && mo > prevTotal && mo <= dueBy) { found = mo; usedDone.add(mo); break; } }
    const pastDue = dueBy <= effNowTotal;
    slots.push({
      seq: i + 1, dueByTotal: dueBy, windowStartTotal: prevTotal + 1,
      doneTotal: found, doneRow: found ? doneByMonth.get(found) : null,
      done: Boolean(found), overdue: pastDue && !found, dueThisMonth: dueBy === effNowTotal && !found,
      future: dueBy > effNowTotal,
    });
    prevTotal = found || dueBy;
    if (prevTotal > limitTotal) break;
  }
  const extraDone = doneMos.filter((mo) => !usedDone.has(mo)).map((mo) => doneByMonth.get(mo));
  return { slots, extraDone, hireTotal, isNew };
}

function cgSupStats(cg, doneRows) {
  const { slots } = evaluateCgSupervisions(cg, doneRows);
  let total = 0, completed = 0, overdue = 0, dueNow = 0;
  for (const s of slots) { if (s.future) continue; total++; if (s.done) completed++; else if (s.overdue) overdue++; else if (s.dueThisMonth) dueNow++; }
  const lastDone = [...doneRows].sort((a, b) => (b.roc_year * 12 + b.roc_month) - (a.roc_year * 12 + a.roc_month))[0] || null;
  const paperDue = doneRows.filter((r) => !r.paper_submitted).length;
  return { total, completed, overdue, dueNow, ok: overdue === 0, lastDone, paperDue };
}

let cgSupState = { region: null, status: 'all', supervisor: '全部', onlyPaperDue: false, showResigned: false, q: '' };
const canRecordCgSup = (cg) => canEditCgAudit(cg);
const canCheckCgSupPaper = () => hasPerm('cg_supervision_paper_check');

async function viewCgSupervisionList() {
  if (cgSupState.region === null) cgSupState.region = me.region || '全部';
  $('#main').innerHTML = '<p class="muted">載入中…</p>';
  let allSup;
  try { allSup = await db.all('caregiver_supervisions', {}); }
  catch (e) { $('#main').innerHTML = `<div class="card"><p class="err-text">${esc(e.message)}</p></div>`; return; }
  const byCg = new Map();
  for (const r of allSup) { if (!byCg.has(r.caregiver_id)) byCg.set(r.caregiver_id, []); byCg.get(r.caregiver_id).push(r); }

  const draw = () => {
    const q = cgSupState.q.trim().toLowerCase();
    const rows = L.cg.filter((c) => (cgSupState.region === '全部' || c.region === cgSupState.region)
      && (cgSupState.showResigned || !c.resign_date)
      && (cgSupState.supervisor === '全部' || L.staffById[c.lead_supervisor_staff_id]?.name === cgSupState.supervisor)
      && (!q || c.name.toLowerCase().includes(q) || (c.code || '').toLowerCase().includes(q)))
      .map((c) => ({ c, stats: cgSupStats(c, byCg.get(c.id) || []) }))
      .filter(({ stats }) => {
        if (cgSupState.onlyPaperDue && stats.paperDue === 0) return false;
        if (cgSupState.status === 'overdue') return stats.overdue > 0;
        if (cgSupState.status === 'due') return stats.dueNow > 0;
        if (cgSupState.status === 'ok') return stats.ok;
        return true;
      });

    const allRows = L.cg.filter((c) => !c.resign_date).map((c) => cgSupStats(c, byCg.get(c.id) || []));
    const totalPaperDue = allRows.reduce((s, x) => s + x.paperDue, 0);
    const supervisors = [...new Set(L.cg.map((c) => L.staffById[c.lead_supervisor_staff_id]?.name).filter(Boolean))].sort();

    $('#main').innerHTML = `
    <div class="head"><div><h1>個督檢核</h1><div class="muted small" style="margin-top:4px">追蹤每位居服員的個別督導辦理狀況，督導只能記錄自己負責區域的居服員。</div></div></div>
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;flex-wrap:wrap;gap:16px 40px">
        <div><div class="small muted">居服員人數</div><div style="font-size:26px;font-weight:700">${allRows.length}</div></div>
        <div><div class="small muted">符合規定</div><div style="font-size:26px;font-weight:700;color:var(--ok)">${allRows.filter((x) => x.ok).length}</div></div>
        <div><div class="small muted">有逾期未辦</div><div style="font-size:26px;font-weight:700;color:var(--bad)">${allRows.filter((x) => x.overdue > 0).length}</div></div>
        <div><div class="small muted">本月應辦</div><div style="font-size:26px;font-weight:700;color:var(--warn)">${allRows.filter((x) => x.dueNow > 0).length}</div></div>
        <div><div class="small muted">紙本未繳</div><div style="font-size:26px;font-weight:700;color:var(--bad)">${totalPaperDue}</div></div>
      </div>
    </div>
    <div class="card filters">
      <div class="seg" role="group" aria-label="區域">${['全部', ...REGIONS].map((r) => `<button type="button" data-cgsregion="${r}" class="${cgSupState.region === r ? 'on' : ''}">${r}</button>`).join('')}</div>
      <div class="pills">
        ${[['all', '全部'], ['overdue', '⚠ 有逾期'], ['due', '📅 本月應辦'], ['ok', '✓ 符合規定']].map(([k, l]) => `<button type="button" data-cgsstatus="${k}" class="${cgSupState.status === k ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <select id="cgsSupSel"><option value="全部">全部主責居督</option>${supervisors.map((s) => opt(s, s, cgSupState.supervisor)).join('')}</select>
      <label class="inline-check"><input type="checkbox" id="cgsShowResigned" ${cgSupState.showResigned ? 'checked' : ''}>顯示離職</label>
      <label class="inline-check"><input type="checkbox" id="cgsPaperDue" ${cgSupState.onlyPaperDue ? 'checked' : ''}>只顯示紙本未繳${totalPaperDue ? ` <span class="st" style="background:var(--bad-bg);color:var(--bad)">${totalPaperDue}</span>` : ''}</label>
      <input type="search" class="grow" id="cgsQ" placeholder="搜尋姓名、員編" value="${esc(cgSupState.q)}">
    </div>
    <div class="muted small" style="margin-bottom:8px">共 ${rows.length} 筆</div>
    <div class="tbox"><table class="t roster">
      <thead><tr><th>員編</th><th>姓名</th><th>區域</th><th>主責居督</th><th>到職日</th><th>狀態</th><th>已完成/應辦</th><th>最近一次個督</th><th>紙本未繳</th></tr></thead>
      <tbody>${rows.map(({ c, stats }) => {
        const badge = !c.hire_date ? '<span class="faint small">尚未設定到職日</span>'
          : stats.overdue > 0 ? `<span class="st r-拒絕">⚠ 逾期 ${stats.overdue} 次</span>`
          : stats.dueNow > 0 ? '<span class="st s-問案中">📅 本月應辦</span>'
          : '<span class="st s-成案">✓ 符合規定</span>';
        return `<tr class="click" data-id="${c.id}">
          <td class="nowrap">${esc(c.code || '')}</td><td>${esc(c.name)}</td><td>${esc(c.region || '')}</td>
          <td>${esc(L.staffById[c.lead_supervisor_staff_id]?.name || '')}</td>
          <td class="nowrap">${c.hire_date ? fmtDate(c.hire_date) : '<span class="faint">未設定</span>'}</td>
          <td>${c.resign_date ? '<span class="st" style="background:#ECEDEB;color:#4A524F">🚪 已離職</span>' : badge}</td>
          <td class="num">${stats.completed}／${stats.total}</td>
          <td class="nowrap">${stats.lastDone ? `${stats.lastDone.roc_year}/${String(stats.lastDone.roc_month).padStart(2, '0')}` : '<span class="faint">尚無紀錄</span>'}</td>
          <td class="num">${stats.paperDue ? `<span class="st" style="background:var(--bad-bg);color:var(--bad)">${stats.paperDue} 筆</span>` : '—'}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="9" class="empty">沒有符合條件的居服員</td></tr>'}</tbody>
    </table></div>`;

    $$('[data-cgsregion]').forEach((b) => (b.onclick = () => { cgSupState.region = b.dataset.cgsregion; draw(); }));
    $$('[data-cgsstatus]').forEach((b) => (b.onclick = () => { cgSupState.status = b.dataset.cgsstatus; draw(); }));
    $('#cgsSupSel').onchange = (e) => { cgSupState.supervisor = e.target.value; draw(); };
    $('#cgsShowResigned').onchange = (e) => { cgSupState.showResigned = e.target.checked; draw(); };
    $('#cgsPaperDue').onchange = (e) => { cgSupState.onlyPaperDue = e.target.checked; draw(); };
    $('#cgsQ').oninput = (e) => { cgSupState.q = e.target.value; draw(); };
    $$('tr.click').forEach((tr) => (tr.onclick = () => { location.hash = `#/cgsup/${tr.dataset.id}`; }));
  };
  draw();
}

async function viewCgSupervisionDetail(cgId) {
  const cg = L.cgById[cgId];
  if (!cg) { $('#main').innerHTML = '<div class="card empty">找不到這位居服員。</div>'; return; }
  const canRecord = canRecordCgSup(cg);
  const canPaper = canCheckCgSupPaper();
  $('#main').innerHTML = `
  <a href="#/cgsup" class="small" style="text-decoration:none">← 回個督檢核列表</a>
  <div class="head" style="margin-top:10px"><div><h1>${esc(cg.name)}</h1><div class="muted small" style="margin-top:4px">${esc(cg.code || '')}　${esc(cg.region || '')}　主責居督：${esc(L.staffById[cg.lead_supervisor_staff_id]?.name || '—')}　到職：${cg.hire_date ? fmtDate(cg.hire_date) : '未設定'}${cg.resign_date ? `　<span style="color:var(--warn)">離職：${fmtDate(cg.resign_date)}</span>` : ''}${canRecord ? '' : '　<span style="color:var(--warn)">非本區，唯讀</span>'}</div></div>
    <div class="right">${canRecord ? '<button type="button" class="btn primary" id="cgsNew">＋ 記錄個督</button>' : ''}</div></div>
  <div id="cgs-body"><p class="muted">載入中…</p></div>`;
  const box = $('#cgs-body');
  if (!cg.hire_date) { box.innerHTML = '<div class="card empty">這位居服員還沒有設定到職日，無法計算個督排程。請到「管理 → 居服員」設定。</div>'; if (canRecord) $('#cgsNew').disabled = true; return; }
  let rows;
  try { rows = await db.all('caregiver_supervisions', { caregiver_id: `eq.${cgId}`, order: 'roc_year.desc,roc_month.desc' }); }
  catch (e) { box.innerHTML = `<div class="card"><p class="err-text">${esc(e.message)}</p></div>`; return; }

  const refresh = () => viewCgSupervisionDetail(cgId);
  $('#cgsNew')?.addEventListener('click', () => openCgSupRecordModal(cg, null, refresh));

  const { slots, extraDone } = evaluateCgSupervisions(cg, rows);
  const paperChip = (r) => r.paper_submitted
    ? `<span class="tag" style="background:var(--ok-bg);color:var(--ok)">紙本已繳交</span>`
    : canPaper
      ? `<button type="button" class="btn small" data-cgspaper="${r.id}">標記紙本已繳</button>`
      : `<span class="tag" style="background:var(--warn-bg);color:var(--warn)">紙本未繳</span>`;
  const slotHtml = slots.map((s) => {
    let cls, result, action;
    if (s.done) {
      cls = 'done'; result = `✓ 已於 ${rocMonthKeyOf(s.doneTotal)} 辦理`;
      action = paperChip(s.doneRow);
    } else if (s.overdue) {
      cls = 'overdue'; result = '⚠ 逾期未辦';
      action = canRecord ? `<button type="button" class="btn small danger" data-cgsrecord="${s.dueByTotal}">記錄個督</button>` : '';
    } else if (s.dueThisMonth) {
      cls = 'due'; result = '📅 本月應辦';
      action = canRecord ? `<button type="button" class="btn small" data-cgsrecord="${s.dueByTotal}">記錄個督</button>` : '';
    } else {
      cls = 'future'; result = `應於 ${rocMonthKeyOf(s.dueByTotal)} 前辦理`;
      action = '<button type="button" class="btn small" disabled>未到期</button>';
    }
    return `<div class="slot-row ${cls}" style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:8px;margin-bottom:6px;flex-wrap:wrap;background:${cls === 'done' ? 'var(--ok-bg)' : cls === 'overdue' ? 'var(--bad-bg)' : cls === 'due' ? 'var(--warn-bg)' : 'var(--chip)'}">
      <span style="font-weight:600;min-width:56px">第 ${s.seq} 次</span>
      <span class="muted" style="min-width:150px">應於 ${rocMonthKeyOf(s.dueByTotal)} 前</span>
      <span style="flex:1;font-weight:500">${result}</span>
      ${action}
    </div>`;
  }).join('');

  box.innerHTML = `
  <div class="card"><h2 style="margin:0 0 12px">個督時間軸</h2>
    ${slots.length ? slotHtml : '<p class="muted small">目前無應辦個督。</p>'}
  </div>
  ${extraDone.length ? `<div class="card" style="margin-top:16px"><h2 style="margin:0 0 10px">不定期個督</h2>
    ${extraDone.map((r) => `<div class="chip" style="margin-bottom:6px">${r.roc_year}/${String(r.roc_month).padStart(2, '0')}${r.paper_submitted ? '' : '　<span style="color:var(--warn)">紙本未繳</span>'}</div>`).join('')}
  </div>` : ''}`;

  $$('[data-cgsrecord]').forEach((b) => (b.onclick = () => {
    const total = Number(b.dataset.cgsrecord);
    const y = Math.floor((total - 1) / 12), m = total - y * 12;
    openCgSupRecordModal(cg, { roc_year: y, roc_month: m }, refresh);
  }));
  $$('[data-cgspaper]').forEach((b) => (b.onclick = async () => {
    try { await db.update('caregiver_supervisions', Number(b.dataset.cgspaper), { paper_submitted: true, paper_submitted_at: new Date().toISOString(), paper_submitted_by_staff_id: me.id }); toast('已標記紙本已繳交'); refresh(); }
    catch (e) { toast(e.message, true); }
  }));
}

function openCgSupRecordModal(cg, prefill, afterDone) {
  const thisRocYear = new Date().getFullYear() - 1911;
  const y0 = prefill?.roc_year || thisRocYear, m0 = prefill?.roc_month || (new Date().getMonth() + 1);
  modal(`<h2>記錄個督：${esc(cg.name)}</h2>
    <div class="stack">
      <div class="grid2">
        <label class="f">完成年度 <span class="req">*</span><input type="number" name="roc_year" value="${y0}" min="100" max="150"></label>
        <label class="f">完成月份 <span class="req">*</span><input type="number" name="roc_month" value="${m0}" min="1" max="12"></label>
      </div>
      <label class="f spanall">備註<textarea name="note" style="min-height:70px"></textarea></label>
      ${canCheckCgSupPaper() ? '<label class="inline-check"><input type="checkbox" name="paper_submitted">紙本已繳交</label>' : ''}
      <p class="err-text" id="cgsmerr" hidden></p>
    </div>
    <div class="acts"><button type="button" class="btn" data-no>取消</button><button type="button" class="btn primary" data-yes>記錄</button></div>`,
  (m, close) => {
    $('[data-no]', m).onclick = close;
    $('[data-yes]', m).onclick = async () => {
      const er = $('#cgsmerr', m); er.hidden = true;
      const roc_year = Number($('[name=roc_year]', m).value), roc_month = Number($('[name=roc_month]', m).value);
      if (!roc_year || roc_year < 100 || roc_year > 150) { er.textContent = '請填寫正確的民國年份'; er.hidden = false; return; }
      if (!roc_month || roc_month < 1 || roc_month > 12) { er.textContent = '請填寫正確的月份（1–12）'; er.hidden = false; return; }
      const paperChecked = $('[name=paper_submitted]', m)?.checked;
      const body = {
        caregiver_id: cg.id, roc_year, roc_month, note: $('[name=note]', m).value.trim() || null,
        created_by_staff_id: me.id,
        ...(paperChecked ? { paper_submitted: true, paper_submitted_at: new Date().toISOString(), paper_submitted_by_staff_id: me.id } : {}),
      };
      const btn = $('[data-yes]', m); btn.disabled = true;
      try {
        await db.insert('caregiver_supervisions', body);
        toast('已記錄個督'); close(); afterDone?.();
      } catch (e) { er.textContent = /duplicate|unique/.test(e.message) ? '這個月份已經有個督紀錄了' : e.message; er.hidden = false; btn.disabled = false; }
    };
  });
}

/* ================= 啟動 ================= */
$('#btn-logout').onclick = signOut;
$('#btn-pw').onclick = changePassword;
render();
