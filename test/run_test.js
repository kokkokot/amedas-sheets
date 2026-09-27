// Apps Script の代わりに最低限の模擬オブジェクトを用意して、Code.gs の collect() を実データで試す
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const assert = require('assert');

// ── 模擬: シート ──
class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; }
  getLastRow() { return this.rows.length; }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    return {
      setValues(vals) {
        vals.forEach((row, i) => { const rr = r - 1 + i; sh.rows[rr] = sh.rows[rr] || []; row.forEach((v, j) => { sh.rows[rr][c - 1 + j] = v; }); });
        return this;
      },
      getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = sh.rows[r - 1 + i] || []; out.push(Array.from({ length: nc }, (_, j) => row[c - 1 + j] ?? '')); } return out; },
      setNumberFormat() { return this; },
    };
  }
}
const sheets = {};
const SpreadsheetApp = { getActive: () => ({ getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = new FakeSheet(n)) }) };

// ── 模擬: 通信（curl で本物を取りに行く。failCode の地点は 500 を返す） ──
let failCode = null;
let requestCount = 0;
const UrlFetchApp = {
  fetch(url) {
    requestCount++;
    if (failCode && url.includes('/point/' + failCode + '/')) return { getResponseCode: () => 500, getContentText: () => '' };
    const out = execFileSync('curl', ['-s', '-m', '20', '-w', '\n%{http_code}', url], { encoding: 'utf8' });
    const i = out.lastIndexOf('\n');
    const body = out.slice(0, i), code = Number(out.slice(i + 1));
    return { getResponseCode: () => code, getContentText: () => body };
  },
};

// ── 模擬: その他 ──
const store = {};
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => store[k] ?? null, setProperty: (k, v) => { store[k] = v; } }) };
const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
const Utilities = {
  sleep: () => {},
  parseDate: (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10) - 9, +s.slice(10, 12))),
  formatDate: (d, tz, fmt) => {
    const j = new Date(d.getTime() + 9 * 3600 * 1000); const p = n => String(n).padStart(2, '0');
    return fmt.replace('yyyy', j.getUTCFullYear()).replace('MM', p(j.getUTCMonth() + 1)).replace('dd', p(j.getUTCDate()))
      .replace('HH', p(j.getUTCHours())).replace('mm', p(j.getUTCMinutes())).replace('ss', p(j.getUTCSeconds()));
  },
};

const ctx = vm.createContext({ SpreadsheetApp, UrlFetchApp, PropertiesService, LockService, Utilities, console, Date, JSON, Math, String, Number, Object, Array, Error });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), ctx);
const run = src => vm.runInContext(src, ctx);

const data = () => sheets['データ'].rows.slice(1);
const logs = () => sheets['ログ'].rows.slice(1);
const keysOf = code => data().filter(r => r[1] === code).map(r => Utilities.formatDate(r[0], 'Asia/Tokyo', 'yyyyMMddHHmm'));
const noDup = code => { const k = keysOf(code); assert.strictEqual(new Set(k).size, k.length, code + ' に重複があります'); return k; };
const step = (label, fn) => { fn(); console.log('OK  ' + label); };

// 1. 純粋な関数
step('日時・ブロック計算', () => {
  assert.strictEqual(run("latestKey('2026-09-27T17:20:00+09:00')"), '20260927172000');
  assert.strictEqual(run("blockOf('20260927172000')"), '20260927_15');
  assert.strictEqual(run("blockOf('20260927000000')"), '20260927_00');
  assert.strictEqual(run("prevBlock('20260927_00')"), '20260926_21');
  assert.strictEqual(run("prevBlock('20260301_00')"), '20260228_21');
  assert.strictEqual(run("prevBlock('20270101_00')"), '20261231_21');
});

