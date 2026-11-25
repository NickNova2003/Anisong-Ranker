"use strict";
/* Nick's AniSong - the phone side. Everything lives on the phone (IndexedDB): playlists and scores come in
   from the PC app's "Send to phone" file, songs download straight from AniSongDB, and scores go back as a file. */

const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const ic = name => `<svg><use href="#i-${name}"/></svg>`;
const now = () => Date.now() / 1000;
const fmtScore = v => v == null ? "" : String(+(+v).toFixed(2));
const fmtTime = t => !isFinite(t) || t < 0 ? "0:00" : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const fmtSize = b => b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b < 1e6 ? "<1 MB" : Math.round(b / 1e6) + " MB";
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const shuffled = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } };
const ytId = s => { const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/.exec((s && s.link) || ""); return m ? m[1] : null; };

/* ---------- storage ---------- */
const DB = new Promise((ok, fail) => {
  const r = indexedDB.open("nick-anisong", 1);
  r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("songs", {keyPath: "key"}); d.createObjectStore("lists", {keyPath: "id"}); d.createObjectStore("blobs"); };
  r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
});
async function tx(name, mode, fn) {
  const d = await DB;
  return new Promise((ok, fail) => {
    const t = d.transaction(name, mode), out = fn(t.objectStore(name));
    t.oncomplete = () => ok(out && "result" in out ? out.result : out);
    t.onerror = t.onabort = () => fail(t.error);
  });
}
const putSong = s => tx("songs", "readwrite", st => st.put(s));
const putList = l => tx("lists", "readwrite", st => st.put(l));
const getBlob = k => tx("blobs", "readonly", st => st.get(k));
const putBlob = (k, b) => tx("blobs", "readwrite", st => st.put(b, k));
const delBlobs = ks => tx("blobs", "readwrite", st => ks.forEach(k => st.delete(k)));

const S = {songs: new Map(), lists: [], have: new Set(), covers: new Map(), tab: "library", list: null, path: "",
           q: "", rankScope: "", rankDir: "top", rankMin: 0, lastExport: store("lastExport") || 0};
const D = new Map();  // playlist id -> download progress {done, total, failed, stop}

async function boot() {
  const [songs, lists, keys] = await Promise.all([tx("songs", "readonly", st => st.getAll()), tx("lists", "readonly", st => st.getAll()),
                                                  tx("blobs", "readonly", st => st.getAllKeys())]);
  songs.forEach(s => S.songs.set(s.key, s));
  S.lists = lists; sortLists();
  keys.filter(k => k.startsWith("a:")).forEach(k => S.have.add(k.slice(2)));
  await Promise.all(keys.filter(k => k.startsWith("c:")).map(k => getBlob(k).then(b => b && S.covers.set(k.slice(2), URL.createObjectURL(b)))));
  if (!S.lists.length) S.tab = "sync";
  render(); badge();
}
const sortLists = () => S.lists.sort((a, b) => (b.all - a.all) || (!!b.isFolder - !!a.isFolder) || a.name.localeCompare(b.name));

/* ---------- helpers ---------- */
const song = k => S.songs.get(k);
const listById = id => S.lists.find(l => l.id === id);
const canPlay = k => { const s = song(k); return !!s && (S.have.has(k) || (navigator.onLine && !!(s.audio || ytId(s)))); };
const coverOf = s => (s && (S.covers.get(s.cover) || (navigator.onLine && s.cover))) || "";
const img = (s, cls = "cv") => { const c = coverOf(s); return `<img class="${cls}${c ? "" : " ph"}" ${c ? `src="${esc(c)}"` : ""} alt="" loading="lazy" referrerpolicy="no-referrer">`; };
const subOf = s => [s.artist, s.anime].filter(Boolean).join(" · ");
const keysOf = l => l.items.map(([k]) => k).filter(k => S.songs.has(k));
function ranked(list) {  // the PC app's order: score high to low, ties by your nudges, then unrated
  const pos = new Map(list.items);
  return keysOf(list).sort((a, b) => {
    const x = song(a).score, y = song(b).score;
    if ((x == null) !== (y == null)) return x == null ? 1 : -1;
    return (x != null && y !== x ? y - x : 0) || pos.get(a) - pos.get(b);
  });
}
function mosaic(keys, cls = "art") {  // 1 or 4 covers, like a music app's playlist art
  const covers = [...new Set(keys.map(k => coverOf(song(k))).filter(Boolean))].slice(0, 4);
  if (covers.length < 4) return `<div class="${cls} one">${covers[0] ? `<img src="${esc(covers[0])}" alt="" referrerpolicy="no-referrer">` : `<img class="ph" alt="">`}</div>`;
  return `<div class="${cls}">${covers.map(c => `<img src="${esc(c)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join("")}</div>`;
}
function toast(msg, ms = 2600) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), ms);
}
function changes() { return [...S.songs.values()].filter(s => s.changed > S.lastExport).length + S.lists.filter(l => l.orderChanged > S.lastExport).length; }
function badge() { const n = changes(); $("badge").hidden = !n; $("badge").textContent = n > 99 ? "99+" : n; }
const fill = el => el && el.style.setProperty("--p", (el.value / el.max * 100) + "%");
// the colour of the cover tints the player, like Spotify does
const tintCache = new Map();
function tint(s) {
  const url = coverOf(s); if (!url) return document.documentElement.style.setProperty("--tint", "40, 70, 130");
  if (tintCache.has(url)) return document.documentElement.style.setProperty("--tint", tintCache.get(url));
  const im = new Image(); im.crossOrigin = "anonymous";
  im.onload = () => {
    try {
      const c = document.createElement("canvas"); c.width = c.height = 12; const x = c.getContext("2d"); x.drawImage(im, 0, 0, 12, 12);
      const d = x.getImageData(0, 0, 12, 12).data; let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { const lum = d[i] + d[i + 1] + d[i + 2]; if (lum > 60 && lum < 690) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } }
      const v = n ? `${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)}` : "40, 70, 130";
      tintCache.set(url, v); document.documentElement.style.setProperty("--tint", v);
    } catch (e) { /* cover host didn't allow it */ }
  };
  im.src = url;
}

