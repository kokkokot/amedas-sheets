/**
 * アメダス自動収集 → Googleスプレッドシート蓄積 & ダッシュボード
 *
 * 気象庁アメダスの10分ごとの観測値を、10分おきに自動で取得して
 * 「データ」シートに時系列で蓄積し、「ダッシュボード」で最新値とグラフを表示する。
 *
 * 使い方:
 *   1. このコードをスプレッドシートの Apps Script に貼り付ける
 *   2. 関数 setup を1回実行する（シート作成・ダッシュボード作成・10分おきのトリガー登録）
 *   以降は collect が10分おきに自動で動く。止めるときは removeTriggers を実行する。
 *
 * 出典：気象庁ホームページ（アメダス）のデータを加工して作成
 */

// ───────── 設定 ─────────
const CONFIG = {
  stations: [
    { code: '44132', name: '東京' },
    { code: '62078', name: '大阪' },
    { code: '14163', name: '札幌' },
  ],
  intervalMinutes: 10,
  maxBackfillBlocks: 8,   // 取りこぼしがあったとき、最大何ブロック（1ブロック=3時間）さかのぼるか
  requestGapMs: 500,      // サイトに負担をかけないよう、リクエストの間をあける
  retries: 2,
  sheets: { data: 'データ', log: 'ログ', dash: 'ダッシュボード', chart: 'グラフ用' },
};

const BASE = 'https://www.jma.go.jp/bosai/amedas/data';
const HEADERS = ['観測日時', '地点コード', '地点', '気温(℃)', '湿度(%)', '降水量10分(mm)',
  '風速(m/s)', '風向', '日照10分(分)', '気圧(hPa)', '品質注意', '取得日時'];
const LOG_HEADERS = ['実行日時', '地点', '結果', '追加件数', '詳細', '所要時間(ms)'];
const WIND_DIRS = ['静穏', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南',
  '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西', '北'];

// ───────── 純粋な処理（シートに依存しない） ─────────

/** "2026-09-27T17:20:00+09:00" → "20260927172000" */
function latestKey(latestTimeText) {
  const m = String(latestTimeText).trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) throw new Error('最新時刻の形式が想定外です: ' + latestTimeText);
  return m[1] + m[2] + m[3] + m[4] + m[5] + '00';
}

/** 観測キー → そのキーを含むブロックファイル名（3時間ごと） "20260927_15" */
function blockOf(key) {
  const h = Number(key.slice(8, 10));
  return key.slice(0, 8) + '_' + String(Math.floor(h / 3) * 3).padStart(2, '0');
}

/** ブロック名を3時間前にずらす（日付またぎ対応。タイムゾーンに依存しないようUTCとして計算） */
function prevBlock(block) {
  const y = +block.slice(0, 4), mo = +block.slice(4, 6), d = +block.slice(6, 8), h = +block.slice(9, 11);
  const t = new Date(Date.UTC(y, mo - 1, d, h) - 3 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return t.getUTCFullYear() + p(t.getUTCMonth() + 1) + p(t.getUTCDate()) + '_' + p(t.getUTCHours());
}

/** "20260927172000" → "2026/09/27 17:20" */
function keyToText(key) {
  return key.slice(0, 4) + '/' + key.slice(4, 6) + '/' + key.slice(6, 8) + ' ' + key.slice(8, 10) + ':' + key.slice(10, 12);
}

/** "20260927172000" → 日本時間の日時（シートでは日付として扱われる） */
function keyToDate(key) {
  return Utilities.parseDate(key, 'Asia/Tokyo', 'yyyyMMddHHmmss');
}

/** アメダスの値 [値, 品質フラグ] を取り出す。欠測や要注意は notes に記録する */
function pick(obs, field, label, notes) {
  const v = obs[field];
  if (!v || v[0] === null || v[0] === undefined) { notes.push(label + ':欠測'); return ''; }
  if (v[1] !== 0) notes.push(label + ':要確認(' + v[1] + ')');
  return v[0];
}

/** 1観測分を1行に変換 */
function toRow(key, station, obs, fetchedAt) {
  const notes = [];
  const wd = pick(obs, 'windDirection', '風向', notes);
  const row = [
    keyToDate(key), station.code, station.name,
    pick(obs, 'temp', '気温', notes),
    pick(obs, 'humidity', '湿度', notes),
    pick(obs, 'precipitation10m', '降水量', notes),
    pick(obs, 'wind', '風速', notes),
    wd === '' ? '' : (WIND_DIRS[wd] || String(wd)),
    pick(obs, 'sun10m', '日照', notes),
    pick(obs, 'pressure', '気圧', notes),
    notes.join(' / '),
    fetchedAt,
  ];
  return row;
}

/**
 * 取得済みブロック（新しい順）から、lastKey より新しく latest 以下の観測を古い順に返す。
 * blocks: [{ name, json }]
 */
function newObservations(blocks, lastKey, latest) {
  const seen = {};
  const out = [];
  blocks.forEach(b => Object.keys(b.json || {}).forEach(k => {
    if (k > (lastKey || '') && k <= latest && !seen[k]) { seen[k] = true; out.push({ key: k, obs: b.json[k] }); }
  }));
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

// ───────── 通信 ─────────

function fetchText(url) {
  let lastErr;
  for (let i = 0; i <= CONFIG.retries; i++) {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'amedas-sheets-sample (low-frequency)' } });
    const code = res.getResponseCode();
    if (code === 200) return res.getContentText('UTF-8');
    if (code === 404) return null;           // まだ存在しないブロックなど
    lastErr = new Error('HTTP ' + code + ' ' + url);
    Utilities.sleep(1000 * (i + 1));         // 一時的なエラーは少し待ってやり直す
  }
  throw lastErr;
}