// 2. 初回の取得
step('初回の取得（3地点とも追加される）', () => {
  run('collect()');
  ['44132', '62078', '14163'].forEach(c => assert.ok(noDup(c).length > 0, c + ' が0件'));
  assert.ok(logs().every(l => String(l[2]).startsWith('追加')), JSON.stringify(logs()));
});
console.log('    行数:', data().length, ' 例:', JSON.stringify(data()[data().length - 1]).slice(0, 160));

// 3. 続けて実行 → 重複しない
step('続けて実行しても重複しない', () => {
  const before = data().length; const logBefore = logs().length;
  run('collect()');
  assert.strictEqual(data().length, before);
  assert.ok(logs().slice(logBefore).every(l => l[2] === '新データなし'), JSON.stringify(logs().slice(logBefore)));
});

// 4. 取りこぼしの補完：東京だけ9時間前まで戻したことにする
step('取りこぼしを前のブロックから補完する', () => {
  const tokyo = keysOf('44132');
  const latest = tokyo[tokyo.length - 1];
  const t = Utilities.parseDate(latest + '00'); const back = new Date(t.getTime() - 9 * 3600 * 1000);
  const backKey = Utilities.formatDate(back, 'Asia/Tokyo', 'yyyyMMddHHmm') + '00';
  // 9時間前より新しい東京の行を消して、記憶も9時間前にする
  sheets['データ'].rows = [sheets['データ'].rows[0], ...data().filter(r => !(r[1] === '44132' && Utilities.formatDate(r[0], 'Asia/Tokyo', 'yyyyMMddHHmm') + '00' > backKey))];
  store['last_44132'] = backKey;
  const logBefore = logs().length;
  run('collect()');
  const k = noDup('44132');
  const after = k.filter(x => x + '00' > backKey);
  assert.ok(after.length >= 50, '9時間分（約54件）が補完されていない: ' + after.length);
  const tl = logs().slice(logBefore).find(l => l[1] === '東京');
  assert.ok(/補完/.test(tl[4]), JSON.stringify(tl));
  console.log('    補完ログ:', tl[2], tl[3] + '件', tl[4]);
});

// 5. 記憶が消えてもシートから復元して重複しない
step('記憶（スクリプトプロパティ）が消えても重複しない', () => {
  Object.keys(store).forEach(k => delete store[k]);
  const before = data().length;
  run('collect()');
  assert.strictEqual(data().length, before);
  ['44132', '62078', '14163'].forEach(noDup);
});

// 6. 1地点のエラーで他が止まらない
step('1地点がエラーでも、エラーを記録して他の地点は続ける', () => {
  // 大阪と札幌の直近1時間分を消して取得が必要な状態にし、大阪だけ通信を失敗させる
  const cut = Utilities.formatDate(new Date(Utilities.parseDate(keysOf('14163').slice(-1)[0] + '00').getTime() - 3600 * 1000), 'Asia/Tokyo', 'yyyyMMddHHmm');
  sheets['データ'].rows = [sheets['データ'].rows[0], ...data().filter(r => !(['62078', '14163'].includes(r[1]) && Utilities.formatDate(r[0], 'Asia/Tokyo', 'yyyyMMddHHmm') > cut))];
  store['last_62078'] = cut + '00'; store['last_14163'] = cut + '00';
  failCode = '62078';
  const logBefore = logs().length; const req0 = requestCount;
  run('collect()');
  failCode = null;
  const recent = logs().slice(logBefore);
  assert.ok(recent.some(l => l[1] === '大阪' && l[2] === 'エラー'), JSON.stringify(recent));
  assert.ok(recent.some(l => l[1] === '札幌' && String(l[2]).startsWith('追加') || l[1] === '札幌' && l[2] === '新データなし'), JSON.stringify(recent));
  noDup('14163');
  console.log('    エラーログ:', JSON.stringify(recent.find(l => l[1] === '大阪')));
});

console.log('\nすべてのテストに合格  データ行数:', data().length, ' ログ行数:', logs().length, ' 通信回数:', requestCount);
