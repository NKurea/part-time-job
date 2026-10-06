// 実行: TZ=Asia/Tokyo node --test baito/calc.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('./calc.js');

function ev(id, summary, start, end, extra) {
  return Object.assign({
    id, summary,
    start: { dateTime: start + ':00+09:00' },
    end: { dateTime: end + ':00+09:00' }
  }, extra || {});
}

const now = new Date('2030-01-01T00:00:00+09:00');

test('時給の切替日', () => {
  const s = C.jobById('senbikiya'), g = C.jobById('gakudo');
  assert.strictEqual(C.rateFor(s, '2026-08-31'), 1300);
  assert.strictEqual(C.rateFor(s, '2026-09-01'), 1350);
  assert.strictEqual(C.rateFor(g, '2026-09-30'), 1270);
  assert.strictEqual(C.rateFor(g, '2026-10-01'), 1300);
});

test('千疋屋の休憩: 6h未満なし / 6h以上8h未満45分 / 8h以上60分', () => {
  const sh = C.toShifts([
    ev('a', '千疋屋', '2026-10-01T10:00', '2026-10-01T15:59'),
    ev('b', '千疋屋', '2026-10-02T10:00', '2026-10-02T16:00'),
    ev('c', '千疋屋', '2026-10-03T10:00', '2026-10-03T17:59'),
    ev('d', '千疋屋', '2026-10-04T10:00', '2026-10-04T18:00')
  ], now);
  assert.deepStrictEqual(sh.map(s => s.breakMin), [0, 45, 45, 60]);
});

test('学童の休憩: 6h以下なし / 6h超8h未満45分 / 8h以上60分', () => {
  const sh = C.toShifts([
    ev('a', '学童', '2026-10-01T10:00', '2026-10-01T16:00'),
    ev('b', '学童', '2026-10-02T10:00', '2026-10-02T16:01'),
    ev('c', '学童', '2026-10-03T10:00', '2026-10-03T17:59'),
    ev('d', '学童', '2026-10-04T10:00', '2026-10-04T18:00')
  ], now);
  assert.deepStrictEqual(sh.map(s => s.breakMin), [0, 45, 45, 60]);
});

test('給与・交通費の計算', () => {
  const sh = C.toShifts([
    // 2026/8: 5h × 1300 = 6500 + 交通費1000
    ev('a', '千疋屋', '2026-08-30T10:00', '2026-08-30T15:00'),
    // 2026/9: 6.5h - 45m = 5h45m × 1350 = 7762.5 → 7762 + 1000
    ev('b', '千疋屋', '2026-09-01T10:00', '2026-09-01T16:30'),
    // 学童 2026/10: 12:30-19:00 = 6.5h - 45m = 5h45m × 1300 = 7475
    ev('c', '学童', '2026-10-07T12:30', '2026-10-07T19:00')
  ], now);
  assert.deepStrictEqual(sh.map(s => [s.wage, s.transport]), [[6500, 1000], [7762, 1000], [7475, 0]]);
  const sum = C.summarize(sh);
  assert.strictEqual(sum.total.total, 6500 + 1000 + 7762 + 1000 + 7475);
  assert.strictEqual(sum.byJob.senbikiya.days, 2);
  assert.strictEqual(sum.byJob.gakudo.workMin, 345);
});

test('交通費は同日2回でも1日分', () => {
  const sh = C.toShifts([
    ev('a', '千疋屋', '2026-10-01T10:00', '2026-10-01T12:00'),
    ev('b', '千疋屋', '2026-10-01T15:00', '2026-10-01T17:00')
  ], now);
  assert.strictEqual(C.summarize(sh).total.transport, 1000);
});

test('対象外の予定（終日・無関係・リマインド）', () => {
  const sh = C.toShifts([
    { id: 'x', summary: '千疋屋', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } },
    ev('y', 'ランチ', '2026-10-01T12:00', '2026-10-01T13:00'),
    ev('z', '千疋屋 シフト希望提出', '2026-10-05T09:00', '2026-10-05T09:15'),
    ev('w', 'メモ', '2026-10-05T09:00', '2026-10-05T09:15',
      { extendedProperties: { private: { baitoApp: 'x' } } })
  ], now);
  assert.strictEqual(sh.length, 0);
});

test('月別・年間フィルタ', () => {
  const sh = C.toShifts([
    ev('a', '学童', '2026-09-28T13:30', '2026-09-28T19:00'),
    ev('b', '学童', '2026-10-02T14:00', '2026-10-02T19:00'),
    ev('c', '学童', '2027-01-05T14:00', '2027-01-05T19:00')
  ], now);
  assert.strictEqual(C.inMonth(sh, 2026, 10).length, 1);
  assert.strictEqual(C.inYear(sh, 2026).length, 2);
});

test('リマインド日（毎月5日・20日）', () => {
  const d = (s) => C.dateKey(s);
  assert.strictEqual(d(C.currentReminderDate(new Date(2026, 9, 6))), '2026-10-05');
  assert.strictEqual(d(C.currentReminderDate(new Date(2026, 9, 20))), '2026-10-20');
  assert.strictEqual(d(C.currentReminderDate(new Date(2026, 0, 3))), '2025-12-20');
  assert.strictEqual(d(C.nextReminderDate(new Date(2026, 9, 6))), '2026-10-20');
  assert.strictEqual(d(C.nextReminderDate(new Date(2026, 9, 20))), '2026-11-05');
  assert.strictEqual(d(C.nextReminderDate(new Date(2026, 11, 25))), '2027-01-05');
});
