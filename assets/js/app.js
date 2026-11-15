/* ============================================
   Verdant TG Mini App — v2
   Firebase + Telegram WebApp, instant navigation (mini-SPA),
   stale-while-revalidate cache, i18n, hardened writes.
   ============================================ */
import {
    initializeApp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
    getAuth,
    signInAnonymously,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
    initializeFirestore,
    getFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    doc,
    getDoc,
    setDoc,
    collection,
    query,
    where,
    orderBy,
    limit,
    getDocs,
    serverTimestamp,
    increment,
    onSnapshot,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

const t = (k, v) => window.t(k, v);
const CFG = window.APP_CONFIG || {};
const REFERRAL_REWARD = 0.5;
const CHECKIN_REWARD = 0.05;
const MIN_CONVERT = 2;
const DAILY_GOAL = CFG.dailyGoal || 5;
const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
} [c]));
const safeUrl = u => {
    try {
        const x = new URL(String(u), location.href);
        return ["http:", "https:", "tg:"].includes(x.protocol) ? x.href : "#";
    } catch {
        return "#";
    }
};
const num = n => Number(n) || 0;
const money = n => "$" + num(n).toFixed(2);
const clamp = (s, n) => String(s ?? "").slice(0, n);
const STATUS = ["pending", "paid", "approved", "rejected"];
const okStatus = s => (STATUS.includes(s) ? s : "pending");

// UTC day key — MUST match dayKey() in firestore.rules (server verifies it against request.time)
function dayKey(d = new Date()) {
    return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

// ---------- state ----------
let app, auth, db;
let currentUser = null,
    userData = null,
    telegramUser = null;
let pendingRef = null;
let tasks = [],
    doneSet = new Set(),
    announcements = [];
let tasksLoading = true,
    unsubUser = null,
    activeFilter = "all";
const pageCache = new Map();

// ---------- local cache (stale-while-revalidate) ----------
const LS = (() => {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
})();
let cacheUid = LS?.getItem("vd2:uid") || "";
const ck = k => `vd2:${cacheUid}:${k}`;

function cget(k) {
    try {
        const r = JSON.parse(LS.getItem(ck(k)));
        return r || null;
    } catch {
        return null;
    }
}

function cset(k, d) {
    try {
        LS.setItem(ck(k), JSON.stringify({
            t: Date.now(),
            d
        }));
    } catch {}
}

function stripUser(u) {
    const x = {
        ...u
    };
    delete x.createdAt;
    delete x.updatedAt;
    return x;
}

function cacheUser() {
    if (userData && !userData._offline) cset("user", stripUser(userData));
}

// ---------- toast / haptics / burst ----------
function showToast(msg) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
window.showToast = showToast;

function haptic(kind = "success") {
    try {
        const h = window.Telegram?.WebApp?.HapticFeedback;
        kind === "tap" ? h?.impactOccurred("light") : h?.notificationOccurred(kind);
    } catch {}
}

function burst(x, y) {
    if (REDUCED) return;
    const colors = ["#2d6a4f", "#e9c46a", "#e07a5f", "#b7edc9"];
    for (let i = 0; i < 14; i++) {
        const p = document.createElement("i");
        p.className = "burst-p";
        p.style.cssText = `left:${x}px;top:${y}px;--dx:${(Math.random() - .5) * 180}px;--dy:${-30 - Math.random() * 120}px;--c:${colors[i % 4]}`;
        document.body.appendChild(p);
        setTimeout(() => p.remove(), 950);
    }
}
const evXY = e => (e && e.clientX != null ? [e.clientX, e.clientY] : [innerWidth / 2, innerHeight / 2]);

// ---------- formatting ----------
function formatDate(ts) {
    if (!ts) return "";
    const d = ts.toDate ? ts.toDate() : new Date(ts.seconds ? ts.seconds * 1000 : ts);
    const now = new Date(),
        diff = now - d;
    const tm = d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    });
    if (diff < 864e5 && now.getDate() === d.getDate()) return "• " + tm;
    return d.toLocaleDateString([], {
        day: "numeric",
        month: "short"
    }) + " · " + tm;
}
const getInitials = n => (!n ? "?" : String(n).trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase());
const fullName = u => [u?.firstName, u?.lastName].filter(Boolean).join(" ");

function greeting() {
    const h = new Date().getHours();
    return h < 12 ? t("g_morning") : h < 17 ? t("g_afternoon") : t("g_evening");
}

function fm(n) {
    const p = num(n).toFixed(2).split(".");
    return {
        whole: p[0],
        dec: p[1]
    };
}

// ---------- theme ----------
function applyTheme() {
    let th = null;
    try {
        th = LS?.getItem("vd_theme");
    } catch {}
    if (!th) th = window.Telegram?.WebApp?.colorScheme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = th;
    const c = th === "dark" ? "#12150f" : "#f5f4ed";
    try {
        window.Telegram?.WebApp?.setHeaderColor(c);
        window.Telegram?.WebApp?.setBackgroundColor(c);
    } catch {}
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", c);
}

function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    try {
        LS?.setItem("vd_theme", next);
    } catch {}
    applyTheme();
    paintThemeSwitch();
}

function paintThemeSwitch() {
    const s = $("#theme-switch");
    if (s) s.checked = document.documentElement.dataset.theme === "dark";
}

// ---------- Telegram ----------
function initTelegram() {
    const tg = window.Telegram?.WebApp;
    if (tg) {
        try {
            tg.ready();
            tg.expand();
        } catch {}
        telegramUser = tg.initDataUnsafe?.user || null;
        if (!telegramUser && tg.initData) {
            try {
                const r = new URLSearchParams(tg.initData).get("user");
                if (r) telegramUser = JSON.parse(r);
            } catch {}
        }
    }
    let sp = tg?.initDataUnsafe?.start_param || null;
    if (!sp) {
        try {
            sp = new URLSearchParams(location.hash.slice(1)).get("tgWebAppStartParam") || new URLSearchParams(location.search).get("tgWebAppStartParam");
        } catch {}
    }
    if (sp && /^ref_/i.test(sp)) {
        pendingRef = sp.slice(4).trim().toUpperCase();
        try {
            LS?.setItem("vd2:ref", pendingRef);
        } catch {}
    } else {
        try {
            pendingRef = LS?.getItem("vd2:ref") || null;
        } catch {}
    }
    return telegramUser;
}

