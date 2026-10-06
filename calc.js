/*
 * バイト管理 — 給与計算ロジック（UI非依存）
 * ブラウザでは window.BaitoCalc、Node では require() で利用できる。
 */
(function (root) {
  'use strict';

  // ---- アルバイト設定 ---------------------------------------------------
  // rates: from/to は 'YYYY-MM-DD'（両端を含む）。省略は無期限。
  // breakMinutes(spanMin): 予定の長さ（分）から休憩時間（分）を返す。
  var JOBS = [
    {
      id: 'senbikiya',
      name: '千疋屋',
      keywords: ['千疋屋'],
      color: '#d9536f',
      rates: [
        { to: '2026-08-31', rate: 1300 },
        { from: '2026-09-01', rate: 1350 }
      ],
      transportPerDay: 1000,
      // 6時間未満: なし / 6時間以上8時間未満: 45分 / 8時間以上: 60分（労基法に準拠）
      breakMinutes: function (span) {
        if (span < 360) return 0;
        if (span < 480) return 45;
        return 60;
      },
      breakNote: '6時間未満 なし／6時間以上8時間未満 45分／8時間以上 60分',
      shiftReminder: true
    },
    {
      id: 'gakudo',
      name: '学童',
      keywords: ['学童'],
      color: '#3b82c4',
      rates: [
        { to: '2026-09-30', rate: 1270 },
        { from: '2026-10-01', rate: 1300 }
      ],
      transportPerDay: 0,
      // 6時間以下: なし / 6時間超8時間未満: 45分 / 8時間以上: 60分
      breakMinutes: function (span) {
        if (span <= 360) return 0;
        if (span < 480) return 45;
        return 60;
      },
      breakNote: '6時間以下 なし／6時間超8時間未満 45分／8時間以上 60分',
      shiftReminder: false
    }
  ];

  // タイトルにこれらを含む予定はシフトとして数えない（リマインド予定など）
  var EXCLUDE_WORDS = ['シフト希望', 'リマインド'];
  var APP_TAG = 'baitoApp';

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function dateKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function rateFor(job, key) {
    for (var i = 0; i < job.rates.length; i++) {
      var r = job.rates[i];
      if ((!r.from || key >= r.from) && (!r.to || key <= r.to)) return r.rate;
    }
    return 0;
  }

  function matchJob(ev) {
    var title = ev.summary || '';
    if (!ev.start || !ev.start.dateTime) return null; // 終日予定は対象外
    if (ev.status === 'cancelled') return null;
    var props = ev.extendedProperties && ev.extendedProperties.private;
    if (props && props[APP_TAG]) return null;
    for (var w = 0; w < EXCLUDE_WORDS.length; w++) {
      if (title.indexOf(EXCLUDE_WORDS[w]) !== -1) return null;
    }
    for (var i = 0; i < JOBS.length; i++) {
      for (var k = 0; k < JOBS[i].keywords.length; k++) {
        if (title.indexOf(JOBS[i].keywords[k]) !== -1) return JOBS[i];
      }
    }
    return null;
  }

  // Google カレンダーのイベント配列 → シフト配列（開始時刻順）
  function toShifts(events, now) {
    now = now || new Date();
    var shifts = [];
    var seen = {};
    events.forEach(function (ev) {
      var job = matchJob(ev);
      if (!job || seen[ev.id]) return;
      seen[ev.id] = true;
      var start = new Date(ev.start.dateTime);
      var end = new Date(ev.end.dateTime);
      var span = Math.max(0, Math.round((end - start) / 60000));
      var brk = Math.min(span, job.breakMinutes(span));
      var work = span - brk;
      var key = dateKey(start);
      var rate = rateFor(job, key);
      shifts.push({
        id: ev.id,
        jobId: job.id,
        title: ev.summary,
        start: start,
        end: end,
        dateKey: key,
        spanMin: span,
        breakMin: brk,
        workMin: work,
        rate: rate,
        wage: Math.floor(work * rate / 60),
        transport: 0,
        done: end <= now
      });
    });
    shifts.sort(function (a, b) { return a.start - b.start; });
    // 交通費は「勤務日」単位（同日に複数予定があっても1日分）
    var paidDays = {};
    shifts.forEach(function (s) {
      var job = jobById(s.jobId);
      var dk = s.jobId + '|' + s.dateKey;
      if (job.transportPerDay && !paidDays[dk]) {
        paidDays[dk] = true;
        s.transport = job.transportPerDay;
      }
    });
    return shifts;
  }

  function emptyTotals() {
    return { count: 0, days: 0, workMin: 0, breakMin: 0, wage: 0, transport: 0, total: 0,
      doneTotal: 0, plannedTotal: 0 };
  }

  function addTo(t, s, daySet) {
    t.count++;
    if (!daySet[s.dateKey]) { daySet[s.dateKey] = true; t.days++; }
    t.workMin += s.workMin;
    t.breakMin += s.breakMin;
    t.wage += s.wage;
    t.transport += s.transport;
    var sum = s.wage + s.transport;
    t.total += sum;
    if (s.done) t.doneTotal += sum; else t.plannedTotal += sum;
  }

  // シフト配列を集計 { total, byJob: {jobId: totals} }
  function summarize(shifts) {
    var res = { total: emptyTotals(), byJob: {} };
    var days = { all: {} };
    JOBS.forEach(function (j) { res.byJob[j.id] = emptyTotals(); days[j.id] = {}; });
    shifts.forEach(function (s) {
      addTo(res.total, s, days.all);
      addTo(res.byJob[s.jobId], s, days[s.jobId]);
    });
    return res;
  }

  function inMonth(shifts, year, month /* 1-12 */) {
    var prefix = year + '-' + pad(month) + '-';
    return shifts.filter(function (s) { return s.dateKey.indexOf(prefix) === 0; });
  }

  function inYear(shifts, year) {
    var prefix = year + '-';
    return shifts.filter(function (s) { return s.dateKey.indexOf(prefix) === 0; });
  }

  function jobById(id) {
    for (var i = 0; i < JOBS.length; i++) if (JOBS[i].id === id) return JOBS[i];
    return null;
  }

  // ---- シフト希望リマインド（毎月5日・20日） -------------------------------
  var REMINDER_DAYS = [5, 20];

  // 直近（今日を含む過去）のリマインド日
  function currentReminderDate(today) {
    var y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
    for (var i = REMINDER_DAYS.length - 1; i >= 0; i--) {
      if (d >= REMINDER_DAYS[i]) return new Date(y, m, REMINDER_DAYS[i]);
    }
    return new Date(y, m - 1, REMINDER_DAYS[REMINDER_DAYS.length - 1]);
  }

  // 今日より後の次回リマインド日
  function nextReminderDate(today) {
    var y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
    for (var i = 0; i < REMINDER_DAYS.length; i++) {
      if (d < REMINDER_DAYS[i]) return new Date(y, m, REMINDER_DAYS[i]);
    }
    return new Date(y, m + 1, REMINDER_DAYS[0]);
  }

  var api = {
    JOBS: JOBS,
    APP_TAG: APP_TAG,
    REMINDER_DAYS: REMINDER_DAYS,
    dateKey: dateKey,
    rateFor: rateFor,
    matchJob: matchJob,
    toShifts: toShifts,
    summarize: summarize,
    inMonth: inMonth,
    inYear: inYear,
    jobById: jobById,
    currentReminderDate: currentReminderDate,
    nextReminderDate: nextReminderDate
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BaitoCalc = api;
})(this);