function fetchBlock(code, block) {
  const text = fetchText(BASE + '/point/' + code + '/' + block + '.json');
  return text ? JSON.parse(text) : null;
}

// ───────── シート操作 ─────────

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (headers && sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sh;
}

function writeLog_(station, result, count, detail, ms) {
  const sh = sheet_(CONFIG.sheets.log, LOG_HEADERS);
  sh.getRange(sh.getLastRow() + 1, 1, 1, LOG_HEADERS.length)
    .setValues([[new Date(), station, result, count, detail, ms]]);
}

function nowText_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
}

/**
 * 地点ごとの記録済みの最新キー。
 * スクリプトの記憶とシートの末尾の両方を見て、新しい方を使う（記憶が古い・消えた場合も重複させない）
 */
function lastKeys_(dataSheet) {
  const props = PropertiesService.getScriptProperties();
  const result = {};
  CONFIG.stations.forEach(st => { result[st.code] = props.getProperty('last_' + st.code) || ''; });
  const n = Math.min(dataSheet.getLastRow() - 1, 1000);
  if (n > 0) {
    dataSheet.getRange(dataSheet.getLastRow() - n + 1, 1, n, 2).getValues().forEach(r => {
      const code = String(r[1]);
      if (!(code in result)) return;
      const v = r[0];
      const k = v instanceof Date
        ? Utilities.formatDate(v, 'Asia/Tokyo', 'yyyyMMddHHmm') + '00'
        : String(v).replace(/[\/: ]/g, '') + '00';
      if (k > result[code]) result[code] = k;
    });
  }
  return result;
}

// ───────── メイン：10分おきに実行 ─────────

function collect() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;       // 前回の実行がまだ終わっていなければ重ねない
  try {
    const data = sheet_(CONFIG.sheets.data, HEADERS);
    const latest = latestKey(fetchText(BASE + '/latest_time.txt'));
    const fetchedAt = nowText_();
    const props = PropertiesService.getScriptProperties();
    const lastKeys = lastKeys_(data);

    CONFIG.stations.forEach(st => {
      const t0 = Date.now();
      try {
        const last = lastKeys[st.code];
        if (last >= latest) { writeLog_(st.name, '新データなし', 0, '最新 ' + keyToText(latest), Date.now() - t0); return; }

        // 最新のブロックから、記録済みの時刻に届くまでさかのぼって取得する
        const blocks = [];
        let block = blockOf(latest);
        for (let i = 0; i <= CONFIG.maxBackfillBlocks; i++) {
          const json = fetchBlock(st.code, block);
          if (json) blocks.push({ name: block, json: json });
          const oldest = json ? Object.keys(json).sort()[0] : null;
          if (!last || (oldest && oldest <= last)) break;
          block = prevBlock(block);
          Utilities.sleep(CONFIG.requestGapMs);
        }

        const obs = newObservations(blocks, last, latest);
        if (obs.length === 0) { writeLog_(st.name, '新データなし', 0, '', Date.now() - t0); return; }

        const rows = obs.map(o => toRow(o.key, st, o.obs, fetchedAt));
        data.getRange(data.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
        props.setProperty('last_' + st.code, obs[obs.length - 1].key);

        const flagged = rows.filter(r => r[10]).length;
        const gapFilled = blocks.length > 1 ? '・取りこぼしを' + (blocks.length - 1) + 'ブロック補完' : '';
        writeLog_(st.name, flagged ? '追加（欠測・要確認あり）' : '追加', rows.length,
          keyToText(obs[0].key) + ' 〜 ' + keyToText(obs[obs.length - 1].key) + gapFilled
          + (flagged ? ' / 注意' + flagged + '件' : ''), Date.now() - t0);
      } catch (e) {
        writeLog_(st.name, 'エラー', 0, String(e && e.message || e), Date.now() - t0);
      }
      Utilities.sleep(CONFIG.requestGapMs);
    });
    updateChartAxis_();
  } catch (e) {
    writeLog_('全体', 'エラー', 0, String(e && e.message || e), 0);
  } finally {
    lock.releaseLock();
  }
}

