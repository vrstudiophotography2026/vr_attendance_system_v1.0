// Loaded AFTER index.html's script. Connects the UI to the real API.
(() => {
  const $ = id => document.getElementById(id);
  let token = null, es = null, poll = null, pendingRole = 'admin', authedRole = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const api = async (path, method = 'GET', body) => {
    const r = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
      body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 404 && !j.error)
      throw new Error('Server does not have this feature yet (404). Replace server.js with the latest version and restart the server.');
    if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
    return j;
  };

  // ---------- toast notifications ----------
  document.body.insertAdjacentHTML('beforeend',
    `<div id="toast-wrap" class="fixed top-20 right-4 z-[80] space-y-3 w-80 max-w-[calc(100vw-2rem)]"></div>`);

  // kind: ok (green) | bad (red) | info (blue). Stays until closed.
  function toast(title, msg, kind, onClose) {
    const styles = {
      ok:   { box: 'bg-emerald-50 border-emerald-400', t: 'text-emerald-800', icon: 'fa-circle-check text-emerald-600' },
      bad:  { box: 'bg-rose-50 border-rose-400',       t: 'text-rose-800',    icon: 'fa-circle-xmark text-rose-600' },
      info: { box: 'bg-blue-50 border-blue-400',       t: 'text-blue-800',    icon: 'fa-circle-info text-blue-600' }
    }[kind || 'info'];
    const el = document.createElement('div');
    el.className = `toast-in border-l-4 rounded-xl shadow-lg p-4 flex gap-3 ${styles.box}`;
    el.innerHTML = `<i class="fa-solid ${styles.icon} text-xl mt-0.5"></i>
      <div class="flex-1 min-w-0">
        <div class="font-bold text-sm ${styles.t}"></div>
        <div class="text-xs text-slate-600 mt-0.5"></div>
      </div>
      <button type="button" class="text-slate-400 hover:text-slate-700 self-start"><i class="fa-solid fa-xmark"></i></button>`;
    el.children[1].children[0].textContent = title;
    el.children[1].children[1].textContent = msg;
    el.querySelector('button').onclick = () => { el.remove(); if (onClose) onClose(); };
    $('toast-wrap').appendChild(el);
  }

  // Employee: show a pop-up for every leave decision they have not seen yet
  const shownDecisions = new Set();
  function checkLeaveNotifications() {
    if (currentRole === 'admin') return;
    db.leaveRequests
      .filter(r => r.status !== 'PENDING' && !r.seen && !shownDecisions.has(r.id + ':' + r.status))
      .forEach(r => {
        shownDecisions.add(r.id + ':' + r.status);
        const ok = r.status === 'APPROVED';
        toast(
          ok ? 'Leave Approved' : 'Leave Rejected',
          `Your ${r.type} request (${r.startDate} to ${r.endDate}) was ${ok ? 'approved' : 'rejected'} by the administrator.`,
          ok ? 'ok' : 'bad',
          () => api(`/leaves/${r.id}/seen`, 'PATCH').catch(() => {})   // marked as seen when closed
        );
      });
  }

  // ---------- data sync ----------
  async function refresh() {
    db = await api('/data');
    serverOffset = (db.serverNow || Date.now()) - Date.now();   // keeps break timers in step with the server clock
  }
  function rerender() {
    if (currentRole === 'admin') {
      renderAdminDashboard(); renderEmployeeDirectory(); renderAttendanceLogs();
      renderLeaveRequests(); renderPayrollReport();
    } else {
      renderEmployeePortal(currentRole);
      checkLeaveNotifications();
    }
  }
  async function act(fn) {
    let err;
    try { await fn(); } catch (e) { err = e; }
    try { await refresh(); rerender(); } catch {}   // always resync the screen with the server
    if (err) alert(err.message);
  }
  function connectLive() {
    if (es) es.close();
    es = new EventSource('/api/events?token=' + token);
    es.onmessage = () => refresh().then(rerender).catch(() => {});
  }

  // ---------- login modal (admin: username + password, employee: password only) ----------
  document.body.insertAdjacentHTML('beforeend', `
  <div id="modal-login" style="top:64px" class="fixed inset-x-0 bottom-0 bg-slate-900/80 hidden z-[60] flex items-center justify-center p-4">
    <div class="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-sm w-full overflow-hidden">
      <div class="bg-slate-900 px-6 py-4 text-white flex items-center">
        <i class="fa-solid fa-lock text-blue-400 mr-2"></i>
        <h3 id="login-title" class="font-bold text-base">Login</h3>
      </div>
      <form id="form-login" class="p-6 space-y-4">
        <div id="login-user-wrap"><label class="block text-xs font-bold text-slate-700 uppercase mb-1">Username</label>
          <input id="login-user" autocomplete="off" class="w-full border border-slate-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"></div>
        <div><label class="block text-xs font-bold text-slate-700 uppercase mb-1">Password</label>
          <input id="login-pass" type="password" required class="w-full border border-slate-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"></div>
        <p id="login-error" class="text-xs text-rose-600 font-semibold hidden"></p>
        <p id="login-hint" class="text-[11px] text-slate-400"></p>
        <div class="pt-1 flex justify-end space-x-3">
          <button type="button" id="login-cancel" class="px-4 py-2 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-100">Cancel</button>
          <button type="submit" class="px-5 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 shadow-sm">Login</button>
        </div>
      </form>
    </div>
  </div>`);

  const setAppVisible = v => {
    $('admin-nav-bar').style.visibility = v ? '' : 'hidden';
    document.querySelector('main').style.visibility = v ? '' : 'hidden';
  };

  function showLogin(role) {
    pendingRole = role;
    const isAdmin = role === 'admin';
    const sel = $('portal-role-select');
    const name = isAdmin ? 'Administrator' : (sel.selectedOptions[0]?.text || role).replace(/^Employee: /, '');
    $('login-title').innerText = 'Login — ' + name;
    $('login-user-wrap').style.display = isAdmin ? '' : 'none';   // employees: password only
    $('login-user').required = isAdmin;
    $('login-user').value = ''; $('login-pass').value = '';
    $('login-error').classList.add('hidden');
    $('login-hint').innerHTML = isAdmin
      ? 'Not the administrator? Choose your name from the <b>Mode</b> switch at the top right.'
      : 'Enter your password. Wrong profile? Use the <b>Mode</b> switch at the top right to pick another.';
    $('login-cancel').style.display = authedRole ? '' : 'none'; // first login can't be skipped
    $('modal-login').classList.remove('hidden');
    (isAdmin ? $('login-user') : $('login-pass')).focus();
  }

  $('login-cancel').onclick = () => {
    $('modal-login').classList.add('hidden');
    $('portal-role-select').value = authedRole; // revert dropdown
  };

  const origSwitch = window.switchPortalMode;
  window.switchPortalMode = () => showLogin($('portal-role-select').value);

  $('form-login').onsubmit = async e => {
    e.preventDefault();
    try {
      const body = pendingRole === 'admin'
        ? { as: 'admin', username: $('login-user').value.trim(), password: $('login-pass').value }
        : { as: pendingRole, password: $('login-pass').value };
      const r = await api('/login', 'POST', body);
      token = r.token; currentRole = pendingRole; authedRole = pendingRole;
      $('toast-wrap').innerHTML = ''; shownDecisions.clear();   // fresh notifications for the new user
      await refresh(); connectLive();
      clearInterval(poll);
      poll = setInterval(() => refresh().then(rerender).catch(() => {}), 15000); // fallback if live stream drops
      $('modal-login').classList.add('hidden');
      setAppVisible(true);
      origSwitch(); // original view-toggle logic
      checkLeaveNotifications();
    } catch (err) {
      $('login-error').innerText = err.message;
      $('login-error').classList.remove('hidden');
    }
  };

  // ---------- Mode dropdown: Administrator + employees from DB ----------
  window.populateRoleDropdown = async () => {
    const sel = $('portal-role-select'), keep = sel.value || 'admin';
    const list = await fetch('/api/public/employees').then(r => r.json());
    sel.innerHTML = '<option value="admin">Administrator View</option>' +
      list.map(e => `<option value="${e.id}">Employee: ${e.name} (${e.id})</option>`).join('');
    sel.value = [...sel.options].some(o => o.value === keep) ? keep : 'admin';
  };

  // ---------- Staff register / edit / delete ----------
  window.handleEmployeeFormSubmit = async e => {
    e.preventDefault();
    const id = $('emp-form-id').value;
    const errEl = $('emp-form-error');
    const fail = msg => { errEl.innerText = msg; errEl.classList.remove('hidden'); };
    errEl.classList.add('hidden');

    const body = {
      name: $('emp-form-name').value.trim(),
      password: $('emp-form-pass').value,
      role: $('emp-form-role').value.trim(),
      hourlyRate: parseFloat($('emp-form-rate').value),
      workStart: getTime12('emp-form-start'),
      workEnd: getTime12('emp-form-end')
    };

    // Exact, field-specific messages (the popup stays open until it saves)
    if (!body.name) return fail('Full name is required.');
    if (!body.role) return fail('Role title is required.');
    if (!(body.hourlyRate > 0)) return fail('Enter a valid hourly rate greater than 0.');
    if (!id && !body.password) return fail('Password is required for a new employee.');

    try {
      await (id ? api('/employees/' + id, 'PUT', body) : api('/employees', 'POST', body));
    } catch (ex) {
      return fail(ex.message);
    }
    try { await refresh(); rerender(); } catch {}
    closeModal('modal-employee');
    populateRoleDropdown();
  };

  window.deleteEmployee = async id => {
    if (!confirm(`Remove employee ${id}? Their logs and leaves will also be deleted.`)) return;
    await act(() => api('/employees/' + id, 'DELETE'));
    populateRoleDropdown();
  };

  // ---------- attendance / leaves / punches ----------
  window.handleManualLogSubmit = async e => {
    e.preventDefault();
    await act(() => api('/attendance', 'POST', {
      empId: $('manual-log-emp-id').value, date: $('manual-log-date').value,
      clockIn: getTime12('manual-log-in'), clockOut: getTime12('manual-log-out'),
      status: $('manual-log-status').value
    }));
    closeModal('modal-manual-log');
  };
  window.deleteLog = async id => { if (confirm('Delete this attendance log?')) await act(() => api('/attendance/' + id, 'DELETE')); };
  window.updateLeaveStatus = (id, status) => act(() => api('/leaves/' + id, 'PATCH', { status }));

  let busy = false;
  async function punch(path) {
    if (currentRole === 'admin' || busy) return;      // ignore double clicks
    busy = true;
    ['btn-clock-in', 'btn-clock-out'].forEach(id => $(id).disabled = true);
    const ov = $('scanner-overlay');
    ov.classList.remove('hidden'); ov.classList.add('flex');
    await sleep(700);
    ov.classList.add('hidden'); ov.classList.remove('flex');
    await act(() => api(path, 'POST'));
    busy = false;
    rerender();                                        // re-evaluate which button should be enabled
  }
  window.simulateClockIn = () => punch('/clock-in');
  window.simulateClockOut = () => punch('/clock-out');

  // ---------- Overtime (employee enters the exact timing, e.g. 09:00 PM - 09:30 PM) ----------
  window.openOvertimeModal = () => {
    if (currentRole === 'admin') return;
    const el = $('ot-form-error'); el.innerText = ''; el.classList.add('hidden');
    setTime12('ot-form-start', '21:00');
    setTime12('ot-form-end', '21:30');
    openModal('modal-overtime');
  };

  window.handleOvertimeSubmit = async e => {
    e.preventDefault();
    const errEl = $('ot-form-error');
    const fail = msg => { errEl.innerText = msg; errEl.classList.remove('hidden'); };
    errEl.classList.add('hidden');
    const start = getTime12('ot-form-start'), end = getTime12('ot-form-end');
    if (end <= start) return fail('End time must be after the start time.');
    try {
      await api('/overtime', 'POST', { start, end });
    } catch (ex) {
      return fail(ex.message);                         // keep the popup open on error
    }
    try { await refresh(); rerender(); } catch {}
    closeModal('modal-overtime');
    toast('Overtime recorded', `${fmt12(start)} – ${fmt12(end)} added to today's attendance.`, 'ok');
  };

  // ---------- Break (30 min) / Lunch (1 hr): click to start, click again to end ----------
  window.toggleBreak = async kind => {
    if (currentRole === 'admin') return;
    const log = db.attendanceLogs.find(l => l.empId === currentRole && l.date === getTodayISO());
    const active = log && (log.breakSlots || []).find(b => !b.end);
    await act(() => api(active ? '/break/end' : '/break/start', 'POST', { kind }));
  };

  // ---------- Sudden leave (no application: today turns red with status LEAVE) ----------
  window.markLeaveToday = async () => {
    if (currentRole === 'admin') return;
    if (!confirm('Mark yourself on LEAVE for today?\n\nYou will not be able to punch in today.')) return;
    let err;
    try { await api('/leave-today', 'POST'); } catch (e) { err = e; }
    try { await refresh(); rerender(); } catch {}
    if (err) alert(err.message);
    else toast('You are on leave today', 'Your status for today is now LEAVE.', 'info');
  };

  window.handleApplyLeaveSubmit = async e => {
    e.preventDefault();
    try {
      await api('/leaves', 'POST', {
        type: $('leave-form-type').value, startDate: $('leave-form-start').value,
        endDate: $('leave-form-end').value, reason: $('leave-form-reason').value.trim()
      });
    } catch (ex) {
      return alert(ex.message);                        // keep the form open on error
    }
    try { await refresh(); rerender(); } catch {}
    closeModal('modal-apply-leave');
    toast('Leave request submitted', 'Waiting for the administrator to approve or reject it.', 'info');
  };

  // ---------- startup: force admin login first ----------
  window.onload = async () => {
    setupLiveClocks();
    const today = getTodayISO();
    $('filter-log-date').value = today;
    $('payroll-month-select').value = today.substring(0, 7);
    $('emp-month-select').value = today.substring(0, 7);
    setAppVisible(false);
    await populateRoleDropdown();
    $('portal-role-select').value = 'admin';
    showLogin('admin');
  };
})();