# Buzzer Lab

A live poll for the big screen. You run it from a laptop on the projector; people join on their phones with a 6-digit PIN or a QR code and vote. When you close voting, the results show as bars, and a summary of every question's top answer comes at the end. There are no points or leaderboards.

- **Host:** open the page with `#host` at the end of the address, e.g. `https://yourname.github.io/buzzer-lab/#host`
- **Voters:** open the page without `#host` (or scan the QR code on the big screen) and type the PIN and a name. No account needed.

## Try it now (demo mode)

Until you add Firebase settings, the app runs in demo mode: everything stays in one browser, so you can rehearse with several tabs on your own computer.

1. In this folder, run `python3 -m http.server 8000`
2. Open `http://localhost:8000/#host` → **Add sample poll** → **Run poll**
3. Open `http://localhost:8000/` in one or more other tabs and join with the PIN.

## Put it online (about 15 minutes, free)

You need two free things: a **Firebase project** (handles the live sync and sign-in) and a place to host the files, for example **GitHub Pages**.

### 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> → **Create a project** (Google Analytics isn't needed).
2. **Build → Realtime Database → Create database.** Pick a location close to you and start in **locked mode**.
3. On the database's **Rules** tab, replace everything with the contents of `database.rules.json` and click **Publish**.
4. **Build → Authentication → Get started**, then under **Sign-in method** enable:
   - **Anonymous** (for voters)
   - **Google** (for you, the host)
5. **Project settings (gear icon) → General → Your apps → Web (`</>`)**. Register an app (no hosting needed) and copy the `firebaseConfig` values into `firebase-config.js` in this folder. Make sure `databaseURL` is filled in. If it's missing, you created the app before the database: copy it from the Realtime Database page.

### 2. Publish the files on GitHub Pages

1. Create a new **public** repository on GitHub, e.g. `buzzer-lab`.
2. **Add file → Upload files** and upload everything in this folder.
3. **Settings → Pages** → Source: **Deploy from a branch**, branch `main`, folder `/ (root)` → **Save**. After a minute your site is live at `https://<your-username>.github.io/buzzer-lab/`.
4. Back in Firebase: **Authentication → Settings → Authorized domains → Add domain** → `<your-username>.github.io`. Without this step, Google sign-in on the host page fails.

The Firebase settings in `firebase-config.js` are meant to be public. The database rules are what protect your data.

## How a poll runs

1. On `#host`, sign in, write a poll (or add the sample) and click **Run poll**.
2. The big screen shows the address, the PIN and a QR code. Names pop up as people join. Click a name twice to remove someone.
3. **Start poll.** The question and its answers go up on the screen, and the screen counts how many people have voted. People can change their vote until voting closes.
4. Click **Close voting** (or let the time limit run out, if you set one). The results show how many votes each answer got; the top answer is outlined.
5. After the last question, **Show summary** lists every question with its winner (or a tie). **Run again** keeps the same people and PIN, and **End poll** closes it.

If the host laptop reloads mid-poll, open `#host` again in the same tab and the poll picks up where it was.

## Anonymity

The big screen only ever shows totals. With Firebase, the database rules let each voter read only their own vote, so other voters can't see who voted for what. You, the host, technically can (the votes are stored under each voter's ID in your database), but the app never displays them.

## Writing polls

- 2 to 10 answers per question. **+ Add answer** adds one; **×** removes one.
- **Fill with lab members** puts the lab's names in as the answers, for awards like "Best figure of the day". The names are listed at the top of `app.js` (`LAB_MEMBERS`): edit that line when the lab changes.
- Time limit: none by default (you close voting yourself), or 15 seconds to 2 minutes.
- Images (e.g. "whose figure is this?") show on the big screen only. They're shrunk to 1600 px and stored with the poll.
- Polls save automatically and are private to your Google account.

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css` | The page and its look |
| `app.js` | Host, editor and voter screens (and the lab member list) |
| `backend.js` | Talks to Firebase, or to the browser in demo mode |
| `firebase-config.js` | Your Firebase settings (edit this) |
| `database.rules.json` | Security rules to paste into Firebase |