function openExternal(url) {
    const tg = window.Telegram?.WebApp;
    try {
        if (tg && /^https?:\/\/(t\.me|telegram\.me)\//i.test(url)) return tg.openTelegramLink(url);
        if (tg) return tg.openLink(url);
    } catch {}
    window.open(url, "_blank", "noopener");
}

// ---------- Firebase ----------
function initFirebase() {
    const c = window.FIREBASE_CONFIG;
    if (!c || !c.apiKey || c.apiKey === "YOUR_API_KEY") return false;
    try {
        app = initializeApp(c);
        auth = getAuth(app);
        try {
            db = initializeFirestore(app, {
                localCache: persistentLocalCache({
                    tabManager: persistentMultipleTabManager()
                })
            });
        } catch {
            db = getFirestore(app);
        }
        return true;
    } catch (e) {
        console.error("Firebase init:", e);
        return false;
    }
}

function waitAuth(ms = 15000) {
    return new Promise(res => {
        let done = false,
            unsub = null;
        const fin = u => {
            if (done) return;
            done = true;
            clearTimeout(to);
            try {
                unsub && unsub();
            } catch {}
            res(u);
        };
        const to = setTimeout(() => fin(null), ms);
        unsub = onAuthStateChanged(auth, async u => {
            if (u) return fin(u);
            try {
                fin((await signInAnonymously(auth)).user);
            } catch (e) {
                console.error("Auth:", e?.code || e);
                fin(null);
            }
        });
    });
}
const canWrite = () => !!(db && userData && !userData._offline && currentUser);

// ---------- user ----------
function genCode() {
    const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
}
async function reserveCode(uid) {
    for (let i = 0; i < 6; i++) {
        const code = genCode(),
            ref = doc(db, "referralCodes", code);
        const s = await getDoc(ref);
        if (!s.exists()) {
            await setDoc(ref, {
                uid,
                createdAt: serverTimestamp()
            });
            return code;
        }
    }
    throw new Error("code-collision");
}

function buildOfflineUser() {
    return {
        id: "offline",
        firstName: telegramUser?.first_name || "Guest",
        lastName: telegramUser?.last_name || "",
        username: telegramUser?.username || "",
        photoUrl: telegramUser?.photo_url || "",
        balance: 0,
        pending: 0,
        lifetime: 0,
        withdrawn: 0,
        tasksCompleted: 0,
        streak: 0,
        lastCheckin: null,
        referralCode: "------",
        referrals: 0,
        referralEarnings: 0,
        _offline: true
    };
}
async function ensureUserDoc(user) {
    const uid = user.uid,
        ref = doc(db, "users", uid),
        tg = telegramUser;
    const snap = await getDoc(ref),
        today = dayKey();
    if (snap.exists()) {
        const d = snap.data(),
            plain = {};
        if (tg?.id && d.telegramId !== tg.id) plain.telegramId = tg.id;
        if (tg?.first_name && d.firstName !== tg.first_name) plain.firstName = clamp(tg.first_name, 64);
        if (tg && (tg.last_name || "") !== (d.lastName || "")) plain.lastName = clamp(tg.last_name || "", 64);
        if (tg?.username && d.username !== tg.username) plain.username = clamp(tg.username, 64);
        if (tg?.photo_url && d.photoUrl !== tg.photo_url) plain.photoUrl = tg.photo_url;
        if (!d.referralCode || ["------", "GUEST1"].includes(d.referralCode)) plain.referralCode = await reserveCode(uid);
        if (d.lastActiveDate !== today) {
            const y = dayKey(new Date(Date.now() - 864e5)),
                legacyY = new Date(Date.now() - 864e5).toDateString();
            plain.streak = (d.lastActiveDate === y || d.lastActiveDate === legacyY) ? num(d.streak) + 1 : 1;
            plain.lastActiveDate = today;
        }
        if (Object.keys(plain).length) await setDocPatch(ref, plain);
        userData = {
            id: uid,
            ...d,
            ...plain
        };
        // make sure the referral code has a lookup doc (older accounts)
        if (userData.referralCode && LS && !LS.getItem(`vd2:${uid}:codeok`)) {
            try {
                const cr = doc(db, "referralCodes", userData.referralCode);
                if (!(await getDoc(cr)).exists()) await setDoc(cr, {
                    uid,
                    createdAt: serverTimestamp()
                });
                LS.setItem(`vd2:${uid}:codeok`, "1");
            } catch {}
        }
    } else {
        let referredBy = null;
        if (pendingRef) {
            try {
                const r = await getDoc(doc(db, "referralCodes", pendingRef));
                if (r.exists() && r.data().uid !== uid) referredBy = r.data().uid;
            } catch {}
        }
        const code = await reserveCode(uid);
        const nu = {
            uid,
            telegramId: tg?.id || null,
            firstName: clamp(tg?.first_name || "User", 64),
            lastName: clamp(tg?.last_name || "", 64),
            username: clamp(tg?.username || "", 64),
            photoUrl: tg?.photo_url || "",
            balance: 0,
            pending: 0,
            lifetime: 0,
            withdrawn: 0,
            tasksCompleted: 0,
            streak: 1,
            lastCheckin: null,
            lastActiveDate: today,
            referralCode: code,
            referredBy,
            referralRewarded: false,
            referrals: 0,
            referralEarnings: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };
        await setDoc(ref, nu);
        userData = {
            id: uid,
            ...nu
        };
    }
    cacheUser();
}
async function setDocPatch(ref, plain) {
    const b = writeBatch(db);
    b.update(ref, {
        ...plain,
        updatedAt: serverTimestamp()
    });
    await b.commit();
}

function watchUser(uid) {
    if (unsubUser) unsubUser();
    unsubUser = onSnapshot(doc(db, "users", uid), snap => {
        if (!snap.exists()) return;
        const before = userData?.lifetime;
        userData = {
            ...(userData || {}),
            id: uid,
            ...snap.data()
        };
        delete userData._offline;
        cacheUser();
        paintUser();
        if (before !== userData.lifetime) syncLeaderboard();
    }, e => console.warn("user watch:", e?.code));
}

// ---------- data loaders ----------
async function loadTasks() {
    const c = cget("tasks");
    if (c && Date.now() - c.t < 45000 && Array.isArray(c.d) && c.d.length) {
        tasks = c.d;
        tasksLoading = false;
        return tasks;
    }
    if (!db) {
        tasksLoading = false;
        return tasks;
    }
    try {
        const snap = await getDocs(query(collection(db, "tasks"), where("active", "==", true)));
        tasks = snap.docs.map(d => ({
            id: d.id,
            ...d.data()
        })).sort((a, b) => num(a.order) - num(b.order));
        cset("tasks", tasks);
    } catch (e) {
        console.error("tasks:", e?.code);
        if (c?.d) tasks = c.d;
    }
    tasksLoading = false;
    return tasks;
}
let lastDoneLoad = 0;
async function loadDone() {
    lastDoneLoad = Date.now();
    const day = dayKey();
    if (!db || !userData || userData._offline) return doneSet;
    try {
        const snap = await getDocs(query(collection(db, "users", userData.id, "completedTasks"), where("date", "==", day)));
        doneSet = new Set(snap.docs.map(d => d.data().taskId));
        cset("done:" + day, [...doneSet]);
    } catch (e) {
        console.warn("done:", e?.code);
    }
    return doneSet;
}
async function getSub(taskId) {
    if (!db || !userData || userData._offline) return null;
    try {
        const s = await getDoc(doc(db, "submissions", `${userData.id}_${taskId}_${dayKey()}`));
        return s.exists() ? s.data() : null;
    } catch {
        return null;
    }
}
async function loadAnnouncements() {
    const c = cget("ann");
    if (c?.d) announcements = c.d;
    if (!db || !currentUser || (c && Date.now() - c.t < 120000)) return announcements;
    try {
        const snap = await getDocs(query(collection(db, "announcements"), orderBy("createdAt", "desc"), limit(10)));
        announcements = snap.docs.map(d => {
            const x = d.data();
            return {
                id: d.id,
                title: x.title,
                body: x.body,
                createdAt: x.createdAt ? {
                    seconds: x.createdAt.seconds
                } : null
            };
        });
        cset("ann", announcements);
    } catch (e) {
        console.warn("ann:", e?.code);
    }
    return announcements;
}
async function loadList(sub, orderField, n = 30) {
    if (!db || !userData || userData._offline) return [];
    try {
        const snap = await getDocs(query(collection(db, "users", userData.id, sub), orderBy(orderField, "desc"), limit(n)));
        return snap.docs.map(d => ({
            id: d.id,
            ...d.data()
        }));
    } catch (e) {
        console.warn(sub, e?.code);
        return [];
    }
}
async function loadLeaderboard() {
    const c = cget("lb");
    if (!db || !currentUser) return c?.d || [];
    try {
        const snap = await getDocs(query(collection(db, "leaderboard"), orderBy("score", "desc"), limit(20)));
        const list = snap.docs.map((d, i) => {
            const u = d.data();
            return {
                rank: i + 1,
                uid: d.id,
                name: u.name || "User",
                score: num(u.score),
                tasks: num(u.tasks)
            };
        });
        cset("lb", list);
        return list;
    } catch (e) {
        console.warn("lb:", e?.code);
        return c?.d || [];
    }
}
let lbTimer = null;

function syncLeaderboard() {
    clearTimeout(lbTimer);
    lbTimer = setTimeout(async () => {
        if (!canWrite()) return;
        const name = clamp(fullName(userData) || userData.username || "User", 60);
        const sig = `${userData.lifetime}|${userData.tasksCompleted}|${name}`;
        if (LS?.getItem(`vd2:${userData.id}:lbsig`) === sig) return;
        try {
            await setDoc(doc(db, "leaderboard", userData.id), {
                name,
                score: num(userData.lifetime),
                tasks: num(userData.tasksCompleted),
                updatedAt: serverTimestamp()
            });
            LS?.setItem(`vd2:${userData.id}:lbsig`, sig);
        } catch (e) {
            console.warn("lb sync:", e?.code);
        }
    }, 900);
}

// ---------- actions ----------
const deniedMsg = e => (e?.code === "permission-denied" ? `${t("t_denied")} (${t("t_clock")})` : t("t_err"));

async function completeTask(taskId, ev) {
    if (!canWrite()) {
        showToast(t("t_offline"));
        return false;
    }
    const task = tasks.find(x => x.id === taskId);
    if (!task || task.proofRequired) return false;
    if (doneSet.has(taskId)) {
        showToast(t("t_done_already"));
        return false;
    }
    const uid = userData.id,
        day = dayKey(),
        cid = `${taskId}_${day}`,
        reward = num(task.reward);
    const uref = doc(db, "users", uid);
    try {
        const b = writeBatch(db);
        b.set(doc(db, "users", uid, "completedTasks", cid), {
            taskId,
            title: clamp(task.title, 100),
            reward,
            date: day,
            completedAt: serverTimestamp()
        });
        b.set(doc(collection(db, "users", uid, "transactions")), {
            type: "earn",
            title: clamp(task.title, 100),
            amount: reward,
            icon: clamp(task.icon || "✳", 8),
            createdAt: serverTimestamp()
        });
        const upd = {
            balance: increment(reward),
            lifetime: increment(reward),
            tasksCompleted: increment(1),
            lastClaimId: cid,
            updatedAt: serverTimestamp()
        };
        const giveRef = userData.referredBy && !userData.referralRewarded && num(userData.tasksCompleted) === 0;
        if (giveRef) {
            upd.referralRewarded = true;
            b.update(doc(db, "users", userData.referredBy), {
                balance: increment(REFERRAL_REWARD),
                lifetime: increment(REFERRAL_REWARD),
                referrals: increment(1),
                referralEarnings: increment(REFERRAL_REWARD),
                updatedAt: serverTimestamp()
            });
            b.set(doc(collection(db, "users", userData.referredBy, "transactions")), {
                type: "referral",
                title: "Referral bonus",
                amount: REFERRAL_REWARD,
                icon: "🤝",
                createdAt: serverTimestamp()
            });
        }
        b.update(uref, upd);
        await b.commit();
        doneSet.add(taskId);
        cset("done:" + day, [...doneSet]);
        haptic("success");
        burst(...evXY(ev));
        showToast(t("t_earned", {
            n: money(reward)
        }));
        syncLeaderboard();
        return true;
    } catch (e) {
        console.error("complete:", e?.code, e?.message);
        showToast(deniedMsg(e));
        return false;
    }
}

async function submitProof(taskId, payload) {
    if (!canWrite()) {
        showToast(t("t_offline"));
        return false;
    }
    const task = tasks.find(x => x.id === taskId);
    if (!task) return false;
    if (doneSet.has(taskId)) {
        showToast(t("t_done_already"));
        return false;
    }
    let proof = "",
        proofData = null;
    if (payload && typeof payload === "object") {
        const username = clamp(payload.username, 150).trim(),
            note = clamp(payload.note, 300).trim();
        if (!username) {
            showToast(t("t_enter_proof"));
            return false;
        }
        proofData = {
            username,
            note,
            platform: clamp(task.type || "account", 30)
        };
        proof = clamp(`User: ${username}${note ? "\nNote: " + note : ""}`, 590);
    } else {
        proof = clamp(String(payload || "").trim(), 590);
        if (!proof) {
            showToast(t("t_enter_proof"));
            return false;
        }
    }
    const day = dayKey();
    try {
        const data = {
            uid: userData.id,
            taskId,
            taskTitle: clamp(task.title, 100),
            reward: num(task.reward),
            proof,
            status: "pending",
            date: day,
            createdAt: serverTimestamp(),
            userName: clamp(fullName(userData) || userData.username || "User", 60)
        };
        if (proofData) data.proofData = proofData;
        await setDoc(doc(db, "submissions", `${userData.id}_${taskId}_${day}`), data);
        haptic("success");
        showToast(t("t_submitted"));
        return true;
    } catch (e) {
        console.error("proof:", e?.code);
        showToast(e?.code === "permission-denied" ? t("t_done_already") : t("t_err"));
        return false;
    }
}

async function doCheckin(ev) {
    if (!canWrite()) {
        showToast(t("t_offline"));
        return false;
    }
    const today = dayKey();
    if (userData.lastCheckin === today) {
        showToast(t("t_claimed_already"));
        return false;
    }
    try {
        const uid = userData.id,
            b = writeBatch(db);
        b.update(doc(db, "users", uid), {
            balance: increment(CHECKIN_REWARD),
            lifetime: increment(CHECKIN_REWARD),
            lastCheckin: today,
            updatedAt: serverTimestamp()
        });
        b.set(doc(collection(db, "users", uid, "transactions")), {
            type: "earn",
            title: "Daily check-in",
            amount: CHECKIN_REWARD,
            icon: "🎁",
            createdAt: serverTimestamp()
        });
        await b.commit();
        haptic("success");
        burst(...evXY(ev));
        showToast(t("t_checked", {
            n: money(CHECKIN_REWARD)
        }));
        syncLeaderboard();
        return true;
    } catch (e) {
        console.error("checkin:", e?.code);
        showToast(deniedMsg(e));
        return false;
    }
}

const CONVERT_RATES = {
    BD: {
        code: "BDT",
        rate: 120,
        symbol: "৳"
    },
    IN: {
        code: "INR",
        rate: 84,
        symbol: "₹"
    },
    ID: {
        code: "IDR",
        rate: 15800,
        symbol: "Rp"
    },
    NP: {
        code: "NPR",
        rate: 134,
        symbol: "रू"
    }
};
const CONVERT_FEE = 0.04;

function calcConvert(usd, country) {
    const info = CONVERT_RATES[country];
    if (!info || !usd || usd <= 0) return null;
    const fee = usd * CONVERT_FEE,
        net = usd - fee;
    return {
        fee,
        net,
        local: net * info.rate,
        info
    };
}
const fmtLocal = v => (v >= 1000 ? v.toLocaleString(undefined, {
    maximumFractionDigits: 0
}) : v.toFixed(2));

function updateConvertPreview() {
    const a = $("#convert-amount"),
        c = $("#convert-country"),
        p = $("#convert-preview");
    if (!a || !c || !p) return;
    const usd = parseFloat(a.value) || 0,
        r = calcConvert(usd, c.value);
    if (!r) {
        p.hidden = true;
        return;
    }
    p.hidden = false;
    $("[data-cv-usd]", p).textContent = money(usd);
    $("[data-cv-fee]", p).textContent = "−" + money(r.fee);
    $("[data-cv-net]", p).textContent = money(r.net);
    $("[data-cv-label]", p).textContent = t("you_receive", {
        c: r.info.code
    });
    $("[data-cv-local]", p).textContent = r.info.symbol + fmtLocal(r.local);
}
async function requestWithdraw(amount, country, account) {
    if (!canWrite()) {
        showToast(t("t_offline"));
        return false;
    }
    amount = Math.round(parseFloat(amount) * 100) / 100;
    account = clamp(String(account || "").trim(), 120);
    if (isNaN(amount) || amount < MIN_CONVERT) {
        showToast(t("t_min"));
        return false;
    }
    if (amount > num(userData.balance)) {
        showToast(t("t_insuff"));
        return false;
    }
    const conv = calcConvert(amount, country);
    if (!conv) {
        showToast(t("t_sel_country"));
        return false;
    }
    if (!account) return false;
    const uid = userData.id,
        label = `Convert → ${conv.info.code}`;
    try {
        const b = writeBatch(db),
            wref = doc(collection(db, "users", uid, "withdrawals"));
        b.set(wref, {
            amount,
            method: label,
            country,
            currency: conv.info.code,
            rate: conv.info.rate,
            feePercent: CONVERT_FEE * 100,
            feeUsd: conv.fee,
            netUsd: conv.net,
            localAmount: conv.local,
            account,
            status: "pending",
            createdAt: serverTimestamp()
        });
        b.set(doc(collection(db, "users", uid, "transactions")), {
            type: "withdraw",
            title: `${label} (${conv.info.symbol}${fmtLocal(conv.local)})`,
            amount: -amount,
            icon: "⇄",
            createdAt: serverTimestamp()
        });
        b.update(doc(db, "users", uid), {
            balance: increment(-amount),
            pending: increment(amount),
            lastWithdrawId: wref.id,
            updatedAt: serverTimestamp()
        });
        await b.commit();
        haptic("success");
        showToast(t("t_conv_ok", {
            n: conv.info.symbol + fmtLocal(conv.local)
        }));
        return true;
    } catch (e) {
        console.error("withdraw:", e?.code);
        showToast(deniedMsg(e));
        return false;
    }
}

// ---------- modal ----------
function ensureModal() {
    if ($("#task-modal-overlay")) return;
    const d = document.createElement("div");
    d.id = "task-modal-overlay";
    d.className = "modal-overlay";
    d.innerHTML = `<div class="modal" id="task-modal"><div class="modal-handle"></div><div id="task-modal-body"></div></div>`;
    d.addEventListener("click", e => {
        if (e.target === d) closeModal();
    });
    document.body.appendChild(d);
}
const closeModal = () => $("#task-modal-overlay")?.classList.remove("open");

function openModal(html) {
    ensureModal();
    $("#task-modal-body").innerHTML = html;
    window.applyLang($("#task-modal-body"));
    requestAnimationFrame(() => $("#task-modal-overlay").classList.add("open"));
}
const modalClose = () => `<button class="btn-secondary" data-act="close-modal" style="width:100%;margin-top:12px">${t("close")}</button>`;

// ---------- task UI ----------
const TYPE_KEYS = ["visit", "join", "watch", "survey", "quiz", "social", "gmail", "facebook", "instagram", "other"];
const typeLabel = ty => (TYPE_KEYS.includes(ty) ? t("ty_" + ty) : t("ty_other"));
const isAccountTask = k => ["gmail", "facebook", "instagram"].includes((k?.type || "").toLowerCase()) || (k?.category || "").toLowerCase() === "account";

function stepsHTML(steps) {
    const lines = String(steps || "").split("\n").map(s => s.trim()).filter(Boolean);
    if (!lines.length) return "";
    return `<div class="task-steps"><h4>${t("how_to")}</h4><ol>${lines.map(l => `<li>${esc(l.replace(/^\d+[.)]\s*/, ""))}</li>`).join("")}</ol></div>`;
}

