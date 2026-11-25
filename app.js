'use strict';

const LIMIT_MS = 10_000;
const ROUND_SIZE = 50;
const FEEDBACK_MS = 1_900;
const STORAGE_PREFIX = 'jlpt-trainer-round-v1:';
const MODES = {
  vocab: { name: '假名詞彙', symbol: '語', description: '看假名，快速辨認中文詞義。', instruction: '選出符合詞義的中文解釋' },
  mimetic: { name: '擬聲擬態詞', symbol: '音', description: '用情境練習聲音、動作與感受。', instruction: '選出這個語境中的詞義' },
  grammar: { name: 'N1 核心語法', symbol: '文', description: '從日文例句選出合適的文法。', instruction: '選出最適合填入空格的文法' },
};
const STATUS = { correct: '正確', wrong: '答錯', unknown: '不知道', timeout: '超時' };
const SPEED = ['2 秒內', '2 至 5 秒', '5 至 10 秒'];
const main = document.querySelector('#main');
const entries = new Map(Object.entries(BANK).flatMap(([mode, bank]) => bank.map(item => [item.id, { ...item, mode }])));

let storageFailed = false;
let rounds = readHistory();
let round = null;
let timer = null;
let advanceTimer = null;
let reviewMode = 'all';
let reviewDeck = [];
let reviewIndex = 0;
let reviewFlipped = false;

function readHistory() {
  try {
    const saved = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      try {
        const record = JSON.parse(localStorage.getItem(key));
        if (record?.id && MODES[record.mode] && Array.isArray(record.answers)) saved.push(record);
      } catch {
        // Preserve the rest of the history if a single record cannot be parsed.
      }
    }
    return saved.sort((left, right) => right.date.localeCompare(left.date));
  } catch {
    storageFailed = true;
    return [];
  }
}