// ───────── 初回セットアップ ─────────

function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone('Asia/Tokyo');

  const data = sheet_(CONFIG.sheets.data, HEADERS);
  styleHeader_(data, HEADERS.length);
  data.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm');
  const log = sheet_(CONFIG.sheets.log, LOG_HEADERS);
  styleHeader_(log, LOG_HEADERS.length);
  log.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');

  buildChartData_();
  buildDashboard_();
  collect();
  installTrigger_();
  updateChartAxis_();
  // 最初からある空のシートは使わないので消す
  ['シート1', 'Sheet1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  ss.setActiveSheet(ss.getSheetByName(CONFIG.sheets.dash));
  SpreadsheetApp.flush();
}

function styleHeader_(sh, n) {
  sh.getRange(1, 1, 1, n).setFontWeight('bold').setBackground('#1F7A4A').setFontColor('#FFFFFF');
  sh.setFrozenRows(1);
}

function buildChartData_() {
  const d = CONFIG.sheets.data;
  const sh = sheet_(CONFIG.sheets.chart);
  sh.clear();
  // 直近24時間の気温を「時刻 × 地点」の表にする（グラフの元データ）
  sh.getRange('A1').setFormula(
    '=QUERY(\'' + d + '\'!A1:L, "select A, max(D) where A >= datetime \'"&TEXT(NOW()-1,"yyyy-mm-dd HH:mm:ss")&"\' group by A pivot C", 1)');
  // 日ごとのまとめ
  sh.getRange('H1').setFormula(
    '=QUERY(\'' + d + '\'!A1:L, "select toDate(A), C, max(D), min(D), sum(F) where A is not null group by toDate(A), C order by toDate(A) desc label toDate(A) \'日付\', C \'地点\', max(D) \'最高気温\', min(D) \'最低気温\', sum(F) \'降水量合計\'", 1)');
  sh.getRange('A:A').setNumberFormat('mm/dd hh:mm');
  sh.getRange('H:H').setNumberFormat('yyyy/mm/dd');
}

