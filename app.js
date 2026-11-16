import { createBackend } from './backend.js?v=4';

// A live poll: questions on the big screen, votes from phones, results as bars. No scores.
// Routes: "#host" is the poll runner (library, editor, big screen); anything else is the voter's phone.
// Data layout (same in Firebase and demo mode):
//   quizzes/<hostUid>/<pollId>       { title, updatedAt, questions: [{ id, text, options[2..10], time, image }] }
//   games/<pin>                      { hostUid, createdAt, quizId, state, players, answers }
//   games/<pin>/state                what every phone renders
//   games/<pin>/players/<uid>        { name, joinedAt }
//   games/<pin>/answers/<q>/<uid>    { choice }  (only the host can read other people's votes)

// The "Lab members" button in the editor fills a question's answers with these names.
const LAB_MEMBERS = ['Olivia and Meghan', 'Colin', 'Dalia', 'Valeria', 'Sydney', 'Tessa', 'Amelie'];

const $app = document.getElementById('app');
const LETTERS = 'ABCDEFGHIJ'.split('');
const MAX_OPTS = LETTERS.length;
const TIMES = [0, 15, 30, 60, 90, 120]; // 0 = no time limit: the host closes voting
const PLAYER_KEY = 'buzzerlab-player';
const HOST_KEY = 'buzzerlab-hosting';
let be;
let cleanups = [];

/* ---------- small helpers ---------- */

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k === 'value') n.value = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (typeof v !== 'string' && k in n) n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid != null && kid !== false) n.append(kid instanceof Node ? kid : String(kid));
  }
  return n;
}

function svg(tag, attrs, ...kids) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids);
  return n;
}

function clearSubs() {
  for (const f of cleanups) { try { f(); } catch { /* ignore */ } }
  cleanups = [];
}

function show(...nodes) { $app.replaceChildren(...nodes); window.scrollTo(0, 0); }

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const asArray = v => Array.isArray(v) ? v
  : v && typeof v === 'object' ? Object.keys(v).sort((a, b) => a - b).map(k => v[k]) : [];