/* ---------- screens ---------- */
let renderTimer;
const renderSoon = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 250); };
function render() {
  const inList = S.tab === "lists" && S.list != null && listById(S.list);
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === S.tab));
  $("back").hidden = !(inList || (S.tab === "lists" && S.path)); $("topExtra").innerHTML = "";
  const v = $("view"), y = window.scrollY, same = render.last === S.tab + S.list + S.path;
  render.last = S.tab + S.list + S.path;
  if (inList) { $("title").textContent = ""; v.innerHTML = listView(inList); tint(song(ranked(inList)[0])); }
  else {
    $("title").textContent = S.tab === "lists" && S.path ? S.path.split(" / ").pop() : {library: "Library", ranked: "Ranked", lists: "Playlists", sync: "Sync"}[S.tab];
    v.innerHTML = VIEWS[S.tab]();
  }
  if (same) window.scrollTo(0, y);
  const q = $("q"); if (q && render.focus) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  markNow();
}
function songRow(k, {rank, nudge, ctx} = {}) {
  const s = song(k), have = S.have.has(k), yt = !have && !s.audio && ytId(s);
  const state = have ? `<span class="got">${ic("done")}</span>` : yt ? `<span class="yt">${ic("yt")}</span>` : "";
  return `<div class="song${canPlay(k) ? "" : " off"}" data-key="${esc(k)}" data-ctx="${ctx}">
    ${rank !== undefined ? `<span class="rank">${rank}</span>` : ""}${img(s)}
    <div class="meta"><div class="t">${esc(s.songName)}</div><div class="s">${state}<span>${esc(subOf(s))}</span></div></div>
    ${nudge ? `<span class="nudge"><button data-nudge="-1" ${nudge.up ? "" : "disabled style=visibility:hidden"} aria-label="Move up">${ic("up")}</button><button data-nudge="1" ${nudge.down ? "" : "disabled style=visibility:hidden"} aria-label="Move down">${ic("down")}</button></span>` : ""}
    <span class="score${s.score == null ? " none" : ""}">${s.score == null ? "–" : fmtScore(s.score)}</span>
    <button class="more" data-more aria-label="More">${ic("more")}</button></div>`;
}
const CTX = {};  // what "play from here" plays, per screen
const VIEWS = {
  library() {
    const all = [...S.have].filter(k => S.songs.has(k)).sort((a, b) => song(a).songName.localeCompare(song(b).songName));
    if (!all.length) return S.lists.length ? `<div class="empty">${ic("music")}<b>Nothing downloaded yet</b>Open a playlist and tap the download button. Your songs show up here, ready for offline.</div>` : VIEWS.sync();
    const f = S.q.trim().toLowerCase();
    const keys = f ? all.filter(k => { const s = song(k); return [s.songName, s.artist, s.anime].join(" ").toLowerCase().includes(f); }) : all;
    CTX.library = keys;
    return `<label class="search">${ic("search")}<input id="q" type="search" placeholder="Search ${all.length} downloaded songs" value="${esc(S.q)}"></label>
      <div class="actions"><button class="btn light" data-play="library" data-shuffle="1">${ic("shuffle")} Shuffle</button><button class="btn" data-play="library">${ic("play")} Play all</button></div>
      ${keys.map(k => songRow(k, {ctx: "library"})).join("") || `<div class="empty">No matches.</div>`}`;
  },
  ranked() {
    if (!S.lists.length) return VIEWS.sync();
    const scope = listById(+S.rankScope) || S.lists.find(l => l.all) || S.lists[0];
    let keys = ranked(scope).filter(k => song(k).score != null && song(k).score >= S.rankMin);
    const playable = keys.filter(canPlay), missing = keys.length - playable.length;
    const ranks = new Map(keys.map((k, i) => [k, i + 1]));
    if (S.rankDir === "bottom") playable.reverse();
    CTX.ranked = playable;
    const n = playable.length;
    return `<div class="actions"><select class="sel" id="rankScope">${S.lists.map(l => `<option value="${l.id}" ${scope.id === l.id ? "selected" : ""}>${l.all ? "★ " : l.isFolder ? "📁 " : ""}${esc(l.name)}</option>`).join("")}</select>
        <span class="grow"></span><button class="icon round" data-play="ranked" ${n ? "" : "disabled"} aria-label="Play">${ic("play")}</button></div>
      <div class="chips"><button class="chip ${S.rankDir === "top" ? "on" : ""}" data-dir="top">Top first</button><button class="chip ${S.rankDir === "bottom" ? "on" : ""}" data-dir="bottom">Bottom first</button>
        ${[0, 9, 8, 7, 6].map(m => `<button class="chip ${S.rankMin === m ? "on" : ""}" data-min="${m}">${m ? m + "+" : "Any score"}</button>`).join("")}</div>
      ${missing ? `<div class="sub" style="margin-bottom:8px">${plural(missing, "rated song")} can't play offline, so ${missing === 1 ? "it's" : "they're"} left out.</div>` : ""}
      ${playable.map(k => songRow(k, {rank: ranks.get(k), ctx: "ranked"})).join("") || `<div class="empty">${ic("chart")}<b>Nothing here yet</b>No playable songs rated ${S.rankMin ? S.rankMin + " or more" : "yet"}.</div>`}`;
  },
  lists() {
    if (!S.lists.length) return VIEWS.sync();
    const here = S.path, under = p => (p.folder || "") === here, full = l => (l.folder ? l.folder + " / " : "") + l.name;
    const folders = new Map();  // sub-folders one level down, from playlists' folder paths
    for (const l of S.lists) {
      const path = l.isFolder ? full(l) : l.folder || "";
      if (path && (here ? path.startsWith(here + " / ") : true) && path !== here) {
        const name = path.slice(here ? here.length + 3 : 0).split(" / ")[0];
        const key = here ? here + " / " + name : name;
        if (!folders.has(key)) folders.set(key, new Set());
      }
    }
    for (const l of S.lists) for (const [key, keys] of folders) {
      const p = l.isFolder ? full(l) : l.folder || "";
      if (p === key || p.startsWith(key + " / ")) keysOf(l).forEach(k => keys.add(k));
    }
    const self = S.lists.find(l => l.isFolder && full(l) === here);  // the folder itself, sent as one list
    const tiles = [];
    if (!here) { const all = S.lists.find(l => l.all); if (all) tiles.push(tile(all, `<div class="art star">${ic("star")}</div>`)); }
    if (self) tiles.push(tile(self, mosaic(keysOf(self)), "Everything in this folder"));
    for (const [key, keys] of folders) tiles.push(`<button class="tile" data-path="${esc(key)}"><div class="art fold">${ic("folder")}</div>
      <div class="name">${esc(key.split(" / ").pop())}</div><div class="info">Folder · ${plural(keys.size, "song")}</div></button>`);
    for (const l of S.lists.filter(l => !l.all && !l.isFolder && under(l))) tiles.push(tile(l, mosaic(keysOf(l))));
    return `${here.includes(" / ") ? `<div class="crumbs">${esc(here.slice(0, here.lastIndexOf(" / ")))}</div>` : ""}<div class="grid">${tiles.join("")}</div>`;
  },
  sync() {
    const n = changes(), last = S.lastExport ? new Date(S.lastExport * 1000).toLocaleString() : "never";
    setTimeout(storageLine);
    return `${S.lists.length ? "" : `<div class="card"><h3>${ic("music")} Getting started</h3><ol class="steps">
        <li>On your PC, open the app and click <b>Send to phone</b>.</li><li>Send that file to your phone (WhatsApp, Drive, email).</li>
        <li>Tap <b>Import from PC</b> below and pick the file. Songs start downloading straight away.</li></ol></div>`}
      <div class="card"><h3>${ic("import")} From your PC</h3><div class="sub" style="margin-bottom:14px">Brings in playlists and your PC scores. If a song changed on both, the newer change wins.</div>
        <button class="btn primary wide" id="importBtn">Import from PC</button></div>
      ${S.lists.length ? `<div class="card"><h3>${ic("upload")} Back to your PC</h3><div class="sub" style="margin-bottom:14px">${n ? `<b style="color:var(--text)">${plural(n, "change")}</b> not sent yet.` : "Everything's been sent."} Last sent: ${last}. Open the file in the PC app with <b>Import</b>.</div>
        <button class="btn ${n ? "primary" : ""} wide" id="exportBtn">Send scores to PC</button></div>` : ""}
      <div class="card"><h3>${ic("dl")} Downloads</h3><div class="sub" id="storage">Checking…</div>
        ${S.lists.length ? `<button class="btn wide" id="dlAll" style="margin-top:14px">Download every playlist</button>` : ""}</div>
      ${installPrompt ? `<button class="btn primary wide" id="installBtn">Install as an app</button>` : ""}`;
  },
};
function tile(l, art, info) {
  const keys = keysOf(l), got = keys.filter(k => S.have.has(k)).length, d = D.get(l.id);
  return `<button class="tile" data-list="${l.id}"><div style="position:relative">${art}${d ? `<div class="bar" style="position:absolute;left:8px;right:8px;bottom:8px"><i style="width:${(100 * d.done / Math.max(d.total, 1)).toFixed(1)}%"></i></div>` : ""}</div>
    <div class="name">${esc(l.name)}</div><div class="info">${info || `${plural(keys.length, "song")}${got ? ` · ${got} saved` : ""}`}</div></button>`;
}
async function storageLine() {
  const el = $("storage"); if (!el) return;
  const used = [...S.have].reduce((t, k) => t + ((song(k) || {}).size || 0), 0);
  let line = S.have.size ? `${plural(S.have.size, "song")} saved on this phone (${fmtSize(used)}).` : "No songs saved yet.";
  try { const e = await navigator.storage.estimate(); line += ` About ${fmtSize(Math.max(e.quota - e.usage, 0))} free for the app.`; } catch (e) { /* not supported */ }
  try { if (navigator.storage.persisted && !(await navigator.storage.persisted())) line += " Install the app so Android keeps your downloads."; } catch (e) { /* ignore */ }
  el.textContent = line;
}
function listView(l) {
  const keys = ranked(l), d = D.get(l.id), missing = keys.filter(k => !S.have.has(k) && song(k).audio && !song(k).noDl).length;
  CTX["list" + l.id] = keys;
  const got = keys.filter(k => S.have.has(k)).length, rated = keys.filter(k => song(k).score != null);
  const avg = rated.length ? (rated.reduce((t, k) => t + song(k).score, 0) / rated.length).toFixed(2) : null;
  const dl = d ? `<button class="icon sm on dlring" id="dlStop" aria-label="Stop downloading">${ic("stop")}</button>`
    : missing ? `<button class="icon sm" id="dlList" aria-label="Download ${missing}">${ic("dl")}</button>`
    : got ? `<span class="icon sm on" aria-label="Downloaded">${ic("done")}</span>` : "";
  return `<div class="hero">${mosaic(keys)}
      <h2>${l.all ? "★ " : ""}${esc(l.name)}</h2>
      <div class="info">${l.isFolder ? "Folder · " : ""}${plural(keys.length, "song")} · ${rated.length} rated${avg ? ` · avg ${avg}` : ""} · ${got} saved</div>
      <div class="actions" style="margin:12px 0 0">${dl}<button class="icon sm" id="rateBtn" aria-label="Rate">${ic("star")}</button>
        <button class="icon sm" id="listMore" aria-label="More">${ic("more")}</button><span class="grow"></span>
        <button class="icon sm" data-play="list${l.id}" data-shuffle="1" aria-label="Shuffle">${ic("shuffle")}</button>
        <button class="icon round" data-play="list${l.id}" aria-label="Play">${ic("play")}</button></div></div>
    ${d ? `<div class="prog"><i style="width:${(100 * d.done / Math.max(d.total, 1)).toFixed(1)}%"></i></div><div class="sub" style="margin:-6px 0 8px">Downloading ${d.done} of ${d.total}…</div>` : ""}
    ${keys.map((k, i) => {
      const sc = song(k).score, up = i > 0 && sc != null && song(keys[i - 1]).score === sc, down = i < keys.length - 1 && sc != null && song(keys[i + 1]).score === sc;
      return songRow(k, {rank: sc == null ? "" : i + 1, nudge: !l.isFolder && (up || down) ? {up, down} : null, ctx: "list" + l.id});
    }).join("")}`;
}

/* ---------- player ---------- */
const A = new Audio();
const P = {queue: [], i: -1, order: null, shuffle: false, repeat: "off", sleep: 0, sleepEnd: false, url: null, key: null, single: false, yt: false, from: ""};
const YTP = {player: null, ready: null};
function ytReady() {  // YouTube's own player, for songs that only have a YouTube link (needs internet)
  if (YTP.ready) return YTP.ready;
  return YTP.ready = new Promise((ok, fail) => {
    window.onYouTubeIframeAPIReady = ok;
    const sc = document.createElement("script"); sc.src = "https://www.youtube.com/iframe_api";
    sc.onerror = () => { YTP.ready = null; fail(new Error("offline")); }; document.head.appendChild(sc);
  }).then(() => new Promise(ok => {
    YTP.player = new YT.Player("ytFrame", {width: "100%", height: "100%", playerVars: {autoplay: 1, rel: 0, playsinline: 1},
      events: {onReady: ok, onStateChange: e => { drawPlayState(); if (e.data === 0) next(true); },
               onError: () => { toast("This video only plays on YouTube itself."); }}});
  }));
}
const media = {
  get paused() { return P.yt ? ![1, 3].includes(YTP.player?.getPlayerState?.()) : A.paused; },
  play() { P.yt ? YTP.player?.playVideo?.() : A.play().catch(() => {}); },
  pause() { P.yt ? YTP.player?.pauseVideo?.() : A.pause(); },
  get time() { return P.yt ? YTP.player?.getCurrentTime?.() || 0 : A.currentTime; },
  set time(t) { P.yt ? YTP.player?.seekTo?.(t, true) : A.currentTime = t; },
  get dur() { return P.yt ? YTP.player?.getDuration?.() || 0 : A.duration || 0; },
};
async function playQueue(keys, start = 0, shuffle = false, from = "") {
  keys = keys.filter(canPlay);
  if (!keys.length) return toast(navigator.onLine ? "Nothing here can play yet - download it first." : "Nothing downloaded here yet.");
  if (shuffle) { keys = shuffled(keys); start = 0; }
  P.queue = keys; P.order = null; P.shuffle = shuffle; P.single = false; P.i = Math.min(start, keys.length - 1); P.from = from;
  await load(true);
}
async function load(play) {
  const k = P.queue[P.i]; if (k == null) return;
  const s = song(k); let src = null;
  if (S.have.has(k)) { const b = await getBlob("a:" + k); if (b) src = URL.createObjectURL(b); else S.have.delete(k); }
  if (!src && navigator.onLine && s.audio) src = s.audio;
  const yt = !src && navigator.onLine && ytId(s);
  if (!src && !yt) { toast(`"${s.songName}" isn't saved on this phone - skipped`); return P.i < P.queue.length - 1 ? (P.i++, load(play)) : undefined; }
  const old = P.url;
  P.key = k; P.yt = !!yt; $("player").classList.toggle("yt", P.yt);
  if (yt) {
    A.pause(); A.removeAttribute("src"); P.url = null;
    ytReady().then(() => { if (P.key === k && P.yt) YTP.player.loadVideoById(yt); }).catch(() => toast("Couldn't reach YouTube."));
    if ($("player").hidden && $("rate").hidden) openPlayer();  // YouTube needs the video on screen
  } else {
    if (YTP.player) try { YTP.player.stopVideo(); } catch (e) { /* not ready */ }
    P.url = src.startsWith("blob:") ? src : null;
    A.src = src; if (play) A.play().catch(() => {});
  }
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  drawPlayer(); markNow(); mediaInfo(s);
}
function next(auto) {
  if (auto && P.repeat === "one") { media.time = 0; return media.play(); }
  if (auto && P.sleepEnd) { P.sleepEnd = false; drawSleep(); return; }
  if (P.single) return;
  if (P.i < P.queue.length - 1) { P.i++; return load(true); }
  if (P.repeat === "all" && P.queue.length) { P.i = 0; return load(true); }
  if (!auto) toast("End of the queue");
}
function prev() {
  if (media.time > 3 || P.i <= 0) { media.time = 0; return; }
  P.i--; load(true);
}
const toggle = () => { if (!P.key) return; media.paused ? media.play() : media.pause(); };
A.addEventListener("ended", () => next(true));
A.addEventListener("error", () => { if (P.key && !P.yt && A.getAttribute("src")) { toast("That song wouldn't play"); if (!P.single) setTimeout(() => next(false), 600); } });
["play", "pause"].forEach(ev => A.addEventListener(ev, drawPlayState));
function tick() {
  const d = media.dur, t = media.time;
  $("miniBar").firstChild.style.width = d ? (100 * t / d) + "%" : 0;
  if (!$("player").hidden && !seeking) { $("pSeek").value = d ? Math.round(1000 * t / d) : 0; fill($("pSeek")); $("pNow").textContent = fmtTime(t); $("pDur").textContent = fmtTime(d); }
  const rs = $("rSeek"); if (rs && !seeking) { rs.value = d ? Math.round(1000 * t / d) : 0; fill(rs); $("rTime").textContent = `${fmtTime(t)} / ${fmtTime(d)}`; }
  if (!P.yt && "setPositionState" in (navigator.mediaSession || {}) && d) try { navigator.mediaSession.setPositionState({duration: d, position: Math.min(t, d), playbackRate: 1}); } catch (e) { /* ignore */ }
}
A.addEventListener("timeupdate", tick);
setInterval(() => { if (P.yt) { tick(); drawPlayState(); } }, 500);
function drawPlayState() {
  const icon = ic(media.paused ? "play" : "pause");
  $("miniPlay").innerHTML = icon; $("pPlay").innerHTML = icon; const rp = $("rPlay"); if (rp) rp.innerHTML = icon;
  if (navigator.mediaSession) navigator.mediaSession.playbackState = A.paused ? "paused" : "playing";
}
function drawPlayer() {
  const s = song(P.key); if (!s) return;
  document.body.classList.add("mini"); $("mini").hidden = false;
  const c = coverOf(s);
  for (const id of ["miniCover", "pCover"]) { $(id).classList.toggle("ph", !c); if (c) $(id).src = c; else $(id).removeAttribute("src"); }
  $("miniTitle").textContent = $("pTitle").textContent = s.songName;
  $("miniSub").textContent = s.artist; $("pSub").textContent = subOf(s);
  $("pFrom").textContent = P.from ? "Playing from " + P.from : "Now playing";
  $("pScore").className = "pscore" + (s.score == null ? " none" : "");
  $("pScore").innerHTML = s.score == null ? "Rate" : ic("star") + fmtScore(s.score);
  $("pShuffle").classList.toggle("on", P.shuffle);
  $("pRepeat").classList.toggle("on", P.repeat !== "off"); $("pRepeat").innerHTML = ic(P.repeat === "one" ? "repeat1" : "repeat");
  tint(s); drawPlayState(); drawSleep(); if (!$("pQueue").hidden) drawQueue();
}
function drawQueue() {
  const up = P.queue.slice(P.i + 1, P.i + 101);
  $("pQueue").innerHTML = `<h4>Now playing</h4>${songRow(P.key, {ctx: "queue"})}<h4>Up next${P.queue.length - P.i - 1 > 100 ? " (first 100)" : ""}</h4>`
    + (up.map((k, j) => songRow(k, {ctx: "queue"}).replace(`data-more aria-label="More">${ic("more")}`, `data-qdel="${P.i + 1 + j}" aria-label="Remove">${ic("x")}`)).join("") || `<div class="sub">Nothing after this one.</div>`);
}
function markNow() { document.querySelectorAll(".song").forEach(el => el.classList.toggle("now", el.dataset.key === P.key)); }
function mediaInfo(s) {
  if (!navigator.mediaSession) return;
  const c = coverOf(s);
  navigator.mediaSession.metadata = new MediaMetadata({title: s.songName, artist: s.artist || "", album: s.anime || "",
                                                       artwork: c ? [{src: c, sizes: "512x512"}] : []});
}
if (navigator.mediaSession) {
  const ms = navigator.mediaSession, on = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) { /* not supported */ } };
  on("play", () => media.play()); on("pause", () => media.pause()); on("nexttrack", () => next(false)); on("previoustrack", prev);
  on("seekto", e => { media.time = e.seekTime; }); on("seekbackward", () => { media.time -= 10; }); on("seekforward", () => { media.time += 10; });
}
function setShuffle(on) {
  if (on === P.shuffle) return;
  const rest = P.queue.slice(P.i + 1), done = P.queue.slice(0, P.i + 1);
  if (on) { P.order = P.queue.slice(); P.queue = [...done, ...shuffled(rest)]; }
  else if (P.order) { const left = new Set(rest); P.queue = [...done, ...P.order.filter(k => left.has(k) && !done.includes(k))]; }
  P.shuffle = on; drawPlayer();
}
function setSleep(mins) {
  clearTimeout(P.sleep); P.sleep = 0; P.sleepEnd = mins === "end"; P.sleepAt = 0;
  if (typeof mins === "number" && mins) { P.sleepAt = Date.now() + mins * 60000; P.sleep = setTimeout(() => { media.pause(); P.sleep = 0; P.sleepAt = 0; drawSleep(); toast("Sleep timer: paused"); }, mins * 60000); }
  drawSleep();
}
function drawSleep() {
  $("pSleepTxt").textContent = P.sleepEnd ? "End of song" : P.sleepAt ? `${Math.max(1, Math.round((P.sleepAt - Date.now()) / 60000))}m` : "";
  $("pSleep").classList.toggle("on", !!(P.sleepEnd || P.sleepAt));
}
setInterval(() => { if (P.sleepAt) drawSleep(); }, 30000);
function queueAdd(k, nextUp) {
  if (!canPlay(k)) return toast("Download it first.");
  if (!P.key) return playQueue([k]);
  P.single = false;
  P.queue.splice(nextUp ? P.i + 1 : P.queue.length, 0, k); if (P.order) P.order.push(k);
  toast(nextUp ? "Plays next" : "Added to the queue"); if (!$("pQueue").hidden) drawQueue();
}
function openPlayer() { $("pQueue").hidden = true; $("pMain").hidden = false; $("pQueueBtn").classList.remove("on"); openLayer("player"); drawPlayer(); }