function saveHistory(record) {
  try {
    localStorage.setItem(STORAGE_PREFIX + record.id, JSON.stringify(record));
    storageFailed = false;
  } catch {
    storageFailed = true;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function button(label, action, value = '', style = 'secondary') {
  return '<button type="button" class="' + style + '" data-action="' + action +
    '" data-value="' + escapeHtml(value) + '">' + escapeHtml(label) + '</button>';
}

function setView(markup, focus = true) {
  main.innerHTML = markup;
  if (focus) {
    const heading = main.querySelector('h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  }
}

function shuffle(values) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function clearTimers() {
  clearInterval(timer);
  clearTimeout(advanceTimer);
  timer = null;
  advanceTimer = null;
}

function showHome(focus = true) {
  setView(`<section class="hero">
    <p class="eyebrow">JLPT N1</p>
    <h1 lang="ja">日本語瞬発力</h1>
    <p>每輪 50 題，每題 10 秒。選擇一個題庫開始練習。</p>
  </section>
  <div class="cards">${Object.entries(MODES).map(([mode, { name, symbol, description }]) => `
    <section class="card mode">
      <div class="symbol" aria-hidden="true">${symbol}</div>
      <h2>${name}</h2>
      <p>${description}<br>${BANK[mode].length} 題可練習</p>
      ${button('開始練習', 'start', mode, 'primary')}
    </section>`).join('')}</div>`, focus);
}

function chooseOptions(item) {
  const solution = item.solution ?? item.meaning;
  let alternatives = item.decoys;
  if (!alternatives) {
    const candidates = BANK[item.mode].filter(other => other.id !== item.id &&
      other.reading !== item.reading && !other.categories.some(group => item.categories.includes(group)));
    const pool = candidates.length >= 3 ? candidates : BANK[item.mode].filter(other =>
      other.id !== item.id && other.reading !== item.reading);
    alternatives = [...new Set(shuffle(pool).map(other => other.meaning))].filter(meaning => meaning !== solution).slice(0, 3);
  }
  return [...shuffle([solution, ...alternatives]), '不知道／完全沒有印象'];
}

function start(mode) {
  if (!MODES[mode]) return;
  clearTimers();
  round = { mode, questions: shuffle(BANK[mode]).slice(0, ROUND_SIZE).map(item => entries.get(item.id)), answers: [] };
  showQuestion();
}

function showQuestion() {
  const item = round.questions[round.answers.length];
  const mode = MODES[round.mode];
  const index = round.answers.length + 1;
  const total = round.questions.length;
  const options = chooseOptions(item);
  round.options = options;
  round.feedback = false;
  const grammar = item.mode === 'grammar';
  setView(`<section class="flow">
    <div class="row between"><strong>${mode.name} · 第 ${index} / ${total} 題</strong><span id="time" class="time">10.0 秒</span></div>
    <progress id="meter" class="meter" aria-label="剩餘答題時間" max="${LIMIT_MS}" value="${LIMIT_MS}"></progress>
    <div class="card prompt">
      <p class="eyebrow">${mode.instruction}</p>
      <h1 lang="ja" class="${grammar ? 'grammar' : ''}">${escapeHtml(grammar ? item.context : item.reading)}</h1>
      ${!grammar && item.context ? `<p class="context" lang="ja">${escapeHtml(item.context)}</p>` : ''}
    </div>
    <div class="options" aria-label="答案選項">${options.map((choice, i) =>
      `<button type="button" class="option" data-action="answer" data-value="${i}"><span class="key" aria-hidden="true">${i + 1}</span><span${grammar && i < 4 ? ' lang="ja"' : ''}>${escapeHtml(choice)}</span></button>`
    ).join('')}</div>
    <p id="feedback" class="feedback" role="status"></p>
  </section>`);
  round.started = performance.now();
  timer = setInterval(tick, 40);
}

function updateTimer(remaining) {
  const display = document.querySelector('#time');
  display.textContent = (Math.ceil(remaining / 100) / 10).toFixed(1) + ' 秒';
  display.classList.toggle('urgent', remaining <= 3000);
  document.querySelector('#meter').value = remaining;
}

function tick() {
  const remaining = Math.max(0, LIMIT_MS - (performance.now() - round.started));
  updateTimer(remaining);
  if (remaining === 0) answer(null);
}

function answer(index) {
  if (!round || round.feedback || (index !== null && (!Number.isInteger(index) || index < 0 || index > 4))) return;
  const item = round.questions[round.answers.length];
  const elapsed = Math.min(LIMIT_MS, Math.max(0, performance.now() - round.started));
  if (elapsed >= LIMIT_MS) index = null;
  const solution = item.solution ?? item.meaning;
  const selected = index === null ? null : round.options[index];
  const status = index === null ? 'timeout' : index === 4 ? 'unknown' : selected === solution ? 'correct' : 'wrong';
  round.answers.push({ id: item.id, status, elapsed: Math.round(elapsed), selected });
  round.feedback = true;
  clearTimers();
  updateTimer(LIMIT_MS - elapsed);

  main.querySelectorAll('.option').forEach((option, i) => {
    option.disabled = true;
    option.classList.toggle('good', round.options[i] === solution);
    option.classList.toggle('bad', i === index && status !== 'correct');
  });
  const feedback = document.querySelector('#feedback');
  feedback.textContent = STATUS[status] + ' · ' + item.word + (item.solution ? ' · ' + solution : ' · ' + item.meaning);

  if (round.answers.length === round.questions.length) {
    const date = new Date().toISOString();
    const id = globalThis.crypto?.randomUUID?.() ?? date + '-' + Math.random().toString(36).slice(2);
    round.finished = { id, mode: round.mode, date, answers: round.answers };
    rounds = [round.finished, ...rounds];
    saveHistory(round.finished);
  }

  advanceTimer = setTimeout(() => {
    if (round.finished) {
      const finished = round.finished;
      round = null;
      showResult(finished);
      return;
    }
    showQuestion();
  }, FEEDBACK_MS);
}

function tally(answers) {
  const totals = { correct: 0, wrong: 0, unknown: 0, timeout: 0 };
  for (const { status } of answers) if (Object.hasOwn(totals, status)) totals[status]++;
  return totals;
}

function stats(answers) {
  return '<dl class="stats">' + Object.entries(tally(answers)).map(([status, count]) =>
    '<div><dt>' + STATUS[status] + '</dt><dd>' + count + '</dd></div>').join('') + '</dl>';
}

function speedSummary(answers) {
  const correct = answers.filter(answer => answer.status === 'correct');
  if (!correct.length) return '';
  const bands = [0, 0, 0];
  for (const answer of correct) bands[answer.elapsed <= 2000 ? 0 : answer.elapsed <= 5000 ? 1 : 2]++;
  const average = correct.reduce((sum, answer) => sum + answer.elapsed, 0) / correct.length / 1000;
  return `<p class="muted">答對題平均 ${average.toFixed(1)} 秒。 ${SPEED.map((band, i) => `${band}：${bands[i]} 題`).join(' · ')}</p>`;
}

function answerDetails(item) {
  return `<p lang="ja"><strong>${escapeHtml(item.word)}</strong>${item.alias ? '／' + escapeHtml(item.alias) : ''}　<span class="muted">${escapeHtml(item.reading)}</span></p>
    <p>${escapeHtml(item.meaning)}</p>
    ${item.connect ? `<p>接續　${escapeHtml(item.connect)}</p>` : ''}
    <p lang="ja">${escapeHtml(item.example)}</p>
    ${item.translation ? `<p class="muted">${escapeHtml(item.translation)}</p>` : ''}
    ${item.note ? `<p>${escapeHtml(item.note)}</p>` : ''}`;
}

function showResult(record) {
  const missed = record.answers.filter(answer => answer.status !== 'correct');
  const done = tally(record.answers);
  const percent = Math.round(100 * done.correct / record.answers.length);
  setView(`<section class="flow">
    <p class="eyebrow">${MODES[record.mode].name} · 練習結果</p>
    <h1>${done.correct} / ${record.answers.length} 答對 · ${percent}%</h1>
    ${stats(record.answers)}
    ${speedSummary(record.answers)}
    ${storageFailed ? '<p role="status">瀏覽器暫時無法儲存，本次結果只保留在目前頁面。</p>' : ''}
    <div class="row">
      ${missed.length ? button('翻卡複習本輪錯題', 'round-review', rounds.indexOf(record), 'primary') : ''}
      ${button('再做一輪', 'start', record.mode)}${button('回首頁', 'home')}
    </div>
    <div class="stack"><h2>本輪作答明細</h2>${record.answers.map((result, i) => {
      const item = entries.get(result.id);
      if (!item) return '';
      const prompt = item.mode === 'grammar' ? item.context : item.reading;
      return `<details class="card"><summary>${i + 1}. <span lang="ja">${escapeHtml(prompt)}</span> · ${STATUS[result.status]} · ${(result.elapsed / 1000).toFixed(1)} 秒</summary>
        ${result.selected ? `<p>你的選擇　${escapeHtml(result.selected)}</p>` : ''}
        ${answerDetails(item)}
      </details>`;
    }).join('')}</div>
  </section>`);
}

function modeTabs(action, selected) {
  return '<div class="tabs" aria-label="題庫篩選">' + [['all', '所有題庫'], ...Object.entries(MODES).map(([key, value]) => [key, value.name])]
    .map(([key, name]) => `<button type="button" class="secondary" data-action="${action}" data-value="${key}" aria-pressed="${key === selected}">${name}</button>`)
    .join('') + '</div>';
}

function showHistory(filter = 'all') {
  const records = rounds.filter(record => filter === 'all' || record.mode === filter)
    .sort((left, right) => right.date.localeCompare(left.date));
  const answers = records.flatMap(record => record.answers);
  setView(`<section class="flow">
    <h1>學習檔案</h1>
    <p class="muted">學習紀錄保存在目前的瀏覽器。${storageFailed ? ' 目前無法存取瀏覽器儲存空間。' : ''}</p>
    ${modeTabs('history', filter)}
    ${records.length ? `<p class="context">${records.length} 輪 · ${answers.length} 題 · 正確率 ${Math.round(100 * tally(answers).correct / answers.length)}%</p>${stats(answers)}${speedSummary(answers)}` : '<p class="context">這個題庫還沒有完成的練習紀錄。</p>'}
    <div class="stack">${records.map(record => {
      const date = new Date(record.date).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' });
      return button(date + ' · ' + MODES[record.mode].name + ' · ' + tally(record.answers).correct + ' / ' + record.answers.length, 'result', rounds.indexOf(record), 'secondary list-button');
    }).join('')}</div>
  </section>`);
}

function buildReview(filter, recordIndex) {
  reviewMode = filter;
  const records = recordIndex === null ? rounds.slice().sort((left, right) => right.date.localeCompare(left.date)) : [rounds[recordIndex]].filter(Boolean);
  const latest = new Map();
  for (const record of records) {
    if (filter !== 'all' && filter !== record.mode) continue;
    for (const answer of record.answers) if (!latest.has(answer.id)) latest.set(answer.id, answer);
  }
  reviewDeck = [...latest.values()].filter(answer => answer.status !== 'correct' && entries.has(answer.id));
  reviewIndex = 0;
  reviewFlipped = false;
  showReview(recordIndex);
}

let activeReviewRecord = null;

function showReview(recordIndex, focus = true) {
  activeReviewRecord = recordIndex;
  const result = reviewDeck[reviewIndex];
  const item = result && entries.get(result.id);
  setView(`<section class="flow">
    <h1>${recordIndex === null ? '錯題複習' : '本輪錯題複習'}</h1>
    ${recordIndex === null ? modeTabs('review', reviewMode) : button('回本輪結果', 'result', recordIndex)}
    ${item ? `<div class="stack"><article class="card flash">
      <p class="eyebrow">${MODES[item.mode].name} · ${reviewIndex + 1} / ${reviewDeck.length} · ${STATUS[result.status]}</p>
      <h2 lang="ja">${escapeHtml(item.mode === 'grammar' ? item.context : item.reading)}</h2>
      ${item.mode !== 'grammar' && item.context ? `<p lang="ja">${escapeHtml(item.context)}</p>` : ''}
      <div id="flash-answer" aria-live="polite">${reviewFlipped ? answerDetails(item) : ''}</div>
      ${button(reviewFlipped ? '收起答案' : '翻面看答案', 'flip', '', 'primary')}
      <div class="row">${reviewIndex > 0 ? button('上一張', 'step', -1) : ''}
      ${reviewIndex + 1 < reviewDeck.length ? button('下一張', 'step', 1) : ''}</div>
    </article></div>` : '<p class="context">目前沒有需要複習的題目。</p>'}
  </section>`, focus);
  if (!focus) main.querySelector('[data-action="flip"]')?.focus({ preventScroll: true });
}

function navigate(callback) {
  if (round && round.answers.length < round.questions.length && !window.confirm('要離開這輪練習嗎？本輪尚未完成，作答紀錄將不會儲存。')) return;
  clearTimers();
  round = null;
  callback();
}

main.addEventListener('click', event => {
  const target = event.target.closest('button[data-action]');
  if (!target) return;
  const { action, value } = target.dataset;
  switch (action) {
    case 'start': start(value); break;
    case 'answer': answer(Number(value)); break;
    case 'home': navigate(showHome); break;
    case 'history': showHistory(value); break;
    case 'result': if (rounds[Number(value)]) showResult(rounds[Number(value)]); break;
    case 'review': buildReview(value, null); break;
    case 'round-review': buildReview('all', Number(value)); break;
    case 'flip': reviewFlipped = !reviewFlipped; showReview(activeReviewRecord, false); break;
    case 'step': reviewIndex += Number(value); reviewFlipped = false; showReview(activeReviewRecord, false); break;
  }
});

document.querySelector('#home').addEventListener('click', () => navigate(showHome));
document.querySelector('#history').addEventListener('click', () => navigate(showHistory));
document.querySelector('#review').addEventListener('click', () => navigate(() => buildReview('all', null)));
document.addEventListener('keydown', event => {
  if (!round || event.repeat || event.ctrlKey || event.altKey || event.metaKey || !/^[1-5]$/.test(event.key)) return;
  event.preventDefault();
  answer(Number(event.key) - 1);
});
window.addEventListener('storage', event => {
  if (event.key?.startsWith(STORAGE_PREFIX) && !storageFailed) {
    // Keep existing indices stable while results and review cards are open.
    const known = new Set(rounds.map(record => record.id));
    rounds.push(...readHistory().filter(record => !known.has(record.id)));
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && round && !round.feedback) tick();
});

showHome(false);