function taskCardHTML(k, isDone, i = 0) {
    const badge = k.proofRequired ? t("review") : t("instant");
    return `
  <div class="task-card ${isDone ? "completed" : ""}" style="--i:${Math.min(i, 8)}" data-task data-category="${esc(k.category)}" data-search="${esc(k.title)} ${esc(k.description)}" data-id="${esc(k.id)}">
    <div class="task-icon ${esc(k.iconClass || "")}">${esc(k.icon || "✳")}</div>
    <div class="task-body">
      <h3>${esc(k.title)}</h3><p>${esc(k.description || "")}</p>
      <div class="task-meta"><span>◷ ${esc(k.duration || "—")}</span><span>${esc(k.level || "Easy")}</span><span>${badge}</span></div>
    </div>
    <div class="task-reward"><span class="amount">+${money(k.reward)}</span>
      <button class="btn-start" ${isDone ? "disabled" : ""}>${isDone ? t("done") : t("view")}</button></div>
  </div>`;
}
const skeletonHTML = (n = 3) => Array.from({
    length: n
}, () => `<div class="task-card sk-card"><div class="sk sk-ic"></div><div class="sk-col"><div class="sk sk-l1"></div><div class="sk sk-l2"></div></div></div>`).join("");

async function openTaskDetail(taskId) {
    const task = tasks.find(x => x.id === taskId);
    if (!task) return;
    const isDone = doneSet.has(taskId);
    let sub = null;
    if (!isDone && task.proofRequired) sub = await getSub(taskId);
    const done = isDone || sub?.status === "approved";
    const link = task.link ? safeUrl(task.link) : "";
    const linkBtn = (label) => link && link !== "#" ? `<a class="btn-primary btn-block" data-ext href="${esc(link)}" target="_blank" rel="noopener">${label}</a>` : "";
    let action = "";
    if (done) action = `<div class="task-done-banner">${t("done_today")}</div>`;
    else if (sub?.status === "pending") action = `<div class="task-pending-banner">${t("waiting")}</div>`;
    else if (sub?.status === "rejected") action = `<div class="task-pending-banner">${t("rejected_today")}</div>`;
    else if (task.proofRequired && isAccountTask(task)) {
        action = `<div class="account-proof"><p class="account-proof-hint">${esc(task.proofHint || t("acct_hint"))}</p>
      <div class="form-field"><label>${t("acct_user")}</label><input id="proof-user" type="text" maxlength="150" autocomplete="off" placeholder="${t("acct_ph")}"></div>
      <div class="form-field"><label>${t("acct_note")}</label><input id="proof-note" type="text" maxlength="300" autocomplete="off"></div></div>
      ${linkBtn(t("open_link"))}<button class="btn-primary btn-block" id="btn-submit-proof">${t("submit_review")}</button>`;
    } else if (task.proofRequired) {
        action = `<div class="form-field"><label>${esc(task.proofHint || t("submit_proof"))}</label>
      <textarea id="proof-input" rows="3" maxlength="590" class="proof-text" placeholder="${t("enter_proof")}"></textarea></div>
      ${linkBtn(t("open_link"))}<button class="btn-primary btn-block" id="btn-submit-proof">${t("submit_review")}</button>`;
    } else {
        action = `${linkBtn(esc(typeLabel(task.type)) + " →")}<button class="btn-primary btn-block" id="btn-mark-done">${t("i_completed", { n: money(task.reward) })}</button>`;
    }
    openModal(`
    <div class="task-detail-icon ${esc(task.iconClass || "")}">${esc(task.icon || "✳")}</div>
    <h3>${esc(task.title)}</h3><p>${esc(task.description || "")}</p>
    <div class="task-detail-reward">+${money(task.reward)}</div>
    <div class="task-detail-meta"><span>◷ ${esc(task.duration || "—")}</span><span>${esc(task.level || "Easy")}</span><span>${typeLabel(task.type)}</span>${task.proofRequired ? `<span>· ${t("proof_needed")}</span>` : ""}</div>
    ${stepsHTML(task.steps)}${action}${modalClose()}`);

    const refresh = async () => {
        closeModal();
        await renderCurrentPage();
    };
    $("#btn-mark-done")?.addEventListener("click", async e => {
        const b = e.currentTarget;
        b.disabled = true;
        b.textContent = "…";
        if (await completeTask(taskId, e)) await refresh();
        else {
            b.disabled = false;
            b.textContent = t("i_completed", {
                n: money(task.reward)
            });
        }
    });
    $("#btn-submit-proof")?.addEventListener("click", async e => {
        const b = e.currentTarget;
        b.disabled = true;
        b.textContent = "…";
        const payload = isAccountTask(task) ? {
            username: $("#proof-user")?.value || "",
            note: $("#proof-note")?.value || ""
        } : ($("#proof-input")?.value || "");
        if (await submitProof(taskId, payload)) await refresh();
        else {
            b.disabled = false;
            b.textContent = t("submit_review");
        }
    });
}