/* ---------- layers (Android back button closes them) ---------- */
let swapMenu = false;  // a menu choice that opens a screen takes the menu's place in history, so Back stays in step
function openLayer(id) { $(id).hidden = false; history[swapMenu ? "replaceState" : "pushState"]({layer: id}, ""); swapMenu = false; }
function closeTop() {
  if (!$("menu").hidden) return closeMenu();
  if (!$("rate").hidden) { $("rate").hidden = true; $("rBody").innerHTML = ""; if (P.key) tint(song(P.key)); renderSoon(); return; }
  if (!$("player").hidden) { $("player").hidden = true; return; }
  if (S.tab === "lists" && S.list != null) { S.list = null; return render(); }
  if (S.tab === "lists" && S.path) { S.path = S.path.includes(" / ") ? S.path.slice(0, S.path.lastIndexOf(" / ")) : ""; render(); }
}
window.addEventListener("popstate", closeTop);
const back = () => history.back();

function menu(html) { $("menu").innerHTML = html; $("menu").hidden = $("shade").hidden = false; history.pushState({layer: "menu"}, ""); }
function closeMenu() { $("menu").hidden = $("shade").hidden = true; }
$("shade").onclick = back;
const mi = (act, icon, label, cls = "") => `<button class="mi ${cls}" data-act="${act}">${ic(icon)}${label}</button>`;
function songMenu(k) {
  const s = song(k), have = S.have.has(k), list = S.list, yt = ytId(s);
  menu(`<div class="mhead">${img(s)}<div class="meta"><div class="t">${esc(s.songName)}</div><div class="s">${esc(subOf(s))}</div></div></div>
    ${mi("next", "playnext", "Play next")}${mi("queue", "addq", "Add to queue")}${mi("rate", "star", s.score == null ? "Rate this song" : `Change score (${fmtScore(s.score)})`)}
    ${!have && s.audio ? mi("dl", "dl", "Download") : ""}
    ${mi("file", "file", `${s.own ? "Change" : "Add"} audio file`)}
    ${yt ? mi("yt", "yt", "Open on YouTube") : ""}
    ${have ? mi("del", "trash", "Remove download", "danger") : ""}`);
  $("menu").onclick = async e => {
    const a = e.target.closest("[data-act]"); if (!a) return;
    const act = a.dataset.act;
    if (act === "rate") { closeMenu(); swapMenu = true; } else back();
    if (act === "next" || act === "queue") queueAdd(k, act === "next");
    else if (act === "rate") openRate(list != null && listById(list) ? ranked(listById(list)) : [k], k);
    else if (act === "dl") { await fetchSong(k); render(); }
    else if (act === "file") { audioFor = k; $("audioFile").click(); }
    else if (act === "yt") window.open(`https://www.youtube.com/watch?v=${yt}`, "_blank", "noopener");
    else if (act === "del") { await delBlobs(["a:" + k]); S.have.delete(k); s.own = false; await putSong(s); render(); }
  };
}
let audioFor = null;
$("audioFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; const s = song(audioFor); if (!f || !s) return;
  try { await putBlob("a:" + s.key, f); } catch (err) { return toast("Couldn't save it - is the phone full?"); }
  S.have.add(s.key); s.own = true; s.size = f.size; await putSong(s);
  toast(`Added "${f.name}"`); render(); if (!$("rate").hidden) drawRate();
};