const errText = e => e?.code ? e.code.replace(/^.*\//, '').replace(/-/g, ' ') : (e?.message || String(e));
const color = k => `o${k % 4}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function store(kind, key, value) {
  try {
    const s = kind === 'session' ? sessionStorage : localStorage;
    if (value === undefined) return JSON.parse(s.getItem(key));
    if (value === null) s.removeItem(key); else s.setItem(key, JSON.stringify(value));
  } catch { return null; }
}

let toastTimer;
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = el('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function brand(small) {
  return el('div', { class: 'brand' + (small ? ' small' : '') },
    el('span', { class: 'brand-dot', 'aria-hidden': 'true' }), el('span', {}, 'Buzzer Lab'));
}

function screen(kind, ...kids) { return el('main', { class: 'screen ' + kind }, ...kids); }

function splash(msg) { return screen('narrow center', brand(), el('p', { class: 'muted' }, msg)); }

function errorScreen(msg, e, back) {
  return screen('narrow', brand(), el('h1', {}, msg), el('p', { class: 'err' }, errText(e)),
    back ? el('button', { class: 'btn', onclick: back }, 'Go back') : null);
}

// A button that asks once more before doing something destructive.
function confirmButton(label, confirmLabel, action, cls = 'btn ghost') {
  let armed = false, timer;
  const b = el('button', {
    class: cls, type: 'button',
    onclick: () => {
      if (armed) { clearTimeout(timer); action(); return; }
      armed = true;
      b.textContent = confirmLabel;
      b.classList.add('armed');
      timer = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('armed'); }, 3500);
    },
  }, label);
  return b;
}

function ring() {
  const C = 2 * Math.PI * 44;
  const arc = svg('circle', { cx: 50, cy: 50, r: 44, class: 'ring-arc', 'stroke-dasharray': C, 'stroke-dashoffset': 0 });
  const num = el('span', { class: 'ring-num' });
  const node = el('div', { class: 'ring', role: 'timer', 'aria-label': 'Seconds left' },
    svg('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' }, svg('circle', { cx: 50, cy: 50, r: 44, class: 'ring-track' }), arc), num);
  return {
    node,
    set(frac, secs) {
      arc.setAttribute('stroke-dashoffset', C * (1 - frac));
      num.textContent = secs;
      node.classList.toggle('low', secs <= 5);
    },
  };
}

/* ---------- poll model ---------- */

function normQ(q = {}) {
  const opts = asArray(q.options).filter(o => typeof o === 'string').slice(0, MAX_OPTS);
  while (opts.length < 2) opts.push('');
  return {
    id: q.id || newId(),
    text: q.text || '',
    options: opts,
    time: TIMES.includes(q.time) ? q.time : 0,
    image: q.image || null,
  };
}
const blankQ = () => normQ({});
const filled = q => q.options.filter(o => o.trim());
const validQ = q => !!(q.text.trim() && filled(q).length >= 2);
// Games use only the filled-in answers, so the letters on screen have no gaps.
const playable = q => ({ ...q, options: filled(q).map(o => o.trim()) });

function samplePoll() {
  return {
    title: 'Sample: Retreat awards',
    questions: [
      { text: 'Best elevator pitch', options: LAB_MEMBERS },
      { text: 'Meatiest figure', options: LAB_MEMBERS },
      { text: 'Most savage Reviewer 2', options: LAB_MEMBERS },
      { text: 'How close is your paper to submission?', options: ['This month', 'This term', 'This year', 'Ask me again next retreat'] },
    ].map(normQ),
  };
}

async function downscale(file, max = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Which answers got the most votes. Returns [] when nobody voted.
function winners(counts, n) {
  const top = Math.max(0, ...Array.from({ length: n }, (_, k) => counts[k] || 0));
  return top ? Array.from({ length: n }, (_, k) => k).filter(k => (counts[k] || 0) === top) : [];
}

/* ---------- boot ---------- */

boot();

async function boot() {
  show(splash('Loading…'));
  try {
    be = await createBackend();
  } catch (e) {
    show(errorScreen('Couldn’t connect to Firebase. Check firebase-config.js.', e));
    return;
  }
  if (be.mode === 'demo') {
    document.body.append(el('div', { class: 'demo-banner' },
      el('strong', {}, 'Demo mode. '), 'Everything stays in this browser: open more tabs to vote along. Add your Firebase settings to vote from phones.'));
  }
  window.addEventListener('hashchange', route);
  route();
}

function route() {
  clearSubs();
  if (location.hash === '#host') hostHome(); else playerHome();
}

/* ---------- host: sign-in, library, editor ---------- */

async function hostHome() {
  if (be.mode === 'firebase' && (!be.user || be.user.anonymous)) return hostSignIn();
  await be.signInHost();
  const saved = store('session', HOST_KEY);
  if (saved?.pin) {
    const game = await be.get(`games/${saved.pin}`).catch(() => null);
    if (game?.hostUid === be.user.uid && game.state) return resumeGame(saved.pin, game);
    store('session', HOST_KEY, null);
  }
  library();
}

function hostSignIn() {
  clearSubs();
  const err = el('p', { class: 'err', role: 'alert' });
  show(screen('narrow',
    brand(),
    el('h1', {}, 'Run a poll'),
    el('p', { class: 'lead' }, 'Sign in to write polls and run them. Voters join with a PIN and don’t need an account.'),
    el('button', {
      class: 'btn primary big', onclick: async () => {
        try { await be.signInHost(); hostHome(); } catch (e) { err.textContent = 'Sign-in didn’t work: ' + errText(e); }
      },
    }, 'Sign in with Google'),
    err,
    el('a', { class: 'link', href: '#' }, 'I’m here to vote')));
}

function topbar() {
  return el('header', { class: 'topbar' }, brand(true),
    be.mode === 'firebase'
      ? el('button', { class: 'btn ghost small', onclick: async () => { await be.signOut(); hostSignIn(); } }, 'Sign out')
      : null);
}

function library() {
  clearSubs();
  const uid = be.user.uid;
  const list = el('div', { class: 'quiz-list' }, el('p', { class: 'muted' }, 'Loading your polls…'));
  const create = async poll => {
    const id = newId();
    await be.set(`quizzes/${uid}/${id}`, { ...poll, updatedAt: be.TS });
    editor(id);
  };
  show(screen('wide',
    topbar(),
    el('div', { class: 'lib-head' },
      el('h1', {}, 'Your polls'),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => create(samplePoll()) }, 'Add sample poll'),
        el('button', { class: 'btn primary', onclick: () => create({ title: 'Untitled poll', questions: [blankQ()] }) }, 'New poll'))),
    list));

  cleanups.push(be.on(`quizzes/${uid}`, v => {
    const polls = Object.entries(v || {}).map(([id, q]) => ({ id, ...q }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (!polls.length) {
      list.replaceChildren(el('div', { class: 'empty' },
        el('h2', {}, 'No polls yet'),
        el('p', {}, 'Start a new poll, or add the sample to see how one runs.')));
      return;
    }
    list.replaceChildren(...polls.map(p => {
      const qs = asArray(p.questions).map(normQ);
      const ready = qs.filter(validQ).length;
      return el('article', { class: 'quiz-card' },
        el('div', { class: 'quiz-meta' },
          el('h2', {}, p.title || 'Untitled poll'),
          el('p', { class: 'muted' }, plural(qs.length, 'question'),
            ready < qs.length ? ` · ${qs.length - ready} unfinished` : '')),
        el('div', { class: 'row' },
          confirmButton('Delete', 'Delete poll?', () => be.remove(`quizzes/${uid}/${p.id}`), 'btn ghost small'),
          el('button', { class: 'btn small', onclick: () => editor(p.id) }, 'Edit'),
          el('button', { class: 'btn primary small', disabled: !ready, onclick: () => hostGame(p.id) }, 'Run poll')));
    }));
  }));
}

async function editor(pollId) {
  clearSubs();
  const path = `quizzes/${be.user.uid}/${pollId}`;
  show(splash('Opening poll…'));
  const raw = await be.get(path);
  if (!raw) return library();
  const poll = { title: raw.title || '', questions: asArray(raw.questions).map(normQ) };
  if (!poll.questions.length) poll.questions.push(blankQ());

  const status = el('span', { class: 'save-status', 'aria-live': 'polite' }, 'All changes saved');
  let timer = null;
  const write = async () => {
    timer = null;
    try {
      await be.set(path, { ...poll, updatedAt: be.TS });
      if (!timer) status.textContent = 'All changes saved';
    } catch (e) { status.textContent = 'Couldn’t save: ' + errText(e); }
  };
  const save = () => { status.textContent = 'Saving…'; clearTimeout(timer); timer = setTimeout(write, 500); };
  const flush = async () => { if (timer) { clearTimeout(timer); await write(); } };
  cleanups.push(() => { flush(); });

  const list = el('div', { class: 'q-list' });
  const render = () => list.replaceChildren(...poll.questions.map(qCard),
    el('button', {
      class: 'btn add-q', onclick: () => {
        poll.questions.push(blankQ());
        save();
        render();
        list.querySelectorAll('textarea')[poll.questions.length - 1]?.focus();
      },
    }, '+ Add question'));

  function qCard(q, i) {
    const n = poll.questions.length;
    const warn = el('p', { class: 'warn' }, 'Needs a question and at least two answers. It’s skipped in polls until then.');
    const check = () => { warn.hidden = validQ(q); };
    check();
    const move = d => {
      const j = i + d;
      [poll.questions[i], poll.questions[j]] = [poll.questions[j], poll.questions[i]];
      save();
      render();
    };
    const fileIn = el('input', {
      type: 'file', accept: 'image/*', class: 'visually-hidden', tabindex: '-1',
      onchange: async e => {
        const f = e.target.files[0];
        if (!f) return;
        try { q.image = await downscale(f); save(); render(); } catch { toast('That file couldn’t be read as an image.'); }
      },
    });
    const pick = el('button', { class: 'btn ghost small', type: 'button', onclick: () => fileIn.click() }, q.image ? 'Replace image' : 'Add image');

    const fillLab = () => {
      q.options = LAB_MEMBERS.slice(0, MAX_OPTS);
      save();
      render();
    };
    const isLab = q.options.length === LAB_MEMBERS.length && q.options.every((o, k) => o === LAB_MEMBERS[k]);
    const labBtn = isLab ? null
      : filled(q).length
        ? confirmButton('Fill with lab members', 'Replace these answers?', fillLab, 'btn small lab-btn')
        : el('button', { class: 'btn small lab-btn', type: 'button', onclick: fillLab }, 'Fill with lab members');

    return el('article', { class: 'q-card' },
      el('div', { class: 'q-card-head' },
        el('span', { class: 'eyebrow' }, `Question ${i + 1}`),
        el('div', { class: 'row tight' },
          el('button', { class: 'icon-btn', disabled: i === 0, onclick: () => move(-1), 'aria-label': 'Move question up' }, '↑'),
          el('button', { class: 'icon-btn', disabled: i === n - 1, onclick: () => move(1), 'aria-label': 'Move question down' }, '↓'),
          n > 1 ? confirmButton('Delete', 'Delete question?', () => { poll.questions.splice(i, 1); save(); render(); }, 'btn ghost small') : null)),
      el('textarea', {
        id: `t-${q.id}`, rows: 2, placeholder: 'Type the question, e.g. “Best figure of the day”', value: q.text, 'aria-label': `Question ${i + 1} text`,
        oninput: e => { q.text = e.target.value; save(); check(); },
      }),
      el('div', { class: 'img-row' },
        q.image ? el('img', { src: q.image, alt: '', class: 'thumb' }) : null,
        fileIn, pick,
        q.image ? el('button', { class: 'btn ghost small', onclick: () => { q.image = null; save(); render(); } }, 'Remove image') : null,
        el('span', { class: 'muted small' }, 'Images show on the big screen only.')),
      el('div', { class: 'opts-head' },
        el('span', { class: 'muted' }, 'Answers'),
        labBtn),
      el('div', { class: 'opts' }, q.options.map((o, k) => el('div', { class: 'opt-row' },
        el('span', { class: `badge ${color(k)}`, 'aria-hidden': 'true' }, LETTERS[k]),
        el('input', {
          id: `o-${q.id}-${k}`, value: o, 'aria-label': `Answer ${LETTERS[k]}`, placeholder: `Answer ${LETTERS[k]}`,
          oninput: e => { q.options[k] = e.target.value; save(); check(); },
        }),
        q.options.length > 2
          ? el('button', {
            class: 'icon-btn', type: 'button', 'aria-label': `Remove answer ${LETTERS[k]}`,
            onclick: () => { q.options.splice(k, 1); save(); render(); },
          }, '×')
          : null))),
      el('div', { class: 'row' },
        q.options.length < MAX_OPTS
          ? el('button', {
            class: 'btn ghost small', type: 'button', onclick: () => {
              q.options.push('');
              save();
              render();
              document.getElementById(`o-${q.id}-${q.options.length - 1}`)?.focus();
            },
          }, '+ Add answer')
          : null,
        el('span', { class: 'spacer' }),
        el('label', { for: `time-${q.id}`, class: 'muted' }, 'Time limit'),
        el('select', { id: `time-${q.id}`, onchange: e => { q.time = +e.target.value; save(); } },
          TIMES.map(t => el('option', { value: String(t), selected: q.time === t }, t ? `${t} seconds` : 'None (I close voting)')))),
      warn);
  }

  show(screen('wide editor',
    el('header', { class: 'topbar' },
      el('button', { class: 'btn ghost small', onclick: async () => { await flush(); library(); } }, '← Your polls'),
      el('div', { class: 'row' }, status,
        el('button', {
          class: 'btn primary', onclick: async () => {
            if (!poll.questions.some(validQ)) return toast('Finish at least one question before running the poll.');
            await flush();
            hostGame(pollId);
          },
        }, 'Run poll'))),
    el('input', {
      id: 'quiz-title', class: 'title-input', value: poll.title, placeholder: 'Poll title', 'aria-label': 'Poll title',
      oninput: e => { poll.title = e.target.value; save(); },
    }),
    list));
  render();
}

/* ---------- host: the big screen ---------- */

async function loadQuestions(uid, pollId) {
  const raw = await be.get(`quizzes/${uid}/${pollId}`);
  return { raw, questions: asArray(raw?.questions).map(normQ).filter(validQ).map(playable) };
}

async function hostGame(pollId) {
  clearSubs();
  show(splash('Setting up the poll…'));
  const uid = be.user.uid;
  try {
    const { raw, questions } = await loadQuestions(uid, pollId);
    if (!questions.length) { toast('This poll has no finished questions yet.'); return editor(pollId); }
    let pin;
    for (let t = 0; t < 10; t++) {
      pin = String(100000 + Math.floor(Math.random() * 900000));
      if ((await be.get(`games/${pin}/hostUid`)) == null) break;
    }
    const state = { phase: 'lobby', title: raw.title || 'Poll', total: questions.length, qIndex: -1 };
    await be.set(`games/${pin}`, { hostUid: uid, createdAt: be.TS, quizId: pollId, state });
    hostStage(pin, questions, state);
  } catch (e) {
    show(errorScreen('Couldn’t start the poll.', e, library));
  }
}

async function resumeGame(pin, game) {
  const { questions } = await loadQuestions(be.user.uid, game.quizId).catch(() => ({ questions: [] }));
  if (!questions.length) { store('session', HOST_KEY, null); return library(); }
  hostStage(pin, questions, game.state);
}

function hostStage(pin, questions, initial) {
  const G = `games/${pin}`;
  const title = initial.title;
  const root = el('main', { class: 'stage' });
  show(root);
  store('session', HOST_KEY, { pin });

  let state = initial, players = {}, answers = {}, closing = false, ansUnsub = null, tick = null, live = {};
  let startedAt = typeof initial.startedAt === 'number' ? initial.startedAt : null;
  const joinUrl = location.protocol.startsWith('http') ? `${location.origin}${location.pathname}?pin=${pin}` : '';

  cleanups.push(() => { clearInterval(tick); ansUnsub?.(); });
  cleanups.push(be.on(`${G}/players`, v => {
    players = v || {};
    if (state.phase === 'question') updateLive(); else paint();
  }));
  cleanups.push(be.on(`${G}/state/startedAt`, v => {
    if (state.phase === 'question' && typeof v === 'number') startedAt = v;
  }));

  // Every question's tally is kept in the state so the summary survives a reload.
  const carry = () => ({ title, total: questions.length, tallies: state.tallies || {} });

  async function setState(s) {
    state = s;
    paint();
    try { await be.set(`${G}/state`, s); } catch (e) { toast('Couldn’t update the poll: ' + errText(e)); }
  }

  function listenAnswers(i) {
    ansUnsub?.();
    answers = {};
    ansUnsub = be.on(`${G}/answers/${i}`, v => { answers = v || {}; updateLive(); });
  }

  async function startQuestion(i) {
    const q = questions[i];
    startedAt = null;
    closing = false;
    listenAnswers(i);
    await setState({ ...carry(), phase: 'question', qIndex: i, question: { text: q.text, options: q.options, time: q.time }, startedAt: be.TS });
    startTick();
  }

  const voted = () => Object.keys(answers).filter(u => players[u]).length;

  function startTick() {
    clearInterval(tick);
    const q = questions[state.qIndex];
    if (!q.time) return;
    tick = setInterval(() => {
      if (state.phase !== 'question') return clearInterval(tick);
      const limit = q.time * 1000;
      const left = Math.max(0, limit - (be.now() - (startedAt ?? be.now())));
      live.ring?.set(left / limit, Math.ceil(left / 1000));
      if (startedAt != null && left <= 0) closeVoting();
    }, 100);
  }

  async function closeVoting() {
    if (closing) return;
    closing = true;
    clearInterval(tick);
    const i = state.qIndex, n = questions[i].options.length;
    const counts = Array(n).fill(0);
    for (const uid of Object.keys(players)) {
      const c = answers[uid]?.choice;
      if (Number.isInteger(c) && c >= 0 && c < n) counts[c]++;
    }
    const tallies = { ...(state.tallies || {}), [i]: counts };
    await setState({ ...carry(), tallies, phase: 'results', qIndex: i, question: state.question, counts });
  }

  async function runAgain() {
    await be.remove(`${G}/answers`);
    setState({ title, total: questions.length, phase: 'lobby', qIndex: -1 });
  }

  async function endGame() {
    clearSubs();
    store('session', HOST_KEY, null);
    await be.remove(G).catch(() => {});
    library();
  }

  function updateLive() {
    if (state.phase !== 'question' || !live.count) return;
    const n = Object.keys(players).length, v = voted();
    live.count.textContent = n && v >= n ? `Everyone has voted (${v})` : `${v} of ${n} voted`;
    live.count.classList.toggle('all-in', n > 0 && v >= n);
  }

  function paint() {
    live = {};
    const views = { lobby: lobbyView, question: questionView, results: resultsView, done: summaryView };
    root.replaceChildren((views[state.phase] || lobbyView)());
    updateLive();
  }

  function stageTop(left, right) {
    return el('header', { class: 'stage-top' }, left, right);
  }

  function lobbyView() {
    const list = Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
    const qr = el('div', { class: 'qr', 'aria-hidden': 'true' });
    if (joinUrl && window.QRCode) {
      new window.QRCode(qr, { text: joinUrl, width: 220, height: 220, colorDark: '#141726', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
    }
    return el('div', { class: 'lobby' },
      stageTop(brand(true), el('span', { class: 'muted' }, title)),
      el('section', { class: 'join-card' },
        el('div', { class: 'join-text' },
          el('p', { class: 'eyebrow' }, 'Vote on your phone'),
          el('p', { class: 'join-url' }, joinUrl ? joinUrl.replace(/^https?:\/\//, '').replace(/\?pin=.*/, '') : 'Open this page on your phone'),
          el('p', { class: 'eyebrow' }, 'PIN'),
          el('p', { class: 'pin' }, pin.slice(0, 3) + ' ' + pin.slice(3))),
        joinUrl ? qr : null),
      el('section', { class: 'roster' },
        el('h2', {}, list.length ? `${list.length} ${list.length === 1 ? 'person' : 'people'} in` : 'Waiting for people to join…'),
        el('div', { class: 'chips' }, list.map(([uid, p]) =>
          confirmButton(p.name, `Remove ${p.name}?`, () => be.remove(`${G}/players/${uid}`), 'chip')))),
      el('footer', { class: 'stage-actions' },
        confirmButton('Cancel poll', 'Cancel the poll?', endGame),
        el('button', { class: 'btn primary big', disabled: !list.length, onclick: () => startQuestion(0) }, 'Start poll')));
  }

  function optionGrid(q) {
    return el('div', { class: 'opt-grid' + (q.options.length > 4 ? ' many' : '') }, q.options.map((o, k) =>
      el('div', { class: `opt ${color(k)}` }, el('span', { class: 'badge' }, LETTERS[k]), el('span', {}, o))));
  }

  function questionView() {
    const i = state.qIndex, q = questions[i];
    live.count = el('span', { class: 'answered', 'aria-live': 'polite' });
    if (q.time) live.ring = ring();
    return el('div', { class: 'qview' + (q.image ? ' has-image' : '') },
      stageTop(el('span', { class: 'eyebrow' }, `Question ${i + 1} of ${questions.length}`), el('div', { class: 'row' }, live.count, live.ring?.node)),
      el('h1', { class: 'q-text' }, q.text),
      q.image ? el('div', { class: 'q-image' }, el('img', { src: q.image, alt: 'Question image' })) : null,
      optionGrid(q),
      el('footer', { class: 'stage-actions' },
        el('button', { class: 'btn primary big', onclick: closeVoting }, 'Close voting')));
  }

  function bars(q, counts) {
    const n = q.options.length;
    const total = counts.reduce((a, b) => a + (b || 0), 0);
    const max = Math.max(1, ...counts.map(c => c || 0));
    const top = winners(counts, n);
    return el('div', { class: 'bars' + (n > 5 ? ' many' : '') }, q.options.map((o, k) => {
      const c = counts[k] || 0;
      return el('div', { class: 'bar-row' + (top.includes(k) ? ' is-top' : '') },
        el('span', { class: `badge ${color(k)}` }, LETTERS[k]),
        el('span', { class: 'bar-label' }, o),
        el('span', { class: 'bar-track' }, el('span', { class: `bar-fill ${color(k)}`, style: `width:${c / max * 100}%` })),
        el('span', { class: 'bar-count' }, c, el('span', { class: 'pct' }, total ? ` ${Math.round(c / total * 100)}%` : '')));
    }));
  }

  function resultsView() {
    const i = state.qIndex, q = questions[i], counts = asArray(state.counts);
    const total = counts.reduce((a, b) => a + (b || 0), 0);
    const last = i >= questions.length - 1;
    return el('div', { class: 'rview' + (q.image ? ' has-image' : '') },
      stageTop(el('span', { class: 'eyebrow' }, `Question ${i + 1} of ${questions.length}`),
        el('span', { class: 'muted' }, plural(total, 'vote'))),
      el('h1', { class: 'q-text small' }, q.text),
      q.image ? el('div', { class: 'q-image small' }, el('img', { src: q.image, alt: 'Question image' })) : null,
      bars(q, counts),
      el('footer', { class: 'stage-actions' },
        el('button', {
          class: 'btn primary big',
          onclick: () => last ? setState({ ...carry(), phase: 'done', qIndex: i }) : startQuestion(i + 1),
        }, last ? 'Show summary' : 'Next question')));
  }

  function summaryView() {
    const tallies = state.tallies || {};
    return el('div', { class: 'summary' },
      stageTop(brand(true), el('span', { class: 'muted' }, title)),
      el('h1', {}, 'Results'),
      el('ol', { class: 'recap' }, questions.map((q, i) => {
        const counts = asArray(tallies[i]);
        const total = counts.reduce((a, b) => a + (b || 0), 0);
        const top = winners(counts, q.options.length);
        const answer = !counts.length ? 'Skipped'
          : !top.length ? 'No votes'
          : (top.length > 1 ? 'Tie: ' : '') + top.map(k => q.options[k]).join(', ');
        return el('li', {},
          el('span', { class: 'recap-q' }, q.text),
          el('span', { class: 'recap-a' + (top.length ? '' : ' none') }, answer),
          el('span', { class: 'recap-n' }, top.length ? `${counts[top[0]]} of ${plural(total, 'vote')}` : ''));
      })),
      el('footer', { class: 'stage-actions' },
        el('button', { class: 'btn ghost', onclick: runAgain }, 'Run again'),
        confirmButton('End poll', 'End and close the poll?', endGame, 'btn primary big')));
  }

  if (state.phase === 'question') { listenAnswers(state.qIndex); startTick(); }
  paint();
}

/* ---------- voter ---------- */

function playerHome() {
  const saved = store('session', PLAYER_KEY);
  if (saved?.pin) return playerJoin(saved.pin, saved.name, true);
  joinForm(new URLSearchParams(location.search).get('pin') || '', '');
}

function joinForm(pin = '', name = '', msg = '') {
  clearSubs();
  const pinIn = el('input', {
    id: 'pin', class: 'pin-input', inputmode: 'numeric', autocomplete: 'off', maxlength: '7', placeholder: '000 000', value: pin,
  });
  const nameIn = el('input', { id: 'nick', maxlength: '20', autocomplete: 'nickname', placeholder: 'Your name', value: name });
  const note = el('p', { class: 'note', role: 'alert' }, msg);
  const form = el('form', {
    class: 'join', novalidate: true,
    onsubmit: e => {
      e.preventDefault();
      const p = pinIn.value.replace(/\D/g, '');
      const n = nameIn.value.trim();
      if (p.length !== 6) { note.textContent = 'The PIN has 6 digits. You’ll find it on the big screen.'; pinIn.focus(); return; }
      if (!n) { note.textContent = 'Add your name so the host can see you’ve joined.'; nameIn.focus(); return; }
      playerJoin(p, n);
    },
  },
  el('label', { for: 'pin' }, 'PIN'), pinIn,
  el('label', { for: 'nick' }, 'Your name'), nameIn,
  el('p', { class: 'muted small' }, 'Your name shows when you join. Your votes are anonymous.'),
  el('button', { class: 'btn primary big', type: 'submit' }, 'Join'),
  note);
  show(screen('narrow', brand(), el('h1', {}, 'Join a poll'), form, el('a', { class: 'link quiet', href: '#host' }, 'Run a poll instead')));
  (pin ? nameIn : pinIn).focus();
}

async function playerJoin(pin, name, silent) {
  clearSubs();
  show(splash('Joining…'));
  try {
    await be.signInPlayer();
    const uid = be.user.uid;
    const G = `games/${pin}`;
    const state = await be.get(`${G}/state`);
    if (!state) {
      store('session', PLAYER_KEY, null);
      return joinForm(silent ? '' : pin, name, silent ? '' : 'There’s no poll with that PIN. Check the number on the big screen.');
    }
    const existing = await be.get(`${G}/players/${uid}`);
    if (!existing) await be.set(`${G}/players/${uid}`, { name: name.slice(0, 20), joinedAt: be.TS });
    store('session', PLAYER_KEY, { pin, name });
    playerStage(pin, uid);
  } catch (e) {
    joinForm(pin, name, 'Couldn’t join: ' + errText(e));
  }
}

function playerStage(pin, uid) {
  const G = `games/${pin}`;
  const root = el('main', { class: 'phone' });
  show(root);
  let state = null, me = null, tick = null, left = false, changing = false;
  const mine = {};

  const leave = msg => {
    if (left) return;
    left = true;
    store('session', PLAYER_KEY, null);
    joinForm('', me?.name || '', msg);
  };

  cleanups.push(() => clearInterval(tick));
  cleanups.push(be.on(`${G}/players/${uid}`, async v => {
    if (v) { me = v; if (state) paint(); return; }
    if (!me) return;
    // Our entry vanished: either the host removed us or the whole poll was closed.
    const gameState = await be.get(`${G}/state`).catch(() => null);
    leave(gameState ? 'The host removed you from the poll.' : 'The poll has ended. Thanks for voting!');
  }));
  cleanups.push(be.on(`${G}/state`, async v => {
    if (!v) return leave('The poll has ended. Thanks for voting!');
    const prev = state;
    state = v;
    if (v.phase === 'lobby') for (const k of Object.keys(mine)) delete mine[k]; // "Run again" starts over
    if (prev?.qIndex !== v.qIndex) changing = false;
    if (v.phase === 'question' && mine[v.qIndex] === undefined && prev?.qIndex !== v.qIndex) {
      const a = await be.get(`${G}/answers/${v.qIndex}/${uid}`).catch(() => null);
      if (a && Number.isInteger(a.choice)) mine[v.qIndex] = a.choice;
    }
    paint();
  }));

  function msgCard(title, text, tone = '') {
    return el('section', { class: 'msg ' + tone }, el('h2', {}, title), text ? el('p', {}, text) : null);
  }

  function vote(qi, k) {
    mine[qi] = k;
    changing = false;
    paint();
    be.set(`${G}/answers/${qi}/${uid}`, { choice: k })
      .catch(() => toast('Your vote didn’t reach the poll in time.'));
  }

  function votePad() {
    const qi = state.qIndex, q = state.question || {}, opts = asArray(q.options);
    if (mine[qi] !== undefined && !changing) {
      const k = mine[qi];
      return el('section', { class: `locked ${color(k)}` },
        el('span', { class: 'badge big' }, LETTERS[k]),
        el('h2', {}, 'Vote in'),
        el('p', { class: 'locked-choice' }, opts[k] || ''),
        el('p', { class: 'small' }, 'Results show on the big screen when voting closes.'),
        el('button', { class: 'btn ghost on-color', onclick: () => { changing = true; paint(); } }, 'Change my vote'));
    }
    const limit = (q.time || 0) * 1000;
    const t0 = typeof state.startedAt === 'number' ? state.startedAt : be.now();
    const remaining = () => Math.max(0, limit - (be.now() - t0));
    const timeUp = () => msgCard('Voting closed', 'Results are coming up on the big screen.', 'muted');
    if (limit && remaining() <= 0) return timeUp();

    const fill = el('span');
    const pad = el('section', { class: 'pad' },
      el('p', { class: 'eyebrow' }, `Question ${qi + 1} of ${state.total}`),
      el('h2', { class: 'pad-q' }, q.text || ''),
      limit ? el('div', { class: 'timebar', 'aria-hidden': 'true' }, fill) : null,
      el('div', { class: 'answers' + (opts.length > 4 ? ' many' : '') }, opts.map((o, k) =>
        el('button', { class: `answer ${color(k)}` + (mine[qi] === k ? ' current' : ''), onclick: () => vote(qi, k) },
          el('span', { class: 'badge' }, LETTERS[k]), el('span', {}, o)))));
    if (limit) {
      const update = () => {
        const r = remaining();
        fill.style.width = (r / limit * 100) + '%';
        if (r <= 0) { clearInterval(tick); pad.replaceWith(timeUp()); }
      };
      update();
      tick = setInterval(update, 100);
    }
    return pad;
  }

  function paint() {
    clearInterval(tick);
    const head = el('header', { class: 'phone-top' }, el('span', { class: 'me' }, me?.name || ''), el('span', { class: 'muted small' }, state.title || ''));
    let body;
    switch (state.phase) {
      case 'lobby': body = msgCard('You’re in!', 'Watch the big screen. The poll starts soon.', 'ok'); break;
      case 'question': body = votePad(); break;
      case 'results': {
        const k = mine[state.qIndex];
        const opts = asArray(state.question?.options);
        body = msgCard('Voting closed', k !== undefined ? `You voted “${opts[k] || LETTERS[k]}”. Results are on the big screen.` : 'You didn’t vote on this one. Results are on the big screen.');
        break;
      }
      default: body = msgCard('That’s all!', 'Thanks for voting.', 'ok');
    }
    root.replaceChildren(head, body);
  }
}
