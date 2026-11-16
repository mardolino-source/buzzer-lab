// Data layer. Two interchangeable backends with the same small API:
//   get / set / update / remove / on(path, cb) / TS (server timestamp) / now()
// - firebase: Realtime Database + Auth, for real games on phones.
// - demo: localStorage + BroadcastChannel, for trying it out in several tabs of one browser.
import { firebaseConfig } from './firebase-config.js?v=5';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';

export async function createBackend() {
  const configured = firebaseConfig?.apiKey && !firebaseConfig.apiKey.startsWith('PASTE');
  const forceDemo = new URLSearchParams(location.search).has('demo');
  return configured && !forceDemo ? firebaseBackend(firebaseConfig) : demoBackend();
}

async function firebaseBackend(config) {
  const [{ initializeApp }, d, a] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-database.js'),
    import(SDK + 'firebase-auth.js'),
  ]);
  const app = initializeApp(config);
  const db = d.getDatabase(app);
  const auth = a.getAuth(app);
  const r = p => d.ref(db, p);

  let offset = 0;
  d.onValue(r('.info/serverTimeOffset'), s => { offset = s.val() || 0; });
  await new Promise(res => { const off = a.onAuthStateChanged(auth, () => { off(); res(); }); });

  return {
    mode: 'firebase',
    get user() {
      const u = auth.currentUser;
      return u ? { uid: u.uid, anonymous: u.isAnonymous, name: u.displayName || '' } : null;
    },
    async signInPlayer() {
      if (!auth.currentUser) await a.signInAnonymously(auth);
      return auth.currentUser.uid;
    },
    async signInHost() {
      if (!auth.currentUser || auth.currentUser.isAnonymous) {
        await a.signInWithPopup(auth, new a.GoogleAuthProvider());
      }
      return auth.currentUser.uid;
    },
    signOut: () => a.signOut(auth),
    get: async p => (await d.get(r(p))).val(),
    set: (p, v) => d.set(r(p), v),
    update: (p, v) => d.update(r(p), v),
    remove: p => d.remove(r(p)),
    on: (p, cb) => d.onValue(r(p), s => cb(s.val()), e => console.error(p, e)),
    TS: d.serverTimestamp(),
    now: () => Date.now() + offset,
  };
}

function demoBackend() {
  const KEY = 'buzzerlab-demo-db';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  let tree = load();
  const subs = new Set();
  let channel = null;
  try {
    channel = new BroadcastChannel('buzzerlab-demo');
    channel.onmessage = () => { tree = load(); notify(); };
  } catch { /* single tab only */ }

  const parts = p => p.split('/').filter(Boolean);
  const getAt = p => parts(p).reduce((n, k) => (n && typeof n === 'object' ? n[k] : undefined), tree) ?? null;
  const resolve = v => {
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') {
      if (v['.sv'] === 'timestamp') return Date.now();
      return Object.fromEntries(Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => [k, resolve(x)]));
    }
    return v;
  };
  function setAt(p, v) {
    const ks = parts(p);
    v = resolve(v);
    if (!ks.length) { tree = v || {}; return; }
    let n = tree;
    for (const k of ks.slice(0, -1)) {
      if (!n[k] || typeof n[k] !== 'object') n[k] = {};
      n = n[k];
    }
    const last = ks[ks.length - 1];
    if (v == null) delete n[last]; else n[last] = v;
  }
  function commit() {
    try { localStorage.setItem(KEY, JSON.stringify(tree)); } catch { /* storage full or blocked */ }
    channel?.postMessage(1);
    notify();
  }
  function notify() {
    queueMicrotask(() => {
      for (const s of subs) {
        const json = JSON.stringify(getAt(s.p));
        if (json !== s.last) { s.last = json; s.cb(JSON.parse(json)); }
      }
    });
  }

  let uid = null;
  try { uid = sessionStorage.getItem('buzzerlab-demo-uid'); } catch { /* ignore */ }

  return {
    mode: 'demo',
    get user() { return uid ? { uid, anonymous: false, name: 'Demo host' } : null; },
    async signInPlayer() {
      if (!uid) {
        uid = 'u' + Math.random().toString(36).slice(2, 10);
        try { sessionStorage.setItem('buzzerlab-demo-uid', uid); } catch { /* ignore */ }
      }
      return uid;
    },
    // The host is the same in every tab, so polls written in one tab show up in all of them.
    // Polls saved by older versions (one host per tab) are moved under the shared host.
    async signInHost() {
      uid = 'demo-host';
      try { sessionStorage.setItem('buzzerlab-demo-uid', uid); } catch { /* ignore */ }
      tree = load();
      const all = tree.quizzes || {};
      const strays = Object.keys(all).filter(k => k !== uid);
      if (strays.length) {
        all[uid] = Object.assign({}, ...strays.map(k => all[k]), all[uid]);
        for (const k of strays) delete all[k];
        commit();
      }
      return uid;
    },
    async signOut() {},
    async get(p) { return JSON.parse(JSON.stringify(getAt(p))); },
    async set(p, v) { setAt(p, v); commit(); },
    async update(p, obj) { for (const [k, v] of Object.entries(obj)) setAt(p + '/' + k, v); commit(); },
    async remove(p) { setAt(p, null); commit(); },
    on(p, cb) { const s = { p, cb, last: undefined }; subs.add(s); notify(); return () => subs.delete(s); },
    TS: { '.sv': 'timestamp' },
    now: () => Date.now(),
  };
}