/* ---------- downloads ---------- */
async function fetchSong(k) {
  const s = song(k); if (!s || S.have.has(k) || !s.audio) return true;
  try {
    const r = await fetch(s.audio); if (!r.ok) throw new Error(r.status);
    const b = await r.blob(); await putBlob("a:" + k, b);
    s.size = b.size; s.noDl = false; S.have.add(k); await putSong(s);
    fetchCover(s); return true;
  } catch (err) {
    if (err && err.name === "QuotaExceededError") throw err;
    s.noDl = true; await putSong(s); return false;
  }
}
async function fetchCover(s) {
  if (!s.cover || S.covers.has(s.cover) || fetchCover.busy.has(s.cover)) return;
  fetchCover.busy.add(s.cover);
  try { const r = await fetch(s.cover); if (r.ok) { const b = await r.blob(); await putBlob("c:" + s.cover, b); S.covers.set(s.cover, URL.createObjectURL(b)); } } catch (e) { /* online later */ }
  fetchCover.busy.delete(s.cover);
}
fetchCover.busy = new Set();
async function downloadList(id, quiet) {
  const l = listById(id); if (!l || D.has(id)) return;
  if (!navigator.onLine) return toast("You're offline - connect to download.");
  try { if (navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
  const keys = ranked(l).filter(k => !S.have.has(k) && song(k).audio);
  if (!keys.length) return quiet || toast("Everything here is saved.");
  const d = {done: 0, total: keys.length, failed: 0, stop: false}; D.set(id, d); render();
  const work = async () => {
    while (keys.length && !d.stop) {
      const k = keys.shift();
      try { if (!(await fetchSong(k))) d.failed++; } catch (err) { d.stop = true; toast("The phone is out of space for downloads.", 5000); }
      d.done++; renderSoon();
    }
  };
  await Promise.all([work(), work(), work()]);
  D.delete(id); render();
  if (!d.stop) toast(d.failed ? `Saved ${d.done - d.failed}. ${d.failed} can only stream - add an audio file for those.` : `Saved ${plural(d.done, "song")}`, 4000);
}

/* ---------- rate mode ---------- */
const R = {keys: [], i: 0};
function openRate(keys, startKey) {
  if (!keys.length) return toast("No songs here.");
  R.keys = keys;
  R.i = startKey != null ? Math.max(keys.indexOf(startKey), 0) : Math.max(keys.findIndex(k => song(k).score == null), 0);
  openLayer("rate"); drawRate(true);
}
function drawRate(play) {
  const k = R.keys[R.i], s = song(k), yt = !S.have.has(k) && !s.audio && navigator.onLine && ytId(s);
  $("rCount").textContent = `Rating · ${R.i + 1} of ${R.keys.length}`;
  tint(s);
  $("rBody").innerHTML = `<div class="rart">${img(s, "")}${yt ? `<iframe src="https://www.youtube.com/embed/${yt}?autoplay=1&rel=0&playsinline=1" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>` : ""}</div>
    <div class="rinfo"><div class="ptitle">${esc(s.songName)}</div><div class="psub">${esc(subOf(s))}</div>
      <div class="sub" style="margin-top:4px">${esc([s.songType, s.vintage].filter(Boolean).join(" · "))}</div></div>
    ${yt ? "" : canPlay(k) ? `<div class="rplay"><button class="icon big" id="rPlay" aria-label="Play or pause"></button>
        <input type="range" id="rSeek" min="0" max="1000" value="0" aria-label="Seek"><span class="rtime" id="rTime">0:00</span></div>`
      : `<div class="rnote">Not saved on this phone. <button class="btn" id="rFile" style="margin-top:10px">${ic("file")} Add an audio file</button></div>`}
    <div class="rform"><label for="rScore">Your score</label>
      <input id="rScore" inputmode="decimal" placeholder="0 – 10" autocomplete="off" value="${esc(fmtScore(s.score))}">
      <div class="err" id="rErr"></div>
      <label for="rNote">Note</label><textarea id="rNote" placeholder="Optional">${esc(s.note || "")}</textarea>
      <div class="rbtns"><button class="btn" id="rPrev" ${R.i ? "" : "disabled"}>Back</button>
        <button class="btn primary" id="rNext">${R.i < R.keys.length - 1 ? "Next" : "Done"}</button></div></div>`;
  if (play && !yt && canPlay(k)) { P.queue = [k]; P.i = 0; P.single = true; P.order = null; P.from = "rating"; load(true); }
  else if (play) media.pause();
  drawPlayState();
}
async function saveRate() {
  const s = song(R.keys[R.i]), raw = $("rScore").value.trim().replace(",", "."), note = $("rNote").value.trim();
  let score = s.score;
  if (raw === "") score = null;
  else { const n = Number(raw); if (!isFinite(n) || n < 0 || n > 10) { $("rErr").textContent = "Type a score from 0 to 10, like 8.5"; return false; } score = Math.round(n * 100) / 100; }
  if (score !== s.score || note !== (s.note || "")) { s.score = score; s.note = note; s.changed = now(); await putSong(s); badge(); if (P.key === s.key) drawPlayer(); }
  return true;
}
$("rBody").addEventListener("click", async e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.id === "rPlay") toggle();
  else if (t.id === "rFile") { audioFor = R.keys[R.i]; $("audioFile").click(); }
  else if (t.id === "rNext" || t.id === "rPrev") {
    if (!(await saveRate())) return;
    if (t.id === "rPrev") { R.i--; return drawRate(true); }
    if (R.i < R.keys.length - 1) { R.i++; drawRate(true); } else { toast("All rated - nice"); back(); }
  }
});
$("rBody").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "rScore") { e.preventDefault(); $("rNext").click(); } });

