const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const SEASON_NUM = {Winter: 0, Spring: 1, Summer: 2, Fall: 3};

const view = (id, sort) => ({id, list: [], shown: [], sort, genres: new Set(), theme: "", text: "", selected: new Set()});
const S = view("s", {key: "anime", dir: 1});   // search results
const P = view("p", {key: "rank", dir: 1});    // open playlist
P.kind = "own";
const ALL_ID = 0;
const isFriend = () => P.kind === "friend", isAll = () => P.kind === "all" || P.kind === "folder";  // folders are read-only like All songs
const mineOf = s => isFriend() ? s.mine : s.score;  // your own score for a row
const state = {playlists: [], current: null, library: {}, ffmpeg: false, season: "", year: 0, queue: [], qi: -1, busy: false,
               loadedSeason: "", video: false, focusKey: null};

async function api(path, opts = {}) {
  if (opts.body && !(opts.body instanceof FormData)) { opts.body = JSON.stringify(opts.body); opts.headers = {"Content-Type": "application/json"}; }
  let r;
  try { r = await fetch(path, opts); } catch (e) { throw new Error("Can't reach the app - is it still running?"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Something went wrong (${r.status})`);
  return data;
}
async function poll(jobId, onTick) {
  while (true) {
    await new Promise(r => setTimeout(r, 800));
    const j = await api("/api/jobs/" + jobId);
    if (j.state === "running") { onTick?.(j); continue; }
    if (j.state === "error") throw new Error(j.error);
    return j;
  }
}
let toastTimer;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.style.display = "none", 4500);
}

const sourceOf = s => s.source || (s.custom ? "custom" : "anisongdb");
const isNew = s => ["animethemes", "mal"].includes(sourceOf(s));
const typeCode = t => /^op/i.test(t) ? "OP" : /^ed/i.test(t) ? "ED" : /^custom/i.test(t) ? "CU" : "IN";
const shortType = t => (t || "").replace(/^Opening/, "OP").replace(/^Ending/, "ED").replace(/^Insert Song/, "Insert");
const ytId = s => { const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/.exec((s && s.link) || ""); return m ? m[1] : null; };
const srcOf = s => s.audio || s.mq || s.hq || (ytId(s) ? "yt:" + ytId(s) : "");  // YouTube-only songs play through YouTube's player
const fmtLen = n => n ? Math.floor(n / 60) + ":" + String(Math.round(n % 60)).padStart(2, "0") : "";
const fmtScore = n => n == null ? "–" : String(+n.toFixed(2));
const seasonNum = v => { const m = /(\w+)\s+(\d{4})/.exec(v || ""); return m ? +m[2] * 4 + (SEASON_NUM[m[1]] ?? 0) : 0; };
const segValue = id => $(id).querySelector(".on").dataset.v;
const setSeg = (id, v) => $(id).querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
const byRank = (a, b) => (a.score == null) - (b.score == null) || (b.score ?? 0) - (a.score ?? 0) || (a.pos ?? a.added) - (b.pos ?? b.added);
const avgOf = list => list.length ? list.reduce((t, s) => t + s.score, 0) / list.length : null;

document.querySelectorAll(".seg").forEach(seg => seg.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  if (seg.id === "segSeason") freshHint();
}));
$("types").onclick = e => { const b = e.target.closest(".chip"); if (b) b.classList.toggle("on"); };
document.querySelectorAll("dialog [data-close]").forEach(b => b.onclick = () => b.closest("dialog").close());

/* ---------- lists: filter, sort, render bits ---------- */
const SORTS = {
  song: s => s.songName.toLowerCase(), artist: s => s.artist.toLowerCase(), anime: s => s.anime.toLowerCase(),
  season: s => seasonNum(s.vintage), length: s => s.length || 0, added: s => s.added || 0, mine: s => s.mine ?? -1,
  type: s => "OPEDINCU".indexOf(typeCode(s.songType)) * 100 + (parseInt(s.songType.replace(/\D/g, "")) || 0),
};
function rated(s) { return state.library[s.key]?.score != null; }
function visible(v) {
  const txt = v.text.trim().toLowerCase();
  const list = v.list.filter(s =>
    [...v.genres].every(g => (s.genres || []).includes(g)) &&
    (!v.theme || (s.tags || []).includes(v.theme)) &&
    (!txt || [s.songName, s.artist, s.anime, s.animeJP, s.composer, s.note].some(x => (x || "").toLowerCase().includes(txt))) &&
    !(v === S && $("hideRated").checked && rated(s)));
  const {key, dir} = v.sort;
  if (key === "rank" || key === "score") list.sort((a, b) => dir > 0 ? byRank(a, b) : byRank(b, a));
  else { const f = SORTS[key]; list.sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; }); }
  return list;
}
function head(v, cols) {
  $(v.id + "Head").innerHTML = "<tr>" + cols.map(([label, key]) => {
    if (!key) return `<th>${label}</th>`;
    const on = v.sort.key === key;
    return `<th class="sortable ${on ? "sorted" : ""}" data-sort="${key}">${label} ${on ? (v.sort.dir > 0 ? "▲" : "▼") : ""}</th>`;
  }).join("") + "</tr>";
}
function facets(v) {
  const el = $(v.id + "Facets");
  const genres = [...new Set(v.list.flatMap(s => s.genres || []))].sort();
  const themes = [...new Set(v.list.flatMap(s => s.tags || []))].sort();
  [...v.genres].forEach(g => genres.includes(g) || v.genres.delete(g));
  if (!themes.includes(v.theme)) v.theme = "";
  el.hidden = !v.list.length;
  el.innerHTML = `
    <div class="row" style="align-items:flex-start;gap:18px 26px">
      <div class="field grow" style="min-width:280px"><div class="label">Genre</div>
        <div class="chips">${genres.map(g => `<button type="button" class="chip ${v.genres.has(g) ? "on" : ""}" data-genre="${esc(g)}">${esc(g)}</button>`).join("") || `<span class="sub">No genres loaded yet</span>`}</div></div>
      <div class="field"><label class="label" for="${v.id}Theme">Theme</label>
        <select id="${v.id}Theme" data-theme><option value="">Any theme</option>${themes.map(t => `<option ${t === v.theme ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></div>
      <div class="field"><label class="label" for="${v.id}Text">Filter this list</label>
        <input type="search" id="${v.id}Text" data-text placeholder="Type to narrow…" value="${esc(v.text)}" style="width:210px"></div>
      ${v.genres.size || v.theme || v.text ? `<div class="field"><div class="label">&nbsp;</div><button type="button" class="btn" data-clear>Clear filters</button></div>` : ""}
    </div>`;
}
function wireFacets(v, render) {
  const el = $(v.id + "Facets");
  el.addEventListener("click", e => {
    const g = e.target.closest("[data-genre]");
    if (g) { v.genres.has(g.dataset.genre) ? v.genres.delete(g.dataset.genre) : v.genres.add(g.dataset.genre); facets(v); render(); }
    if (e.target.closest("[data-clear]")) { v.genres.clear(); v.theme = ""; v.text = ""; facets(v); render(); }
  });
  el.addEventListener("change", e => { if (e.target.matches("[data-theme]")) { v.theme = e.target.value; facets(v); render(); } });
  el.addEventListener("input", e => { if (e.target.matches("[data-text]")) { v.text = e.target.value; render(); } });
  $(v.id + "Head").addEventListener("click", e => {
    const th = e.target.closest("[data-sort]"); if (!th) return;
    v.sort = {key: th.dataset.sort, dir: v.sort.key === th.dataset.sort ? -v.sort.dir : 1}; render();
  });
}

const coverCell = (s, i) => `<button class="cover ${s.coverSmall ? "" : "none"}" data-play="${i}" ${srcOf(s) ? "" : "disabled"}
    title="${srcOf(s) ? "Play" : "No audio for this one"}" aria-label="Play ${esc(s.songName)}"
    ${s.coverSmall ? `style="background-image:url('${esc(s.coverSmall)}')"` : ""}><span>&#9654;</span></button>`;
const pill = (kind, v, id) => v ? `<button type="button" class="pill" data-go="${kind}" data-v="${esc(v)}" data-id="${esc(id ?? "")}">${esc(v)}</button>` : "";
const artistPills = s => (s.artistList || []).length ? s.artistList.map(a => pill("artist", a.name, a.id)).join("") : pill("artist", s.artist);
function typeTags(s) {
  let h = `<span class="tag ${typeCode(s.songType)}">${esc(shortType(s.songType))}</span>`;
  if (sourceOf(s) === "animethemes") h += ` <span class="tag NEW" title="From AnimeThemes - swaps to the AniSongDB version once it's there">New</span>`;
  if (sourceOf(s) === "mal") h += ` <span class="tag MAL" title="From MyAnimeList - no audio until AnimeThemes or AniSongDB add it">No audio</span>`;
  return h;
}
function haveBadge(s) {
  const lib = state.library[s.key]; if (!lib) return "";
  const lists = lib.in || [], tip = (lib.score != null ? `Your score: ${fmtScore(lib.score)}\n` : "") + (lists.length ? "In: " + lists.join(", ") : "Not in a playlist");
  const where = lists.length ? `${esc(lists[0])}${lists.length > 1 ? ` +${lists.length - 1}` : ""}` : "rated";
  return `<span class="have ${lib.score == null ? "unrated" : ""}" title="${esc(tip)}">${lib.score == null ? "In" : "★ " + fmtScore(lib.score) + " ·"} ${where}</span>`;
}
const songCells = s => `
    <td>${pill("anime", s.anime, s.annId)}<div class="genres">${esc((s.genres || []).slice(0, 4).join(" · "))}</div></td>
    <td class="nowrap">${pill("season", s.vintage)}<div class="sub" style="margin-top:3px">${esc(s.animeType)}</div></td>
    <td>${typeTags(s)}</td>`;

/* ---------- menus ---------- */
let menuList = [];
function showMenu(btn, h, alignRight) {
  const m = $("menu"); m.innerHTML = h; m.hidden = false;
  const r = btn.getBoundingClientRect();
  const left = alignRight ? r.right - m.offsetWidth : r.left;
  m.style.left = Math.max(8, Math.min(left, innerWidth - m.offsetWidth - 8)) + "px";
  m.style.top = (r.bottom + m.offsetHeight + 8 > innerHeight - 90 ? r.top - m.offsetHeight - 6 : r.bottom + 6) + "px";
}
function downloadMenu(btn, s) {
  const name = `${s.anime} - ${shortType(s.songType)} - ${s.songName} (${s.artist})`;
  const link = (u, title, sub, mp4) => `<a href="/api/download?url=${encodeURIComponent(u)}&name=${encodeURIComponent(name)}${mp4 ? "&mp4=1" : ""}">${title}<small>${sub}</small></a>`;
  const ext = u => (u.split("?")[0].match(/\.(\w+)$/) || [, ""])[1].toUpperCase();
  const video = s.hq || s.mq;
  let h = "";
  if (s.audio) h += link(s.audio, `${ext(s.audio) || "Audio"} audio`, "Just the song");
  if (video && state.ffmpeg) h += link(video, "MP4 video", "Converted on your PC, takes a few seconds", true);
  if (s.hq) h += link(s.hq, sourceOf(s) === "anisongdb" ? "WebM video · 720p" : "WebM video", "Original file");
  if (s.mq) h += link(s.mq, "WebM video · 480p", "Smaller file");
  if (video && !state.ffmpeg) h += `<div>Install ffmpeg for MP4 (winget install Gyan.FFmpeg)</div>`;
  showMenu(btn, h || `<div>No files for this song yet.</div>`, true);
}
function shareMenu(btn) {
  const base = `/api/playlists/${state.current}/`;
  showMenu(btn, `
    <a href="${base}share.html">Ranking page<small>One file with covers and scores - opens in any browser</small></a>
    <button type="button" data-topimg>Top 10 image<small>A picture for WhatsApp or socials</small></button>
    <a href="${base}export.json">Playlist file<small>A friend can load it with Import playlist</small></a>
    <a href="${base}export.csv">Spreadsheet (CSV)<small>Excel or Google Sheets</small></a>`);
}
document.addEventListener("click", e => {
  if (e.target.closest("#menu input")) return;
  const d = e.target.closest("[data-dl]");
  if (d) { e.stopPropagation(); return downloadMenu(d, menuList[+d.dataset.dl]); }
  if (e.target.closest("#plExport")) { e.stopPropagation(); return shareMenu($("plExport")); }
  if (e.target.closest("[data-topimg]")) topImage();
  $("menu").hidden = true;
});
addEventListener("scroll", () => $("menu").hidden = true, true);

// small hover tooltip for the stats charts
document.addEventListener("mousemove", e => {
  const t = e.target.closest("[data-tip]"), tip = $("tip");
  if (!t) { tip.hidden = true; return; }
  tip.textContent = t.dataset.tip; tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top = (e.clientY + 16) + "px";
});

/* ---------- sidebar ---------- */
async function loadPlaylists() {
  state.playlists = await api("/api/playlists");
  renderPlList();
  const cur = state.playlists.find(p => p.id === state.current);
  if (cur) $("plPin").innerHTML = cur.pinned ? "&#128204; Unpin" : "&#128204; Pin";
  const scope = $("statsScope").value;
  $("statsScope").innerHTML = `<option value="">All songs</option>` + folderTree().map(([p, depth]) =>
    `<option value="${p.id}">${"\u00a0\u00a0".repeat(depth)}${p.kind === "folder" ? "\u{1F4C1} " : ""}${esc(p.name)}</option>`).join("");
  if ([...$("statsScope").options].some(o => o.value === scope)) $("statsScope").value = scope;
}
const ownLists = () => state.playlists.filter(p => p.kind === "own");
async function loadLibrary() {
  try { state.library = await api("/api/library"); } catch (e) {}
}
// folders: open/closed state is remembered; folder ids are negative, like the server sends them
const openFolders = new Set((() => { try { return JSON.parse(localStorage.getItem("openFolders")) || []; } catch (e) { return []; } })());
function folderTree(onlyFolders) {  // [[item, depth]] in sidebar order, folders first at each level
  const out = [], kids = parent => state.playlists.filter(p => p.kind !== "all" && (p.folder ?? null) === parent && (!onlyFolders || p.kind === "folder"))
    .sort((a, b) => (b.kind === "folder") - (a.kind === "folder") || (b.pinned - a.pinned) || a.name.localeCompare(b.name));
  const walk = (parent, depth, seen) => kids(parent).forEach(p => {
    out.push([p, depth]);
    if (p.kind === "folder" && !seen.has(p.id)) walk(p.id, depth + 1, new Set([...seen, p.id]));
  });
  walk(null, 0, new Set());
  return out;
}
function renderPlList() {
  const f = $("plFilter").value.trim().toLowerCase();
  $("plFilter").hidden = state.playlists.length < 4;
  const avg = p => `<small title="${p.rated} of ${p.count} rated">${p.average == null ? p.count + " songs" : "avg " + fmtScore(p.average)}</small>`;
  const all = state.playlists.find(p => p.kind === "all");
  let rows = f ? state.playlists.filter(p => p.kind !== "all" && p.name.toLowerCase().includes(f)).map(p => [p, 0]) : folderTree();
  if (!f) {  // hide what's inside closed folders
    const hidden = new Set();
    rows = rows.filter(([p]) => {
      if (p.folder != null && (hidden.has(p.folder) || !openFolders.has(p.folder))) { hidden.add(p.id); return false; }
      return true;
    });
  }
  const pad = d => d ? ` style="padding-left:${d * 14}px"` : "";
  $("plList").innerHTML = (all && !f ? `<div class="plrow allrow"><button class="nav ${state.current === all.id ? "active" : ""}" data-pl="${all.id}">
         <span class="name">&#9733;&nbsp; ${esc(all.name)}</span>${avg(all)}</button></div>` : "")
    + rows.map(([p, d]) => p.kind === "folder"
      ? `<div class="plrow folderrow"${pad(d)}><button class="fold" data-fold="${p.id}" aria-label="Open or close ${esc(p.name)}">${openFolders.has(p.id) ? "&#9662;" : "&#9656;"}</button>
           <button class="nav ${state.current === p.id ? "active" : ""}" data-pl="${p.id}"><span class="name">&#128193; ${esc(p.name)}</span>${avg(p)}</button></div>`
      : `<div class="plrow"${pad(d)}><button class="nav ${state.current === p.id ? "active" : ""}" data-pl="${p.id}">
           <span class="name">${p.kind === "friend" ? `<span class="tag FRIEND">friend</span> ` : ""}${esc(p.name)}</span>${avg(p)}</button>
         <button class="pin ${p.pinned ? "on" : ""}" data-pin="${p.id}" title="${p.pinned ? "Unpin" : "Pin to top"}" aria-label="Pin ${esc(p.name)}">&#128204;</button></div>`).join("")
    || (f ? `<div class="sub" style="margin:0 12px">No matches.</div>` : "");
}
function reveal(id) {  // open the folders something sits in, so it's visible in the sidebar
  for (let p = state.playlists.find(x => x.id === id), n = 0; p && p.folder != null && n < 50; p = state.playlists.find(x => x.id === p.folder), n++)
    if (!openFolders.has(p.folder)) toggleFolder(p.folder, true);
}
function toggleFolder(id, open = !openFolders.has(id)) {
  open ? openFolders.add(id) : openFolders.delete(id);
  try { localStorage.setItem("openFolders", JSON.stringify([...openFolders])); } catch (e) {}
  renderPlList();
}
async function newFolder(parent = null) {
  const name = prompt("Folder name:"); if (!name || !name.trim()) return null;
  try {
    const f = await api("/api/folders", {method: "POST", body: {name, parent}});
    if (parent != null) openFolders.add(parent);
    await loadPlaylists(); return f.id;
  } catch (e) { toast(e.message); return null; }
}
function moveTo() {  // where should this playlist or folder live?
  const me = state.playlists.find(p => p.id === state.current); if (!me) return;
  const inside = new Set([me.id]);  // a folder can't go into itself or anything inside it
  folderTree(true).forEach(([p]) => { if (inside.has(p.folder)) inside.add(p.id); });
  const choices = folderTree(true).filter(([p]) => !inside.has(p.id));
  $("moveList").innerHTML = `<button class="pickitem ${me.folder == null ? "on" : ""}" data-to="">Top level (no folder)</button>`
    + choices.map(([p, d]) => `<button class="pickitem ${me.folder === p.id ? "on" : ""}" data-to="${p.id}" style="padding-left:${12 + d * 16}px">&#128193; ${esc(p.name)}</button>`).join("");
  $("moveTitle").textContent = `Move "${me.name}"`;
  $("moveDlg").showModal();
}
$("moveList").onclick = async e => {
  const b = e.target.closest("[data-to]"); if (!b) return;
  const to = b.dataset.to === "" ? null : +b.dataset.to;
  try { await api("/api/playlists/" + state.current, {method: "PATCH", body: {folder: to}}); } catch (err) { return toast(err.message); }
  $("moveDlg").close(); if (to != null) openFolders.add(to);
  await loadPlaylists(); refreshPlaylist();
};
$("moveNew").onclick = async () => {
  const id = await newFolder(); if (id == null) return;
  try { await api("/api/playlists/" + state.current, {method: "PATCH", body: {folder: id}}); } catch (err) { return toast(err.message); }
  $("moveDlg").close(); openFolders.add(id); await loadPlaylists(); refreshPlaylist();
};
$("plFilter").addEventListener("input", renderPlList);
async function newPlaylist(suggest = "") {
  const name = prompt("Playlist name:", suggest);
  if (!name || !name.trim()) return null;
  try { const p = await api("/api/playlists", {method: "POST", body: {name}}); await loadPlaylists(); reveal(p.id); return p.id; }
  catch (e) { toast(e.message); return null; }
}
async function togglePin(id) {
  const p = state.playlists.find(x => x.id === id); if (!p) return;
  try { await api("/api/playlists/" + id, {method: "PATCH", body: {pinned: !p.pinned}}); await loadPlaylists(); }
  catch (e) { toast(e.message); }
}
function show(which) {
  for (const v of ["Search", "Playlist", "Stats", "Import"]) $("view" + v).hidden = v.toLowerCase() !== which;
  if (which !== "playlist") state.current = null;
  $("navSearch").classList.toggle("active", which === "search");
  $("navStats").classList.toggle("active", which === "stats");
  renderPlList(); scrollTo(0, 0);
}
$("navSearch").onclick = () => { show("search"); renderSearch(); };
$("navStats").onclick = () => { show("stats"); loadStats(); };
$("newPl").onclick = async () => { const id = await newPlaylist(); if (id) openPlaylist(id); };
$("plList").onclick = e => {
  const pin = e.target.closest("[data-pin]"), b = e.target.closest("[data-pl]"), fold = e.target.closest("[data-fold]");
  if (fold) toggleFolder(+fold.dataset.fold);
  else if (pin) togglePin(+pin.dataset.pin);
  else if (b) { if (+b.dataset.pl < 0 && !openFolders.has(+b.dataset.pl)) toggleFolder(+b.dataset.pl, true); openPlaylist(+b.dataset.pl); }
};
$("newFolder").onclick = async () => { const id = await newFolder(); if (id != null) openPlaylist(id); };
$("plMove").onclick = moveTo;
$("importPl").onclick = () => { show("import"); if (!IMP.rows) resetImport(); };
$("impPick").onclick = () => $("importFile").click();
$("importFile").onchange = async e => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  if (/\.json$/i.test(file.name)) return importPlaylistFile(file);
  const form = new FormData(); form.append("file", file);
  readSheet(form);
};
async function importPlaylistFile(file) {
  let body;
  try { body = JSON.parse(await file.text()); } catch (err) { return toast("That file isn't a playlist from this app."); }
  if (body && body.format === "nick-anisong-phone-scores") return importPhoneScores(body);
  if (body && body.format === "nick-anisong-phone") return toast("That's the file for your phone - open it in the phone app.");
  try {
    const d = await api("/api/playlists/import", {method: "POST", body});
    toast(`Imported "${d.name}" (${d.added} songs)`); await loadLibrary(); openPlaylist(d.id);
  } catch (err) { toast(err.message); }
}

/* ---------- spreadsheet import ---------- */
const IMP = {name: "", sheets: [], sheet: 0, rows: null, items: [], filter: "all"};
const ROLE_NAMES = {ignore: "Ignore", anime: "Anime", song: "Song name", artist: "Artist", songartist: "Song + artist",
                    score: "Score", season: "Season", type: "Song type (OP/ED)", link: "YouTube link"};
function resetImport() {
  IMP.rows = null; IMP.items = [];
  $("impStart").hidden = false; $("impMap").hidden = true; $("impReview").hidden = true; $("impPaste").value = "";
  $("impLinkNote").textContent = "";
}
$("impRestart").onclick = resetImport;
$("impRestart2").onclick = resetImport;
$("impLinkGo").onclick = () => {
  const url = $("impLink").value.trim();
  if (!url) return toast("Paste a Google Sheets or YouTube Music playlist link first.");
  readSheet({url}, /youtu\.?be/i.test(url) ? "Reading the playlist…" : "Opening the sheet…");
};
$("impLink").addEventListener("keydown", e => { if (e.key === "Enter") $("impLinkGo").click(); });
$("impPasteGo").onclick = () => {
  const text = $("impPaste").value;
  if (!text.trim()) return toast("Paste some rows first.");
  readSheet({text, name: "Pasted rows"});
};
async function readSheet(body, waiting) {  // body: an uploaded file (FormData), {url} or {text}
  show("import");
  let d;
  if (waiting) { $("impLinkGo").disabled = true; $("impLinkNote").className = "status"; $("impLinkNote").textContent = waiting; }
  try {
    d = await api("/api/sheet/read", {method: "POST", body});
    $("impLinkNote").textContent = "";
  } catch (err) {
    if (waiting) { $("impLinkNote").className = "status err"; $("impLinkNote").textContent = err.message; } else toast(err.message);
    return;
  } finally { $("impLinkGo").disabled = false; }
  IMP.name = d.name; IMP.sheets = d.sheets; IMP.sheet = 0;
  $("impSheet").innerHTML = d.sheets.map((sh, i) => `<option value="${i}">${esc(sh.name)} (${sh.rows.length} rows)</option>`).join("");
  $("impSheetField").hidden = d.sheets.length < 2;
  useSheet(0);
  $("impStart").hidden = true; $("impMap").hidden = false; $("impReview").hidden = true;
}
$("impSheet").onchange = () => useSheet(+$("impSheet").value);
function useSheet(i) {
  const sh = IMP.sheets[i]; IMP.sheet = i; IMP.rows = sh.rows; IMP.roles = [...sh.guess.roles];
  $("impYear").value = sh.guess.year || ""; $("impOutOf").value = String(sh.guess.outOf || 10);
  $("impType").value = sh.guess.type || ""; $("impHeader").checked = !!sh.guess.header;
  drawPreview();
}
const isSeasonRow = row => { const f = row.filter(c => c.trim()); return f.length === 1 && /^\s*(winter|spring|summer|fall|autumn)\b[\s,\-]*((19|20)\d\d)?\s*$/i.test(f[0]); };
function drawPreview() {
  const rows = IMP.rows, header = $("impHeader").checked;
  const sample = rows.slice(0, header ? 13 : 12);
  $("impPreview").innerHTML = `<thead><tr>${IMP.roles.map((r, i) => `<th><select data-col="${i}" class="${r !== "ignore" ? "set" : ""}">${
      Object.entries(ROLE_NAMES).map(([k, v]) => `<option value="${k}" ${k === r ? "selected" : ""}>${v}</option>`).join("")}</select></th>`).join("")}</tr></thead>
    <tbody>${sample.map((row, n) => `<tr class="${header && n === 0 ? "headrow" : isSeasonRow(row) ? "seasonrow" : ""}">${row.map(c => `<td title="${esc(c)}">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  const data = rows.slice(header ? 1 : 0).filter(r => !isSeasonRow(r) && r.some(c => c.trim() && isNaN(+c)));
  $("impCount").textContent = `${data.length} rows${rows.length > sample.length ? `, showing the first ${sample.length}` : ""}`;
}
$("impHeader").onchange = drawPreview;
$("impPreview").addEventListener("change", e => {
  const col = e.target.dataset.col; if (col == null) return;
  const role = e.target.value;
  // one anime / score / song column at a time
  if (["anime", "score", "song", "songartist", "artist", "season", "type", "link"].includes(role))
    IMP.roles = IMP.roles.map((r, i) => r === role && i !== +col ? "ignore" : r);
  if (role === "songartist") IMP.roles = IMP.roles.map((r, i) => (r === "song" || r === "artist") && i !== +col ? "ignore" : r);
  if (role === "song" || role === "artist") IMP.roles = IMP.roles.map(r => r === "songartist" ? "ignore" : r);
  IMP.roles[+col] = role; drawPreview();
});
$("impMatch").onclick = async () => {
  if (!IMP.roles.some(r => r === "song" || r === "songartist")) return toast("Pick which column has the song names.");
  const mapping = {roles: IMP.roles, header: $("impHeader").checked, year: $("impYear").value, outOf: +$("impOutOf").value, type: $("impType").value};
  const j = await runMatch({rows: IMP.rows, mapping}, "Finding your songs");
  if (!j) return;
  IMP.items = j.items.map(it => ({...it, on: it.status === "found" || it.status === "notfound"}));
  IMP.paused = j.paused; IMP.filter = "all"; setSeg("impFilter", "all");
  $("impInto").innerHTML = `<option value="">New playlist</option>` + ownLists().map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("impName").value = IMP.name; $("impName").hidden = false;
  $("impMap").hidden = true; $("impReview").hidden = false;
  drawReview();
};
$("impFilter").addEventListener("click", e => { const b = e.target.closest("button"); if (b) { IMP.filter = b.dataset.v; drawReview(); } });
$("impInto").onchange = () => { $("impName").hidden = !!$("impInto").value; };
const inFilter = it => IMP.filter === "all" || (IMP.filter === "likely" ? it.status === "found" && (it.confidence === "likely" || it.confidence === "auto")
  : IMP.filter === "none" ? it.status === "notfound" : it.status === "unchecked");
function drawReview() {
  const all = IMP.items, count = st => all.filter(it => it.status === st).length;
  const found = count("found"), unsure = all.filter(it => it.status === "found" && (it.confidence === "likely" || it.confidence === "auto")).length;
  const missing = count("notfound"), unchecked = count("unchecked"), blank = count("blank");
  $("impStats").innerHTML = [["Rows", all.length], ["Found", found, true], ["Double-check", unsure], ["Not found", missing],
    ["Couldn't check", unchecked], ["Rated", all.filter(it => it.score != null).length]]
    .filter(([l, v]) => l !== "Couldn't check" || v)
    .map(([l, v, hi]) => `<div class="stat ${hi ? "hi" : ""}"><b>${v}</b><span>${l}</span></div>`).join("");
  let note = "";
  if (unchecked) note += `<b>${unchecked} row${unchecked === 1 ? "" : "s"} couldn't be checked</b> - ${IMP.paused ? "AniSongDB turns off its song search during AMQ ranked games" : "AniSongDB didn't answer in time"}. They're left out for now. <button class="btn sm" id="impRetry">&#8635; Try these again</button> `;
  const auto = `<button class="btn sm" id="impAuto">&#10024; Auto-pick ${missing + unchecked}</button>`;
  if (missing) note += `Songs that weren't found come in as custom songs with your score - use <b>Find</b> to pick the real one, or ${auto} to take the closest match for each. `;
  else if (unchecked) note += `Or ${auto} to take the closest match for each. `;
  if (blank) note += `${blank} row${blank === 1 ? " has" : "s have"} no song name and will be skipped.`;
  $("impNote").innerHTML = note;
  const list = all.filter(inFilter);
  const fmtRaw = it => it.score == null ? (it.rawScore ? `<span class="sub" title="Not a score out of ${$("impOutOf").value}">${esc(it.rawScore)}?</span>` : "–")
    : fmtScore(it.score) + (String(it.rawScore) !== String(it.score) ? `<div class="sub">${esc(it.rawScore)}</div>` : "");
  $("impRows").innerHTML = list.map(it => {
    const i = IMP.items.indexOf(it), m = it.match;
    const theirs = `<div class="title">${esc(it.song || "(no song name)")}</div><div class="sub">${esc([it.artist, it.anime].filter(Boolean).join(" · "))}${it.season ? ` · ${esc(it.season)}` : ""}</div>`;
    const find = it.song ? `<button class="btn sm" data-find="${i}">&#128269; ${m ? "Change" : "Find"}</button>` : "";
    let ours;
    if (m) {
      const tag = it.confidence === "picked" ? `<span class="tag PICKED">picked</span>` : it.confidence === "auto" ? `<span class="tag LIKELY" title="Auto-picked - the closest match, worth a look">auto</span>`
        : it.confidence === "likely" ? `<span class="tag LIKELY" title="Close but not exact - worth a look">check</span>` : "";
      ours = `<div class="found"><div class="cover ${m.coverSmall ? "" : "none"}" ${m.coverSmall ? `style="background-image:url('${esc(m.coverSmall)}')"` : ""}></div>
        <div><div class="title">${esc(m.songName)} ${tag}</div>
        <div class="sub">${esc(m.artist)} · ${esc(m.anime)} · ${esc(shortType(m.songType))} · ${esc(m.vintage)}</div>
        <div class="impact">${find}${it.confidence === "picked" ? `<button class="btn sm" data-unpick="${i}">Undo</button>` : ""}</div></div></div>`;
    } else if (it.status === "unchecked") {
      ours = `<span class="tag UNCHECKED">Couldn't check</span><div class="impact">${find}</div>`;
    } else if (it.song) {
      ours = `<span class="tag MISS">Not found</span> <span class="sub">adds as a custom song${it.link ? " with its YouTube link" : ""}</span>
        <div class="impact">${it.link ? `<button class="btn sm" data-yt="${i}">&#9654; Play</button>` : ""}${find}</div>`;
    } else ours = `<span class="sub">Skipped</span>`;
    return `<tr class="${it.on ? "" : "off"}"><td><input type="checkbox" class="chkbox" data-imp="${i}" ${it.on ? "checked" : ""} ${it.song ? "" : "disabled"} aria-label="Include"></td>
      <td class="sub">${it.row}</td><td>${theirs}</td><td class="nowrap">${fmtRaw(it)}</td><td>${ours}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">Nothing in this group.</td></tr>`;
  $("impAll").checked = list.some(it => it.song) && list.filter(it => it.song).every(it => it.on);
  $("impGo").textContent = `⇧ Import ${all.filter(it => it.on).length}`;
}
$("impRows").addEventListener("change", e => {
  const i = e.target.dataset.imp; if (i == null) return;
  IMP.items[+i].on = e.target.checked; drawReview();
});
$("impRows").addEventListener("click", e => {
  const f = e.target.closest("[data-find]"), u = e.target.closest("[data-unpick]"), y = e.target.closest("[data-yt]");
  if (y) { const it = IMP.items[+y.dataset.yt]; playQueue([{key: "yt-" + it.row, songName: it.song, artist: it.artist, anime: it.anime, link: it.link, custom: true}], 0); }
  if (f) openFind(+f.dataset.find);
  if (u) { const it = IMP.items[+u.dataset.unpick]; Object.assign(it, it.before || {match: null, confidence: null, status: "notfound"}); drawReview(); }
});
$("impAll").onchange = e => {
  const on = e.target.checked;
  IMP.items.filter(it => it.song && inFilter(it)).forEach(it => it.on = on);
  drawReview();
};
async function runMatch(body, title, path = "/api/sheet/match", payload = null) {
  setBusy(true); overlay(true, title, "Each song gets checked against AniSongDB, so big sheets take a minute or two.");
  const job = busyJob = {cancelled: false};
  try {
    job.id = (await api(path, {method: "POST", body: payload || body})).job;
    const j = await poll(job.id, j => {
      if (job.cancelled) throw new Error("cancelled");
      $("busyStep").textContent = j.step + (j.total ? ` (${j.done} of ${j.total})` : "");
      $("busyBar").parentElement.classList.toggle("indeterminate", !j.total);
      $("busyBar").style.width = j.total ? `${Math.round(j.done / j.total * 100)}%` : "0";
    });
    if (job.cancelled) throw new Error("cancelled");
    return j;
  } catch (err) { if (err.message !== "cancelled") toast(err.message); return null; }
  finally { if (busyJob === job) { busyJob = null; overlay(false); setBusy(false); } }
}
$("impNote").addEventListener("click", async e => {
  if (e.target.closest("#impAuto")) return autoPick();
  if (!e.target.closest("#impRetry")) return;
  const retry = IMP.items.filter(it => it.status === "unchecked");
  const j = await runMatch({items: retry.map(({match, confidence, status, on, checked, before, ...rest}) => rest)}, `Trying ${retry.length} rows again`);
  if (!j) return;
  const byRow = new Map(j.items.map(it => [it.row, it]));
  IMP.items = IMP.items.map(it => {
    const n = byRow.get(it.row); if (!n) return it;
    return {...it, match: n.match, confidence: n.confidence, status: n.status, on: n.status !== "unchecked"};
  });
  IMP.paused = j.paused;
  const still = IMP.items.filter(it => it.status === "unchecked").length;
  toast(still ? `${retry.length - still} sorted, ${still} still couldn't be checked.` : "All checked.");
  drawReview();
});

async function autoPick() {
  const open = it => it.status === "notfound" || it.status === "unchecked";
  const rows = IMP.items.filter(open);
  const j = await runMatch({}, `Auto-picking ${rows.length} songs`, "/api/sheet/autopick",
    {items: rows.map(({match, confidence, status, on, checked, before, ...rest}) => rest)});
  if (!j) return;
  const byRow = new Map(j.items.filter(x => x.match).map(x => [x.row, x.match]));
  IMP.items.forEach(it => {
    if (open(it) && byRow.has(it.row)) {
      it.before = {match: null, confidence: null, status: it.status};
      Object.assign(it, {match: byRow.get(it.row), confidence: "auto", status: "found", on: true});
    }
  });
  const left = IMP.items.filter(open).length;
  toast(`Picked ${byRow.size} - they're tagged "auto" so you can check them.` + (left ? ` ${left} had nothing close.` : "")
    + (j.paused ? " AniSongDB's song search was paused for AMQ ranked, so try again later for better picks." : ""));
  drawReview();
}

/* picking the right song by hand */
let findIdx = null, findList = [];
function openFind(i) {
  const it = IMP.items[i]; findIdx = i;
  $("findFor").textContent = `Row ${it.row}: "${it.song}"${it.artist ? ` by ${it.artist}` : ""}${it.anime ? ` · ${it.anime}` : ""}`;
  $("findQ").value = it.song; setSeg("findField", "song");
  $("findResults").innerHTML = ""; $("findNote").textContent = "";
  $("findDlg").showModal(); runFind();
}
async function runFind() {
  const it = IMP.items[findIdx], field = segValue("findField"), q = $("findQ").value.trim();
  if (!q) return;
  $("findNote").className = "status"; $("findNote").textContent = "Searching…"; $("findResults").innerHTML = "";
  try {
    const d = await api("/api/search", {method: "POST", body: {query: q, fields: [field], partial: true}});
    // closest to the row first: same title, then same anime, then same artist
    const norm = x => (x || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
    const close = (a, b) => !!a && !!b && (a === b || (Math.min(a.length, b.length) > 3 && (a.includes(b) || b.includes(a))));
    const rank = s => (close(norm(s.songName), norm(it.song)) ? 4 : 0)
      + (close(norm(s.anime), norm(it.animeClean)) || close(norm(s.animeJP), norm(it.animeClean)) ? 2 : 0)
      + (close(norm(s.artist), norm(it.artist)) ? 1 : 0);
    findList = d.songs.map((s, n) => [rank(s), n, s]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(x => x[2]).slice(0, 80);
    $("findNote").textContent = d.count ? (d.count > 80 ? `Showing 80 of ${d.count} - add a word or two to narrow it down.` : "")
      : `Nothing for "${q}". Try fewer words, or search by ${field === "anime" ? "song" : "anime"}.`;
    $("findResults").innerHTML = findList.map((s, n) => `<div class="pickrow">
      <button type="button" class="ib preview" data-preview="${n}" ${srcOf(s) ? "" : "disabled"} title="${srcOf(s) ? "Have a listen" : "No audio for this one"}" aria-label="Play ${esc(s.songName)}"></button>
      <button type="button" data-pick="${n}">
      <div class="cover ${s.coverSmall ? "" : "none"}" ${s.coverSmall ? `style="background-image:url('${esc(s.coverSmall)}')"` : ""}></div>
      <div><div class="t">${esc(s.songName)}</div><div class="sub">${esc(s.artist)} · ${esc(s.anime)} · ${esc(shortType(s.songType))} · ${esc(s.vintage)}</div></div></button></div>`).join("");
    markPreview();
  } catch (e) {
    // song/artist search is off during AMQ ranked; the anime's own song list still works
    if (/ranked/i.test(e.message) && field !== "anime" && it.animeClean) {
      setSeg("findField", "anime"); $("findQ").value = it.animeClean;
      await runFind();
      $("findNote").textContent = "Song search is off during AMQ ranked games, so here are the anime's songs instead.";
      return;
    }
    $("findNote").className = "status err"; $("findNote").textContent = e.message;
  }
}
$("findForm").onsubmit = e => { e.preventDefault(); runFind(); };
$("findField").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  const it = IMP.items[findIdx];
  $("findQ").value = b.dataset.v === "anime" ? (it.animeClean || it.anime) : b.dataset.v === "artist" ? it.artist : it.song;
  runFind();
});
// listen before picking: plays through the normal player, the icon shows which one is going
let previewing = false;
function markPreview() {
  const key = state.queue[state.qi]?.key, on = !audio.paused && !audio.ended;
  $("findResults").querySelectorAll("[data-preview]").forEach(b => {
    const s = findList[+b.dataset.preview], playing = on && s.key === key;
    b.innerHTML = playing ? ICON.pause : ICON.play;
    b.classList.toggle("on", playing);
  });
}
$("findResults").addEventListener("click", e => {
  const pv = e.target.closest("[data-preview]");
  if (pv) {
    const s = findList[+pv.dataset.preview];
    if (state.queue[state.qi]?.key === s.key && audio.getAttribute("src")) togglePlay();
    else { state.queue = [s]; state.qi = 0; playCurrent(); }
    previewing = true;
    return;
  }
  const b = e.target.closest("[data-pick]"); if (!b) return;
  const it = IMP.items[findIdx];
  if (it.confidence !== "picked") it.before = {match: it.match, confidence: it.confidence, status: it.status};
  Object.assign(it, {match: findList[+b.dataset.pick], confidence: "picked", status: "found", on: true});
  $("findDlg").close(); drawReview();
});
$("findDlg").addEventListener("close", () => { if (previewing) { audio.pause(); previewing = false; } });
$("findCustom").onclick = () => {
  const it = IMP.items[findIdx];
  Object.assign(it, {match: null, confidence: null, status: "notfound", on: true});
  $("findDlg").close(); drawReview();
};
$("impGo").onclick = async () => {
  const items = IMP.items.filter(it => it.on && it.song).map(it => it.match
    ? {song: it.match, score: it.score}
    : {custom: {name: it.song, artist: it.artist, anime: it.anime, link: it.link || ""}, score: it.score});
  if (!items.length) return toast("Nothing ticked to import.");
  const into = $("impInto").value;
  try {
    const d = await api("/api/sheet/import", {method: "POST", body: {items, into: into || null, name: $("impName").value}});
    toast(`Imported ${d.added} song${d.added === 1 ? "" : "s"} into "${d.name}"` + (d.duplicates ? ` · ${d.duplicates} were already there` : "")
      + (d.kept ? ` · kept your own score for ${d.kept} you'd already rated` : ""));
    resetImport(); await loadLibrary(); openPlaylist(d.id);
  } catch (err) { toast(err.message); }
};

/* ---------- search: reset, pills, suggestions ---------- */
let autoExact = false, pendingLookup = null;
function resetForm(clearResults) {
  $("q").value = ""; $("year").value = ""; $("animeType").value = "";
  setSeg("segField", "all"); setSeg("segSeason", "");
  document.querySelectorAll("#types .chip").forEach(c => c.classList.add("on"));
  ["exact", "dub", "rebroadcast"].forEach(id => $(id).checked = false);
  hideSug(); freshHint();
  if (clearResults) {
    S.list = []; S.selected.clear(); S.genres.clear(); S.theme = ""; S.text = ""; state.loadedSeason = "";
    $("searchStatus").className = "status"; $("searchStatus").textContent = ""; freshHint();
    facets(S); renderSearch(); $("q").focus();
  }
}
$("resetBtn").onclick = () => resetForm(true);
function goSearch(kind, value, id) {
  resetForm(false);
  pendingLookup = id && kind === "artist" ? {artistId: +id} : id && kind === "anime" ? {annId: +id} : null;
  if (kind === "season") {
    const m = /(\w+)\s+(\d{4})/.exec(value); if (!m) return;
    setSeg("segSeason", m[1]); $("year").value = m[2]; freshHint();
  } else {
    $("q").value = value; setSeg("segField", kind);
    if (kind === "anime") { $("exact").checked = true; autoExact = true; }
    if (kind === "artist") $("exact").checked = true;  // "Eve" shouldn't bring up "Steve"
  }
  show("search"); $("searchForm").requestSubmit();
}
document.addEventListener("click", e => { const b = e.target.closest("[data-go]"); if (b) goSearch(b.dataset.go, b.dataset.v, b.dataset.id); });

const sug = $("suggest"); let sugItems = [], sugIdx = -1, sugTimer, sugSeq = 0;
function hideSug() { sugSeq++; clearTimeout(sugTimer); sug.hidden = true; sugItems = []; sugIdx = -1; }
function drawSug() {
  sug.hidden = !sugItems.length;
  sug.innerHTML = sugItems.map((x, i) => `<button type="button" data-i="${i}" class="${i === sugIdx ? "hi" : ""}"><span>${esc(x.name)}</span><small>${esc(x.kind)}</small></button>`).join("");
}
function pickSug(x) { $("q").value = x.name; setSeg("segField", x.kind); hideSug(); $("searchForm").requestSubmit(); }
$("q").addEventListener("input", () => {
  clearTimeout(sugTimer);
  const q = $("q").value.trim();
  if (q.length < 2) return hideSug();
  sugTimer = setTimeout(async () => {
    const seq = ++sugSeq;
    try {
      const d = await api(`/api/suggest?q=${encodeURIComponent(q)}&field=${segValue("segField")}`);
      if (seq === sugSeq && document.activeElement === $("q")) { sugItems = d; sugIdx = -1; drawSug(); }
    } catch (e) {}
  }, 200);
});
$("q").addEventListener("keydown", e => {
  if (sug.hidden || !sugItems.length) return;
  const n = sugItems.length;
  if (e.key === "ArrowDown") { e.preventDefault(); sugIdx = (sugIdx + 1) % n; drawSug(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); sugIdx = sugIdx <= 0 ? n - 1 : sugIdx - 1; drawSug(); }
  else if (e.key === "Enter" && sugIdx >= 0) { e.preventDefault(); pickSug(sugItems[sugIdx]); }
  else if (e.key === "Escape") hideSug();
});
sug.addEventListener("mousedown", e => { const b = e.target.closest("[data-i]"); if (b) { e.preventDefault(); pickSug(sugItems[+b.dataset.i]); } });
$("q").addEventListener("blur", () => setTimeout(() => { sug.hidden = true; }, 150));

/* ---------- search ---------- */
function formBody() {
  const field = segValue("segField");
  return {
    query: $("q").value, season: segValue("segSeason"), year: $("year").value,
    fields: field === "all" ? ["anime", "song", "artist", "composer"] : [field],
    partial: !$("exact").checked, dub: $("dub").checked, rebroadcast: $("rebroadcast").checked,
    types: [...document.querySelectorAll("#types .on")].map(c => c.dataset.v),
    animeTypes: $("animeType").value ? [$("animeType").value] : [],
  };
}
function setBusy(on) {
  state.busy = on;
  $("searchBtn").disabled = on;
  freshHint();
}
function showResults(songs) {
  state.loadedSeason = "";
  S.list = songs; S.selected.clear(); S.genres.clear(); S.theme = ""; S.text = "";
  facets(S); renderSearch();
}
$("searchForm").onsubmit = async e => {
  e.preventDefault();
  if (state.busy) return;
  hideSug();
  const body = formBody();
  if (!body.types.length) return toast("Pick at least one song type.");
  const st = $("searchStatus"); st.className = "status"; st.textContent = "Searching…";
  setBusy(true);
  try {
    const lookup = pendingLookup; pendingLookup = null;
    let d = await api("/api/search", {method: "POST", body: {...body, ...lookup}});
    if (!d.count && autoExact) { $("exact").checked = false; d = await api("/api/search", {method: "POST", body: {...body, partial: true}}); }
    autoExact = false;
    st.dataset.label = "";
    showResults(d.songs);
    if (d.artPending) toast(`Covers for ${d.artPending} anime are still loading - search again in a minute.`);
  } catch (err) { st.className = "status err"; st.textContent = err.message; autoExact = false; }
  setBusy(false);
};

function freshTarget() {
  const season = segValue("segSeason"), year = $("year").value;
  return season && year ? `${season} ${year}` : `${state.season} ${state.year}`;
}
function freshHint() {
  const target = freshTarget(), loaded = target === state.loadedSeason;
  $("freshHint").textContent = loaded ? `${target} is loaded` : `Fills in ${target} from AnimeThemes and MyAnimeList`;
  $("freshBtn").disabled = loaded || state.busy;
}
$("year").addEventListener("input", freshHint);
let busyJob = null;
function overlay(on, title, hint = "") {
  $("busy").hidden = !on;
  if (on) { $("busyTitle").textContent = title; $("busyHint").textContent = hint; $("busyStep").textContent = "Starting…"; $("busyBar").style.width = "0"; $("busyBar").parentElement.classList.add("indeterminate"); }
}
$("busyCancel").onclick = () => {
  if (busyJob) api(`/api/jobs/${busyJob.id}/cancel`, {method: "POST"}).catch(() => {});
  if (busyJob) busyJob.cancelled = true;
  busyJob = null;
  overlay(false); setBusy(false);
};
$("freshBtn").onclick = async () => {
  if (state.busy) return;
  const body = formBody();
  if (!!body.season !== !!body.year) return toast(body.season ? "Pick a year too." : "Pick a season too.");
  if (!body.types.length) return toast("Pick at least one song type.");
  if (!body.season) { body.season = state.season; body.year = state.year; }
  const target = `${body.season} ${body.year}`;
  setBusy(true); overlay(true, `Loading ${target}`, "The first load of a season takes up to a minute. After that it's quick.");
  const job = busyJob = {cancelled: false};
  try {
    job.id = (await api("/api/fresh", {method: "POST", body})).job;
    const j = await poll(job.id, j => {
      if (job.cancelled) throw new Error("cancelled");
      $("busyStep").textContent = j.step + (j.total ? ` (${j.done} of ${j.total})` : "");
      const bar = $("busyBar");
      bar.parentElement.classList.toggle("indeterminate", !j.total);
      bar.style.width = j.total ? `${Math.round(j.done / j.total * 100)}%` : "0";
    });
    if (job.cancelled) throw new Error("cancelled");
    const c = j.counts || {};
    $("searchStatus").className = "status";
    $("searchStatus").dataset.label = ` for ${j.season} · ${c.anisongdb || 0} from AniSongDB, ${c.animethemes || 0} new from AnimeThemes, ${c.mal || 0} without audio`;
    showResults(j.songs || []);
    state.loadedSeason = target;
    if (j.warnings?.length) toast(j.warnings.join(". ") + ".");
  } catch (err) {
    if (err.message !== "cancelled") { $("searchStatus").className = "status err"; $("searchStatus").textContent = err.message; }
  }
  if (busyJob === job) { busyJob = null; overlay(false); setBusy(false); }
};

function renderSearch() {
  const list = visible(S); menuList = list; S.shown = list;
  head(S, [[`<input type="checkbox" class="chkbox" id="selAll" aria-label="Select all">`], [""], ["Song", "song"],
           ["Artist", "artist"], ["Anime", "anime"], ["Season", "season"], ["Type", "type"], [""]]);
  const st = $("searchStatus");
  if (S.list.length && st.className === "status") {
    st.innerHTML = `<b>${list.length}</b> song${list.length === 1 ? "" : "s"}` + (list.length !== S.list.length ? ` of ${S.list.length}` : "")
      + esc(st.dataset.label || "") + (S.selected.size ? ` · ${S.selected.size} selected` : "");
  }
  $("sRows").innerHTML = list.map((s, i) => `
    <tr data-key="${esc(s.key)}">
      <td><input type="checkbox" class="chkbox sel" data-key="${esc(s.key)}" ${S.selected.has(s.key) ? "checked" : ""} aria-label="Select"></td>
      <td>${coverCell(s, i)}</td>
      <td><div class="title">${esc(s.songName)}</div><div class="sub">${fmtLen(s.length)}</div>${haveBadge(s)}</td>
      <td>${artistPills(s)}</td>${songCells(s)}
      <td><div class="actions">${srcOf(s) ? `<button class="btn sm" data-dl="${i}">&#8681; Download ▾</button>` : ""}</div></td>
    </tr>`).join("") || `<tr><td colspan="8" class="empty">${S.list.length ? "Nothing matches those filters." : "Search for something, or load a season."}</td></tr>`;
  if (list.length && list.every(s => S.selected.has(s.key))) $("selAll").checked = true;
  markPlaying();
}
$("hideRated").onchange = renderSearch;
$("sRows").addEventListener("change", e => {
  if (!e.target.matches(".sel")) return;
  e.target.checked ? S.selected.add(e.target.dataset.key) : S.selected.delete(e.target.dataset.key); renderSearch();
});
$("sHead").addEventListener("change", e => {
  if (e.target.id !== "selAll") return;
  const on = e.target.checked;
  S.shown.forEach(s => on ? S.selected.add(s.key) : S.selected.delete(s.key)); renderSearch();
});
$("sRows").addEventListener("click", e => { const b = e.target.closest("[data-play]"); if (b) playQueue(S.shown, +b.dataset.play); });
function pickPlaylist(btn, songs) {
  if (!songs.length) return toast("Nothing to add - tick some songs first.");
  const draw = filter => {
    const f = filter.trim().toLowerCase();
    return ownLists().filter(p => !f || p.name.toLowerCase().includes(f)).map(p =>
      `<button type="button" data-addto="${p.id}"><span>${p.pinned ? "&#128204; " : ""}${esc(p.name)}</span><small>${p.count} songs</small></button>`).join("")
      || `<div>No playlist called that.</div>`;
  };
  showMenu(btn, `<div class="menuhead">Add ${songs.length} song${songs.length === 1 ? "" : "s"} to…</div>
    ${ownLists().length > 5 ? `<input type="search" id="pickFilter" placeholder="Find a playlist…">` : ""}
    <div class="plpick">${draw("")}</div>
    <button type="button" data-addto="new"><b>+ New playlist…</b></button>`, true);
  $("pickFilter")?.focus();
  $("pickFilter")?.addEventListener("input", e => { $("menu").querySelector(".plpick").innerHTML = draw(e.target.value); });
  pendingAdd = songs;
}
let pendingAdd = [], pendingAfter = null;
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-addto]"); if (!b) return;
  const songs = pendingAdd; pendingAdd = [];
  let pid = b.dataset.addto;
  if (pid === "new") {
    const guess = [segValue("segSeason"), $("year").value, ...S.genres].filter(Boolean).join(" ");
    pid = await newPlaylist(guess); if (!pid) return;
  }
  const name = state.playlists.find(p => p.id === +pid)?.name || "";
  try {
    const d = await api(`/api/playlists/${pid}/songs`, {method: "POST", body: {songs}});
    toast(`Added ${d.added} to "${name}"` + (d.skipped ? ` · ${d.skipped} were already there` : "")
      + (d.carried ? ` · ${d.carried} already rated` : ""));
    if (pendingAfter) pendingAfter(); else S.selected.clear();
    pendingAfter = null;
    await Promise.all([loadPlaylists(), loadLibrary()]);
    if (!$("viewPlaylist").hidden) refreshPlaylist(); else renderSearch();
  } catch (err) { toast(err.message); }
});
$("addSel").onclick = e => { e.stopPropagation(); pickPlaylist($("addSel"), S.list.filter(s => S.selected.has(s.key))); };
$("addAll").onclick = e => { e.stopPropagation(); pickPlaylist($("addAll"), S.shown); };

/* ---------- playlist ---------- */
async function openPlaylist(id, keepFilters) {
  let d;
  try { d = await api("/api/playlists/" + id); } catch (e) { toast(e.message); return loadPlaylists(); }
  const same = keepFilters && state.current === id;
  state.current = id;
  P.list = d.songs; P.kind = d.kind;
  if (!same) { P.genres.clear(); P.theme = ""; P.text = ""; P.sort = {key: "rank", dir: 1}; P.selected.clear(); $("dlStatus").hidden = true; }
  const keys = new Set(P.list.map(s => s.key));
  [...P.selected].forEach(k => keys.has(k) || P.selected.delete(k));
  $("plName").textContent = d.name;
  $("plKind").innerHTML = d.kind === "all" ? "Every song in your playlists, plus anything you've rated. It fills itself in."
    : d.kind === "folder" ? "Every song in the playlists inside this folder, ranked together. It fills itself in."
    : d.kind === "friend" ? "A friend's playlist: their scores and notes, with yours alongside. Rating here only changes your score." : "";
  // what you can do depends on the kind of list
  ["plPin", "plRename", "plDelete"].forEach(b => $(b).hidden = d.kind === "all");
  $("plPin").hidden = d.kind === "all" || d.kind === "folder"; $("plMove").hidden = d.kind === "all";
  $("addCustom").hidden = d.kind !== "own";
  if ($("viewPlaylist").hidden) show("playlist");
  state.current = id;
  await loadPlaylists();
  reveal(id); facets(P); renderPlaylist();
}
const refreshPlaylist = () => openPlaylist(state.current, true);
function renderPlaylist() {
  const list = visible(P); menuList = list; P.shown = list;
  const friend = isFriend(), all = isAll();
  const order = P.list.filter(s => s.score != null).sort(byRank);
  const rankOf = new Map(order.map((s, i) => [s.key, i + 1]));
  const avg = avgOf(order), mine = P.list.filter(s => s.mine != null);
  $("plStats").innerHTML = `
    <div class="stat hi"><b>${avg == null ? "–" : avg.toFixed(2)}</b><span>${friend ? "Their average" : "Average"}</span></div>
    ${friend ? `<div class="stat"><b>${mine.length ? (mine.reduce((t, s) => t + s.mine, 0) / mine.length).toFixed(2) : "–"}</b><span>Your average</span></div>` : ""}
    <div class="stat"><b>${P.list.length}</b><span>Songs</span></div>
    <div class="stat"><b>${friend ? mine.length : order.length}</b><span>${friend ? "You've rated" : "Rated"}</span></div>
    <div class="stat"><b>${order.length ? fmtScore(order[0].score) : "–"}</b><span>Highest</span></div>
    <div class="stat"><b>${order.length ? fmtScore(order[order.length - 1].score) : "–"}</b><span>Lowest</span></div>`;
  const shownRated = list.filter(s => s.score != null);
  $("plCount").textContent = list.length !== P.list.length
    ? `Showing ${list.length} of ${P.list.length}` + (shownRated.length ? ` · average of these ${avgOf(shownRated).toFixed(2)}` : "") : "";
  $("plMatch").hidden = !P.list.some(isNew);
  const left = P.list.filter(s => mineOf(s) == null).length;
  $("plRate").textContent = `★ Rate mode${left ? ` (${left} left)` : ""}`;
  const canNudge = !friend && P.sort.key === "rank" && P.sort.dir === 1;
  head(P, [[`<input type="checkbox" class="chkbox" id="pSelAll" aria-label="Select all shown">`], ["Rank", "rank"], [""], ["Song", "song"],
           ["Artist", "artist"], ["Anime", "anime"], ["Season", "season"], ["Type", "type"],
           ...(friend ? [["Theirs", "score"], ["Yours", "mine"]] : [["Score", "score"]]), [""]]);
  $("pRows").innerHTML = list.map((s, i) => {
    const r = rankOf.get(s.key);
    let tie = "";
    if (canNudge && r) {
      const up = order[r - 2]?.score === s.score, down = order[r]?.score === s.score;
      if (up || down) tie = `<span class="tie"><button data-move="-1" data-key="${esc(s.key)}" ${up ? "" : "disabled"} title="Move above the song with the same score">▲</button><button data-move="1" data-key="${esc(s.key)}" ${down ? "" : "disabled"} title="Move below">▼</button></span>`;
    }
    const link = s.custom && /^https?:\/\//i.test(s.link || "") ? `<a class="btn sm" href="${esc(s.link)}" target="_blank" rel="noopener noreferrer">Open &#8599;</a>` : "";
    const box = v => `<input type="number" class="score" min="0" max="10" step="any" value="${v ?? ""}" placeholder="–" data-score="${esc(s.key)}" aria-label="Your score">`;
    const note = friend ? (s.note ? `<div class="theirnote">“${esc(s.note)}”</div>` : "")
      : `<input class="note" data-note="${esc(s.key)}" value="${esc(s.note)}" placeholder="Add a note" maxlength="500" aria-label="Note">`;
    return `
    <tr data-key="${esc(s.key)}" class="${P.selected.has(s.key) ? "picked" : ""}">
      <td><input type="checkbox" class="chkbox psel" data-key="${esc(s.key)}" ${P.selected.has(s.key) ? "checked" : ""} aria-label="Select"></td>
      <td class="rank ${r && r <= 3 ? "top" : ""}">${r ? "#" + r : "–"}${tie}</td>
      <td>${coverCell(s, i)}</td>
      <td><div class="title">${esc(s.songName)}</div>${note}</td>
      <td>${artistPills(s)}</td>${songCells(s)}
      ${friend ? `<td><span class="theirs">${s.score == null ? "–" : fmtScore(s.score)}</span></td><td>${box(s.mine)}</td>` : `<td>${box(s.score)}</td>`}
      <td><div class="actions">${s.custom ? link : srcOf(s) ? `<button class="btn sm" data-dl="${i}">&#8681; ▾</button>` : ""}
          ${all ? "" : `<button class="btn sm danger" data-remove="${esc(s.key)}" title="Remove from playlist">&#10005;</button>`}</div></td>
    </tr>`; }).join("") || `<tr><td colspan="${friend ? 11 : 10}" class="empty">${P.list.length ? "Nothing matches those filters."
      : all ? "Nothing yet - songs show up here once they're in a playlist or rated." : "Empty - add songs from Search."}</td></tr>`;
  $("pSelAll").checked = list.length > 0 && list.every(s => P.selected.has(s.key));
  drawSelBar();
  markPlaying();
  if (state.focusKey) {
    const box = [...$("pRows").querySelectorAll(".score")].find(b => b.dataset.score === state.focusKey);
    state.focusKey = null;
    if (box) { box.focus(); box.select(); }
  }
}
function drawSelBar() {
  const n = P.selected.size;
  $("plSelBar").hidden = !n;
  if (!n) return;
  $("plSelCount").textContent = `${n} selected`;
  $("plSelRemove").hidden = isAll();
}
async function saveScore(key, value) {
  await api(`/api/playlists/${state.current}/songs/${encodeURIComponent(key)}`, {method: "PATCH", body: {score: value}});
  const v = value === "" || value == null ? null : Math.round(+value * 100) / 100;
  const s = P.list.find(x => x.key === key);
  if (s) { s.mine = v; if (!isFriend()) s.score = v; }
}
$("pRows").addEventListener("change", async e => {
  const key = e.target.dataset.score, nkey = e.target.dataset.note;
  if (e.target.matches(".psel")) {
    e.target.checked ? P.selected.add(e.target.dataset.key) : P.selected.delete(e.target.dataset.key);
    e.target.closest("tr").classList.toggle("picked", e.target.checked);
    $("pSelAll").checked = P.shown.length > 0 && P.shown.every(s => P.selected.has(s.key));
    return drawSelBar();
  }
  if (key) {
    try { await saveScore(key, e.target.value); renderPlaylist(); loadPlaylists(); loadLibrary(); }
    catch (err) { state.focusKey = null; toast(err.message); const s = P.list.find(x => x.key === key); e.target.value = s ? mineOf(s) ?? "" : ""; }
  }
  if (nkey) {
    try {
      await api(`/api/playlists/${state.current}/songs/${encodeURIComponent(nkey)}`, {method: "PATCH", body: {note: e.target.value}});
      const s = P.list.find(x => x.key === nkey); if (s) s.note = e.target.value.trim();
    } catch (err) { toast(err.message); }
  }
});
$("pHead").addEventListener("change", e => {
  if (e.target.id !== "pSelAll") return;
  P.shown.forEach(s => e.target.checked ? P.selected.add(s.key) : P.selected.delete(s.key));
  renderPlaylist();
});
$("pRows").addEventListener("keydown", e => {
  if (e.key === "Tab" && e.target.matches(".score")) {
    const boxes = [...$("pRows").querySelectorAll(".score")];
    const next = boxes[boxes.indexOf(e.target) + (e.shiftKey ? -1 : 1)];
    if (!next) return;
    e.preventDefault();
    const s = P.list.find(x => x.key === e.target.dataset.score);
    const changed = String(e.target.value) !== String((s ? mineOf(s) : null) ?? "");
    if (changed) { state.focusKey = next.dataset.score; e.target.blur(); }  // re-render puts focus back
    else { next.focus(); next.select(); }
    return;
  }
  if (e.key === "Enter" && e.target.matches("input")) e.target.blur();
});
$("pRows").addEventListener("click", async e => {
  const p = e.target.closest("[data-play]"), r = e.target.closest("[data-remove]"), m = e.target.closest("[data-move]");
  if (p) playQueue(P.shown, +p.dataset.play);
  if (r) removeSongs([r.dataset.remove]);
  if (m) {
    const key = m.dataset.key, dir = +m.dataset.move;
    try {
      await api(`/api/playlists/${state.current}/songs/${encodeURIComponent(key)}/move`, {method: "POST", body: {dir}});
      const order = P.list.filter(s => s.score != null).sort(byRank);
      const i = order.findIndex(s => s.key === key), other = order[i + dir];
      if (other) [order[i].pos, other.pos] = [other.pos, order[i].pos];
      renderPlaylist();
    } catch (err) { toast(err.message); }
  }
});
async function removeSongs(keys) {
  if (!keys.length) return;
  if (keys.length > 1 && !confirm(`Remove ${keys.length} songs from "${$("plName").textContent}"? Your scores are kept.`)) return;
  try {
    const d = await api(`/api/playlists/${state.current}/remove`, {method: "POST", body: {keys}});
    const gone = new Set(keys);
    P.list = P.list.filter(s => !gone.has(s.key)); keys.forEach(k => P.selected.delete(k));
    facets(P); renderPlaylist(); loadPlaylists(); loadLibrary();
    if (keys.length > 1) toast(`Removed ${d.removed} songs.`);
  } catch (err) { toast(err.message); }
}
$("plSelRemove").onclick = () => removeSongs([...P.selected]);
$("plSelClear").onclick = () => { P.selected.clear(); renderPlaylist(); };
$("plSelCopy").onclick = e => {
  e.stopPropagation();
  const songs = P.list.filter(s => P.selected.has(s.key));
  pickPlaylist($("plSelCopy"), songs);
  pendingAfter = () => { P.selected.clear(); };
};
$("plPin").onclick = () => togglePin(state.current);
$("plPlay").onclick = () => { const i = P.shown.findIndex(srcOf); i < 0 ? toast("Nothing here has audio.") : playQueue(P.shown, i); };
$("plRename").onclick = async () => {
  const name = prompt("New name:", $("plName").textContent); if (!name) return;
  try { await api("/api/playlists/" + state.current, {method: "PATCH", body: {name}}); refreshPlaylist(); }
  catch (e) { toast(e.message); }
};
$("plDelete").onclick = async () => {
  if (!confirm(state.current < 0 ? `Delete the folder "${$("plName").textContent}"? Only the folder goes: what's inside moves up a level.`
    : `Delete "${$("plName").textContent}"? Your scores stay (they're in All songs). Downloaded files stay too.`)) return;
  try { await api("/api/playlists/" + state.current, {method: "DELETE"}); } catch (e) { return toast(e.message); }
  show("search"); loadPlaylists(); loadLibrary(); renderSearch();
};
$("plMatch").onclick = async () => {
  const b = $("plMatch"); b.disabled = true; b.textContent = "Matching…";
  try {
    const {job} = await api("/api/match", {method: "POST"});
    const j = await poll(job, j => { b.textContent = `Matching… ${j.done}/${j.total}`; });
    toast(j.matched ? `Swapped ${j.matched} song${j.matched === 1 ? "" : "s"} for the AniSongDB version, scores kept.`
      : "AniSongDB doesn't have these yet - try again in a while.");
    await loadLibrary(); await refreshPlaylist();
  } catch (e) { toast(e.message); }
  b.disabled = false; b.innerHTML = "&#8635; Match new-season songs";
};
$("dlAll").onclick = async () => {
  const st = $("dlStatus");
  $("dlAll").disabled = true; st.hidden = false; st.className = "status"; st.textContent = "Starting…";
  try {
    const {job} = await api(`/api/playlists/${state.current}/download`, {method: "POST", body: {format: $("dlFormat").value}});
    const j = await poll(job, j => { st.textContent = `Downloading ${j.done}/${j.total}: ${j.current || ""}`; });
    st.textContent = `Done: ${j.saved} saved, ${j.skipped} already there` +
      (j.failed.length ? `, ${j.failed.length} failed (${j.failed.slice(0, 3).join("; ")}${j.failed.length > 3 ? "…" : ""})` : "") + `. ${j.folder}`;
    if (j.failed.length) st.className = "status err";
  } catch (e) { st.className = "status err"; st.textContent = e.message; }
  $("dlAll").disabled = false;
};
$("addCustom").onclick = () => { $("customForm").reset(); $("cErr").textContent = ""; $("customDlg").showModal(); $("cName").focus(); };
$("customForm").onsubmit = async e => {
  e.preventDefault();
  try {
    await api(`/api/playlists/${state.current}/custom`, {method: "POST", body: {
      name: $("cName").value, artist: $("cArtist").value, anime: $("cAnime").value, link: $("cLink").value, score: $("cScore").value}});
    $("customDlg").close(); refreshPlaylist();
  } catch (err) { $("cErr").textContent = err.message; }
};

/* ---------- rate mode ---------- */
// a normal video (or audio) player you control, your score next to it, Enter for the next song
const R = {list: [], i: 0};
$("plRate").onclick = () => {
  let list = P.shown.filter(s => mineOf(s) == null);
  if (!list.length) {
    if (!P.shown.length) return toast("Nothing to rate here.");
    if (!confirm("You've rated everything here. Go through them all again?")) return;
    list = [...P.shown];
  }
  R.list = list; R.i = 0;
  media.pause();
  $("rateDlg").showModal(); renderRate();
};
const rMedia = () => $("rMedia");
function stopRateMedia() {
  const m = rMedia(); if (!m) return;
  if (m.tagName === "IFRAME") return m.remove();
  m.pause(); m.removeAttribute("src"); m.load();
}
function renderRate() {
  stopRateMedia();
  const s = R.list[R.i];
  if (!s) {
    const done = R.list.filter(x => mineOf(x) != null);
    $("rateBody").innerHTML = `<h3>All done</h3><p class="sub">${done.length} of ${R.list.length} rated${done.length ? `, averaging ${(done.reduce((t, x) => t + mineOf(x), 0) / done.length).toFixed(2)}` : ""}.</p>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" data-close>Close</button></div>`;
    return;
  }
  const video = s.hq || s.mq, art = s.cover || s.coverSmall, mine = mineOf(s), yt = !video && !s.audio && ytId(s);
  const media = yt ? `<iframe id="rMedia" class="rvideo" src="https://www.youtube.com/embed/${yt}?autoplay=1&rel=0&playsinline=1"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`
    : video
    ? `<video id="rMedia" class="rvideo" controls autoplay playsinline preload="auto" src="${esc(video)}" ${art ? `poster="${esc(art)}"` : ""}></video>`
    : `<div class="rart ${art ? "" : "none"}" ${art ? `style="background-image:url('${esc(art)}')"` : ""}></div>`
      + (s.audio ? `<audio id="rMedia" class="raudio" controls autoplay preload="auto" src="${esc(s.audio)}"></audio>` : `<div class="sub">No audio for this one.</div>`);
  $("rateBody").innerHTML = `
    <div class="rate2">
      <div class="rmedia">${media}</div>
      <div class="rside">
        <div class="sub">${R.i + 1} of ${R.list.length} · ${esc(shortType(s.songType))}</div>
        <h3>${esc(s.songName)}</h3>
        <div class="who">${esc(s.artist)}</div>
        <div class="sub" style="margin-top:4px">${esc([s.anime, s.vintage].filter(Boolean).join(" · "))}</div>
        ${isFriend() && s.score != null ? `<div class="sub" style="margin-top:8px">Their score: <b>${fmtScore(s.score)}</b></div>` : ""}
        <div class="rscore">
          <input type="text" inputmode="decimal" id="rScore" value="${mine ?? ""}" placeholder="–" aria-label="Your score out of 10" autocomplete="off">
          <span class="sub">/ 10</span>
        </div>
        <div class="status err" id="rErr"></div>
        ${isFriend() ? "" : `<input type="text" class="rnote" id="rNote" placeholder="Note (optional)" maxlength="500" value="${esc(s.note || "")}">`}
        <button class="btn primary wide" type="button" id="rSave" style="margin-top:14px">Save &amp; next →</button>
        <div class="foot">
          <button class="btn sm" type="button" data-step="-1" ${R.i ? "" : "disabled"}>← Back</button>
          <button class="btn sm" type="button" data-step="1">Skip</button>
          <span class="grow"></span>
          <span class="sub"><kbd>Enter</kbd> save · <kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>`;
  const m = rMedia();
  if (m && m.tagName !== "IFRAME") {
    m.volume = audio.volume; m.muted = audio.muted;
    m.play().catch(() => {});  // some browsers want a click first; the controls are right there
  }
  $("rScore").focus(); $("rScore").select();
}
async function rateCurrent() {
  const s = R.list[R.i], box = $("rScore"), raw = box.value.trim().replace(",", ".");
  const v = raw === "" ? null : Number(raw);
  if (raw !== "" && (!isFinite(v) || v < 0 || v > 10)) {
    box.classList.add("bad"); $("rErr").textContent = "Scores go from 0 to 10, like 8 or 8.3."; box.focus(); return;
  }
  try {
    if (v !== mineOf(s)) await saveScore(s.key, v == null ? "" : v);
    const noteBox = $("rNote");
    if (noteBox && noteBox.value.trim() !== (s.note || "")) {
      const note = noteBox.value.trim();
      await api(`/api/playlists/${state.current}/songs/${encodeURIComponent(s.key)}`, {method: "PATCH", body: {note}});
      s.note = note;
    }
    R.i++; renderRate();
  } catch (e) { $("rErr").textContent = e.message; }
}
$("rateDlg").addEventListener("click", e => {
  const st = e.target.closest("[data-step]");
  if (e.target.closest("#rSave")) rateCurrent();
  if (st) { R.i = Math.max(0, R.i + +st.dataset.step); renderRate(); }
  if (e.target.closest("[data-close]")) $("rateDlg").close();
});
$("rateDlg").addEventListener("keydown", e => {
  if (!R.list[R.i]) return;
  if (e.key === "Enter" && (e.target.id === "rScore" || e.target.id === "rNote")) { e.preventDefault(); rateCurrent(); }
});
$("rateDlg").addEventListener("input", e => { if (e.target.id === "rScore") { e.target.classList.remove("bad"); $("rErr").textContent = ""; } });
$("rateDlg").addEventListener("close", () => {
  stopRateMedia();
  if (state.current != null) { facets(P); renderPlaylist(); loadPlaylists(); loadLibrary(); }
});

/* ---------- combining playlists ---------- */
function openCombine(preselect) {
  if (ownLists().length < 1) return toast("Make a playlist first.");
  const pick = new Set(preselect != null && preselect !== ALL_ID ? [preselect] : []);
  $("combineSearch").value = "";
  $("combineFrom").innerHTML = state.playlists.map(p => `<label class="pickitem" data-name="${esc(p.name.toLowerCase())}">
      <input type="checkbox" class="chkbox" value="${p.id}" ${pick.has(p.id) ? "checked" : ""}>
      <span class="pname">${p.kind === "all" ? "&#9733; " : ""}${esc(p.name)}</span>
      ${p.kind === "friend" ? `<span class="tag FRIEND">friend</span>` : ""}
      <span class="pcount">${p.count}</span></label>`).join("");
  $("combineInto").innerHTML = `<option value="">A new playlist</option>` + ownLists().map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("combineName").value = ""; $("combineErr").textContent = ""; $("combineNameField").hidden = false;
  comboCount(); $("combineDlg").showModal();
}
function comboCount() {
  const n = $("combineFrom").querySelectorAll("input:checked").length;
  $("combinePicked").textContent = n ? `${n} picked` : "None picked";
}
$("combineFrom").addEventListener("change", comboCount);
$("combineSearch").addEventListener("input", e => {
  const f = e.target.value.trim().toLowerCase();
  $("combineFrom").querySelectorAll(".pickitem").forEach(l => l.hidden = !!f && !l.dataset.name.includes(f));
});
$("combineAll").onclick = () => {
  const boxes = [...$("combineFrom").querySelectorAll(".pickitem:not([hidden]) input")];
  const on = !boxes.every(b => b.checked);
  boxes.forEach(b => b.checked = on); comboCount();
};
$("combineInto").onchange = () => { $("combineNameField").hidden = !!$("combineInto").value; };
$("combinePl").onclick = () => openCombine(state.current);
$("plCombine").onclick = () => openCombine(state.current);
$("combineForm").onsubmit = async e => {
  e.preventDefault();
  const into = $("combineInto").value;
  const sources = [...$("combineFrom").querySelectorAll("input:checked")].map(c => +c.value).filter(id => String(id) !== into);
  if (!sources.length) return $("combineErr").textContent = into ? "Pick a playlist other than the one you're adding to." : "Pick at least one playlist.";
  try {
    const d = await api("/api/playlists/combine", {method: "POST", body: {sources, into: into || null, name: $("combineName").value}});
    $("combineDlg").close();
    toast(`${d.added} song${d.added === 1 ? "" : "s"} added to "${d.name}"`);
    await loadLibrary(); openPlaylist(d.id);
  } catch (err) { $("combineErr").textContent = err.message; }
};

/* ---------- phone companion ---------- */
function phoneCount() {
  const n = $("phoneFrom").querySelectorAll("input:checked").length;
  $("phonePicked").textContent = n ? `${n} picked` : "None picked";
}
$("phonePl").onclick = () => {
  const lists = state.playlists.filter(p => p.kind !== "friend");
  $("phoneFrom").innerHTML = lists.map(p => `<label class="pickitem">
      <input type="checkbox" class="chkbox" value="${p.id}" ${p.kind === "own" ? "checked" : ""}>
      <span class="pname">${p.kind === "all" ? "&#9733; " : p.kind === "folder" ? "&#128193; " : ""}${esc(p.name)}</span><span class="pcount">${p.count}</span></label>`).join("");
  $("phoneErr").textContent = ""; phoneCount(); $("phoneDlg").showModal();
};
$("phoneFrom").addEventListener("change", phoneCount);
$("phoneAll").onclick = () => {
  const boxes = [...$("phoneFrom").querySelectorAll("input")], on = !boxes.every(b => b.checked);
  boxes.forEach(b => b.checked = on); phoneCount();
};
$("phoneForm").onsubmit = e => {
  e.preventDefault();
  const ids = [...$("phoneFrom").querySelectorAll("input:checked")].map(c => c.value);
  if (!ids.length) return $("phoneErr").textContent = "Pick at least one playlist.";
  location.href = "/api/phone/export?ids=" + ids.join(",");
  $("phoneDlg").close(); toast("Saved - send that file to your phone and open it with Import.");
};
async function importPhoneScores(body) {
  try {
    const d = await api("/api/phone/import", {method: "POST", body});
    toast(`Phone scores: ${d.took} updated` + (d.older ? `, ${d.older} already up to date` : "") + (d.gone ? `, ${d.gone} songs no longer here` : ""));
    await loadLibrary(); await loadPlaylists(); if (state.current != null) openPlaylist(state.current);
  } catch (err) { toast(err.message); }
}

/* ---------- top 10 image ---------- */
function loadImage(url) {
  return new Promise(resolve => {
    if (!url) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img); img.onerror = () => resolve(null);
    img.src = "/api/img?url=" + encodeURIComponent(url);
  });
}
function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  while (text.length > 1 && ctx.measureText(text + "…").width > max) text = text.slice(0, -1);
  return text.trimEnd() + "…";
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
let lastImage = null;
async function topImage() {
  const top = P.list.filter(s => s.score != null).sort(byRank).slice(0, 10);
  if (!top.length) return toast("Rate a few songs first.");
  toast("Drawing…");
  const covers = await Promise.all(top.map(s => loadImage(s.coverSmall || s.cover)));
  const W = 1080, rowH = 100, H = 250 + top.length * rowH + 90;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d"), font = '"Segoe UI", system-ui, sans-serif';
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#111a2e"); g.addColorStop(1, "#0a0e16");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#8f9bb3"; ctx.font = `600 26px ${font}`; ctx.fillText("Nick's ", 60, 80);
  const w1 = ctx.measureText("Nick's ").width;
  ctx.fillStyle = "#6ea8ff"; ctx.fillText("AniSong", 60 + w1, 80);
  ctx.fillStyle = "#8f9bb3"; ctx.fillText(" Ranker", 60 + w1 + ctx.measureText("AniSong").width, 80);
  ctx.fillStyle = "#eceff6"; ctx.font = `700 58px ${font}`; ctx.fillText(fit(ctx, $("plName").textContent, W - 120), 60, 150);
  const all = P.list.filter(s => s.score != null);
  ctx.fillStyle = "#8f9bb3"; ctx.font = `500 26px ${font}`;
  ctx.fillText(`Top ${top.length} · average ${avgOf(all).toFixed(2)} across ${all.length} rated`, 60, 196);
  top.forEach((s, i) => {
    const y = 240 + i * rowH;
    ctx.fillStyle = i < 3 ? "#16223c" : "#111622"; roundRect(ctx, 40, y, W - 80, rowH - 12, 18); ctx.fill();
    ctx.fillStyle = i < 3 ? "#ffc857" : "#8f9bb3"; ctx.font = `800 34px ${font}`; ctx.textAlign = "center";
    ctx.fillText(String(i + 1), 95, y + 56); ctx.textAlign = "left";
    ctx.save(); roundRect(ctx, 140, y + 8, 52, 72, 8); ctx.clip();
    if (covers[i]) {
      const img = covers[i], scale = Math.max(52 / img.width, 72 / img.height);
      ctx.drawImage(img, 166 - img.width * scale / 2, y + 44 - img.height * scale / 2, img.width * scale, img.height * scale);
    } else { ctx.fillStyle = "#232c40"; ctx.fillRect(140, y + 8, 52, 72); }
    ctx.restore();
    ctx.fillStyle = "#eceff6"; ctx.font = `700 30px ${font}`; ctx.fillText(fit(ctx, s.songName, 640), 214, y + 40);
    ctx.fillStyle = "#a8b3c9"; ctx.font = `400 22px ${font}`;
    ctx.fillText(fit(ctx, [s.artist, s.anime].filter(Boolean).join("  ·  "), 640), 214, y + 72);
    ctx.fillStyle = "#2f7af5"; roundRect(ctx, W - 180, y + 18, 100, 52, 14); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = `800 30px ${font}`; ctx.textAlign = "center";
    ctx.fillText(fmtScore(s.score), W - 130, y + 55); ctx.textAlign = "left";
  });
  ctx.fillStyle = "#5d6880"; ctx.font = `400 20px ${font}`; ctx.textAlign = "center";
  ctx.fillText(new Date().toLocaleDateString(undefined, {day: "numeric", month: "long", year: "numeric"}), W / 2, H - 36);
  lastImage = {canvas: c, name: $("plName").textContent};
  $("imagePreview").src = c.toDataURL("image/png");
  $("toast").style.display = "none";
  $("imageDlg").showModal();
}
$("imageSave").onclick = () => {
  if (!lastImage) return;
  lastImage.canvas.toBlob(blob => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${lastImage.name.replace(/[<>:"/\\|?*]/g, "_")} top 10.png`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, "image/png");
};

/* ---------- stats ---------- */
$("statsScope").onchange = loadStats;
async function loadStats() {
  $("statCards").innerHTML = `<div class="sub">Crunching…</div>`; $("statTiles").innerHTML = "";
  let d;
  try { d = await api("/api/stats" + ($("statsScope").value ? "?playlist=" + $("statsScope").value : "")); }
  catch (e) { $("statCards").innerHTML = `<div class="status err">${esc(e.message)}</div>`; return; }
  renderStats(d.entries, d.playlists, d.playlistAverages || [], d.folder);
}
function median(xs) { const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
function groupAvg(songs, keysOf, min = 1) {
  const g = new Map();
  for (const s of songs) for (const k of keysOf(s)) {
    if (!k) continue;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(s);
  }
  return [...g].filter(([, v]) => v.length >= min)
    .map(([label, v]) => ({label, value: avgOf(v), count: v.length, songs: v}));
}
function bars(rows, opts = {}) {
  if (!rows.length) return `<div class="empty-card">${opts.empty || "Not enough rated songs yet."}</div>`;
  return `<div class="bars">${rows.map(r => `
    <div class="lbl" title="${esc(r.label)}">${opts.go ? pill(opts.go, r.label) : esc(r.label)}</div>
    <div class="track" data-tip="${esc(`${r.label}: average ${r.value.toFixed(2)} over ${r.count} song${r.count === 1 ? "" : "s"}`)}"><i style="width:${Math.max(1, r.value * 10)}%"></i></div>
    <div class="val">${r.value.toFixed(2)}<small>${r.count}</small></div>`).join("")}</div>`;
}
function songList(list, from = 1, dir = 1) {
  if (!list.length) return `<div class="empty-card">Nothing yet.</div>`;
  return `<div class="songlist">${list.map((s, i) => `
    <div class="item"><span class="n">${from + i * dir}</span>
      <div class="cover ${s.coverSmall ? "" : "none"}" ${s.coverSmall ? `style="background-image:url('${esc(s.coverSmall)}')"` : ""}></div>
      <div><div class="t">${esc(s.songName)}</div><div class="sub">${esc([s.artist, s.anime].filter(Boolean).join(" · "))}</div></div>
      <span class="badge">${fmtScore(s.score)}</span></div>`).join("")}</div>`;
}
const card = (title, sub, body) => `<div class="card"><h3>${title}</h3><div class="sub">${sub}</div>${body}</div>`;
function renderStats(entries, playlistCount, playlistAverages, folder) {
  const scope = $("statsScope").value;
  const seen = new Set(), songs = entries.filter(e => e.score != null && !seen.has(e.key) && seen.add(e.key));
  const unrated = new Set(entries.filter(e => e.score == null).map(e => e.key)).size;
  if (!songs.length) {
    $("statTiles").innerHTML = "";
    $("statCards").innerHTML = `<div class="card empty-card">No rated songs ${scope ? "in this playlist" : ""} yet. Rate a few and come back.</div>`;
    return;
  }
  const scores = songs.map(s => s.score), avg = avgOf(songs);
  const sd = Math.sqrt(scores.reduce((t, x) => t + (x - avg) ** 2, 0) / scores.length);
  const secs = songs.reduce((t, s) => t + (s.length || 0), 0);
  $("statTiles").innerHTML = [
    ["Average", avg.toFixed(2), true], ["Median", fmtScore(median(scores))], ["Spread", "±" + sd.toFixed(2)],
    ["Rated", songs.length], ["Unrated", unrated], ["Perfect 10s", scores.filter(x => x === 10).length],
    [scope ? "Artists" : "Playlists", scope ? new Set(songs.map(s => s.artist)).size : playlistCount],
    ["Hours of music", secs ? (secs / 3600).toFixed(1) : "–"],
  ].map(([l, v, hi]) => `<div class="stat ${hi ? "hi" : ""}"><b>${v}</b><span>${l}</span></div>`).join("");

  const bins = Array.from({length: 11}, (_, n) => songs.filter(s => Math.floor(s.score) === n).length);
  const peak = Math.max(...bins, 1);
  const hist = `<div class="hist">${bins.map((c, n) => `<div data-tip="${c} song${c === 1 ? "" : "s"} scored ${n}${n < 10 ? "–" + (n + .5) : ""}"><b>${c || ""}</b><i style="height:${c / peak * 100}%"></i></div>`).join("")}</div>
    <div class="histx">${bins.map((_, n) => `<span>${n}</span>`).join("")}</div>`;

  const sortAvg = rows => rows.sort((a, b) => b.value - a.value || b.count - a.count);
  const types = sortAvg(groupAvg(songs, s => [({OP: "Openings", ED: "Endings", IN: "Insert songs", CU: "Custom"})[typeCode(s.songType)]]));
  const artists = sortAvg(groupAvg(songs, s => [s.artist], 2)).slice(0, 12);
  const prolific = groupAvg(songs, s => [s.artist]).sort((a, b) => b.count - a.count || b.value - a.value).slice(0, 8);
  const anime = sortAvg(groupAvg(songs, s => [s.anime], 2)).slice(0, 12);
  const genres = sortAvg(groupAvg(songs, s => s.genres || [], 2));
  const themes = sortAvg(groupAvg(songs, s => s.tags || [], 3)).slice(0, 12);
  const composers = sortAvg(groupAvg(songs, s => [s.composer], 2)).slice(0, 10);
  const years = groupAvg(songs, s => [(s.vintage || "").split(" ")[1]]).sort((a, b) => b.label - a.label).slice(0, 15);
  const seasons = groupAvg(songs, s => [(s.vintage || "").split(" ")[0]]).filter(r => r.label in SEASON_NUM)
    .sort((a, b) => SEASON_NUM[a.label] - SEASON_NUM[b.label]);
  const formats = sortAvg(groupAvg(songs, s => [s.animeType]));
  const lists = scope && !folder ? [] : sortAvg(playlistAverages.map(p => ({label: p.name, value: p.average, count: p.count})));
  const ranked = [...songs].sort((a, b) => b.score - a.score || a.songName.localeCompare(b.songName));
  const gems = songs.filter(s => s.difficulty != null && s.difficulty < 35 && s.score >= 8)
    .sort((a, b) => b.score - a.score || a.difficulty - b.difficulty).slice(0, 8);

  $("statCards").innerHTML = [
    card("Score spread", "How many songs landed on each score", hist),
    card("Openings vs endings", "Average score by song type", bars(types)),
    card("Your top 10", "Best-rated songs" + (scope ? " in this playlist" : ""), songList(ranked.slice(0, 10))),
    ranked.length > 10 ? card("Bottom 5", "Lowest-rated songs", songList(ranked.slice(-5).reverse(), ranked.length, -1)) : "",
    card("Favourite artists", "Highest average, two or more rated songs", bars(artists, {go: "artist"})),
    card("Most rated artists", "Who shows up the most", bars(prolific, {go: "artist"})),
    card("Favourite anime", "Highest average, two or more rated songs", bars(anime, {go: "anime"})),
    card("Genres", "Average score by genre, from AniList", bars(genres, {empty: "Genres load in from AniList as you search."})),
    card("Themes", "Average score by theme (three or more songs)", bars(themes, {empty: "Not enough themed songs yet."})),
    card("By year", "Average score by airing year", bars(years)),
    card("By season", "Winter, spring, summer or fall", bars(seasons)),
    card("By format", "TV, movies, OVAs…", bars(formats)),
    card("Composers", "Highest average, two or more rated songs", bars(composers, {empty: "Composer info only comes with AniSongDB songs."})),
    folder ? (lists.length ? card("Inside this folder", "Average score for each playlist and folder in it", bars(lists)) : "")
      : scope ? "" : card("Playlists", "Average score per playlist", bars(lists)),
    gems.length ? card("Obscure favourites", "Songs you rate 8+ that under 35% of AMQ players guess", songList(gems)) : "",
  ].join("");
}

/* ---------- player ---------- */
const audio = $("audio"), seek = $("seek"), vol = $("vol");
const ICON = {play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>', pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>'};
const fmtT = n => { n = Math.max(0, Math.floor(n || 0)); return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0"); };
const fill = (el, frac) => el.style.setProperty("--p", Math.max(0, Math.min(1, frac)) * 100 + "%");
const duration = () => YTP.on ? YTP.player?.getDuration?.() || 0
  : isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (state.queue[state.qi]?.length || 0);
let seeking = false;
const YTP = {player: null, ready: null, on: false, hidden: false, timer: 0};
function ytReady() {  // YouTube's player script, loaded the first time a YouTube-only song plays
  if (YTP.ready) return YTP.ready;
  return YTP.ready = new Promise((ok, fail) => {
    window.onYouTubeIframeAPIReady = ok;
    const sc = document.createElement("script"); sc.src = "https://www.youtube.com/iframe_api";
    sc.onerror = () => { YTP.ready = null; fail(new Error("offline")); }; document.head.appendChild(sc);
  }).then(() => new Promise(ok => {
    YTP.player = new YT.Player("ytFrame", {width: "100%", height: "100%",
      playerVars: {autoplay: 1, rel: 0, playsinline: 1, origin: location.origin},
      events: {onReady: ok, onStateChange: e => { setIcon(); if (e.data === 0) ended(); }, onError: e => ytFailed(e.data)}});
  }));
}
function ytFailed(code) {
  const s = state.queue[state.qi], id = ytId(s);
  $("videoNone").innerHTML = code === 101 || code === 150 || code === 153
    ? `This video can only play on YouTube. <a href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener">Open it there &#8599;</a>`
    : `YouTube couldn't play this one. <a href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener">Open on YouTube &#8599;</a>`;
  $("videoBox").classList.add("novideo");
}
const media = {  // whichever is playing: the normal player or YouTube's
  get paused() { return YTP.on ? ![1, 3].includes(YTP.player?.getPlayerState?.()) : audio.paused || audio.ended; },
  play() { YTP.on ? YTP.player?.playVideo?.() : audio.play().catch(() => {}); },
  pause() { YTP.on ? YTP.player?.pauseVideo?.() : audio.pause(); },
  get time() { return YTP.on ? YTP.player?.getCurrentTime?.() || 0 : audio.currentTime; },
  set time(t) { YTP.on ? YTP.player?.seekTo?.(t, true) : audio.currentTime = t; },
};
function setIcon() { const on = !media.paused; $("playBtn").innerHTML = on ? ICON.pause : ICON.play; $("playBtn").setAttribute("aria-label", on ? "Pause" : "Play"); }
function playQueue(list, i) { state.queue = list.filter(srcOf); state.qi = state.queue.indexOf(list[i]); playCurrent(); }
function markPlaying() {
  const key = state.queue[state.qi]?.key;
  document.querySelectorAll("tr[data-key]").forEach(r => r.classList.toggle("playing", r.dataset.key === key));
}
const videoOf = s => s.mq || s.hq;
const playSrc = s => state.video ? (videoOf(s) || s.audio) : srcOf(s);
function playCurrent() {
  const s = state.queue[state.qi]; if (!s) return;
  const src = playSrc(s), yt = src.startsWith("yt:");
  clearInterval(YTP.timer);
  if (YTP.on && !yt) YTP.player?.stopVideo?.();
  YTP.on = yt; YTP.hidden = false;
  $("videoNone").textContent = "No video for this one";
  if (yt) {
    audio.pause(); audio.removeAttribute("src"); audio.load();
    ytReady().then(() => { if (!YTP.on) return; YTP.player.loadVideoById(src.slice(3)); YTP.player.setVolume(audio.muted ? 0 : audio.volume * 100); })
      .catch(() => { toast("Couldn't reach YouTube - check your internet."); });
    YTP.timer = setInterval(tick, 500);
  } else { audio.src = src; audio.play().catch(() => {}); }
  showVideoFor(s);
  $("npSong").textContent = s.songName; $("npSub").textContent = [s.artist, s.anime, shortType(s.songType)].filter(Boolean).join(" · ");
  $("npCover").className = "cover" + (s.coverSmall ? "" : " none");
  $("npCover").style.backgroundImage = s.coverSmall ? `url('${s.coverSmall.replace(/'/g, "%27")}')` : "";
  seek.value = 0; fill(seek, 0); $("tCur").textContent = "0:00"; $("tDur").textContent = fmtT(s.length);
  markPlaying();
}
function step(d) { if (state.queue.length < 2) return; state.qi = (state.qi + d + state.queue.length) % state.queue.length; playCurrent(); }
function togglePlay() {
  if (!state.queue[state.qi]) {
    const list = (!$("viewPlaylist").hidden ? P.shown : S.shown) || [];
    const i = list.findIndex(srcOf);
    return i < 0 ? toast("Search for something or open a playlist first.") : playQueue(list, i);
  }
  media.paused ? media.play() : media.pause();
}
// video: the player is a <video> element, it just stays hidden in audio-only mode
function showVideoFor(s) {
  $("videoBox").hidden = YTP.on ? YTP.hidden : !state.video;
  $("videoBox").classList.toggle("yt", YTP.on);
  $("videoBox").classList.toggle("novideo", !!s && !YTP.on && !videoOf(s));
  $("videoTitle").textContent = s ? `${s.songName} · ${s.anime}` : "";
}
function setVideo(on) {
  state.video = on;
  try { localStorage.setItem("video", on ? "1" : ""); } catch (e) {}
  $("videoBtn").classList.toggle("on", on);
  $("videoBtn").title = on ? "Hide the video" : "Show the video";
  const s = state.queue[state.qi];
  showVideoFor(s);
  if (!s || YTP.on || !audio.getAttribute("src")) return;
  const want = playSrc(s);
  if (audio.src === new URL(want, location.href).href) return;
  const t = audio.currentTime, playing = !audio.paused;
  audio.src = want;
  audio.addEventListener("loadedmetadata", () => { audio.currentTime = Math.min(t, audio.duration || t); if (playing) audio.play().catch(() => {}); }, {once: true});
  audio.load();
}
$("videoBtn").onclick = () => setVideo(!state.video);
$("videoClose").onclick = () => { if (YTP.on) { YTP.hidden = true; $("videoBox").hidden = true; } else setVideo(false); };
$("videoBig").onclick = () => $("videoBox").classList.toggle("big");
$("playBtn").onclick = togglePlay; $("next").onclick = () => step(1); $("prev").onclick = () => step(-1);
audio.onplay = audio.onpause = () => { setIcon(); if ($("findDlg").open) markPreview(); };
function tick() {
  const d = duration(), t = media.time;
  if (!seeking) { seek.value = d ? t / d * 1000 : 0; fill(seek, d ? t / d : 0); }
  $("tCur").textContent = fmtT(t); $("tDur").textContent = fmtT(d);
}
audio.ontimeupdate = audio.ondurationchange = tick;
seek.oninput = () => { seeking = true; fill(seek, seek.value / 1000); $("tCur").textContent = fmtT(seek.value / 1000 * duration()); };
seek.onchange = () => { const d = duration(); if (d) media.time = seek.value / 1000 * d; seeking = false; };
function setVolume(v) {
  audio.volume = v; audio.muted = false; vol.value = v * 100; fill(vol, v); YTP.player?.setVolume?.(v * 100);
  try { localStorage.setItem("volume", v); } catch (e) {}
}
vol.oninput = () => setVolume(vol.value / 100);
$("mute").onclick = () => { audio.muted = !audio.muted; fill(vol, audio.muted ? 0 : audio.volume); YTP.player?.setVolume?.(audio.muted ? 0 : audio.volume * 100); };
function ended() { setIcon(); if (!$("rateDlg").open && state.qi < state.queue.length - 1) step(1); }
audio.onended = ended;
audio.onerror = () => { if (audio.getAttribute("src")) toast("That file won't play - the host may be down."); };
addEventListener("keydown", e => {
  // space is play/pause everywhere except while typing
  if (e.code === "Space" && !document.querySelector("dialog[open]") && !/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) {
    e.preventDefault(); togglePlay();
  }
});

/* ---------- start ---------- */
let savedVol = 1; try { savedVol = parseFloat(localStorage.getItem("volume") ?? 1); } catch (e) {}
setVolume(isFinite(savedVol) ? savedVol : 1); setIcon();
try { if (localStorage.getItem("video")) setVideo(true); } catch (e) {}
$("videoBox").hidden = true;
wireFacets(S, renderSearch); wireFacets(P, renderPlaylist);
renderSearch(); loadPlaylists(); loadLibrary();
api("/api/config").then(c => {
  state.ffmpeg = c.ffmpeg; state.season = c.season; state.year = c.year; freshHint();
  $("dlFormat").innerHTML = `<option value="audio">Audio</option>` + (c.ffmpeg ? `<option value="mp4">MP4 video</option>` : "")
    + `<option value="hq">WebM video</option><option value="mq">WebM 480p</option>`;
}).catch(() => {});