// ---------- paint (cheap, user-dependent bits only) ----------
function setBig(el, v) {
    const m = fm(v);
    el.innerHTML = `$${m.whole}<small>.${m.dec}</small>`;
}

function animateBig(el, to) {
    const from = el.dataset.v === undefined ? to : Number(el.dataset.v);
    el.dataset.v = to;
    if (REDUCED || from === to) return setBig(el, to);
    const t0 = performance.now();
    const step = now => {
        const p = Math.min(1, (now - t0) / 650),
            e = 1 - Math.pow(1 - p, 3);
        setBig(el, from + (to - from) * e);
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

function paintUser() {
    if (!userData) return;
    const u = userData;
    $$("[data-balance],[data-wallet-balance]").forEach(el => animateBig(el, num(u.balance)));
    $$("[data-pending],[data-wallet-pending]").forEach(el => (el.textContent = money(u.pending)));
    $$("[data-wallet-lifetime]").forEach(el => (el.textContent = money(u.lifetime)));
    $$("[data-wallet-withdrawn]").forEach(el => (el.textContent = money(u.withdrawn)));
    $$("[data-streak-val]").forEach(el => (el.textContent = String(num(u.streak)).padStart(2, "0")));
    $$("[data-tasks-done]").forEach(el => (el.innerHTML = `${num(u.tasksCompleted)} <small>${t("total")}</small>`));
    $$("[data-greeting]").forEach(el => (el.innerHTML = `${greeting()}, <span>${esc(u.firstName || "")}</span> ✳`));
    $$("[data-ref-count]").forEach(el => (el.textContent = num(u.referrals)));
    $$("[data-ref-earn]").forEach(el => (el.textContent = money(u.referralEarnings)));
    $$("[data-profile-streak]").forEach(el => (el.textContent = "◷ " + t("n_streak", {
        n: num(u.streak)
    })));
    const cb = $("[data-checkin]");
    if (cb) {
        const claimed = u.lastCheckin === dayKey();
        cb.classList.toggle("done", claimed);
        cb.textContent = claimed ? t("claimed") : t("claim", {
            n: money(CHECKIN_REWARD)
        });
    }
}

// re-check tasks / completed set when a page opens (cheap: loadTasks has a 45s cache, loadDone is throttled)
function refreshData(redraw) {
    const sig = () => JSON.stringify(tasks.map(x => [x.id, x.title, x.reward, x.order])) + [...doneSet].join();
    const before = sig();
    Promise.all([loadTasks(), Date.now() - lastDoneLoad > 30000 ? loadDone() : null]).then(() => {
        if (sig() !== before) redraw();
    }).catch(() => {});
}

// ---------- page renderers ----------
function paintProgress() {
    const n = doneSet.size,
        pct = Math.min(100, Math.round(n / DAILY_GOAL * 100));
    const ring = $("[data-progress-ring]");
    if (ring) {
        ring.style.setProperty("--progress", pct + "%");
        $("span", ring).textContent = pct + "%";
    }
    const pt = $("[data-progress-text]");
    if (pt) pt.innerHTML = `<strong>${t("tasks_today", { a: n, b: DAILY_GOAL })}</strong><small>${n >= DAILY_GOAL ? t("goal_reached") : n === 0 ? t("start_first") : t("keep_going")}</small>`;
}

function paintAnnounce() {
    const box = $("[data-announce]");
    if (!box) return;
    const a = announcements[0];
    if (!a) {
        box.hidden = true;
        return;
    }
    box.hidden = false;
    box.innerHTML = `<div class="an-ic">📣</div><div><strong>${esc(a.title)}</strong><p>${esc(a.body || "")}</p></div>`;
}

function emptyState(icon, title, sub) {
    return `<div class="empty-state"><div class="empty-icon">${icon}</div><strong>${title}</strong><p>${sub}</p></div>`;
}

async function renderHome() {
    if (!userData) return;
    const dateEl = $("[data-date]");
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString(getLang() === "en" ? "en-US" : getLang(), {
        weekday: "long",
        day: "numeric",
        month: "short",
        year: "numeric"
    });
    renderStreakDays();
    const list = $("[data-home-tasks]");
    if (list) {
        const rec = tasks.slice(0, 3);
        if (!rec.length) list.innerHTML = tasksLoading ? skeletonHTML(3) : emptyState("✳", t("no_tasks"), t("admin_soon"));
        else list.innerHTML = rec.map((k, i) => taskCardHTML(k, doneSet.has(k.id), i)).join("");
    }
    paintProgress();
    paintAnnounce();
    paintUser();
    loadAnnouncements().then(paintAnnounce);
    if (currentUser) refreshData(renderHome);
}

function renderStreakDays() {
    const c = $("[data-streak-days]");
    if (!c) return;
    const names = ["S", "M", "T", "W", "T", "F", "S"],
        today = new Date().getDay(),
        s = num(userData?.streak);
    c.innerHTML = names.map((d, i) => `<span class="${i === today ? "today" : i < today && today - i <= s ? "done" : ""}">${d}</span>`).join("");
}
async function renderTasks() {
    const list = $("[data-task-list]");
    if (!list) return;
    activeFilter = "all";
    if (!tasks.length) list.innerHTML = tasksLoading ? skeletonHTML(4) : emptyState("✳", t("no_tasks_avail"), t("check_back"));
    else list.innerHTML = tasks.map((k, i) => taskCardHTML(k, doneSet.has(k.id), i)).join("");
    paintProgress();
    if (currentUser) refreshData(renderTasks);
}

function applyTaskFilter() {
    const q = ($("[data-search]")?.value || "").trim().toLowerCase();
    $$("[data-task]", $("[data-task-list]")).forEach(c => {
        const okCat = activeFilter === "all" || c.dataset.category === activeFilter;
        const okQ = !q || (c.dataset.search || "").toLowerCase().includes(q);
        c.classList.toggle("hidden", !(okCat && okQ));
    });
}
async function renderWallet() {
    if (!userData) return;
    paintUser();
    const box = $("[data-tx-list]");
    if (!box) return;
    const draw = txs => {
        box.innerHTML = !txs.length ? `<div class="empty-state"><div class="emoji">📭</div><p>${t("no_tx")}</p></div>` : txs.map(txHTML).join("");
    };
    const c = cget("tx");
    draw(c?.d || []);
    const txs = await loadList("transactions", "createdAt", 15);
    if (txs.length || !c) {
        cset("tx", txs.map(x => ({
            ...x,
            createdAt: x.createdAt?.seconds ? {
                seconds: x.createdAt.seconds
            } : null
        })));
        draw(txs);
    }
}

function txHTML(x) {
    const out = x.amount < 0 || x.type === "withdraw";
    return `<div class="tx-item"><div class="tx-icon ${out ? "out" : ""}">${esc(x.icon || (out ? "↗" : "✳"))}</div>
    <div class="tx-body"><strong>${esc(x.title)}</strong><small>${formatDate(x.createdAt)}</small></div>
    <div class="tx-amount ${out ? "out" : ""}">${out ? "−" : "+"}${money(Math.abs(x.amount))}</div></div>`;
}

function refLink() {
    return `https://t.me/${CFG.botUsername || "VerdantBot_bot"}${CFG.miniAppName ? "/" + CFG.miniAppName : ""}?startapp=ref_${userData?.referralCode || ""}`;
}
async function renderProfile() {
    if (!userData) return;
    const name = fullName(userData) || "User";
    $("[data-profile-name]") && ($("[data-profile-name]").textContent = name);
    $("[data-profile-user]") && ($("[data-profile-user]").textContent = userData.username ? "@" + userData.username : "Telegram");
    const av = $("[data-profile-avatar]");
    if (av) {
        const pu = userData.photoUrl && /^https:\/\//.test(userData.photoUrl) ? userData.photoUrl : "";
        av.innerHTML = pu ? `<img src="${esc(pu)}" alt="" referrerpolicy="no-referrer">` : esc(getInitials(name));
    }
    $("[data-ref-link]") && ($("[data-ref-link]").textContent = refLink().replace("https://", ""));
    paintThemeSwitch();
    paintUser();
}

function modalRow(icon, label, value) {
    return `<div class="menu-item static"><span class="mi-icon">${icon}</span><div class="mi-text"><strong>${esc(value)}</strong><small>${label}</small></div></div>`;
}

function openEditProfile() {
    if (!userData) return;
    openModal(`<h3>${t("edit_profile")}</h3><p class="muted">${t("edit_note")}</p><div class="menu-list">
    ${modalRow("◎", t("display_name"), fullName(userData) || "User")}${modalRow("@", t("username"), userData.username ? "@" + userData.username : "—")}
    ${modalRow("#", t("tg_id"), userData.telegramId || "—")}${modalRow("✳", t("ref_code"), userData.referralCode || "—")}</div>${modalClose()}`);
}

function openSecurity() {
    openModal(`<h3>${t("security")}</h3><p class="muted">${t("sec_note")}</p><div class="menu-list">
    ${modalRow("🛡", "Telegram", "✓")}${modalRow("🔒", "Firebase Auth", "✓")}${modalRow("✓", "HTTPS", "✓")}</div>${modalClose()}`);
}
const LANGS = [
    ["en", "🇬🇧", "English", "International"],
    ["bn", "🇧🇩", "বাংলা", "Bangladesh"],
    ["hi", "🇮🇳", "हिन्दी", "India"],
    ["id", "🇮🇩", "Bahasa Indonesia", "Indonesia"],
    ["ne", "🇳🇵", "नेपाली", "Nepal"]
];

function openLanguage() {
    const cur = getLang();
    openModal(`<h3>${t("language")}</h3><p class="muted">${t("choose_lang")}</p><div class="lang-list">
    ${LANGS.map(([id, f, n, r]) => `<button type="button" class="lang-item ${cur === id ? "active" : ""}" data-act="set-lang" data-lang="${id}">
      <span class="lang-flag">${f}</span><span class="lang-meta"><strong>${n}</strong><small>${r}</small></span>${cur === id ? '<span class="lang-check">✓</span>' : ""}</button>`).join("")}</div>${modalClose()}`);
}
async function renderLeaderboard() {
    const box = $("[data-lb-list]");
    if (!box) return;
    const draw = rows => {
        const me = userData?.id;
        if (me && !rows.find(r => r.uid === me) && userData && !userData._offline) rows = [...rows, {
            rank: rows.length + 1,
            uid: me,
            name: fullName(userData) || "You",
            score: num(userData.lifetime),
            tasks: num(userData.tasksCompleted)
        }];
        box.innerHTML = !rows.length ? emptyState("🏆", t("no_rank"), t("no_rank_sub")) : rows.map((r, i) => {
            const cls = r.rank === 1 ? "gold" : r.rank === 2 ? "silver" : r.rank === 3 ? "bronze" : "";
            const isMe = r.uid === me;
            return `<div class="lb-item ${isMe ? "me" : ""}" style="--i:${Math.min(i, 10)}"><div class="lb-rank ${cls}">${r.rank}</div><div class="lb-avatar">${esc(getInitials(r.name))}</div>
        <div class="lb-info"><strong>${esc(r.name)}${isMe ? " " + t("you") : ""}</strong><small>${t("tasks_done_n", { n: r.tasks })}</small></div><div class="lb-score">${money(r.score)}</div></div>`;
        }).join("");
    };
    const c = cget("lb");
    if (c?.d) draw(c.d);
    draw(await loadLeaderboard());
}
async function renderNotifications() {
    const box = $("[data-notif-list]");
    if (!box) return;
    const draw = () => {
        const items = [];
        announcements.forEach(a => items.push({
            icon: "📣",
            title: esc(a.title),
            body: esc(a.body || ""),
            time: formatDate(a.createdAt),
            unread: false
        }));
        if (userData && userData.lastCheckin !== dayKey()) items.unshift({
            icon: "🎁",
            title: t("n_checkin"),
            body: t("n_checkin_b"),
            time: "",
            unread: true
        });
        if (num(userData?.streak) > 0) items.push({
            icon: "🔥",
            title: t("n_streak", {
                n: userData.streak
            }),
            body: t("n_streak_b"),
            time: "",
            unread: false
        });
        if (tasks.length) items.push({
            icon: "✳",
            title: t("n_tasks", {
                n: tasks.length
            }),
            body: t("n_tasks_b"),
            time: "",
            unread: false
        });
        box.innerHTML = !items.length ? emptyState("🔔", t("notif_none"), t("caught_up")) :
            items.map(n => `<div class="notif-item ${n.unread ? "unread" : ""}"><div class="notif-icon">${n.icon}</div><div class="notif-body"><strong>${n.title}</strong><p>${n.body}</p><small>${n.time}</small></div></div>`).join("");
    };
    draw();
    await loadAnnouncements();
    draw();
}
let histTab = "tx";
async function renderHistory() {
    const box = $("[data-hist-list]");
    if (!box) return;
    $$("[data-hist]").forEach(b => b.classList.toggle("active", b.dataset.hist === histTab));
    box.innerHTML = skeletonHTML(3);
    let rows = [];
    if (histTab === "tx") rows = (await loadList("transactions", "createdAt", 40)).map(txHTML);
    else if (histTab === "wd") rows = (await loadList("withdrawals", "createdAt", 40)).map(w => {
        const st = okStatus(w.status);
        return `<div class="tx-item"><div class="tx-icon out">⇄</div><div class="tx-body"><strong>${esc(w.method)}</strong><small>${formatDate(w.createdAt)}</small></div>
      <div class="tx-right"><div class="tx-amount out">${money(w.amount)}</div><span class="st st-${st}">${t("st_" + st)}</span></div></div>`;
    });
    else rows = (await loadList("completedTasks", "completedAt", 40)).map(c =>
        `<div class="tx-item"><div class="tx-icon">✓</div><div class="tx-body"><strong>${esc(c.title)}</strong><small>${formatDate(c.completedAt)}</small></div><div class="tx-amount">+${money(c.reward)}</div></div>`);
    box.innerHTML = rows.length ? rows.join("") : `<div class="empty-state"><div class="emoji">📭</div><p>${t("none_yet")}</p></div>`;
}
async function renderSupport() {
    const a = $("[data-contact]");
    if (a) {
        if (CFG.supportUrl) {
            a.hidden = false;
            a.href = safeUrl(CFG.supportUrl);
        } else a.hidden = true;
    }
}
const ROUTES = {
    "index.html": renderHome,
    "tasks.html": renderTasks,
    "wallet.html": renderWallet,
    "profile.html": renderProfile,
    "leaderboard.html": renderLeaderboard,
    "notifications.html": renderNotifications,
    "history.html": renderHistory,
    "support.html": renderSupport
};

const getPageName = () => {
    const p = location.pathname.split("/").pop();
    return /\.html$/.test(p) ? p : "index.html";
};
async function renderCurrentPage() {
    window.applyLang();
    const fn = ROUTES[getPageName()];
    const navTarget = $(".page")?.dataset.nav || getPageName();
    $$(".nav-item").forEach(n => n.classList.toggle("active", n.getAttribute("href") === navTarget));
    if (fn) {
        try {
            await fn();
        } catch (e) {
            console.error("render:", e);
        }
    }
    paintUser();
    window.applyLang();
}

// ---------- instant navigation (mini-SPA) ----------
async function fetchPage(url) {
    if (pageCache.has(url)) return pageCache.get(url);
    const r = await fetch(url, {
        credentials: "same-origin"
    });
    if (!r.ok) throw new Error("fetch " + r.status);
    const doc2 = new DOMParser().parseFromString(await r.text(), "text/html");
    pageCache.set(url, doc2);
    return doc2;
}
async function go(url, push = true) {
    try {
        const d = await fetchPage(url);
        const appEl = $(".app"),
            nav = $(".bottom-nav", appEl);
        ["[data-topbar]", "[data-page]", "[data-extra]"].forEach(sel => {
            const nw = d.querySelector(".app " + sel),
                old = $(sel, appEl);
            if (nw && old) old.replaceWith(document.importNode(nw, true));
            else if (nw) nav.before(document.importNode(nw, true));
            else if (old) old.remove();
        });
        document.title = d.title;
        if (push) history.pushState({}, "", url);
        window.scrollTo(0, 0);
        await renderCurrentPage();
    } catch (e) {
        location.href = url;
    }
}

function initRouter() {
    window.addEventListener("popstate", () => go(location.href, false));
    const idle = window.requestIdleCallback || (f => setTimeout(f, 1200));
    idle(() => ["tasks.html", "wallet.html", "leaderboard.html", "profile.html", "history.html", "support.html", "notifications.html"]
        .forEach(p => fetchPage(new URL(p, location.href).href).catch(() => {})));
}

// ---------- global event delegation (bound once) ----------
document.addEventListener("click", async e => {
    const act = e.target.closest("[data-act]");
    if (act) {
        const a = act.dataset.act;
        if (act.tagName === "A") e.preventDefault();
        haptic("tap");
        if (a === "lang") openLanguage();
        else if (a === "set-lang") {
            setLang(act.dataset.lang);
            closeModal();
            await renderCurrentPage();
            showToast(t("lang_saved"));
        } else if (a === "close-modal") closeModal();
        else if (a === "checkin") {
            if (await doCheckin(e)) paintUser();
        } else if (a === "edit-profile") openEditProfile();
        else if (a === "security") openSecurity();
        else if (a === "theme") toggleTheme();
        else if (a === "copy-ref") {
            try {
                await navigator.clipboard.writeText(refLink());
                showToast(t("t_copied"));
            } catch {
                showToast(refLink());
            }
        } else if (a === "share-ref") {
            const url = `https://t.me/share/url?url=${encodeURIComponent(refLink())}&text=${encodeURIComponent(t("invite_sub"))}`;
            openExternal(url);
        } else if (a === "open-withdraw") {
            $("#withdraw-modal")?.classList.add("open");
            updateConvertPreview();
        } else if (a === "close-withdraw") $("#withdraw-modal")?.classList.remove("open");
        else if (a === "filter") {
            $$("[data-filter]").forEach(b => b.classList.toggle("active", b === act));
            activeFilter = act.dataset.filter;
            applyTaskFilter();
        } else if (a === "hist") {
            histTab = act.dataset.hist;
            renderHistory();
        } else if (a === "faq") act.closest(".faq-item")?.classList.toggle("open");
        return;
    }
    if (e.target.id === "withdraw-modal") return $("#withdraw-modal").classList.remove("open");
    const card = e.target.closest("[data-task]");
    if (card && card.dataset.id) {
        e.preventDefault();
        haptic("tap");
        return openTaskDetail(card.dataset.id);
    }
    const ext = e.target.closest("a[data-ext]");
    if (ext) {
        e.preventDefault();
        return openExternal(ext.href);
    }
    const a = e.target.closest("a[href]");
    if (a && !a.target && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
        const h = a.getAttribute("href") || "";
        if (/^[\w-]+\.html(\?.*)?$/.test(h)) {
            e.preventDefault();
            if (new URL(h, location.href).pathname !== location.pathname) go(new URL(h, location.href).href);
        }
    }
});
document.addEventListener("input", e => {
    if (e.target.matches("[data-search]")) applyTaskFilter();
    if (e.target.id === "convert-amount") updateConvertPreview();
});
document.addEventListener("change", e => {
    if (e.target.id === "convert-country") updateConvertPreview();
});
document.addEventListener("submit", async e => {
    const f = e.target.closest("[data-withdraw-form]");
    if (!f) return;
    e.preventDefault();
    const btn = $("[type=submit]", f);
    btn.disabled = true;
    const ok = await requestWithdraw($("[name=amount]", f).value, $("[name=method]", f).value, $("[name=account]", f).value);
    btn.disabled = false;
    if (ok) {
        $("#withdraw-modal")?.classList.remove("open");
        f.reset();
        const p = $("#convert-preview");
        if (p) p.hidden = true;
        renderWallet();
    }
});

// ---------- boot ----------
function hideLoading() {
    const el = $("#loading");
    if (!el) return;
    el.classList.add("hidden");
    setTimeout(() => {
        el.style.display = "none";
    }, 400);
}

function hydrateFromCache() {
    const u = cget("user"),
        tk = cget("tasks"),
        dn = cget("done:" + dayKey());
    if (u?.d) userData = u.d;
    if (tk?.d?.length) {
        tasks = tk.d;
        tasksLoading = false;
    }
    if (dn?.d) doneSet = new Set(dn.d);
}
async function boot() {
    initTelegram();
    applyTheme();
    window.applyLang();
    initRouter();
    const hasFb = initFirebase();
    hydrateFromCache();
    if (userData) {
        await renderCurrentPage();
        hideLoading();
    } // instant paint from cache
    if (!hasFb) {
        userData = userData || buildOfflineUser();
        tasksLoading = false;
        await renderCurrentPage();
        hideLoading();
        return;
    }

    const user = await waitAuth();
    if (!user) {
        if (!userData) userData = buildOfflineUser();
        else userData = {
            ...userData,
            _offline: true
        };
        tasksLoading = false;
        await renderCurrentPage();
        hideLoading();
        showToast(t("t_offline"));
        return;
    }
    if (cacheUid !== user.uid) {
        cacheUid = user.uid;
        try {
            LS?.setItem("vd2:uid", cacheUid);
        } catch {}
        if (userData && userData.id !== user.uid) {
            userData = null;
            tasks = [];
            doneSet = new Set();
        }
    }
    currentUser = user;
    try {
        await ensureUserDoc(user);
        watchUser(user.uid);
        await Promise.all([loadTasks(), loadDone()]);
    } catch (e) {
        console.error("boot:", e?.code, e?.message);
        tasksLoading = false;
        if (!userData) userData = buildOfflineUser();
        showToast(e?.code === "permission-denied" ? t("t_denied") : t("t_offline"));
    }
    await renderCurrentPage();
    hideLoading();
    syncLeaderboard();
}
boot().catch(err => {
    console.error("Boot:", err);
    hideLoading();
    showToast(t("t_err"));
});