/* ---------- sync ---------- */
$("importFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  let data; try { data = JSON.parse(await f.text()); } catch (err) { return toast("That file isn't from the PC app."); }
  if (!data || data.format !== "nick-anisong-phone" || !Array.isArray(data.songs)) {
    return toast(data && data.format === "nick-anisong-phone-scores" ? "That's a file for the PC - open it there with Import." : "That file isn't from the PC app's Send to phone.", 4000);
  }
  let kept = 0;
  for (const p of data.songs) {
    if (!p || !p.key) continue;
    const old = song(p.key), s = {...(old || {}), ...p, score: p.score ?? null, note: p.note || ""};
    delete s.updated;
    if (old && old.changed && old.changed > (p.updated || 0)) { s.score = old.score; s.note = old.note; s.changed = old.changed; kept++; }  // your phone change is newer
    else s.changed = 0;
    s.own = old ? old.own : false; S.songs.set(s.key, s); await putSong(s);
  }
  const fresh = [];
  for (const p of data.playlists || []) {
    const l = {id: p.id, name: p.name, all: !!p.all, isFolder: !!p.isFolder, folder: p.folder || "", items: p.songs || [], orderChanged: 0};
    const i = S.lists.findIndex(x => x.id === l.id); if (i >= 0) S.lists[i] = l; else S.lists.push(l);
    await putList(l); fresh.push(l.id);
  }
  sortLists();
  S.tab = "lists"; S.list = null; S.path = ""; render(); badge();
  toast(`Imported ${plural(fresh.length, "playlist")}` + (kept ? ` · kept ${kept} newer phone scores` : "") + (navigator.onLine ? " - saving songs…" : ""), 4000);
  [...S.songs.values()].forEach(fetchCover);
  if (navigator.onLine) for (const id of fresh) await downloadList(id, true);
};
async function exportScores() {
  const songs = [...S.songs.values()].filter(s => s.changed).map(s => ({key: s.key, score: s.score, note: s.note || "", changed: s.changed}));
  const orders = S.lists.filter(l => l.orderChanged).map(l => ({id: l.id, keys: ranked(l)}));
  if (!songs.length && !orders.length) return toast("You haven't rated anything on the phone yet.");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "");
  const file = new File([JSON.stringify({format: "nick-anisong-phone-scores", version: 1, exported: now(), songs, orders})],
                        `AniSong phone scores ${stamp}.json`, {type: "application/json"});
  try {
    if (navigator.canShare && navigator.canShare({files: [file]})) await navigator.share({files: [file], title: "AniSong scores"});
    else { const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
  } catch (err) { if (err.name === "AbortError") return; toast("Couldn't share it - try again."); return; }
  S.lastExport = now(); store("lastExport", S.lastExport); badge(); render();
  toast("Open that file in the PC app with Import.", 4000);
}

