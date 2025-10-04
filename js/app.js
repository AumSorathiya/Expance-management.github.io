'use strict';
// Expense Management System - Vanilla JS + LocalStorage
// All features in a single modular script: auth, users, expenses, approvals, rules, APIs, and UI.

(function () {
  // ==========================
  // DOM Helpers
  // ==========================
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const on = (el, ev, fn) => el.addEventListener(ev, fn);

  // ==========================
  // Constants & Storage Keys
  // ==========================
  const KEYS = {
    users: 'ems_users',
    company: 'ems_company',
    session: 'ems_session',
    expenses: 'ems_expenses',
    rules: 'ems_rules',
    roles: 'ems_roles',
    countries: 'ems_countries_cache',
    rates: 'ems_rates_cache_v1', // map by base
    seeded: 'ems_seeded_v1',
  };

  const ROLES = {
    EMPLOYEE: 'EMPLOYEE',
    MANAGER: 'MANAGER',
    FINANCE: 'FINANCE',
    DIRECTOR: 'DIRECTOR',
    ADMIN: 'ADMIN',
    CFO: 'CFO', // special approver
  };

  // Built-in roles are fixed; custom roles can be added by Admin and are stored separately
  const BASE_ROLES = [ROLES.EMPLOYEE, ROLES.MANAGER, ROLES.FINANCE, ROLES.DIRECTOR, ROLES.ADMIN, ROLES.CFO];

  function getCustomRoles() { return Storage.get(KEYS.roles, []); }
  function setCustomRoles(list) { Storage.set(KEYS.roles, Array.from(new Set(list))); }
  function getAllRoles() { return Array.from(new Set([...BASE_ROLES, ...getCustomRoles()])); }

  const DEFAULT_RULES = {
    steps: [ROLES.MANAGER, ROLES.FINANCE, ROLES.DIRECTOR],
    percentageRule: { enabled: true, threshold: 50 },
    specificApproverRule: { enabled: true, role: ROLES.CFO },
    hybrid: { enabled: true },
  };

  const CATEGORIES = ['Travel', 'Meals', 'Supplies', 'Software', 'Other'];

  // ==========================
  // Utilities
  // ==========================
  const Storage = {
    get(key, fallback) {
      try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : (fallback ?? null); } catch { return fallback ?? null; }
    },
    set(key, val) { localStorage.setItem(key, JSON.stringify(val)); },
    remove(key) { localStorage.removeItem(key); }
  };

  const uuid = () => (crypto?.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now());
  const nowIso = () => new Date().toISOString();
  const fmtDate = (iso) => new Date(iso).toLocaleDateString();
  const fmtDateTime = (iso) => new Date(iso).toLocaleString();
  const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

  function moneyFmt(amount, ccy) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy }).format(amount); } catch { return `${ccy} ${(+amount).toFixed(2)}`; }
  }

  // Realtime cross-device session sync via Firebase
  function bindRealtimeSessionSync(){
    try{
      if(!(window.FirebaseSync && FirebaseSync.init())) return;
      const comp = getCompany();
      const compId = comp?.id || (window.FIREBASE_CONFIG?.projectId);
      if(!compId) return;
      FirebaseSync.subscribeSession(compId, (s)=>{
        const cur = currentUser();
        if(s && s.userId){
          if(!cur || cur.id !== s.userId){
            let u = getUsers().find(x=>x.id===s.userId);
            if(!u && s.user){
              const list = getUsers();
              list.push({ id: s.user.id, name: s.user.name||'User', email: s.user.email||'', roles: s.user.roles||[], managerId:'', passwordHash:'', createdAt: nowIso() });
              setUsers(list);
              u = list.find(x=>x.id===s.userId);
            }
            if(u){
              setSession({ userId: u.id, at: s.at || nowIso() });
              enterApp(u);
            }
          }
        }else{
          if(cur){ clearSession(); location.reload(); }
        }
      });
    }catch{}
  }

  // Toasts
  function toast(msg, type = 'info', timeout = 2600) {
    const wrap = $('#toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : type === 'error' ? 'fa-circle-xmark' : 'fa-circle-info'}"></i><span>${msg}</span>`;
    wrap.appendChild(el);
    setTimeout(() => { el.remove(); }, timeout);
  }

  // Modals
  function openModal(id) { $('#modal-backdrop').classList.remove('hidden'); $('#' + id).classList.remove('hidden'); }
  function closeModal(id) { $('#modal-backdrop').classList.add('hidden'); $('#' + id).classList.add('hidden'); }
  $$('#app .modal .modal-close').forEach(btn => on(btn, 'click', (e) => closeModal(e.currentTarget.dataset.close)));
  on($('#modal-backdrop'), 'click', () => { $$('#app .modal').forEach(m => m.classList.add('hidden')); $('#modal-backdrop').classList.add('hidden'); });

  // Password hashing (SHA-256 via SubtleCrypto with fallback)
  async function hashText(text) {
    try {
      const enc = new TextEncoder().encode(text);
      const buf = await crypto.subtle.digest('SHA-256', enc);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // fallback
      let h = 0; for (let i = 0; i < text.length; i++) { h = ((h << 5) - h) + text.charCodeAt(i); h |= 0; }
      return 'h' + Math.abs(h);
    }
  }

  // ==========================
  // API: Countries & Rates
  // ==========================
  async function fetchCountries() {
    const cache = Storage.get(KEYS.countries);
    if (cache && (Date.now() - cache.ts) < 7 * 24 * 3600 * 1000) { return cache.data; }
    try {
      const url = 'https://restcountries.com/v3.1/all?fields=name,currencies';
      const res = await fetch(url);
      const json = await res.json();
      const out = [];
      for (const c of json) {
        const name = c?.name?.common;
        const currencies = c?.currencies ? Object.entries(c.currencies) : [];
        if (name && currencies.length) {
          for (const [code, info] of currencies) {
            out.push({ country: name, currencyCode: code, currencySymbol: info?.symbol || code });
          }
        }
      }
      out.sort((a, b) => a.country.localeCompare(b.country));
      Storage.set(KEYS.countries, { ts: Date.now(), data: out });
      return out;
    } catch (e) {
      // Fallback minimal list
      const fallback = [
        { country: 'United States', currencyCode: 'USD', currencySymbol: '$' },
        { country: 'Eurozone', currencyCode: 'EUR', currencySymbol: '€' },
        { country: 'United Kingdom', currencyCode: 'GBP', currencySymbol: '£' },
        { country: 'India', currencyCode: 'INR', currencySymbol: '₹' },
        { country: 'Japan', currencyCode: 'JPY', currencySymbol: '¥' },
      ];
      return fallback;
    }
  }

  async function getRates(base) {
    const map = Storage.get(KEYS.rates, {});
    const entry = map[base];
    if (entry && (Date.now() - entry.ts) < 12 * 3600 * 1000) { return entry.rates; }
    try {
      const url = `https://api.exchangerate-api.com/v4/latest/${encodeURIComponent(base)}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json && json.rates) {
        map[base] = { ts: Date.now(), rates: json.rates };
        Storage.set(KEYS.rates, map);
        return json.rates;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  async function convert(amount, from, to) {
    if (from === to) return amount;
    const rates = await getRates(from);
    if (!rates || !rates[to]) return amount; // fallback
    return amount * rates[to];
  }

  // ==========================
  // Models: Company, Users, Expenses, Rules
  // ==========================
  function getCompany() { return Storage.get(KEYS.company); }
  function setCompany(c) { Storage.set(KEYS.company, c); }

  function getUsers() { return Storage.get(KEYS.users, []); }
  function setUsers(u) { Storage.set(KEYS.users, u); }

  function getRules() { return Storage.get(KEYS.rules, DEFAULT_RULES); }
  function setRules(r) { Storage.set(KEYS.rules, r); }

  function getExpenses() { return Storage.get(KEYS.expenses, []); }
  function setExpenses(e) { Storage.set(KEYS.expenses, e); }

  function getSession() { return Storage.get(KEYS.session); }
  function setSession(s) { Storage.set(KEYS.session, s); }
  function clearSession() { Storage.remove(KEYS.session); }

  function roleList(u) { return (u?.roles || []).slice(); }
  function hasRole(u, role) { return !!roleList(u).includes(role); }

  // ==========================
  // Seed Sample Data (first run)
  // ==========================
  async function seedIfNeeded() {
    if (Storage.get(KEYS.seeded)) return; // already seeded
    const company = {
      id: uuid(), name: 'Acme Corp', country: 'United States', currencyCode: 'USD', currencySymbol: '$', createdAt: nowIso()
    };
    setCompany(company);

    const admin = { id: 'u-admin', name: 'System Admin', email: 'admin@ems.local', roles: [ROLES.ADMIN], passwordHash: await hashText('admin123'), createdAt: nowIso() };
    const manager = { id: 'u-manager', name: 'Mary Manager', email: 'manager@ems.local', roles: [ROLES.MANAGER], passwordHash: await hashText('manager123'), createdAt: nowIso() };
    const employee = { id: 'u-emp', name: 'Evan Employee', email: 'employee@ems.local', roles: [ROLES.EMPLOYEE], managerId: 'u-manager', passwordHash: await hashText('employee123'), createdAt: nowIso() };
    const finance = { id: 'u-fin', name: 'Frank Finance', email: 'finance@ems.local', roles: [ROLES.FINANCE], passwordHash: await hashText('finance123'), createdAt: nowIso() };
    const director = { id: 'u-dir', name: 'Dina Director', email: 'director@ems.local', roles: [ROLES.DIRECTOR], passwordHash: await hashText('director123'), createdAt: nowIso() };
    const cfo = { id: 'u-cfo', name: 'Cindy CFO', email: 'cfo@ems.local', roles: [ROLES.FINANCE, ROLES.CFO], passwordHash: await hashText('cfo123'), createdAt: nowIso() };
    setUsers([admin, manager, employee, finance, director, cfo]);

    setRules(DEFAULT_RULES);

    // Sample expenses
    const exps = [];
    exps.push({
      id: uuid(), userId: 'u-emp', amount: 45.00, currency: 'USD', category: 'Meals', description: 'Team lunch', date: new Date(Date.now() - 4 * 86400000).toISOString(),
      status: 'PENDING', receipt: { fileName: 'lunch.jpg', text: 'Lunch at cafe' },
      approvals: { stepIndex: 0, steps: DEFAULT_RULES.steps.map(r => ({ role: r, approvals: [] })) },
      createdAt: nowIso(), history: [{ at: nowIso(), status: 'PENDING', by: 'u-emp' }]
    });
    // Approved example (already passed steps)
    exps.push({
      id: uuid(), userId: 'u-emp', amount: 300.00, currency: 'EUR', category: 'Travel', description: 'Flight tickets', date: new Date(Date.now() - 10 * 86400000).toISOString(),
      status: 'APPROVED', receipt: { fileName: 'flight.png', text: 'Round trip' },
      approvals: {
        stepIndex: 3, steps: [
          { role: ROLES.MANAGER, approvals: [{ userId: 'u-manager', decision: 'APPROVE', comment: 'OK', at: nowIso() }] },
          { role: ROLES.FINANCE, approvals: [{ userId: 'u-fin', decision: 'APPROVE', comment: 'Budgeted', at: nowIso() }] },
          { role: ROLES.DIRECTOR, approvals: [{ userId: 'u-dir', decision: 'APPROVE', comment: 'Approved', at: nowIso() }] },
        ]
      },
      createdAt: nowIso(), history: [{ at: nowIso(), status: 'APPROVED', by: 'u-dir' }]
    });
    // Rejected example
    exps.push({
      id: uuid(), userId: 'u-emp', amount: 120.00, currency: 'USD', category: 'Supplies', description: 'Office chair cushion', date: new Date(Date.now() - 7 * 86400000).toISOString(),
      status: 'REJECTED', receipt: { fileName: 'cushion.jpg', text: 'Accessory' },
      approvals: {
        stepIndex: 0, steps: [
          { role: ROLES.MANAGER, approvals: [{ userId: 'u-manager', decision: 'REJECT', comment: 'Not needed', at: nowIso() }] },
          { role: ROLES.FINANCE, approvals: [] },
          { role: ROLES.DIRECTOR, approvals: [] },
        ]
      },
      createdAt: nowIso(), history: [{ at: nowIso(), status: 'REJECTED', by: 'u-manager' }]
    });
    setExpenses(exps);

    Storage.set(KEYS.seeded, true);
  }

  // ==========================
  // Auth
  // ==========================
  async function login(email, password) {
    const users = getUsers();
    const pass = await hashText(password);
    const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.passwordHash === pass);
    if (!user) throw new Error('Invalid email or password');
    const sess = { userId: user.id, at: nowIso(), user: { id: user.id, name: user.name, email: user.email, roles: roleList(user) } };
    setSession(sess);
    // Publish to Firebase session (cross-device)
    try {
      if (window.FirebaseSync && FirebaseSync.init()) {
        const comp = getCompany();
        const compId = comp?.id || (window.FIREBASE_CONFIG?.projectId);
        if (compId) { await FirebaseSync.setSession(compId, sess); }
      }
    } catch {}
    return user;
  }
  function logout() {
    try {
      if (window.FirebaseSync && FirebaseSync.init()) {
        const comp = getCompany();
        const compId = comp?.id || (window.FIREBASE_CONFIG?.projectId);
        if (compId) { FirebaseSync.clearSession(compId); }
      }
    } catch {}
    clearSession();
  }
  function currentUser() { const s = getSession(); if (!s) return null; return getUsers().find(u => u.id === s.userId) || null; }

  // ==========================
  // Approval Logic
  // ==========================
  function getCurrentStep(expense) {
    const steps = expense?.approvals?.steps || getRules().steps || [];
    const idx = expense?.approvals?.stepIndex ?? 0;
    const role = steps[idx] || null;
    return { idx, role };
  }

  function isUserApproverFor(expense, user) {
    const { role } = getCurrentStep(expense);
    if (!role) return false;
    const eligible = eligibleApproverIds(expense, role);
    return eligible.includes(user.id) || hasRole(user, ROLES.ADMIN);
  }

  function recordHistory(expense, status, by) {
    (expense.history ||= []).push({ at: nowIso(), status, by });
  }

  function approverEntry(expense) {
    const { idx, role } = getCurrentStep(expense);
    if (role == null) return null;
    const step = expense.approvals.steps[idx];
    return step;
  }

  function rulesEval(expense) {
    const rules = getRules();
    const cur = getCurrentStep(expense);
    if (!cur.role) return; // already finished
    const step = expense.approvals.steps[cur.idx];
    const approvals = step.approvals || [];
    const rejected = approvals.some(a => a.decision === 'REJECT');
    if (rejected) {
      expense.status = 'REJECTED';
      recordHistory(expense, 'REJECTED', approvals[approvals.length - 1]?.userId || '');
      return;
    }

    // Unanimous approval required for current step
    const eligible = eligibleApproverIds(expense, cur.role);
    // If no eligible approvers (e.g., no users with that role), auto-skip this step
    if (eligible.length === 0) {
      const next = expense.approvals.stepIndex + 1;
      if (next >= expense.approvals.steps.length) {
        expense.status = 'APPROVED';
        recordHistory(expense, 'APPROVED', approvals[approvals.length - 1]?.userId || '');
      } else {
        expense.approvals.stepIndex = next;
      }
      return;
    }

    const approvedUserIds = Array.from(new Set(approvals.filter(a => a.decision === 'APPROVE').map(a => a.userId)));
    const pass = eligible.every(id => approvedUserIds.includes(id));

    if (pass) {
      const next = expense.approvals.stepIndex + 1;
      if (next >= expense.approvals.steps.length) {
        expense.status = 'APPROVED';
        recordHistory(expense, 'APPROVED', approvals[approvals.length - 1]?.userId || '');
      } else {
        expense.approvals.stepIndex = next;
      }
    }
  }

  // Compute eligible approver IDs for a step role on an expense
  function eligibleApproverIds(expense, role) {
    if (!role) return [];
    if (role === ROLES.MANAGER) {
      const emp = getUsers().find(u => u.id === expense.userId);
      return emp?.managerId ? [emp.managerId] : [];
    }
    // For all other roles, any user with that role can approve
    return getUsers().filter(u => hasRole(u, role)).map(u => u.id);
  }

  function approveOrReject(expenseId, userId, decision, comment) {
    const expenses = getExpenses();
    const expense = expenses.find(e => e.id === expenseId);
    if (!expense) throw new Error('Expense not found');
    if (expense.status !== 'PENDING') throw new Error('Expense is not pending');

    const step = approverEntry(expense);
    if (!step) throw new Error('No active approval step');

    step.approvals.push({ userId, decision: decision === 'APPROVE' ? 'APPROVE' : 'REJECT', comment: comment || '', at: nowIso() });
    rulesEval(expense);
    setExpenses(expenses);
    return expense.status;
  }

  function adminOverride(expenseId, status, adminId) {
    const expenses = getExpenses();
    const e = expenses.find(x => x.id === expenseId);
    if (!e) throw new Error('Expense not found');
    e.status = status;
    // Mark as concluded relative to the expense's own steps
    e.approvals.stepIndex = e.approvals.steps.length;
    recordHistory(e, status, adminId);
    setExpenses(expenses);
  }

  // ==========================
  // Expense CRUD
  // ==========================
  function listExpensesFor(user) {
    const all = getExpenses();
    if (hasRole(user, ROLES.ADMIN) || hasRole(user, ROLES.CFO)) return all.slice();
    if (hasRole(user, ROLES.MANAGER)) {
      const teamIds = getUsers().filter(u => u.managerId === user.id).map(u => u.id);
      return all.filter(e => teamIds.includes(e.userId) || e.userId === user.id);
    }
    if (hasRole(user, ROLES.FINANCE) || hasRole(user, ROLES.DIRECTOR)) {
      // approver sees all pending + their own
      return all.filter(e => e.status === 'PENDING' || e.userId === user.id);
    }
    // employee: own
    return all.filter(e => e.userId === user.id);
  }

  function canCurrentUserSubmitExpense(user) { return hasRole(user, ROLES.EMPLOYEE); }

  function addExpense(exp) {
    const expenses = getExpenses();
    expenses.unshift(exp);
    setExpenses(expenses);
  }

  // ==========================
  // UI Rendering
  // ==========================
  function setActiveView(id) {
    $$('.view').forEach(v => v.classList.add('hidden'));
    $('#' + id).classList.remove('hidden');
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === id));
  }

  function applyRoleVisibility(user) {
    $$('#sidebar [data-role]').forEach(el => {
      const need = (el.dataset.role || '').split(',').map(s => s.trim()).filter(Boolean);
      el.style.display = need.some(r => hasRole(user, r)) ? '' : 'none';
    });
    // New expense button
    if ($('#new-expense-btn')) $('#new-expense-btn').style.display = canCurrentUserSubmitExpense(user) ? '' : 'none';
    // Ensure Approvals nav is visible if user has any role used in current steps (or is admin)
    const apprBtn = $(`#sidebar .nav-item[data-view="approvals-view"]`);
    if (apprBtn) {
      const stepRoles = (getRules().steps || []);
      const userHasStepRole = stepRoles.some(r => hasRole(user, r));
      if (userHasStepRole || hasRole(user, ROLES.ADMIN) || hasRole(user, ROLES.CFO)) apprBtn.style.display = '';
    }
  }

  function setHeaderContext(user) {
    const company = getCompany();
    $('#company-badge').textContent = `${company?.name || '—'} · ${company?.currencyCode || ''}`;
    $('#current-user').textContent = `${user.name} (${roleList(user).join(', ')})`;
  }

  function cardEl(title, value, icon) {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<h4>${title}</h4><div class="value"><i class="fa-solid ${icon}"></i> ${value}</div>`;
    return el;
  }

  async function renderDashboard(user) {
    const wrap = $('#dashboard-cards');
    wrap.innerHTML = '';
    const all = listExpensesFor(user);
    const pendingMine = all.filter(e => e.userId === user.id && e.status === 'PENDING').length;
    const myTotal = all.filter(e => e.userId === user.id).length;
    const companyAll = hasRole(user, ROLES.ADMIN) ? getExpenses().length : all.length;
    const pendingToApprove = listExpensesFor(user).filter(e => isUserApproverFor(e, user) && e.status === 'PENDING').length;

    wrap.append(
      cardEl('My Pending Expenses', pendingMine, 'fa-hourglass-half'),
      cardEl('My Expenses', myTotal, 'fa-file-invoice-dollar'),
      cardEl('Pending to Approve', pendingToApprove, 'fa-check-double'),
      cardEl('Total Visible Expenses', companyAll, 'fa-list')
    );

    // Recent activity
    const act = $('#recent-activity');
    const recent = getExpenses().slice(0, 6);
    act.innerHTML = recent.map(e => {
      const u = getUsers().find(x => x.id === e.userId);
      return `<div class="activity-item">
        <span class="badge">${e.status}</span>
        <span>${fmtDate(e.date)} - ${u?.name || 'Unknown'} - ${e.category}: ${e.description}</span>
      </div>`;
    }).join('');
  }

  async function renderExpensesView(user) {
    // Populate currency select
    const ccys = await fetchCountries();
    const cset = new Set();
    $('#exp-currency').innerHTML = ccys.filter(c => { if (cset.has(c.currencyCode)) return false; cset.add(c.currencyCode); return true; })
      .map(c => `<option value="${c.currencyCode}">${c.currencyCode} ${c.currencySymbol !== c.currencyCode ? `(${c.currencySymbol})` : ''}</option>`).join('');

    const tbody = $('#expenses-table tbody');
    function applyFilters(rows) {
      const q = ($('#exp-search').value || '').toLowerCase();
      const st = $('#exp-status-filter').value;
      const cat = $('#exp-category-filter').value;
      const df = $('#exp-date-from').value; const dt = $('#exp-date-to').value;
      return rows.filter(r => {
        if (q && !(`${r.description} ${r.category}`.toLowerCase().includes(q))) return false;
        if (st && r.status !== st) return false;
        if (cat && r.category !== cat) return false;
        if (df && new Date(r.date) < new Date(df)) return false;
        if (dt && new Date(r.date) > new Date(dt)) return false;
        return true;
      });
    }

    async function draw() {
      const rows = listExpensesFor(user);
      const filtered = applyFilters(rows);
      const company = getCompany();
      const items = await Promise.all(filtered.map(async e => {
        const amountC = await convert(e.amount, e.currency, company.currencyCode);
        const emp = getUsers().find(u => u.id === e.userId);
        const approver = isUserApproverFor(e, user) && e.status === 'PENDING';
        const adminAct = (hasRole(user, ROLES.ADMIN) || hasRole(user, ROLES.CFO)) && e.status === 'PENDING';
        let statusCell = `<span class="status ${e.status}">${e.status}</span>`;
        if(e.status==='PENDING'){
          const step = getCurrentStep(e);
          const elig = eligibleApproverIds(e, step.role);
          const apr = (e.approvals.steps[step.idx]?.approvals || []).filter(a=>a.decision==='APPROVE');
          const uniqApproved = Array.from(new Set(apr.map(a=>a.userId))).filter(id=> elig.includes(id)).length;
          statusCell = `<span class=\"status ${e.status}\">${e.status}</span> <small class=\"muted\">(${step.role} ${uniqApproved}/${elig.length})</small>`;
        }
        return `<tr data-id="${e.id}">
          <td>${fmtDate(e.date)}</td>
          <td>${emp?.name || '-'}</td>
          <td>${e.category}</td>
          <td title="${e.receipt?.text || ''}">${e.description}</td>
          <td>${moneyFmt(e.amount, e.currency)}</td>
          <td>${moneyFmt(amountC, company.currencyCode)}</td>
          <td>${statusCell}</td>
          <td>
            ${approver ? `<button class=\"btn btn-primary btn-approve\" title=\"Approve\">Approve</button> <button class=\"btn btn-ghost btn-reject\" title=\"Reject\">Reject</button>` : ''}
            ${adminAct ? `<button class=\"btn btn-ghost btn-ovr-approve\" title=\"Admin Approve\">Override ✓</button> <button class=\"btn btn-ghost btn-ovr-reject\" title=\"Admin Reject\">Override ✗</button>` : ''}
          </td>
        </tr>`;
      }));
      tbody.innerHTML = items.join('');
    }

    // Bind filters once
    ['exp-search', 'exp-status-filter', 'exp-category-filter', 'exp-date-from', 'exp-date-to'].forEach(id => on($('#' + id), 'input', draw));

    // Row actions
    on(tbody, 'click', (e) => {
      const tr = e.target.closest('tr'); if (!tr) return; const id = tr.dataset.id;
      if (e.target.classList.contains('btn-approve')) { openApproval('APPROVE', id); }
      if (e.target.classList.contains('btn-reject')) { openApproval('REJECT', id); }
      if (e.target.classList.contains('btn-ovr-approve')) { try { adminOverride(id, 'APPROVED', currentUser().id); toast('Approved by admin', 'success'); draw(); renderDashboard(currentUser()); } catch (err) { toast(err.message, 'error'); } }
      if (e.target.classList.contains('btn-ovr-reject')) { try { adminOverride(id, 'REJECTED', currentUser().id); toast('Rejected by admin', 'success'); draw(); renderDashboard(currentUser()); } catch (err) { toast(err.message, 'error'); } }
    });

    await draw();
  }

  async function renderApprovalsView(user) {
    const tbody = $('#approvals-table tbody');

    async function draw() {
      const rows = listExpensesFor(user).filter(e => isUserApproverFor(e, user) && e.status === 'PENDING');
      const items = rows.map(e => {
        const emp = getUsers().find(u => u.id === e.userId);
        const step = getCurrentStep(e);
        return `<tr data-id="${e.id}">
          <td>${fmtDate(e.date)}</td>
          <td>${emp?.name || '-'}</td>
          <td>${e.category}</td>
          <td>${e.description}</td>
          <td>${moneyFmt(e.amount, e.currency)}</td>
          <td>${step.role || '-'}</td>
          <td>
            <button class="btn btn-primary btn-approve">Approve</button>
            <button class="btn btn-ghost btn-reject">Reject</button>
          </td>
        </tr>`;
      });
      tbody.innerHTML = items.join('');
    }

    on(tbody, 'click', (e) => {
      const tr = e.target.closest('tr'); if (!tr) return; const id = tr.dataset.id;
      if (e.target.classList.contains('btn-approve')) openApproval('APPROVE', id);
      if (e.target.classList.contains('btn-reject')) openApproval('REJECT', id);
    });

    await draw();
  }

  function populateManagerSelect() {
    const sel = $('#user-manager'); if (!sel) return;
    const managers = getUsers().filter(u => hasRole(u, ROLES.MANAGER));
    sel.innerHTML = `<option value="">— None —</option>` + managers.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  }

  function openUserModal(existing) {
    $('#user-modal-title').textContent = existing ? 'Edit User' : 'Add User';
    $('#user-id').value = existing?.id || '';
    $('#user-name').value = existing?.name || '';
    $('#user-email').value = existing?.email || '';
    $('#user-password').value = '';
    // Render dynamic role checkboxes
    renderRoleCheckboxes(existing?.roles || []);
    // Manager field visibility
    const updateMgrVis = () => {
      const employeeChecked = $$('.role-checkbox').find(cb => cb.value === ROLES.EMPLOYEE)?.checked;
      $('#manager-select-wrap').classList.toggle('hidden', !employeeChecked);
    };
    $$('.role-checkbox').forEach(cb => on(cb, 'change', updateMgrVis));
    updateMgrVis();
    populateManagerSelect();
    $('#user-manager').value = existing?.managerId || '';
    openModal('user-modal');
  }

  function renderUsersView() {
    const tbody = $('#users-table tbody');
    const cur = currentUser();
    // Hide the currently logged-in user (admin) from the list so it's empty right after setup
    const users = getUsers().filter(u => !(cur && u.id === cur.id));
    tbody.innerHTML = users.map(u => {
      const mgr = users.find(x => x.id === u.managerId);
      return `<tr data-id="${u.id}">
        <td>${u.name}</td>
        <td>${u.email}</td>
        <td>${(u.roles || []).join(', ')}</td>
        <td>${mgr ? mgr.name : '-'}</td>
        <td>
          <button class="btn btn-ghost btn-edit"><i class="fa-solid fa-pen"></i></button>
          ${u.id === 'u-admin' ? '' : '<button class="btn btn-ghost btn-del"><i class="fa-solid fa-trash"></i></button>'}
        </td>
      </tr>`;
    }).join('');

    on(tbody, 'click', (e) => {
      const tr = e.target.closest('tr'); if (!tr) return; const id = tr.dataset.id; const u = getUsers().find(x => x.id === id);
      const editBtn = e.target.closest('.btn-edit');
      const delBtn = e.target.closest('.btn-del');
      if (editBtn) { openUserModal(u); return; }
      if (delBtn) {
        e.preventDefault(); e.stopPropagation();
        // Prevent deleting yourself
        const me = currentUser(); if (me && me.id === id) { toast("You can't delete your own account.", 'error'); return; }
        // Admin immediate delete (no confirmation)
        const list = getUsers().filter(x => x.id !== id);
        // Cleanup manager references
        let hasToastShown = false;

list.forEach(x => {
  if (x.managerId === id) {
    x.managerId = '';
    if (!hasToastShown) {
      toast('User deleted', 'success');
      hasToastShown = true;
    }
  }
});

setUsers(list);
renderUsersView();

      }
    });
  }

  function loadRulesIntoForm() {
    const r = getRules();
    $('#rule-percentage-enabled').checked = !!r.percentageRule?.enabled;
    $('#rule-percentage-threshold').value = r.percentageRule?.threshold ?? 50;
    $('#rule-cfo-enabled').checked = !!r.specificApproverRule?.enabled;
    $('#rule-hybrid-enabled').checked = !!r.hybrid?.enabled;
    // Populate specific approver role selector
    const sel = $('#rule-cfo-role');
    if (sel) {
      const roles = getAllRoles();
      const cur = r.specificApproverRule?.role || ROLES.CFO;
      sel.innerHTML = roles.map(role => `<option value="${role}">${role}</option>`).join('');
      sel.value = roles.includes(cur) ? cur : ROLES.CFO;
    }
    // Render steps editor from current rules
    renderStepsEditor();
  }

  // ==========================
  // Modal flows
  // ==========================
  function openApproval(decision, expenseId) {
    $('#approval-decision').value = decision;
    $('#approval-expense-id').value = expenseId;
    $('#approval-comment').value = '';
    openModal('approval-modal');
  }

  // Render role checkboxes dynamically inside the user modal
  function renderRoleCheckboxes(selected) {
    const wrap = $('#roles-checkboxes');
    if (!wrap) return;
    const roles = getAllRoles();
    wrap.innerHTML = roles.map(role => `<label><input type="checkbox" value="${role}" class="role-checkbox"/> ${role}</label>`).join('');
    $$('.role-checkbox', wrap).forEach(cb => { cb.checked = selected.includes(cb.value); });
  }

  async function handleApprovalSubmit(e) {
    e.preventDefault();
    const decision = $('#approval-decision').value;
    const expenseId = $('#approval-expense-id').value;
    const comment = $('#approval-comment').value;
    try {
      const status = approveOrReject(expenseId, currentUser().id, decision, comment);
      toast(`Expense ${status.toLowerCase()}`, 'success');
      closeModal('approval-modal');
      renderApprovalsView(currentUser());
      renderExpensesView(currentUser());
      renderDashboard(currentUser());
    } catch (err) { toast(err.message, 'error'); }
  }

  function openExpenseModal() {
    $('#expense-modal-title').textContent = 'New Expense';
    $('#exp-amount').value = '';
    $('#exp-currency').value = getCompany()?.currencyCode || 'USD';
    $('#exp-category').value = 'Travel';
    $('#exp-date').valueAsDate = new Date();
    $('#exp-description').value = '';
    $('#exp-receipt').value = '';
    openModal('expense-modal');
  }

  // ===== OCR helpers =====
  function formatDateForInput(d){
    try{
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const dd = String(d.getDate()).padStart(2,'0');
      return `${yyyy}-${mm}-${dd}`;
    }catch{ return ''; }
  }
  function detectCurrency(text){
    const map = { '$':'USD','€':'EUR','£':'GBP','₹':'INR','¥':'JPY','₩':'KRW','AED':'AED','USD':'USD','INR':'INR','EUR':'EUR','GBP':'GBP','JPY':'JPY'};
    for(const [k,v] of Object.entries(map)) if(text.includes(k)) return v;
    return getCompany()?.currencyCode || 'USD';
  }
  function detectCategory(text, merchant){
    const t = (text+" "+(merchant||'')).toLowerCase();
    if(/restaurant|cafe|coffee|tea|bar|grill|pizza|burger|kfc|mcdonald|subway|starbucks|meal|food/.test(t)) return 'Meals';
    if(/uber|lyft|cab|taxi|flight|airline|hotel|train|bus|parking|toll|fuel|petrol|diesel|car rental/.test(t)) return 'Travel';
    if(/license|subscription|saas|software|cloud|aws|azure|gcp/.test(t)) return 'Software';
    if(/paper|pen|staple|notebook|mouse|keyboard|monitor|chair|stationery|suppl(y|ies)/.test(t)) return 'Supplies';
    return 'Other';
  }
  function extractDate(text){
    // Try multiple common patterns
    const pats = [
      /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/,           // YYYY-MM-DD
      /(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/,         // DD/MM/YYYY or MM/DD/YYYY
    ];
    for(const re of pats){
      const m = text.match(re);
      if(m){
        if(m[0].length>=8){
          let y,mm,dd;
          if(re===pats[0]){ y=+m[1]; mm=+m[2]; dd=+m[3]; }
          else{ // assume DD/MM/YYYY then fallback MM/DD
            const a=+m[1], b=+m[2], c=+m[3];
            if(c>31){ // year
              // disambiguate using >12
              if(a>12){ dd=a; mm=b; } else if(b>12){ dd=b; mm=a; } else { mm=a; dd=b; }
              y=c;
            }else{ continue; }
          }
          const dt = new Date(Date.UTC(y,mm-1,dd));
          if(!isNaN(dt)) return dt;
        }
      }
    }
    return null;
  }
  function extractAmounts(text){
    const rx = /(?:[$€£₹¥])?\s*([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{2})|[0-9]+(?:\.[0-9]{2})?)/g;
    let m; const vals=[];
    while((m=rx.exec(text))){
      const raw = m[1].replace(/,/g,'');
      const v = parseFloat(raw);
      if(!isNaN(v)) vals.push({v, idx:m.index});
    }
    return vals.sort((a,b)=> a.v-b.v);
  }
  function extractMerchant(text){
    const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    for(const line of lines){
      const clean=line.replace(/[^A-Za-z0-9 '&.@-]/g,'').trim();
      if(!clean) continue;
      if(/receipt|invoice|total|amount|change|cash|tax|thank/i.test(clean)) continue;
      if(clean.length>=3 && /[A-Za-z]/.test(clean)) return clean.slice(0,60);
    }
    return lines[0]?.slice(0,60) || '';
  }
  function extractItems(text){
    const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    const out=[];
    for(const ln of lines){
      if(/total|subtotal|tax|change|amount due/i.test(ln)) continue;
      if(/\d/.test(ln) && ln.length>3){ out.push(ln); if(out.length>=6) break; }
    }
    return out;
  }
  function parseReceiptText(text){
    const currency = detectCurrency(text);
    const merchant = extractMerchant(text);
    const dateObj = extractDate(text);
    const dateStr = dateObj? formatDateForInput(dateObj) : '';
    const amounts = extractAmounts(text);
    const total = amounts.length? amounts[amounts.length-1].v : null;
    const items = extractItems(text);
    const category = detectCategory(text, merchant);
    return { currency, merchant, dateStr, total, items, raw:text, category };
  }

  async function simulateOCR() {
    const file = $('#exp-receipt').files?.[0];
    if(!file){ toast('Attach a receipt image first','error'); return; }
    // Real OCR if Tesseract is available
    if(window.Tesseract && Tesseract.recognize){
      toast('Reading receipt…','info');
      try{
        const { data } = await Tesseract.recognize(file, 'eng');
        const text = (data?.text || '').trim();
        if(!text){ throw new Error('No text recognized'); }
        const rec = parseReceiptText(text);
        if(rec.total!=null) $('#exp-amount').value = String(rec.total.toFixed(2));
        if(rec.dateStr) $('#exp-date').value = rec.dateStr;
        if(rec.currency){
          const sel = $('#exp-currency');
          if(Array.from(sel.options).some(o=>o.value===rec.currency)) sel.value = rec.currency;
        }
        if(rec.category) $('#exp-category').value = rec.category;
        const lines = rec.items.map(i=>`- ${i}`).join('\n');
        const descParts = [];
        if(rec.merchant) descParts.push(`Merchant: ${rec.merchant}`);
        if(lines) descParts.push(`Items:\n${lines}`);
        const base = descParts.join('\n');
        const ocrBlock = `Receipt OCR:\n${text.slice(0,2000)}`;
        const cur = $('#exp-description').value.trim();
        $('#exp-description').value = [base, cur, ocrBlock].filter(Boolean).join('\n\n');
        toast('OCR complete. Fields auto-filled.','success');
      }catch(err){
        console.error(err);
        // Fallback quick summary
        const name = file.name.replace(/\.[^.]+$/, '');
        const text = `Receipt: ${name} · ${Math.round(file.size / 1024)}KB · ${file.type}`;
        const cur = $('#exp-description').value;
        $('#exp-description').value = cur ? `${cur}\n${text}` : text;
        toast('OCR fallback used','info');
      }
    }else{
      // Fallback simple stub
      const name = file.name.replace(/\.[^.]+$/, '');
      const text = `Receipt: ${name} · ${Math.round(file.size / 1024)}KB · ${file.type}`;
      const cur = $('#exp-description').value;
      $('#exp-description').value = cur ? `${cur}\n${text}` : text;
      toast('OCR simulated (library unavailable)','info');
    }
  }

  async function handleExpenseSubmit(e) {
    e.preventDefault(); const user = currentUser(); if (!user) return;
    const amount = parseFloat($('#exp-amount').value);
    const currency = $('#exp-currency').value;
    const category = $('#exp-category').value;
    const date = new Date($('#exp-date').valueAsDate || new Date()).toISOString();
    const description = ($('#exp-description').value || '').trim();
    const file = $('#exp-receipt').files?.[0];
    const receipt = file ? { fileName: file.name, text: (description.match(/Receipt:[\s\S]+$/m)?.[0] || '') } : { fileName: '', text: '' };

    const exp = {
      id: uuid(), userId: user.id, amount, currency, category, description, date,
      status: 'PENDING', receipt,
      approvals: { stepIndex: 0, steps: getRules().steps.map(r => ({ role: r, approvals: [] })) },
      createdAt: nowIso(), history: [{ at: nowIso(), status: 'PENDING', by: user.id }]
    };
    addExpense(exp);
    toast('Expense submitted', 'success');
    closeModal('expense-modal');
    renderExpensesView(user); renderDashboard(user);
  }

  async function handleCompanySetup(e) {
    e.preventDefault();
    const name = $('#setup-company-name').value.trim();
    const country = $('#setup-country').value;
    const currencyCode = $('#setup-currency').value.trim() || 'USD';
    const company = { id: uuid(), name, country, currencyCode, currencySymbol: currencyCode, createdAt: nowIso() };
    setCompany(company);

    // Create admin user
    const uname = $('#setup-admin-name').value.trim();
    const email = $('#setup-admin-email').value.trim();
    const pass = $('#setup-admin-password').value;
    const users = getUsers();
    // Prevent duplicate emails
    if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
      toast('Email already exists. Please use a different email.', 'error');
      return;
    }
    const newAdmin = { id: uuid(), name: uname, email, roles: [ROLES.ADMIN], managerId: '', passwordHash: await hashText(pass), createdAt: nowIso() };
    // Replace any existing users with only the new admin
    setUsers([newAdmin]);
    // Clear demo/sample data so Users view starts empty (except hidden current admin)
    setExpenses([]);
    // Reset custom roles to start clean
    setCustomRoles([]);
    // (Re)bind realtime session sync now that company exists
    try { if (window.FirebaseSync) { bindRealtimeSessionSync(); } } catch {}
    toast('Company setup completed. You can now sign in.', 'success');
    closeModal('company-setup-modal');
  }

  // ==========================
  // Navigation & Bindings
  // ==========================
  function bindNavigation() {
    on($('#sidebar-toggle'), 'click', () => $('#sidebar').classList.toggle('open'));
    $$('#sidebar .nav-item').forEach(btn => on(btn, 'click', () => {
      setActiveView(btn.dataset.view);
      $$('#sidebar .nav-item').forEach(b => b.classList.toggle('active', b === btn));
      if (window.innerWidth < 980) $('#sidebar').classList.remove('open');
    }));
  }

  function bindAuth() {
    on($('#login-form'), 'submit', async (e) => {
      e.preventDefault();
      const email = $('#login-email').value.trim();
      const password = $('#login-password').value;
      try {
        const user = await login(email, password);
        toast('Welcome back', 'success');
        enterApp(user);
      } catch (err) { toast(err.message, 'error'); }
    });
    on($('#open-setup-btn'), 'click', async () => {
      // load countries
      const list = await fetchCountries();
      const countries = Array.from(new Map(list.map(i => [i.country, i])).values());
      $('#setup-country').innerHTML = countries.map(c => `<option value="${c.country}" data-ccy="${c.currencyCode}" data-symbol="${c.currencySymbol}">${c.country}</option>`).join('');
      on($('#setup-country'), 'change', (e) => { const opt = e.target.selectedOptions[0]; $('#setup-currency').value = opt?.dataset?.ccy || 'USD'; });
      // default currency
      const first = countries[0]; $('#setup-currency').value = first ? first.currencyCode : 'USD';
      openModal('company-setup-modal');
    });
  }

  function bindModals() {
    on($('#expense-form'), 'submit', handleExpenseSubmit);
    on($('#btn-ocr'), 'click', simulateOCR);
    on($('#approval-form'), 'submit', handleApprovalSubmit);
    on($('#company-setup-form'), 'submit', handleCompanySetup);
    on($('#new-expense-btn'), 'click', openExpenseModal);
    on($('#manage-roles-btn'), 'click', () => { renderRolesList(); openModal('roles-modal'); });
    on($('#role-add-form'), 'submit', (e) => { e.preventDefault(); handleAddRole(); });
    on($('#roles-list'), 'click', (e) => {
      const chip = e.target.closest('[data-role]');
      if (!chip) return;
      if (chip.dataset.base === 'true') return; // built-in, not removable
      const role = chip.dataset.role;
      if (confirm(`Remove role ${role}? Users with this role will lose it.`)) {
        removeRole(role);
      }
    });

    on($('#add-user-btn'), 'click', () => openUserModal(null));
    on($('#user-form'), 'submit', async (e) => {
      e.preventDefault();
      const id = $('#user-id').value.trim();
      const name = $('#user-name').value.trim();
      const email = $('#user-email').value.trim();
      const pwd = $('#user-password').value;
      const roles = $$('.role-checkbox').filter(cb => cb.checked).map(cb => cb.value);
      const managerId = $('#user-manager').value;
      const list = getUsers();
      if (id) {
        const u = list.find(x => x.id === id);
        u.name = name; u.email = email; u.roles = roles; u.managerId = managerId;
        if (pwd) u.passwordHash = await hashText(pwd);
      } else {
        list.push({ id: uuid(), name, email, roles, managerId, passwordHash: await hashText(pwd || 'changeme'), createdAt: nowIso() });
      }
      setUsers(list);
      toast('User saved', 'success');
      closeModal('user-modal');
      renderUsersView();
      renderApprovalsView(currentUser());
    });
  }

  // ==========================
  // Steps Editor (Rules)
  // ==========================
  function stepsEditorRolesOptions(selected) {
    const roles = getAllRoles();
    return roles.map(r => `<option value="${r}" ${r === selected ? 'selected' : ''}>${r}</option>`).join('');
  }

  function renderStepsEditor(stepsOverride) {
    const listEl = $('#steps-list'); if (!listEl) return;
    const steps = Array.isArray(stepsOverride) ? stepsOverride.slice() : (getRules().steps || []).slice();
    listEl.innerHTML = steps.map((role, idx) =>
      `<div class="step-row" data-index="${idx}">
        <span class="chip">Step ${idx + 1}</span>
        <select class="step-role-select">${stepsEditorRolesOptions(role)}</select>
        <span class="spacer"></span>
        <button type="button" class="icon-btn btn-up" title="Move up"><i class="fa-solid fa-arrow-up"></i></button>
        <button type="button" class="icon-btn btn-down" title="Move down"><i class="fa-solid fa-arrow-down"></i></button>
        <button type="button" class="icon-btn btn-del" title="Remove"><i class="fa-solid fa-trash"></i></button>
      </div>`
    ).join('');

    // Populate add-step role picker
    const addSel = $('#add-step-role'); if (addSel) { addSel.innerHTML = stepsEditorRolesOptions(getAllRoles()[0]); }
  }

  function getStepsFromEditor() {
    const listEl = $('#steps-list'); if (!listEl) return (getRules().steps || []).slice();
    return $$('.step-row .step-role-select', listEl).map(sel => sel.value).filter(Boolean);
  }

  function bindStepsEditor() {
    const listEl = $('#steps-list'); if (!listEl) return;
    const addBtn = $('#add-step-btn'); const addSel = $('#add-step-role');
    if (addBtn) on(addBtn, 'click', () => {
      const cur = getStepsFromEditor();
      const role = addSel?.value;
      if (!role) { toast('Select a role to add', 'error'); return; }
      cur.push(role);
      renderStepsEditor(cur);
    });
    on(listEl, 'click', (e) => {
      const row = e.target.closest('.step-row'); if (!row) return;
      const rows = Array.from(listEl.querySelectorAll('.step-row'));
      const idx = rows.indexOf(row);
      let steps = getStepsFromEditor();
      if (e.target.closest('.btn-up')) {
        if (idx > 0) { const tmp = steps[idx - 1]; steps[idx - 1] = steps[idx]; steps[idx] = tmp; renderStepsEditor(steps); }
      }
      if (e.target.closest('.btn-down')) {
        if (idx < steps.length - 1) { const tmp = steps[idx + 1]; steps[idx + 1] = steps[idx]; steps[idx] = tmp; renderStepsEditor(steps); }
      }
      if (e.target.closest('.btn-del')) {
        steps.splice(idx, 1); renderStepsEditor(steps);
      }
    });
    on(listEl, 'change', (e) => {
      if (e.target.classList.contains('step-role-select')) {
        // No immediate persistence; reflect in DOM only
      }
    });
  }

  // ===== Roles management =====
  function normalizeRoleName(input) {
    return input.trim().toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_\-]/g, '');
  }

  function renderRolesList() {
    const el = $('#roles-list'); if (!el) return;
    const base = BASE_ROLES;
    const custom = getCustomRoles();
    const baseChips = base.map(r => `<span class="chip" data-role="${r}" data-base="true" title="Built-in">${r}</span>`).join(' ');
    const customChips = custom.map(r => `<span class="chip" data-role="${r}" title="Click to remove">${r} <i class="fa-solid fa-xmark"></i></span>`).join(' ');
    el.innerHTML = baseChips + (customChips ? (' ' + customChips) : '');
  }

  function refreshRoleCheckboxesPreserveSelection() {
    const wrap = $('#roles-checkboxes'); if (!wrap) return;
    const selected = $$('.role-checkbox', wrap).filter(cb => cb.checked).map(cb => cb.value);
    renderRoleCheckboxes(selected);
  }

  function handleAddRole() {
    const input = $('#role-name-input'); if (!input) return;
    let role = normalizeRoleName(input.value);
    if (!role) { toast('Enter a role name', 'error'); return; }
    if (BASE_ROLES.includes(role)) { toast('This is already a built-in role', 'error'); return; }
    const custom = getCustomRoles();
    if (custom.map(r => r.toUpperCase()).includes(role)) { toast('Role already exists', 'error'); return; }
    custom.push(role);
    setCustomRoles(custom);
    input.value = '';
    toast('Role added', 'success');
    renderRolesList();
    refreshRoleCheckboxesPreserveSelection();
    loadRulesIntoForm(); // refresh specific approver select
  }

  function removeRole(role) {
    const custom = getCustomRoles().filter(r => r !== role);
    setCustomRoles(custom);
    // Remove from users
    const users = getUsers();
    users.forEach(u => { u.roles = (u.roles || []).filter(x => x !== role); });
    setUsers(users);
    // Fix rules if pointing to removed role
    const r = getRules();
    if (r.specificApproverRule?.role === role) { r.specificApproverRule.role = ROLES.CFO; }
    if (Array.isArray(r.steps)) {
      r.steps = r.steps.filter(x => x !== role);
      if (r.steps.length === 0) { r.steps = [ROLES.MANAGER, ROLES.FINANCE, ROLES.DIRECTOR]; }
    }
    setRules(r);
    toast('Role removed', 'success');
    renderRolesList();
    refreshRoleCheckboxesPreserveSelection();
    loadRulesIntoForm();
    renderStepsEditor();
    renderUsersView();
  }

  async function enterApp(user) {
    $('#auth-view').classList.add('hidden');
    $('#main-layout').classList.remove('hidden');
    setHeaderContext(user);
    applyRoleVisibility(user);
    setActiveView('dashboard-view');
    await renderDashboard(user);
    await renderExpensesView(user);
    await renderApprovalsView(user);
    renderUsersView();
    loadRulesIntoForm();
  }

  function bindRulesForm() {
    on($('#rules-form'), 'submit', (e) => {
      e.preventDefault();
      const r = getRules();
      r.percentageRule.enabled = $('#rule-percentage-enabled').checked;
      r.percentageRule.threshold = clamp(parseInt($('#rule-percentage-threshold').value || '50', 10), 1, 100);
      r.specificApproverRule.enabled = $('#rule-cfo-enabled').checked;
      const sel = $('#rule-cfo-role'); if (sel) { r.specificApproverRule.role = sel.value || r.specificApproverRule.role; }
      r.hybrid.enabled = $('#rule-hybrid-enabled').checked;
      // Steps from editor
      const steps = getStepsFromEditor();
      if (!steps.length) { toast('Add at least one approval step before saving.', 'error'); return; }
      r.steps = steps;
      setRules(r); toast('Rules updated', 'success');
    });
  }

  function bindLogout() { on($('#logout-btn'), 'click', () => { logout(); location.reload(); }); }

  // Sync login/logout and data changes across browser tabs/windows on the same device
  function bindSessionSync(){
    window.addEventListener('storage', (e)=>{
      try{
        // Session changes: log in/out this tab accordingly
        if(e.key === KEYS.session){
          const s = Storage.get(KEYS.session);
          const cur = currentUser();
          if(s && !cur){
            const u = getUsers().find(x=>x.id===s.userId);
            if(u){ enterApp(u); }
          }else if(!s && cur){
            toast('Session ended in another tab','info');
            location.reload();
          }
          return;
        }
        // Data changes: refresh views for current user
        if([KEYS.users, KEYS.expenses, KEYS.rules, KEYS.roles, KEYS.company].includes(e.key)){
          const u = currentUser();
          if(u){
            setHeaderContext(u);
            renderUsersView();
            renderExpensesView(u);
            renderApprovalsView(u);
            renderDashboard(u);
          }
        }
      }catch{ /* ignore */ }
    });
  }

  // ==========================
  // Boot
  // ==========================
  (async function init() {
    await seedIfNeeded();
    bindNavigation();
    bindAuth();
    bindModals();
    bindRulesForm();
    bindStepsEditor();
    bindLogout();
    bindSessionSync();
    bindRealtimeSessionSync();

    const sessionUser = currentUser();
    if (sessionUser) { enterApp(sessionUser); }
  })();

})();
