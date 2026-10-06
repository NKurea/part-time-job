(function () {
	'use strict';

	var C = window.BaitoCalc;
	var SCOPE_READ = 'https://www.googleapis.com/auth/calendar.events.readonly';
	var SCOPE_WRITE = 'https://www.googleapis.com/auth/calendar.events';
	var API = 'https://www.googleapis.com/calendar/v3/';
	var REMINDER_TAG = 'senbikiya-shift-reminder';
	var WEEK = ['日', '月', '火', '水', '木', '金', '土'];

	// ---- storage -----------------------------------------------------------
	function load(key, fallback) {
		try {
			var v = localStorage.getItem('baito.' + key);
			return v == null ? fallback : JSON.parse(v);
		} catch (e) { return fallback; }
	}
	function save(key, value) {
		try { localStorage.setItem('baito.' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
	}

	var today = new Date();
	var state = {
		view: load('view', 'month'),
		year: today.getFullYear(),
		month: today.getMonth() + 1,
		cache: load('cache', {}), // { [year]: { fetchedAt, events: [] } }
		token: null,              // { access_token, expires_at, scope }
		syncing: false
	};

	var $ = function (id) { return document.getElementById(id); };

	// ---- format ------------------------------------------------------------
	function yen(n) { return '¥' + Math.round(n).toLocaleString('ja-JP'); }
	function pad(n) { return (n < 10 ? '0' : '') + n; }
	function hm(min) {
		var h = Math.floor(min / 60), m = min % 60;
		return h + '時間' + (m ? m + '分' : '');
	}
	function clock(d) { return d.getHours() + ':' + pad(d.getMinutes()); }
	function md(d) { return (d.getMonth() + 1) + '/' + d.getDate() + '(' + WEEK[d.getDay()] + ')'; }
	function esc(s) {
		return String(s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}
	function jobColor(job) { return 'var(--' + job.id + ', ' + job.color + ')'; }

	var toastTimer;
	function toast(msg) {
		var t = $('toast');
		t.textContent = msg;
		t.classList.add('show');
		clearTimeout(toastTimer);
		toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3200);
	}

	// ---- data --------------------------------------------------------------
	function allShifts() {
		var events = [];
		Object.keys(state.cache).forEach(function (y) { events = events.concat(state.cache[y].events); });
		return C.toShifts(events, new Date());
	}

	// ---- render ------------------------------------------------------------
	function render() {
		document.querySelectorAll('.segmented button').forEach(function (b) {
			b.setAttribute('aria-selected', String(b.dataset.view === state.view));
		});
		$('periodLabel').textContent = state.view === 'month'
			? state.year + '年' + state.month + '月'
			: state.year + '年';

		renderReminder();

		var shifts = allShifts();
		var html = '';
		if (!state.cache[state.year]) {
			html += renderNoData();
		}
		if (state.view === 'month') {
			html += renderMonth(C.inMonth(shifts, state.year, state.month));
		} else {
			html += renderYear(C.inYear(shifts, state.year));
		}
		$('content').innerHTML = html;

		var c = state.cache[state.year];
		$('syncStatus').textContent = c
			? state.year + '年の予定を ' + new Date(c.fetchedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' に同期'
			: '';
		$('syncBtn').classList.toggle('spinning', state.syncing);
	}

	function renderNoData() {
		var hasClient = !!load('clientId', '');
		return '<div class="card empty">' +
			(hasClient
				? '<p>' + state.year + '年の予定はまだ読み込まれていません。</p><button class="btn primary" data-action="sync">Googleカレンダーと同期</button>'
				: '<p>Googleカレンダーと連携すると、アルバイトの予定から給与見込を計算します。</p><button class="btn primary" data-action="settings">連携を設定する</button>') +
			'</div>';
	}

	function renderHero(sum, label) {
		var t = sum.total;
		var donePct = t.total ? Math.round(t.doneTotal / t.total * 100) : 0;
		return '<section class="card hero">' +
			'<div class="label">' + label + '（交通費込）</div>' +
			'<div class="amount num"><small>¥</small>' + Math.round(t.total).toLocaleString('ja-JP') + '</div>' +
			'<dl class="stats num">' +
				'<div><dt>給与</dt><dd>' + yen(t.wage) + '</dd></div>' +
				'<div><dt>交通費</dt><dd>' + yen(t.transport) + '</dd></div>' +
				'<div><dt>労働時間</dt><dd>' + hm(t.workMin) + '</dd></div>' +
				'<div><dt>出勤</dt><dd>' + t.days + '日</dd></div>' +
			'</dl>' +
			(t.total ? '<div class="progress"><div class="progress-bar"><span style="width:' + donePct + '%"></span></div>' +
				'<div class="progress-legend num"><span>勤務済み <b>' + yen(t.doneTotal) + '</b></span><span>これから <b>' + yen(t.plannedTotal) + '</b></span></div></div>' : '') +
			'</section>';
	}

	function rateText(job, shifts) {
		var rates = {};
		shifts.forEach(function (s) { if (s.jobId === job.id) rates[s.rate] = true; });
		var list = Object.keys(rates).map(Number).sort(function (a, b) { return a - b; });
		if (!list.length) {
			var key = state.view === 'month'
				? state.year + '-' + pad(state.month) + '-01'
				: state.year + '-12-31';
			list = [C.rateFor(job, key)];
		}
		return '時給 ' + list.map(function (r) { return r.toLocaleString('ja-JP'); }).join(' / ') + '円';
	}

	function renderJobs(sum, shifts) {
		return '<div class="jobs">' + C.JOBS.map(function (job) {
			var t = sum.byJob[job.id];
			return '<section class="card">' +
				'<div class="job-name"><span class="dot" style="background:' + jobColor(job) + '"></span>' + esc(job.name) + '</div>' +
				'<div class="job-amount num">' + yen(t.total) + '</div>' +
				'<div class="job-meta num">' + t.days + '日・' + hm(t.workMin) + '<br>' + rateText(job, shifts) +
				(t.transport ? '<br>交通費 ' + yen(t.transport) : '') + '</div>' +
				'</section>';
		}).join('') + '</div>';
	}

	function renderMonth(shifts) {
		var sum = C.summarize(shifts);
		var html = renderHero(sum, state.month + '月の給与見込') + renderJobs(sum, shifts);
		html += '<h2 class="section-title">シフト（' + shifts.length + '件）</h2>';
		if (!shifts.length) {
			return html + '<div class="card empty"><p>この月のアルバイト予定はありません。</p></div>';
		}
		html += '<section class="card"><ul class="shift-list">' + shifts.map(function (s) {
			var job = C.jobById(s.jobId);
			var dow = s.start.getDay();
			var dowClass = dow === 0 ? 'sun' : dow === 6 ? 'sat' : '';
			return '<li class="shift">' +
				'<div class="shift-date"><b class="num">' + s.start.getDate() + '</b><span class="' + dowClass + '">' + WEEK[dow] + '</span></div>' +
				'<div class="shift-main">' +
					'<div class="shift-title"><span class="dot" style="background:' + jobColor(job) + '"></span>' + esc(job.name) +
						(s.done ? '' : ' <span class="tag">予定</span>') + '</div>' +
					'<div class="shift-sub num">' + clock(s.start) + '–' + clock(s.end) +
						'・実働 ' + Math.floor(s.workMin / 60) + ':' + pad(s.workMin % 60) +
						(s.breakMin ? '（休憩' + s.breakMin + '分）' : '') + '</div>' +
				'</div>' +
				'<div class="shift-pay num">' + yen(s.wage + s.transport) +
					'<small>' + s.rate.toLocaleString('ja-JP') + '円/h' + (s.transport ? '＋交通費' : '') + '</small></div>' +
				'</li>';
		}).join('') + '</ul></section>';
		return html;
	}

	function renderYear(shifts) {
		var sum = C.summarize(shifts);
		var html = renderHero(sum, state.year + '年の給与見込') + renderJobs(sum, shifts);
		var months = [];
		var max = 0;
		for (var m = 1; m <= 12; m++) {
			var s = C.summarize(C.inMonth(shifts, state.year, m));
			months.push(s);
			if (s.total.total > max) max = s.total.total;
		}
		var curKey = today.getFullYear() === state.year ? today.getMonth() + 1 : 0;
		html += '<h2 class="section-title">月別の推移</h2><section class="card"><ul class="bars">' +
			months.map(function (s, i) {
				var bars = C.JOBS.map(function (job) {
					var v = s.byJob[job.id].total;
					return v && max ? '<span style="width:' + (v / max * 100).toFixed(2) + '%;background:' + jobColor(job) + '"></span>' : '';
				}).join('');
				return '<li><button class="bar-row' + (i + 1 === curKey ? ' current' : '') + '" data-month="' + (i + 1) + '">' +
					'<span class="m num">' + (i + 1) + '月</span>' +
					'<span class="bar-track">' + bars + '</span>' +
					'<span class="v num">' + (s.total.total ? yen(s.total.total) : '—') + '</span>' +
					'</button></li>';
			}).join('') + '</ul>' +
			'<div class="legend">' + C.JOBS.map(function (job) {
				return '<span><span class="dot" style="background:' + jobColor(job) + '"></span>' + esc(job.name) + '</span>';
			}).join('') + '</div></section>';
		html += '<p class="hint" style="margin:12px 4px">月をタップすると、その月の詳細を表示します。</p>';
		return html;
	}

	// ---- reminder ----------------------------------------------------------
	function reminderKey(d) { return C.dateKey(d); }

	function renderReminder() {
		var now = new Date();
		var cur = C.currentReminderDate(now);
		var done = load('reminderDone', {});
		var el = $('reminder');
		if (done[reminderKey(cur)]) { el.innerHTML = ''; return; }
		var isToday = C.dateKey(cur) === C.dateKey(now);
		el.innerHTML = '<div class="banner" role="alert"><span class="bell" aria-hidden="true">🔔</span><div>' +
			'<p><strong>' + (isToday ? '今日は千疋屋のシフト希望の提出日です' : '千疋屋のシフト希望は提出しましたか？') + '</strong>' +
			'<span class="shift-sub">' + md(cur) + ' のリマインド</span></p>' +
			'<button class="btn small" data-action="reminder-done">提出済みにする</button>' +
			'</div></div>';
	}

	function markReminderDone() {
		var done = load('reminderDone', {});
		done[reminderKey(C.currentReminderDate(new Date()))] = true;
		// 古い記録は消しておく
		var keys = Object.keys(done).sort();
		while (keys.length > 24) delete done[keys.shift()];
		save('reminderDone', done);
		toast('提出済みにしました。次回は ' + md(C.nextReminderDate(new Date())) + ' です');
		render();
	}

	function maybeNotify() {
		if (!('Notification' in window) || Notification.permission !== 'granted') return;
		var now = new Date();
		if (C.REMINDER_DAYS.indexOf(now.getDate()) === -1) return;
		var key = C.dateKey(now);
		if (load('reminderDone', {})[key] || load('lastNotified', '') === key) return;
		save('lastNotified', key);
		var title = '千疋屋のシフト希望';
		var opts = { body: '今日はシフト希望の提出日です。忘れずに提出しましょう。', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'shift-reminder' };
		if (navigator.serviceWorker && navigator.serviceWorker.ready) {
			navigator.serviceWorker.ready.then(function (reg) { reg.showNotification(title, opts); });
		} else {
			try { new Notification(title, opts); } catch (e) { /* ignore */ }
		}
	}

	function requestNotify() {
		if (!('Notification' in window)) {
			toast('この端末ではアプリ通知が使えません。カレンダー登録をご利用ください');
			return;
		}
		Notification.requestPermission().then(function (p) {
			if (p === 'granted') {
				toast('5日・20日にアプリを開くと通知します');
				save('lastNotified', '');
				maybeNotify();
			} else {
				toast('通知が許可されませんでした');
			}
		});
	}

	function nextReminderStart() {
		var t = ($('reminderTime').value || '09:00').split(':');
		var now = new Date();
		var d = C.currentReminderDate(now);
		d.setHours(+t[0], +t[1], 0, 0);
		if (d <= now) {
			d = C.nextReminderDate(now);
			d.setHours(+t[0], +t[1], 0, 0);
		}
		return d;
	}

	function icsStamp(d, utc) {
		if (utc) {
			return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
				pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
		}
		return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + '00';
	}

	function downloadIcs() {
		var start = nextReminderStart();
		var lines = [
			'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//baito-kanri//JA', 'CALSCALE:GREGORIAN',
			'BEGIN:VTIMEZONE', 'TZID:Asia/Tokyo', 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
			'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:JST', 'END:STANDARD', 'END:VTIMEZONE',
			'BEGIN:VEVENT',
			'UID:' + REMINDER_TAG + '@baito-kanri',
			'DTSTAMP:' + icsStamp(new Date(), true),
			'DTSTART;TZID=Asia/Tokyo:' + icsStamp(start),
			'DURATION:PT15M',
			'RRULE:FREQ=MONTHLY;BYMONTHDAY=' + C.REMINDER_DAYS.join(','),
			'SUMMARY:シフト希望を提出（千疋屋）',
			'DESCRIPTION:千疋屋のシフト希望提出リマインド（毎月5日・20日）',
			'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT0M', 'DESCRIPTION:千疋屋のシフト希望を提出', 'END:VALARM',
			'END:VEVENT', 'END:VCALENDAR'
		];
		var blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' });
		var a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'senbikiya-shift-reminder.ics';
		document.body.appendChild(a);
		a.click();
		setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
	}

	function addGcalReminder() {
		withToken(SCOPE_WRITE, function () {
			var q = new URLSearchParams({ privateExtendedProperty: C.APP_TAG + '=' + REMINDER_TAG, maxResults: '1', fields: 'items(id)' });
			return gfetch('calendars/primary/events?' + q).then(function (r) {
				if (r.items && r.items.length) {
					toast('リマインドはすでに登録されています');
					return;
				}
				var start = nextReminderStart();
				var end = new Date(start.getTime() + 15 * 60000);
				var local = function (d) { return C.dateKey(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00'; };
				var props = {};
				props[C.APP_TAG] = REMINDER_TAG;
				return gfetch('calendars/primary/events', {
					method: 'POST',
					body: JSON.stringify({
						summary: 'シフト希望を提出（千疋屋）',
						description: '千疋屋のシフト希望提出リマインド（毎月5日・20日）\nバイト管理アプリから登録',
						start: { dateTime: local(start), timeZone: 'Asia/Tokyo' },
						end: { dateTime: local(end), timeZone: 'Asia/Tokyo' },
						recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=' + C.REMINDER_DAYS.join(',')],
						reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
						transparency: 'transparent',
						extendedProperties: { private: props }
					})
				}).then(function () {
					toast('Googleカレンダーに登録しました（毎月5日・20日 ' + clock(start) + '）');
				});
			});
		});
	}

	// ---- Google auth / API -------------------------------------------------
	var gisLoading;
	function loadGis() {
		if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
		if (gisLoading) return gisLoading;
		gisLoading = new Promise(function (resolve, reject) {
			var s = document.createElement('script');
			s.src = 'https://accounts.google.com/gsi/client';
			s.async = true;
			s.onload = function () { resolve(); };
			s.onerror = function () { gisLoading = null; reject(new Error('Googleログインを読み込めませんでした（オフライン？）')); };
			document.head.appendChild(s);
		});
		return gisLoading;
	}

	function tokenHas(scope) {
		var t = state.token;
		if (!t || Date.now() > t.expires_at - 60000) return false;
		var granted = (t.scope || '').split(' ');
		if (granted.indexOf(scope) !== -1) return true;
		return scope === SCOPE_READ && granted.indexOf(SCOPE_WRITE) !== -1;
	}

	// ポップアップがブロックされないよう、ボタン操作の中で同期的に呼び出す
	function withToken(scope, task) {
		var clientId = load('clientId', '');
		if (!clientId) {
			toast('先にOAuth クライアント ID を設定してください');
			openSettings();
			return Promise.resolve();
		}
		if (tokenHas(scope)) return run();
		if (!(window.google && google.accounts && google.accounts.oauth2)) {
			loadGis().then(function () { toast('もう一度タップしてください'); }, function (e) { toast(e.message); });
			return Promise.resolve();
		}
		return new Promise(function (resolve) {
			var client = google.accounts.oauth2.initTokenClient({
				client_id: clientId,
				scope: scope,
				include_granted_scopes: true,
				callback: function (r) {
					if (r.error) { toast('ログインできませんでした: ' + r.error); return resolve(); }
					state.token = {
						access_token: r.access_token,
						expires_at: Date.now() + (Number(r.expires_in) || 3600) * 1000,
						scope: r.scope || scope
					};
					try { sessionStorage.setItem('baito.token', JSON.stringify(state.token)); } catch (e) { /* ignore */ }
					run().then(resolve);
				},
				error_callback: function (e) {
					toast(e && e.type === 'popup_closed' ? 'ログインがキャンセルされました' : 'ログインできませんでした');
					resolve();
				}
			});
			client.requestAccessToken({ prompt: load('consented', false) ? '' : 'consent' });
		});

		function run() {
			save('consented', true);
			return Promise.resolve().then(task).catch(function (e) {
				toast(e.message || String(e));
			});
		}
	}

	function gfetch(path, opts) {
		opts = opts || {};
		var headers = { Authorization: 'Bearer ' + state.token.access_token };
		if (opts.body) headers['Content-Type'] = 'application/json';
		return fetch(API + path, { method: opts.method || 'GET', headers: headers, body: opts.body })
			.then(function (res) {
				if (res.status === 401) {
					state.token = null;
					try { sessionStorage.removeItem('baito.token'); } catch (e) { /* ignore */ }
					throw new Error('ログインの有効期限が切れました。もう一度同期してください');
				}
				if (!res.ok) {
					return res.json().catch(function () { return {}; }).then(function (j) {
						throw new Error('Google APIエラー（' + res.status + '）' + (j.error && j.error.message ? ': ' + j.error.message : ''));
					});
				}
				return res.json();
			});
	}

	function fetchYear(year) {
		var events = [];
		function page(token) {
			var q = new URLSearchParams({
				timeMin: new Date(year, 0, 1).toISOString(),
				timeMax: new Date(year + 1, 0, 1).toISOString(),
				singleEvents: 'true',
				orderBy: 'startTime',
				maxResults: '2500',
				fields: 'nextPageToken,items(id,status,summary,start,end,extendedProperties)'
			});
			if (token) q.set('pageToken', token);
			return gfetch('calendars/primary/events?' + q).then(function (r) {
				(r.items || []).forEach(function (ev) {
					if (C.matchJob(ev)) {
						events.push({ id: ev.id, summary: ev.summary, start: ev.start, end: ev.end });
					}
				});
				return r.nextPageToken ? page(r.nextPageToken) : null;
			});
		}
		return page().then(function () {
			state.cache[year] = { fetchedAt: Date.now(), events: events };
			save('cache', state.cache);
		});
	}

	function sync() {
		if (state.syncing) return;
		var year = state.year;
		withToken(SCOPE_READ, function () {
			state.syncing = true;
			render();
			return fetchYear(year).then(function () {
				var n = state.cache[year].events.length;
				toast(year + '年のアルバイト予定を ' + n + ' 件読み込みました');
			}).finally(function () {
				state.syncing = false;
				render();
			});
		});
	}

	function signOut() {
		var t = state.token;
		state.token = null;
		try { sessionStorage.removeItem('baito.token'); } catch (e) { /* ignore */ }
		save('consented', false);
		if (t && window.google && google.accounts && google.accounts.oauth2) {
			google.accounts.oauth2.revoke(t.access_token, function () {});
		}
		toast('ログアウトしました');
	}

	// ---- settings ----------------------------------------------------------
	function renderRules() {
		$('rules').innerHTML = C.JOBS.map(function (job) {
			var rates = job.rates.map(function (r) {
				var range = r.from && r.to ? r.from + '〜' + r.to
					: r.to ? '〜' + r.to.replace(/-/g, '/')
					: r.from.replace(/-/g, '/') + '〜';
				return range + '：' + r.rate.toLocaleString('ja-JP') + '円';
			}).join('<br>');
			return '<table class="rules"><caption><span class="dot" style="background:' + jobColor(job) + '"></span>' + esc(job.name) + '</caption>' +
				'<tr><th>時給</th><td>' + rates + '</td></tr>' +
				'<tr><th>交通費</th><td>' + (job.transportPerDay ? job.transportPerDay.toLocaleString('ja-JP') + '円／日' : 'なし') + '</td></tr>' +
				'<tr><th>休憩</th><td>' + esc(job.breakNote) + '</td></tr>' +
				'</table>';
		}).join('') +
		'<p class="hint" style="margin-top:12px">予定の開始〜終了を拘束時間とし、休憩を引いた実働時間で計算します（1円未満切り捨て／シフトごと）。8時間以上の千疋屋の休憩は労働基準法に合わせて60分としています。</p>';
	}

	function openSettings() {
		$('clientIdInput').value = load('clientId', '');
		$('reminderTime').value = load('reminderTime', '09:00');
		$('nextReminder').textContent = '次回：' + md(C.nextReminderDate(new Date())) + (
			load('reminderDone', {})[reminderKey(C.currentReminderDate(new Date()))] ? '' : '（' + md(C.currentReminderDate(new Date())) + '分は未提出）');
		renderRules();
		var dlg = $('settings');
		if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
	}

	// ---- events ------------------------------------------------------------
	function shiftPeriod(delta) {
		if (state.view === 'month') {
			var m = state.month + delta;
			state.year += Math.floor((m - 1) / 12);
			state.month = ((m - 1) % 12 + 12) % 12 + 1;
		} else {
			state.year += delta;
		}
		render();
	}

	function bind() {
		document.querySelectorAll('.segmented button').forEach(function (b) {
			b.addEventListener('click', function () {
				state.view = b.dataset.view;
				save('view', state.view);
				render();
			});
		});
		$('prevBtn').addEventListener('click', function () { shiftPeriod(-1); });
		$('nextBtn').addEventListener('click', function () { shiftPeriod(1); });
		$('periodLabel').addEventListener('click', function () {
			var n = new Date();
			state.year = n.getFullYear();
			state.month = n.getMonth() + 1;
			render();
		});
		$('syncBtn').addEventListener('click', sync);
		$('settingsBtn').addEventListener('click', openSettings);

		$('content').addEventListener('click', function (e) {
			var row = e.target.closest('[data-month]');
			if (row) {
				state.month = Number(row.dataset.month);
				state.view = 'month';
				save('view', state.view);
				render();
				window.scrollTo(0, 0);
				return;
			}
			var act = e.target.closest('[data-action]');
			if (!act) return;
			if (act.dataset.action === 'sync') sync();
			if (act.dataset.action === 'settings') openSettings();
		});
		$('reminder').addEventListener('click', function (e) {
			if (e.target.closest('[data-action="reminder-done"]')) markReminderDone();
		});

		// 横スワイプで前後の期間へ
		var sx = null, sy = null;
		$('content').addEventListener('touchstart', function (e) {
			sx = e.touches[0].clientX; sy = e.touches[0].clientY;
		}, { passive: true });
		$('content').addEventListener('touchend', function (e) {
			if (sx == null) return;
			var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
			sx = null;
			if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftPeriod(dx < 0 ? 1 : -1);
		}, { passive: true });

		$('saveClientIdBtn').addEventListener('click', function () {
			var v = $('clientIdInput').value.trim();
			save('clientId', v);
			if (!v) { toast('クライアント ID を削除しました'); return; }
			loadGis().then(function () {
				$('settings').close();
				sync();
			}, function (e) { toast(e.message); });
		});
		$('signOutBtn').addEventListener('click', signOut);
		$('reminderTime').addEventListener('change', function () { save('reminderTime', $('reminderTime').value); });
		$('addGcalReminderBtn').addEventListener('click', addGcalReminder);
		$('downloadIcsBtn').addEventListener('click', downloadIcs);
		$('notifyBtn').addEventListener('click', requestNotify);
		$('clearCacheBtn').addEventListener('click', function () {
			if (!confirm('保存した予定データと設定を削除しますか？')) return;
			Object.keys(localStorage).forEach(function (k) { if (k.indexOf('baito.') === 0) localStorage.removeItem(k); });
			state.cache = {};
			state.token = null;
			try { sessionStorage.removeItem('baito.token'); } catch (e) { /* ignore */ }
			$('settings').close();
			render();
			toast('削除しました');
		});

		document.addEventListener('visibilitychange', function () {
			if (document.visibilityState !== 'visible') return;
			var n = new Date();
			if (C.dateKey(n) !== C.dateKey(today)) { today = n; }
			render();
			maybeNotify();
		});
	}

	// ---- init --------------------------------------------------------------
	try {
		var saved = JSON.parse(sessionStorage.getItem('baito.token') || 'null');
		if (saved && saved.expires_at > Date.now()) state.token = saved;
	} catch (e) { /* ignore */ }

	bind();
	render();
	if (load('clientId', '')) loadGis().catch(function () {});
	// ログイン中（1時間以内）なら古いデータを自動で更新
	var cached = state.cache[state.year];
	if (tokenHas(SCOPE_READ) && (!cached || Date.now() - cached.fetchedAt > 10 * 60000)) sync();
	if ('serviceWorker' in navigator && location.protocol !== 'file:') {
		navigator.serviceWorker.register('sw.js').catch(function () {});
	}
	maybeNotify();
})();
