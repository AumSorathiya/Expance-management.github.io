'use strict';
// Expense Management System - Vanilla JS + LocalStorage
// All features in a single modular script: auth, users, expenses, approvals, rules, APIs, and UI.

(function(){
  // ==========================
  // DOM Helpers
  // ==========================
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
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

  const DEFAULT_RULES = {
    steps: [ROLES.MANAGER, ROLES.FINANCE, ROLES.DIRECTOR],
    percentageRule: { enabled: true, threshold: 50 },
    specificApproverRule: { enabled: true, role: ROLES.CFO },
    hybrid: { enabled: true },
  };

  const CATEGORIES = ['Travel','Meals','Supplies','Software','Other'];

  // ==========================
  // Utilities
  // ==========================
  const Storage = {
    get(key, fallback){
      try{ const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : (fallback ?? null); }catch{ return fallback ?? null; }
    },
    set(key, val){ localStorage.setItem(key, JSON.stringify(val)); },
    remove(key){ localStorage.removeItem(key); }
  };

  const uuid = () => (crypto?.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now());
  const nowIso = () => new Date().toISOString();
  const fmtDate = (iso) => new Date(iso).toLocaleDateString();
  const fmtDateTime = (iso) => new Date(iso).toLocaleString();
  const clamp = (n,min,max)=>Math.min(Math.max(n,min),max);

  function moneyFmt(amount, ccy){
    try{ return new Intl.NumberFormat(undefined,{style:'currency',currency:ccy}).format(amount); }catch{ return `${ccy} ${(+amount).toFixed(2)}`; }
  }

  // Toasts
  function toast(msg, type='info', timeout=2600){
    const wrap = $('#toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<i class="fa-solid ${type==='success'?'fa-circle-check': type==='error'?'fa-circle-xmark':'fa-circle-info'}"></i><span>${msg}</span>`;
    wrap.appendChild(el);
    setTimeout(()=>{ el.remove(); }, timeout);
  }

  // Modals
  function openModal(id){ $('#modal-backdrop').classList.remove('hidden'); $('#'+id).classList.remove('hidden'); }
  function closeModal(id){ $('#modal-backdrop').classList.add('hidden'); $('#'+id).classList.add('hidden'); }
  $$('#app .modal .modal-close').forEach(btn => on(btn,'click', (e)=> closeModal(e.currentTarget.dataset.close)));
  on($('#modal-backdrop'),'click', ()=> { $$('#app .modal').forEach(m=>m.classList.add('hidden')); $('#modal-backdrop').classList.add('hidden'); });

  // Password hashing (SHA-256 via SubtleCrypto with fallback)
  async function hashText(text){
    try{
      const enc = new TextEncoder().encode(text);
      const buf = await crypto.subtle.digest('SHA-256', enc);
      return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
    }catch{
      // fallback
      let h=0; for(let i=0;i<text.length;i++){ h=((h<<5)-h)+text.charCodeAt(i); h|=0; }
      return 'h'+Math.abs(h);
    }
  }

  // ==========================
  // API: Countries & Rates
  // ==========================
  async function fetchCountries(){
    const cache = Storage.get(KEYS.countries);
    if(cache && (Date.now()-cache.ts) < 7*24*3600*1000){ return cache.data; }
    try{
      const url = 'https://restcountries.com/v3.1/all?fields=name,currencies';
      const res = await fetch(url);
      const json = await res.json();
      const out = [];
      for(const c of json){
        const name = c?.name?.common;
        const currencies = c?.currencies ? Object.entries(c.currencies) : [];
        if(name && currencies.length){
          for(const [code,info] of currencies){
            out.push({ country: name, currencyCode: code, currencySymbol: info?.symbol || code });
          }
        }
      }
      out.sort((a,b)=> a.country.localeCompare(b.country));
      Storage.set(KEYS.countries, { ts: Date.now(), data: out });
      return out;
    }catch(e){
      // Fallback minimal list
      const fallback = [
        {country:'United States', currencyCode:'USD', currencySymbol:'$'},
        {country:'Eurozone', currencyCode:'EUR', currencySymbol:'€'},
        {country:'United Kingdom', currencyCode:'GBP', currencySymbol:'£'},
        {country:'India', currencyCode:'INR', currencySymbol:'₹'},
        {country:'Japan', currencyCode:'JPY', currencySymbol:'¥'},
      ];
      return fallback;
    }
  }

  async function getRates(base){
    const map = Storage.get(KEYS.rates, {});
    const entry = map[base];
    if(entry && (Date.now()-entry.ts) < 12*3600*1000){ return entry.rates; }
    try{
      const url = `https://api.exchangerate-api.com/v4/latest/${encodeURIComponent(base)}`;
      const res = await fetch(url);
      const json = await res.json();
      if(json && json.rates){
        map[base] = { ts: Date.now(), rates: json.rates };
        Storage.set(KEYS.rates, map);
        return json.rates;
      }
    }catch(e){ /* ignore */ }
    return null;
  }

  async function convert(amount, from, to){
    if(from === to) return amount;
    const rates = await getRates(from);
    if(!rates || !rates[to]) return amount; // fallback
    return amount * rates[to];
  }

  // ==========================
  // Models: Company, Users, Expenses, Rules
  // ==========================
  function getCompany(){ return Storage.get(KEYS.company); }
  function setCompany(c){ Storage.set(KEYS.company, c); }

  function getUsers(){ return Storage.get(KEYS.users, []); }
  function setUsers(u){ Storage.set(KEYS.users, u); }

  function getRules(){ return Storage.get(KEYS.rules, DEFAULT_RULES); }
  function setRules(r){ Storage.set(KEYS.rules, r); }

  function getExpenses(){ return Storage.get(KEYS.expenses, []); }
  function setExpenses(e){ Storage.set(KEYS.expenses, e); }

  function getSession(){ return Storage.get(KEYS.session); }
  function setSession(s){ Storage.set(KEYS.session, s); }
  function clearSession(){ Storage.remove(KEYS.session); }

  function roleList(u){ return (u?.roles || []).slice(); }
  function hasRole(u, role){ return !!roleList(u).includes(role); }

  // ==========================
  // Seed Sample Data (first run)
  // ==========================
  async function seedIfNeeded(){
    if(Storage.get(KEYS.seeded)) return; // already seeded
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
      id: uuid(), userId: 'u-emp', amount: 45.00, currency: 'USD', category: 'Meals', description: 'Team lunch', date: new Date(Date.now()-4*86400000).toISOString(),
      status: 'PENDING', receipt: { fileName: 'lunch.jpg', text: 'Lunch at cafe' },
      approvals: { stepIndex: 0, steps: DEFAULT_RULES.steps.map(r=>({ role:r, approvals:[] })) },
      createdAt: nowIso(), history: [{at: nowIso(), status:'PENDING', by: 'u-emp'}]
    });
    // Approved example (already passed steps)
    exps.push({
      id: uuid(), userId: 'u-emp', amount: 300.00, currency: 'EUR', category: 'Travel', description: 'Flight tickets', date: new Date(Date.now()-10*86400000).toISOString(),
      status: 'APPROVED', receipt: { fileName: 'flight.png', text: 'Round trip' },
      approvals: { stepIndex: 3, steps: [
        { role: ROLES.MANAGER, approvals:[{userId:'u-manager', decision:'APPROVE', comment:'OK', at: nowIso()}] },
        { role: ROLES.FINANCE, approvals:[{userId:'u-fin', decision:'APPROVE', comment:'Budgeted', at: nowIso()}] },
        { role: ROLES.DIRECTOR, approvals:[{userId:'u-dir', decision:'APPROVE', comment:'Approved', at: nowIso()}] },
      ] },
      createdAt: nowIso(), history: [{at: nowIso(), status:'APPROVED', by:'u-dir'}]
    });
    // Rejected example
    exps.push({
      id: uuid(), userId: 'u-emp', amount: 120.00, currency: 'USD', category: 'Supplies', description: 'Office chair cushion', date: new Date(Date.now()-7*86400000).toISOString(),
      status: 'REJECTED', receipt: { fileName: 'cushion.jpg', text: 'Accessory' },
      approvals: { stepIndex: 0, steps: [
        { role: ROLES.MANAGER, approvals:[{userId:'u-manager', decision:'REJECT', comment:'Not needed', at: nowIso()}] },
        { role: ROLES.FINANCE, approvals:[] },
        { role: ROLES.DIRECTOR, approvals:[] },
      ] },
      createdAt: nowIso(), history: [{at: nowIso(), status:'REJECTED', by:'u-manager'}]
    });
    setExpenses(exps);

    Storage.set(KEYS.seeded, true);
  }

  // ==========================
  // Auth
  // ==========================
  async function login(email, password){
    const users = getUsers();
    const pass = await hashText(password);
    const user = users.find(u => u.email.toLowerCase()===email.toLowerCase() && u.passwordHash===pass);
    if(!user) throw new Error('Invalid email or password');
    setSession({ userId: user.id, at: nowIso() });
    return user;
  }
  function logout(){ clearSession(); }
  function currentUser(){ const s=getSession(); if(!s) return null; return getUsers().find(u=>u.id===s.userId) || null; }

  // ==========================
  // Approval Logic
  // ==========================
  function getCurrentStep(expense){
    const rules = getRules();
    const steps = rules.steps;
    const idx = expense.approvals?.stepIndex ?? 0;
    const role = steps[idx] || null;
    return { idx, role };
  }

  function isUserApproverFor(expense, user){
    const { role } = getCurrentStep(expense);
    if(!role) return false;
    // MANAGER: only the employee's manager can approve
    if(role === ROLES.MANAGER){
      const emp = getUsers().find(u=>u.id===expense.userId);
      return emp?.managerId && user.id === emp.managerId;
    }
    // FINANCE/DIRECTOR: any user with that role (or ADMIN for override view)
    return hasRole(user, role) || hasRole(user, ROLES.ADMIN);
  }

  function recordHistory(expense, status, by){
    (expense.history ||= []).push({ at: nowIso(), status, by });
  }

  function approverEntry(expense){
    const { idx, role } = getCurrentStep(expense);
    if(role==null) return null;
    const step = expense.approvals.steps[idx];
    return step;
  }

  function rulesEval(expense){
    const rules = getRules();
    const step = approverEntry(expense);
    if(!step) return; // already finished

    // CFO override
    if(rules.specificApproverRule?.enabled){
      for(const s of expense.approvals.steps){
        for(const a of s.approvals){
          const u = getUsers().find(x=>x.id===a.userId);
          if(a.decision==='APPROVE' && u && hasRole(u, rules.specificApproverRule.role)){
            expense.status = 'APPROVED';
            expense.approvals.stepIndex = rules.steps.length; // conclude
            recordHistory(expense, 'APPROVED', u.id);
            return;
          }
        }
      }
    }

    // Percentage rule for current step
    const approvals = step.approvals || [];
    const total = approvals.length;
    const approved = approvals.filter(a=>a.decision==='APPROVE').length;
    const rejected = approvals.filter(a=>a.decision==='REJECT').length;

    if(rejected>0){
      expense.status = 'REJECTED';
      recordHistory(expense, 'REJECTED', approvals[approvals.length-1]?.userId || '');
      return;
    }

    let pass = false;
    if(rules.percentageRule?.enabled && total>0){
      const pct = (approved/total)*100;
      pass = pct >= clamp(rules.percentageRule.threshold||50,1,100);
    } else {
      // default: at least one approval moves forward
      pass = approved>0;
    }

    if(pass){
      // advance step
      const next = expense.approvals.stepIndex + 1;
      if(next >= getRules().steps.length){
        expense.status = 'APPROVED';
        recordHistory(expense, 'APPROVED', approvals[approvals.length-1]?.userId || '');
      } else {
        expense.approvals.stepIndex = next;
        // keep pending
      }
    }
  }

  function approveOrReject(expenseId, userId, decision, comment){
    const expenses = getExpenses();
    const expense = expenses.find(e=>e.id===expenseId);
    if(!expense) throw new Error('Expense not found');
    if(expense.status!=='PENDING') throw new Error('Expense is not pending');

    const step = approverEntry(expense);
    if(!step) throw new Error('No active approval step');

    step.approvals.push({ userId, decision: decision==='APPROVE'?'APPROVE':'REJECT', comment: comment||'', at: nowIso() });
    rulesEval(expense);
    setExpenses(expenses);
    return expense.status;
  }

  function adminOverride(expenseId, status, adminId){
    const expenses = getExpenses();
    const e = expenses.find(x=>x.id===expenseId);
    if(!e) throw new Error('Expense not found');
    e.status = status;
    e.approvals.stepIndex = getRules().steps.length;
    recordHistory(e, status, adminId);
    setExpenses(expenses);
  }

  // ==========================
  // Expense CRUD
  // ==========================
  function listExpensesFor(user){
    const all = getExpenses();
    if(hasRole(user, ROLES.ADMIN)) return all.slice();
    if(hasRole(user, ROLES.MANAGER)){
      const teamIds = getUsers().filter(u=>u.managerId===user.id).map(u=>u.id);
      return all.filter(e=> teamIds.includes(e.userId) || e.userId===user.id );
    }
    if(hasRole(user, ROLES.FINANCE) || hasRole(user, ROLES.DIRECTOR)){
      // approver sees all pending + their own
      return all.filter(e=> e.status==='PENDING' || e.userId===user.id);
    }
    // employee: own
    return all.filter(e=>e.userId===user.id);
  }

  function canCurrentUserSubmitExpense(user){ return hasRole(user, ROLES.EMPLOYEE); }

  function addExpense(exp){
    const expenses = getExpenses();
    expenses.unshift(exp);
    setExpenses(expenses);
  }

  // ==========================
  // UI Rendering
  // ==========================
  function setActiveView(id){
    $$('.view').forEach(v=>v.classList.add('hidden'));
    $('#'+id).classList.remove('hidden');
    $$('.nav-item').forEach(b=> b.classList.toggle('active', b.dataset.view===id));
  }

  function applyRoleVisibility(user){
    $$('#sidebar [data-role]').forEach(el=>{
      const need = (el.dataset.role||'').split(',').map(s=>s.trim()).filter(Boolean);
      el.style.display = need.some(r=> hasRole(user, r)) ? '' : 'none';
    });
    // New expense button
    if($('#new-expense-btn')) $('#new-expense-btn').style.display = canCurrentUserSubmitExpense(user) ? '' : 'none';
  }

  function setHeaderContext(user){
    const company = getCompany();
    $('#company-badge').textContent = `${company?.name || '—'} · ${company?.currencyCode || ''}`;
    $('#current-user').textContent = `${user.name} (${roleList(user).join(', ')})`;
  }

  function cardEl(title, value, icon){
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<h4>${title}</h4><div class="value"><i class="fa-solid ${icon}"></i> ${value}</div>`;
    return el;
  }

  async function renderDashboard(user){
    const wrap = $('#dashboard-cards');
    wrap.innerHTML='';
    const all = listExpensesFor(user);
    const pendingMine = all.filter(e=> e.userId===user.id && e.status==='PENDING').length;
    const myTotal = all.filter(e=> e.userId===user.id).length;
    const companyAll = hasRole(user, ROLES.ADMIN) ? getExpenses().length : all.length;
    const pendingToApprove = listExpensesFor(user).filter(e=> isUserApproverFor(e, user) && e.status==='PENDING').length;

    wrap.append(
      cardEl('My Pending Expenses', pendingMine, 'fa-hourglass-half'),
      cardEl('My Expenses', myTotal, 'fa-file-invoice-dollar'),
      cardEl('Pending to Approve', pendingToApprove, 'fa-check-double'),
      cardEl('Total Visible Expenses', companyAll, 'fa-list')
    );

    // Recent activity
    const act = $('#recent-activity');
    const recent = getExpenses().slice(0,6);
    act.innerHTML = recent.map(e=>{
      const u = getUsers().find(x=>x.id===e.userId);
      return `<div class="activity-item">
        <span class="badge">${e.status}</span>
        <span>${fmtDate(e.date)} - ${u?.name || 'Unknown'} - ${e.category}: ${e.description}</span>
      </div>`;
    }).join('');
  }

  async function renderExpensesView(user){
    // Populate currency select
    const ccys = await fetchCountries();
    const cset = new Set();
    $('#exp-currency').innerHTML = ccys.filter(c=>{ if(cset.has(c.currencyCode)) return false; cset.add(c.currencyCode); return true; })
      .map(c=>`<option value="${c.currencyCode}">${c.currencyCode} ${c.currencySymbol!==c.currencyCode?`(${c.currencySymbol})`:''}</option>`).join('');

    const tbody = $('#expenses-table tbody');
    function applyFilters(rows){
      const q = ($('#exp-search').value||'').toLowerCase();
      const st = $('#exp-status-filter').value;
      const cat = $('#exp-category-filter').value;
      const df = $('#exp-date-from').value; const dt = $('#exp-date-to').value;
      return rows.filter(r=>{
        if(q && !(`${r.description} ${r.category}`.toLowerCase().includes(q))) return false;
        if(st && r.status!==st) return false;
        if(cat && r.category!==cat) return false;
        if(df && new Date(r.date) < new Date(df)) return false;
        if(dt && new Date(r.date) > new Date(dt)) return false;
        return true;
      });
    }

    async function draw(){
      const rows = listExpensesFor(user);
      const filtered = applyFilters(rows);
      const company = getCompany();
      const items = await Promise.all(filtered.map(async e=>{
        const amountC = await convert(e.amount, e.currency, company.currencyCode);
        const emp = getUsers().find(u=>u.id===e.userId);
        const approver = isUserApproverFor(e, user) && e.status==='PENDING';
        const adminAct = hasRole(user, ROLES.ADMIN) && e.status==='PENDING';
        return `<tr data-id="${e.id}">
          <td>${fmtDate(e.date)}</td>
          <td>${emp?.name || '-'}</td>
          <td>${e.category}</td>
          <td title="${e.receipt?.text||''}">${e.description}</td>
          <td>${moneyFmt(e.amount, e.currency)}</td>
          <td>${moneyFmt(amountC, company.currencyCode)}</td>
          <td><span class="status ${e.status}">${e.status}</span></td>
          <td>
            ${approver?`<button class="btn btn-primary btn-approve" title="Approve">Approve</button> <button class="btn btn-ghost btn-reject" title="Reject">Reject</button>`:''}
            ${adminAct?`<button class="btn btn-ghost btn-ovr-approve" title="Admin Approve">Override ✓</button> <button class="btn btn-ghost btn-ovr-reject" title="Admin Reject">Override ✗</button>`:''}
          </td>
        </tr>`;
      }));
      tbody.innerHTML = items.join('');
    }

    // Bind filters once
    ['exp-search','exp-status-filter','exp-category-filter','exp-date-from','exp-date-to'].forEach(id=> on($('#'+id),'input', draw));

    // Row actions
    on(tbody,'click', (e)=>{
      const tr = e.target.closest('tr'); if(!tr) return; const id = tr.dataset.id;
      if(e.target.classList.contains('btn-approve')){ openApproval('APPROVE', id); }
      if(e.target.classList.contains('btn-reject')){ openApproval('REJECT', id); }
      if(e.target.classList.contains('btn-ovr-approve')){ try{ adminOverride(id,'APPROVED', currentUser().id); toast('Approved by admin','success'); draw(); renderDashboard(currentUser()); }catch(err){ toast(err.message,'error'); } }
      if(e.target.classList.contains('btn-ovr-reject')){ try{ adminOverride(id,'REJECTED', currentUser().id); toast('Rejected by admin','success'); draw(); renderDashboard(currentUser()); }catch(err){ toast(err.message,'error'); } }
    });

    await draw();
  }

  async function renderApprovalsView(user){
    const tbody = $('#approvals-table tbody');

    async function draw(){
      const rows = listExpensesFor(user).filter(e=> isUserApproverFor(e, user) && e.status==='PENDING');
      const items = rows.map(e=>{
        const emp = getUsers().find(u=>u.id===e.userId);
        const step = getCurrentStep(e);
        return `<tr data-id="${e.id}">
          <td>${fmtDate(e.date)}</td>
          <td>${emp?.name||'-'}</td>
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

    on(tbody,'click',(e)=>{
      const tr = e.target.closest('tr'); if(!tr) return; const id = tr.dataset.id;
      if(e.target.classList.contains('btn-approve')) openApproval('APPROVE', id);
      if(e.target.classList.contains('btn-reject')) openApproval('REJECT', id);
    });

    await draw();
  }

  function populateManagerSelect(){
    const sel = $('#user-manager'); if(!sel) return;
    const managers = getUsers().filter(u=> hasRole(u, ROLES.MANAGER));
    sel.innerHTML = `<option value="">— None —</option>` + managers.map(m=>`<option value="${m.id}">${m.name}</option>`).join('');
  }

  function openUserModal(existing){
    $('#user-modal-title').textContent = existing? 'Edit User' : 'Add User';
    $('#user-id').value = existing?.id || '';
    $('#user-name').value = existing?.name || '';
    $('#user-email').value = existing?.email || '';
    $('#user-password').value = '';
    $$('.role-checkbox').forEach(cb=> cb.checked = existing? (existing.roles||[]).includes(cb.value) : false);
    // Manager field visibility
    const updateMgrVis = ()=>{
      const employeeChecked = $$('.role-checkbox').find(cb=>cb.value===ROLES.EMPLOYEE)?.checked;
      $('#manager-select-wrap').classList.toggle('hidden', !employeeChecked);
    };
    $$('.role-checkbox').forEach(cb=> on(cb,'change', updateMgrVis));
    updateMgrVis();
    populateManagerSelect();
    $('#user-manager').value = existing?.managerId || '';
    openModal('user-modal');
  }

  function renderUsersView(){
    const tbody = $('#users-table tbody');
    const users = getUsers();
    tbody.innerHTML = users.map(u=>{
      const mgr = users.find(x=>x.id===u.managerId);
      return `<tr data-id="${u.id}">
        <td>${u.name}</td>
        <td>${u.email}</td>
        <td>${(u.roles||[]).join(', ')}</td>
        <td>${mgr? mgr.name : '-'}</td>
        <td>
          <button class="btn btn-ghost btn-edit"><i class="fa-solid fa-pen"></i></button>
          ${u.id==='u-admin'? '' : '<button class="btn btn-ghost btn-del"><i class="fa-solid fa-trash"></i></button>'}
        </td>
      </tr>`;
    }).join('');

    on(tbody,'click', (e)=>{
      const tr = e.target.closest('tr'); if(!tr) return; const id = tr.dataset.id; const u = getUsers().find(x=>x.id===id);
      if(e.target.closest('.btn-edit')) openUserModal(u);
      if(e.target.closest('.btn-del')){
        if(confirm('Delete this user?')){
          const list = getUsers().filter(x=>x.id!==id);
          // Cleanup manager references
          list.forEach(x=>{ if(x.managerId===id) x.managerId = ''; });
          setUsers(list); toast('User deleted','success'); renderUsersView();
        }
      }
    });
  }

  function loadRulesIntoForm(){
    const r = getRules();
    $('#rule-percentage-enabled').checked = !!r.percentageRule?.enabled;
    $('#rule-percentage-threshold').value = r.percentageRule?.threshold ?? 50;
    $('#rule-cfo-enabled').checked = !!r.specificApproverRule?.enabled;
    $('#rule-hybrid-enabled').checked = !!r.hybrid?.enabled;
  }

  // ==========================
  // Modal flows
  // ==========================
  function openApproval(decision, expenseId){
    $('#approval-decision').value = decision;
    $('#approval-expense-id').value = expenseId;
    $('#approval-comment').value = '';
    openModal('approval-modal');
  }

  async function handleApprovalSubmit(e){
    e.preventDefault();
    const decision = $('#approval-decision').value;
    const expenseId = $('#approval-expense-id').value;
    const comment = $('#approval-comment').value;
    try{
      const status = approveOrReject(expenseId, currentUser().id, decision, comment);
      toast(`Expense ${status.toLowerCase()}`,'success');
      closeModal('approval-modal');
      renderApprovalsView(currentUser());
      renderExpensesView(currentUser());
      renderDashboard(currentUser());
    }catch(err){ toast(err.message,'error'); }
  }

  function openExpenseModal(){
    $('#expense-modal-title').textContent = 'New Expense';
    $('#exp-amount').value = '';
    $('#exp-currency').value = getCompany()?.currencyCode || 'USD';
    $('#exp-category').value = 'Travel';
    $('#exp-date').valueAsDate = new Date();
    $('#exp-description').value = '';
    $('#exp-receipt').value = '';
    openModal('expense-modal');
  }

  function simulateOCR(){
    const file = $('#exp-receipt').files?.[0];
    let text = '';
    if(file){
      // basic simulation using filename and size
      const name = file.name.replace(/\.[^.]+$/, '');
      text = `Receipt: ${name} · ${Math.round(file.size/1024)}KB · ${file.type}`;
    } else {
      text = 'Receipt: No image provided';
    }
    const cur = $('#exp-description').value;
    $('#exp-description').value = cur ? `${cur}\n${text}` : text;
    toast('OCR simulated: text extracted','info');
  }

  async function handleExpenseSubmit(e){
    e.preventDefault(); const user = currentUser(); if(!user) return;
    const amount = parseFloat($('#exp-amount').value);
    const currency = $('#exp-currency').value;
    const category = $('#exp-category').value;
    const date = new Date($('#exp-date').valueAsDate || new Date()).toISOString();
    const description = ($('#exp-description').value||'').trim();
    const file = $('#exp-receipt').files?.[0];
    const receipt = file? { fileName: file.name, text: (description.match(/Receipt:[\s\S]+$/m)?.[0] || '') } : { fileName: '', text: '' };

    const exp = {
      id: uuid(), userId: user.id, amount, currency, category, description, date,
      status: 'PENDING', receipt,
      approvals: { stepIndex: 0, steps: getRules().steps.map(r=>({ role:r, approvals:[] })) },
      createdAt: nowIso(), history: [{ at: nowIso(), status:'PENDING', by: user.id }]
    };
    addExpense(exp);
    toast('Expense submitted','success');
    closeModal('expense-modal');
    renderExpensesView(user); renderDashboard(user);
  }

  async function handleCompanySetup(e){
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
    users.push({ id: uuid(), name: uname, email, roles:[ROLES.ADMIN], managerId:'', passwordHash: await hashText(pass), createdAt: nowIso() });
    setUsers(users);
    toast('Company setup completed. You can now sign in.','success');
    closeModal('company-setup-modal');
  }

  // ==========================
  // Navigation & Bindings
  // ==========================
  function bindNavigation(){
    on($('#sidebar-toggle'),'click', ()=> $('#sidebar').classList.toggle('open'));
    $$('#sidebar .nav-item').forEach(btn=> on(btn,'click', ()=>{
      setActiveView(btn.dataset.view);
      $$('#sidebar .nav-item').forEach(b=> b.classList.toggle('active', b===btn));
      if(window.innerWidth<980) $('#sidebar').classList.remove('open');
    }));
  }

  function bindAuth(){
    on($('#login-form'),'submit', async (e)=>{
      e.preventDefault();
      const email = $('#login-email').value.trim();
      const password = $('#login-password').value;
      try{
        const user = await login(email, password);
        toast('Welcome back','success');
        enterApp(user);
      }catch(err){ toast(err.message,'error'); }
    });
    on($('#open-setup-btn'),'click', async ()=>{
      // load countries
      const list = await fetchCountries();
      const countries = Array.from(new Map(list.map(i=>[i.country,i])).values());
      $('#setup-country').innerHTML = countries.map(c=>`<option value="${c.country}" data-ccy="${c.currencyCode}" data-symbol="${c.currencySymbol}">${c.country}</option>`).join('');
      on($('#setup-country'),'change', (e)=>{ const opt=e.target.selectedOptions[0]; $('#setup-currency').value = opt?.dataset?.ccy || 'USD'; });
      // default currency
      const first = countries[0]; $('#setup-currency').value = first? first.currencyCode : 'USD';
      openModal('company-setup-modal');
    });
  }

  function bindModals(){
    on($('#expense-form'),'submit', handleExpenseSubmit);
    on($('#btn-ocr'),'click', simulateOCR);
    on($('#approval-form'),'submit', handleApprovalSubmit);

    on($('#add-user-btn'),'click', ()=> openUserModal(null));
    on($('#user-form'),'submit', async (e)=>{
      e.preventDefault();
      const id = $('#user-id').value.trim();
      const name = $('#user-name').value.trim();
      const email = $('#user-email').value.trim();
      const pwd = $('#user-password').value;
      const roles = $$('.role-checkbox').filter(cb=>cb.checked).map(cb=>cb.value);
      const managerId = $('#user-manager').value;
      const list = getUsers();
      if(id){
        const u = list.find(x=>x.id===id);
        u.name = name; u.email = email; u.roles = roles; u.managerId = managerId;
        if(pwd) u.passwordHash = await hashText(pwd);
      }else{
        list.push({ id: uuid(), name, email, roles, managerId, passwordHash: await hashText(pwd || 'changeme'), createdAt: nowIso() });
      }
      setUsers(list);
      toast('User saved','success');
      closeModal('user-modal');
      renderUsersView();
      renderApprovalsView(currentUser());
    });
  }

  async function enterApp(user){
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

  function bindRulesForm(){
    on($('#rules-form'),'submit', (e)=>{
      e.preventDefault();
      const r = getRules();
      r.percentageRule.enabled = $('#rule-percentage-enabled').checked;
      r.percentageRule.threshold = clamp(parseInt($('#rule-percentage-threshold').value||'50',10),1,100);
      r.specificApproverRule.enabled = $('#rule-cfo-enabled').checked;
      r.hybrid.enabled = $('#rule-hybrid-enabled').checked;
      setRules(r); toast('Rules updated','success');
    });
  }

  function bindLogout(){ on($('#logout-btn'),'click', ()=>{ logout(); location.reload(); }); }

  // ==========================
  // Boot
  // ==========================
  (async function init(){
    await seedIfNeeded();
    bindNavigation();
    bindAuth();
    bindModals();
    bindRulesForm();
    bindLogout();

    const sessionUser = currentUser();
    if(sessionUser){ enterApp(sessionUser); }
  })();

})();