function buildDashboard_() {
  const d = "'" + CONFIG.sheets.data + "'";
  const sh = sheet_(CONFIG.sheets.dash);
  sh.clear();
  sh.getCharts().forEach(c => sh.removeChart(c));

  sh.getRange('A1').setValue('アメダス 自動収集ダッシュボード').setFontSize(16).setFontWeight('bold');
  sh.getRange('A2').setFormula('="最終観測: "&TEXT(MAX(' + d + '!A2:A),"yyyy/mm/dd hh:mm")&"　（10分おきに自動更新）"');

  const head = ['地点', '最新の観測', '気温(℃)', '湿度(%)', '風速(m/s)', '今日の最高(℃)', '今日の最低(℃)', '今日の降水量(mm)'];
  sh.getRange(4, 1, 1, head.length).setValues([head]);
  sh.getRange(4, 1, 1, head.length).setFontWeight('bold').setBackground('#1F7A4A').setFontColor('#FFFFFF');

  CONFIG.stations.forEach((st, i) => {
    const r = 5 + i;
    const f = [
      st.name,
      '=IFERROR(MAXIFS(' + d + '!A2:A,' + d + '!C2:C,$A' + r + '),"")',
      '=IFERROR(INDEX(FILTER(' + d + '!D2:D,' + d + '!C2:C=$A' + r + ',' + d + '!A2:A=$B' + r + '),1),"")',
      '=IFERROR(INDEX(FILTER(' + d + '!E2:E,' + d + '!C2:C=$A' + r + ',' + d + '!A2:A=$B' + r + '),1),"")',
      '=IFERROR(INDEX(FILTER(' + d + '!G2:G,' + d + '!C2:C=$A' + r + ',' + d + '!A2:A=$B' + r + '),1),"")',
      '=IFERROR(MAXIFS(' + d + '!D2:D,' + d + '!C2:C,$A' + r + ',' + d + '!A2:A,">="&TODAY()),"")',
      '=IFERROR(MINIFS(' + d + '!D2:D,' + d + '!C2:C,$A' + r + ',' + d + '!A2:A,">="&TODAY()),"")',
      '=IFERROR(SUMIFS(' + d + '!F2:F,' + d + '!C2:C,$A' + r + ',' + d + '!A2:A,">="&TODAY()),"")',
    ];
    sh.getRange(r, 1, 1, f.length).setValues([f]);
  });
  const last = 4 + CONFIG.stations.length;
  sh.getRange(5, 2, CONFIG.stations.length, 1).setNumberFormat('mm/dd hh:mm');
  sh.getRange(4, 1, CONFIG.stations.length + 1, head.length).setBorder(true, true, true, true, true, true, '#D5DDE5', null);

  const r2 = last + 2;
  sh.getRange(r2, 1).setFormula('="取得状況（直近24時間）: 成功 "&COUNTIFS(\'' + CONFIG.sheets.log + '\'!C2:C,"追加*",\'' + CONFIG.sheets.log + '\'!A2:A,">="&(NOW()-1))&" 回 / エラー "&COUNTIFS(\'' + CONFIG.sheets.log + '\'!C2:C,"エラー",\'' + CONFIG.sheets.log + '\'!A2:A,">="&(NOW()-1))&" 回"');
  sh.getRange(r2 + 1, 1).setValue('出典：気象庁ホームページ（アメダス）のデータを加工して作成').setFontColor('#6B7785');

  const src = SpreadsheetApp.getActive().getSheetByName(CONFIG.sheets.chart);
  const chart = sh.newChart()
    .setChartType(Charts.ChartType.LINE)
    .addRange(src.getRange(1, 1, 200, 1 + CONFIG.stations.length))
    .setNumHeaders(1)
    .setPosition(r2 + 3, 1, 0, 0)
    .setOption('title', '直近24時間の気温（℃）')
    .setOption('width', 900)
    .setOption('height', 360)
    .setOption('legend', { position: 'bottom' })
    .build();
  sh.insertChart(chart);
  sh.setColumnWidths(1, head.length, 120);
}

/**
 * グラフの縦軸を、直近24時間の最低〜最高気温に合わせる。
 * （スプレッドシートのグラフは既定で0から始まり、気温の変化が平らに見えるため）
 */
function updateChartAxis_() {
  const ss = SpreadsheetApp.getActive();
  const dash = ss.getSheetByName(CONFIG.sheets.dash);
  const src = ss.getSheetByName(CONFIG.sheets.chart);
  if (!dash || !src || dash.getCharts().length === 0) return;
  SpreadsheetApp.flush();
  const temps = src.getRange(2, 2, 199, CONFIG.stations.length).getValues()
    .reduce((all, r) => all.concat(r), []).filter(v => typeof v === 'number');
  if (temps.length === 0) return;
  const min = Math.floor(Math.min.apply(null, temps)) - 1;
  const max = Math.ceil(Math.max.apply(null, temps)) + 1;
  const chart = dash.getCharts()[0];
  dash.updateChart(chart.modify().setOption('vAxes', { 0: { viewWindow: { min: min, max: max } } }).build());
}

function installTrigger_() {
  removeTriggers();
  ScriptApp.newTrigger('collect').timeBased().everyMinutes(CONFIG.intervalMinutes).create();
}

/** 自動実行を止める */
function removeTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'collect')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// Node.js でのテスト用（Apps Script では module が無いので無視される）
if (typeof module !== 'undefined') {
  module.exports = { latestKey, blockOf, prevBlock, keyToText, keyToDate, toRow, newObservations, collect, CONFIG, HEADERS };
}