/* ---------- taps ---------- */
$("tabs").onclick = e => {
  const b = e.target.closest("[data-tab]"); if (!b) return;
  const depth = (S.list != null ? 1 : 0) + (S.path ? S.path.split(" / ").length : 0);
  S.list = null; S.path = ""; if (depth) history.go(-depth);
  S.tab = b.dataset.tab; render(); window.scrollTo(0, 0);
};
$("back").onclick = back;
$("view").addEventListener("click", async e => {
  const t = e.target;
  const play = t.closest("[data-play]");
  if (play) return playQueue(CTX[play.dataset.play] || [], 0, !!play.dataset.shuffle, play.dataset.play.startsWith("list") ? listById(S.list)?.name : S.tab === "ranked" ? "Ranked" : "Library");
  const dir = t.closest("[data-dir]"); if (dir) { S.rankDir = dir.dataset.dir; return render(); }
  const min = t.closest("[data-min]"); if (min) { S.rankMin = +min.dataset.min; return render(); }
  const path = t.closest("[data-path]"); if (path) { S.path = path.dataset.path; history.pushState({layer: "path"}, ""); render(); return window.scrollTo(0, 0); }
  const card = t.closest("[data-list]"); if (card) { S.list = +card.dataset.list; history.pushState({layer: "list"}, ""); render(); return window.scrollTo(0, 0); }
  const row = t.closest(".song");
  if (row) {
    const k = row.dataset.key;
    if (t.closest("[data-more]")) return songMenu(k);
    const nudge = t.closest("[data-nudge]"); if (nudge) return nudgeSong(k, +nudge.dataset.nudge);
    const ctx = CTX[row.dataset.ctx] || [k], playable = ctx.filter(canPlay);
    if (!canPlay(k)) return songMenu(k);
    return playQueue(playable, playable.indexOf(k), false, row.dataset.ctx.startsWith("list") ? listById(S.list)?.name : row.dataset.ctx === "ranked" ? "Ranked" : "Library");
  }
  const id = t.closest("button") && t.closest("button").id;
  if (id === "importBtn") $("importFile").click();
  else if (id === "exportBtn") exportScores();
  else if (id === "installBtn") { installPrompt.prompt(); installPrompt = null; render(); }
  else if (id === "dlAll") { for (const l of S.lists) await downloadList(l.id, true); }
  else if (id === "rateBtn") openRate(ranked(listById(S.list)));
  else if (id === "dlList") downloadList(S.list);
  else if (id === "dlStop") { const d = D.get(S.list); if (d) d.stop = true; }
  else if (id === "listMore") listMenu(S.list);
});
$("view").addEventListener("input", e => { if (e.target.id === "q") { S.q = e.target.value; render.focus = true; render(); render.focus = false; } });
$("view").addEventListener("change", e => { if (e.target.id === "rankScope") { S.rankScope = e.target.value; render(); } });
async function nudgeSong(k, step) {
  const l = listById(S.list), keys = ranked(l), i = keys.indexOf(k), j = i + step;
  if (j < 0 || j >= keys.length || song(keys[j]).score !== song(k).score) return;
  [keys[i], keys[j]] = [keys[j], keys[i]];
  l.items = keys.map((key, n) => [key, n]).concat(l.items.filter(([key]) => !S.songs.has(key)));
  l.orderChanged = now(); await putList(l); badge(); render();
}
function listMenu(id) {
  const l = listById(id), got = l.items.filter(([k]) => S.have.has(k)).length;
  menu(`<div class="mhead"><div class="meta"><div class="t">${esc(l.name)}</div><div class="s">${plural(l.items.length, "song")}</div></div></div>
    ${got ? mi("undl", "trash", `Remove ${plural(got, "download")}`, "danger") : ""}${mi("drop", "x", "Remove from this phone", "danger")}`);
  $("menu").onclick = async e => {
    const a = e.target.closest("[data-act]"); if (!a) return;
    const act = a.dataset.act; back();
    const keys = l.items.map(([k]) => k);
    if (act === "undl") {
      if (!confirm(`Remove ${plural(got, "downloaded song")}? Songs that are also in other playlists lose their download too.`)) return;
      await delBlobs(keys.map(k => "a:" + k)); keys.forEach(k => { S.have.delete(k); const s = song(k); if (s) { s.own = false; putSong(s); } }); render();
    } else if (act === "drop") {
      if (!confirm(`Remove "${l.name}" from this phone? Your PC keeps it.`)) return;
      S.lists = S.lists.filter(x => x.id !== id); await tx("lists", "readwrite", st => st.delete(id));
      const still = new Set(S.lists.flatMap(x => x.items.map(([k]) => k)));
      const gone = keys.filter(k => !still.has(k) && !(song(k) && song(k).changed > S.lastExport));  // keep unsent scores
      await delBlobs(gone.map(k => "a:" + k)); await tx("songs", "readwrite", st => gone.forEach(k => st.delete(k)));
      gone.forEach(k => { S.have.delete(k); S.songs.delete(k); });
      setTimeout(() => { if (S.list === id) back(); }, 50);
    }
  };
}

