# Verdant Mini App — v2 (fixed)

## Deploy checklist (do in this order)
1. **Firebase Console → Authentication**: enable *Anonymous*. For the admin login enable *Email/Password*, create `m@verdantbot.org`, and **verify that email** (the admin page sends a verification link on first login attempt).
2. **Firestore → Rules**: paste `firestore.rules` and Publish. (Change the admin email inside if needed — also in `admin/index.html`.) Never use test-mode rules.
3. **Firestore indexes**: `firebase deploy --only firestore:indexes` (or open the admin once and click the link Firebase prints in the console). Needed only for the admin's Withdrawals/Txns tabs.
4. Edit `assets/js/firebase-config.js` → `APP_CONFIG` (`botUsername`, `miniAppName`, `supportUrl`).
5. Host on HTTPS (GitHub Pages / Firebase Hosting) and set it as the Mini App URL in BotFather.
6. Google Cloud Console → restrict the Web API key to your domain; check that Realtime Database (if created) is locked.

## What changed
- **Security**: rules now validate every money move (task claim, check-in, convert, referral) against server time and the task's real reward; users can no longer edit balance, forge withdrawals or read other users. XSS fixed everywhere (`esc`, safe URLs, status whitelist). Admin requires a verified email.
- **Passwords are no longer collected.** Account tasks ask only for a username/email/profile link.
- **Speed**: pages switch instantly without reloading (mini-SPA), Firebase loads once, data shows instantly from local cache then refreshes, Firestore offline cache on, live balance via one listener, parallel startup.
- **Language**: 🌐 switches the whole UI (English, বাংলা, हिन्दी, Bahasa Indonesia, नेपाली). Task titles/descriptions are whatever the admin writes. Terms/Privacy stay English.
- **New**: dark mode, History page (transactions / withdrawals / completed), Support/FAQ page, real Notifications (+ admin "Notify" tab), quick actions, Share-to-Telegram, new sprout loader, skeleton loading, motion that respects "reduce motion".
- Day boundaries are **UTC** (server-verified), so changing the phone clock no longer re-opens daily rewards.

## Known limits (need a backend to fully solve)
- Telegram `initData` is not verified server-side and auth is anonymous, so a determined person can create multiple accounts. Add a Cloud Function that validates `initData` and mints a custom token for strong anti-fraud.
- Proof tasks are manually reviewed; "join channel" is not auto-verified (use Bot API `getChatMember`).
- Convert rates are fixed in `app.js` (`CONVERT_RATES`).
- If you had users before: their streak resets once, and legacy accounts get a referral-code lookup doc on first open.