$("miniOpen").onclick = $("miniCover").onclick = openPlayer;
$("miniPlay").onclick = $("pPlay").onclick = toggle;
$("miniNext").onclick = $("pNext").onclick = () => next(false);
$("pPrev").onclick = prev;
$("pShuffle").onclick = () => setShuffle(!P.shuffle);
$("pRepeat").onclick = () => { P.repeat = {off: "all", all: "one", one: "off"}[P.repeat]; drawPlayer(); toast({all: "Repeat all", one: "Repeat this song", off: "Repeat off"}[P.repeat]); };
$("pQueueBtn").onclick = () => { const q = $("pQueue").hidden; $("pQueue").hidden = !q; $("pMain").hidden = q; $("pQueueBtn").classList.toggle("on", q); if (q) drawQueue(); };
$("pScore").onclick = () => { if (P.key) openRate([P.key], P.key); };
$("pMore").onclick = () => { if (P.key) songMenu(P.key); };
$("pSleep").onclick = () => {
  menu(`<div class="mhead"><div class="meta"><div class="t">Sleep timer</div></div></div>` +
       [[0, "Off"], [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], ["end", "End of this song"]].map(([v, n]) =>
         `<button class="mi" data-sleep="${v}">${ic("moon")}${n}</button>`).join(""));
  $("menu").onclick = e => { const b = e.target.closest("[data-sleep]"); if (!b) return; back(); setSleep(b.dataset.sleep === "end" ? "end" : +b.dataset.sleep); };
};
$("player").addEventListener("click", e => {
  if (e.target.closest("[data-back]")) return back();
  const del = e.target.closest("[data-qdel]");
  if (del) { P.queue.splice(+del.dataset.qdel, 1); return drawQueue(); }
  const row = e.target.closest(".song"); if (!row) return;
  if (e.target.closest("[data-more]")) return songMenu(row.dataset.key);
  const i = P.queue.indexOf(row.dataset.key, P.i); if (i > P.i) { P.i = i; load(true); }
});
$("rate").addEventListener("click", e => { if (e.target.closest("[data-back]")) back(); });
let seeking = false;
document.addEventListener("input", e => { if (e.target.id === "pSeek" || e.target.id === "rSeek") { seeking = true; fill(e.target); } });
document.addEventListener("change", e => {
  if (e.target.id === "pSeek" || e.target.id === "rSeek") { const d = media.dur; if (d) media.time = d * e.target.value / 1000; seeking = false; }
});
window.addEventListener("online", renderSoon); window.addEventListener("offline", renderSoon);

let installPrompt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; if (S.tab === "sync") render(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
boot().catch(err => { $("view").innerHTML = `<div class="empty"><b>Couldn't open the app's storage</b>${esc(err && err.message)}</div>`; });
