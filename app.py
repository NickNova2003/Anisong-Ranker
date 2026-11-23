import csv
import html
import io
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import requests
from flask import Flask, Response, abort, jsonify, request, send_from_directory

import sheets
import sources as src
from sources import http, type_code

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("ANISONG_DB", os.path.join(BASE_DIR, "anisong.db"))
DOWNLOAD_DIR = os.environ.get("ANISONG_DOWNLOADS", os.path.join(BASE_DIR, "downloads"))
MEDIA_HOSTS = ["animemusicquiz.com", "catbox.moe", "catbox.video", "animethemes.moe"] + [
    h for h in os.environ.get("ANISONG_EXTRA_MEDIA_HOSTS", "").split(",") if h]
IMAGE_HOSTS = ["anilist.co", "anili.st"]
FFMPEG = shutil.which("ffmpeg")

DAY = 24 * 3600
META_HIT_TTL = 90 * DAY
META_MISS_TTL = 7 * DAY

SONG_FIELDS = ("key", "source", "anime", "animeJP", "vintage", "animeType", "songType", "songName", "artist",
               "composer", "arranger", "category", "difficulty", "length", "isDub", "isRebroadcast",
               "annId", "malId", "anilistId", "artistList", "audio", "hq", "mq", "custom", "link")
META_FIELDS = ("cover", "coverSmall", "color", "genres", "tags", "anilistUrl")
NEW_SOURCES = ("animethemes", "mal")

app = Flask(__name__, static_folder="static", static_url_path="/static")
JOBS = {}


# ------------------------------------------------------------------- database
def db():
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def init_db():
    with db() as con:
        con.executescript("""
            CREATE TABLE IF NOT EXISTS songs (key TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS playlist_songs (
                playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                song_key TEXT NOT NULL REFERENCES songs(key),
                score REAL, note TEXT DEFAULT '', added REAL NOT NULL,
                PRIMARY KEY (playlist_id, song_key));
            CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, fetched REAL NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS anime_meta (
                key TEXT PRIMARY KEY, fetched REAL NOT NULL, found INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS names (
                kind TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE, PRIMARY KEY (kind, name));
        """)
        if "pinned" not in columns(con, "playlists"):
            con.execute("ALTER TABLE playlists ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
        if "pos" not in columns(con, "playlist_songs"):
            con.execute("ALTER TABLE playlist_songs ADD COLUMN pos REAL")
            con.execute("UPDATE playlist_songs SET pos = added")
        if not con.execute("SELECT 1 FROM names LIMIT 1").fetchone():
            for row in con.execute("SELECT data FROM cache WHERE key LIKE 'season:%'").fetchall():
                remember_names(con, [src.normalize(x) for x in json.loads(row["data"])])


def columns(con, table):
    return [r["name"] for r in con.execute(f"PRAGMA table_info({table})")]


def cache_get(key, ttl):
    with db() as con:
        row = con.execute("SELECT fetched, data FROM cache WHERE key=?", (key,)).fetchone()
    if row and time.time() - row["fetched"] < ttl:
        return json.loads(row["data"])
    return None


def cache_put(key, data):
    with db() as con:
        con.execute("REPLACE INTO cache(key, fetched, data) VALUES (?,?,?)", (key, time.time(), json.dumps(data)))


def remember_names(con, songs):
    rows = set()
    for s in songs:
        rows.update((("anime", s["anime"]), ("anime", s["animeJP"]), ("artist", s["artist"]),
                     ("song", s["songName"]), ("composer", s["composer"])))
    con.executemany("INSERT OR IGNORE INTO names(kind, name) VALUES (?,?)",
                    [r for r in rows if r[1] and len(r[1]) <= 120])


def stored(song):
    return {k: song.get(k) for k in SONG_FIELDS}


def save_song(con, song):
    con.execute("REPLACE INTO songs(key, data) VALUES (?,?)", (str(song["key"]), json.dumps(stored(song))))


def playlist_rows(con, pid):
    rows = con.execute(
        """SELECT s.data, ps.score, ps.note, ps.added, ps.pos FROM playlist_songs ps
           JOIN songs s ON s.key = ps.song_key WHERE ps.playlist_id=? ORDER BY ps.added""", (pid,)).fetchall()
    out = []
    for r in rows:
        song = json.loads(r["data"])
        song.setdefault("source", "custom" if song.get("custom") else "anisongdb")
        song.update(score=r["score"], note=r["note"] or "", added=r["added"],
                    pos=r["pos"] if r["pos"] is not None else r["added"])
        out.append(song)
    return out


def ranked(songs):
    rated = sorted((s for s in songs if s["score"] is not None), key=lambda s: (-s["score"], s["pos"]))
    return rated, [s for s in songs if s["score"] is None]


def get_playlist_name(con, pid):
    row = con.execute("SELECT name FROM playlists WHERE id=?", (pid,)).fetchone()
    if not row:
        abort(404)
    return row["name"]


# ------------------------------------------------------- seasons, covers, genres
def fetch_season(season, refresh=False):
    key = "season:" + season
    year = int(re.search(r"\d{4}", season).group())
    ttl = 12 * 3600 if year >= time.localtime().tm_year - 1 else 7 * DAY  # recent seasons still fill in
    if not refresh:
        hit = cache_get(key, ttl)
        if hit is not None:
            return hit
    data = src.anisongdb_season(season)
    if data:
        cache_put(key, data)
    return data


def meta_key(song):
    if song.get("anilistId"):
        return "al:%s" % song["anilistId"]
    if song.get("malId"):
        return "mal:%s" % song["malId"]
    return None


def save_meta(con, key, meta):
    con.execute("REPLACE INTO anime_meta(key, fetched, found, data) VALUES (?,?,?,?)",
                (key, time.time(), int(meta is not None), json.dumps(meta or {})))


def enrich(songs, max_batches=14):
    """Adds cover art, genres and themes. Returns how many anime are still waiting on AniList."""
    keys = {k for k in (meta_key(s) for s in songs) if k}
    found, now = {}, time.time()
    with db() as con:
        klist = list(keys)
        for i in range(0, len(klist), 500):
            chunk = klist[i:i + 500]
            for row in con.execute("SELECT * FROM anime_meta WHERE key IN (%s)" % ",".join("?" * len(chunk)), chunk):
                if now - row["fetched"] < (META_HIT_TTL if row["found"] else META_MISS_TTL):
                    found[row["key"]] = json.loads(row["data"]) if row["found"] else None
    todo = sorted(keys - set(found))
    waiting, calls = 0, 0
    for kind in ("al", "mal"):
        ids = [int(k.split(":")[1]) for k in todo if k.startswith(kind + ":") and k.split(":")[1].isdigit()]
        for i in range(0, len(ids), 50):
            chunk = ids[i:i + 50]
            if calls >= max_batches or waiting:
                waiting += len(chunk)
                continue
            try:
                got = src.anilist_meta(kind, chunk)
            except (requests.RequestException, ValueError, KeyError):
                waiting += len(chunk)
                continue
            calls += 1
            with db() as con:
                for n in chunk:
                    k = f"{kind}:{n}"
                    found[k] = got.get(k)
                    save_meta(con, k, got.get(k))
            time.sleep(0.7)  # AniList allows ~30 requests a minute
    blank = {"cover": None, "coverSmall": None, "color": None, "genres": [], "tags": [], "anilistUrl": None}
    for s in songs:
        s.update(found.get(meta_key(s)) or blank)
    return waiting


# ------------------------------------------------------------------- filters
def read_filters(body):
    return {
        "types": set(body.get("types") or ["OP", "ED", "IN"]),
        "categories": set(body.get("categories") or ["Standard", "Instrumental", "Chanting", "Character"]),
        "animeTypes": set(body.get("animeTypes") or []),
        "dub": bool(body.get("dub", False)),
        "rebroadcast": bool(body.get("rebroadcast", False)),
    }


def passes(song, f):
    code = type_code(song["songType"])
    if code != "CU" and code not in f["types"]:
        return False
    if (song["isDub"] and not f["dub"]) or (song["isRebroadcast"] and not f["rebroadcast"]):
        return False
    if song["category"] and song["category"] not in f["categories"]:
        return False
    if f["animeTypes"] and song["animeType"] and song["animeType"] not in f["animeTypes"]:
        return False
    return True


def matches_text(song, query, fields, partial):
    q = query.lower()
    hay = []
    if "anime" in fields:
        hay += [song["anime"], song["animeJP"]]
    if "song" in fields:
        hay.append(song["songName"])
    if "artist" in fields:
        hay.append(song["artist"])
    if "composer" in fields:
        hay += [song["composer"], song["arranger"]]
    return any((q in h.lower()) if partial else (q == h.lower()) for h in hay if h)


def finish(songs, f, query="", fields=(), partial=True):
    """Filter, dedupe, sort, enrich - shared by both kinds of search."""
    seen, out = set(), []
    for s in songs:
        if s["key"] in seen or not passes(s, f):
            continue
        if query and not matches_text(s, query, fields, partial):
            continue
        seen.add(s["key"])
        out.append(s)
    out.sort(key=lambda s: (s["anime"].lower(), type_code(s["songType"]), s["songType"]))
    with db() as con:
        remember_names(con, out)
    waiting = enrich(out)
    return out, waiting


def parse_season(body):
    season = (body.get("season") or "").strip().title()
    year = str(body.get("year") or "").strip()
    if year and not re.fullmatch(r"(19|20)\d\d", year):
        raise ValueError("Year should look like 2024.")
    if season and season not in src.SEASONS:
        raise ValueError("Season must be Winter, Spring, Summer or Fall.")
    return season, year


# -------------------------------------------------------------------- search
@app.post("/api/search")
def search():
    body = request.get_json(force=True) or {}
    query = (body.get("query") or "").strip()
    fields = body.get("fields") or ["anime", "song", "artist", "composer"]
    partial = bool(body.get("partial", True))
    f = read_filters(body)
    try:
        season, year = parse_season(body)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    if season and not year:
        return jsonify(error="Pick a year to go with the season."), 400
    artist_id, ann_id = body.get("artistId"), body.get("annId")
    if not query and not year and not artist_id and not ann_id:
        return jsonify(error="Type something to search for, or pick a year."), 400

    flags = src.anisongdb_flags(f["types"], f["categories"], f["dub"], f["rebroadcast"])
    try:
        raw = src.anisongdb_by_id(flags, ann_id=ann_id) if ann_id and not artist_id else None
        if raw:
            songs, query = [src.normalize(x) for x in raw], ""
        elif artist_id:
            # by ID, so "Eve" doesn't also pull in everyone with "eve" in their name
            raw = src.anisongdb_by_id(flags, artist_id=artist_id)
            if not raw and query:
                raw = src.anisongdb_text(query, ["artist"], False, flags)
            songs, query = [src.normalize(x) for x in raw or []], ""
        elif year:
            raw = []
            for s in ([season] if season else src.SEASONS):
                raw += fetch_season(f"{s} {year}", refresh=bool(body.get("refresh")))
            songs = [src.normalize(x) for x in raw]
        elif query:
            songs, query = [src.normalize(x) for x in src.anisongdb_text(query, fields, partial, flags)], ""
        else:
            songs = []
    except src.SearchPaused:
        return jsonify(error="AniSongDB turns off song/artist name searches while AMQ ranked games are on - "
                             "try again in about half an hour. Season searches and artist clicks still work."), 503
    except requests.RequestException as e:
        return jsonify(error=f"Couldn't reach AniSongDB ({e.__class__.__name__})."), 502
    except ValueError as e:
        return jsonify(error=str(e)), 502

    out, waiting = finish(songs, f, query, fields, partial)
    return jsonify(songs=out, count=len(out), artPending=waiting)


@app.post("/api/fresh")
def fresh():
    """Season search that also fills the gaps AniSongDB hasn't caught up on yet."""
    body = request.get_json(force=True) or {}
    try:
        season, year = parse_season(body)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    if not season or not year:
        season, year = src.current_season()
    return jsonify(job=start_job(run_fresh, body, f"{season} {year}"))


def run_fresh(job, body, label):
    season, year = label.split()
    f = read_filters(body)
    job.update(season=label, counts={"anisongdb": 0, "animethemes": 0, "mal": 0}, warnings=[],
               step="Checking AniSongDB, AnimeThemes and AniList")

    def asdb():
        try:
            return [src.normalize(x) for x in fetch_season(label, refresh=True)]
        except (requests.RequestException, ValueError):
            job["warnings"].append("AniSongDB didn't answer")
            return []

    def themes():
        hit = cache_get("at:" + label, 6 * 3600)
        if hit is not None:
            return hit
        try:
            got = src.animethemes_season(season, year)
            if got:
                cache_put("at:" + label, got)
            return got
        except (requests.RequestException, ValueError, KeyError) as e:
            job["warnings"].append(f"AnimeThemes didn't answer ({e.__class__.__name__})")
            return []

    def shows():
        hit = cache_get("al-season:" + label, 12 * 3600)
        if hit is not None:
            return hit
        try:
            got = src.anilist_season(season, year)
            cache_put("al-season:" + label, got)
            return got
        except (requests.RequestException, ValueError, KeyError):
            job["warnings"].append("AniList didn't answer, so shows missing from AnimeThemes were skipped")
            return []

    with ThreadPoolExecutor(3) as pool:
        base, at_songs, season_shows = [x.result() for x in (pool.submit(asdb), pool.submit(themes), pool.submit(shows))]
    extras = [s for s in at_songs if not src.covered(s, base)]

    with db() as con:  # covers and genres for the whole season in one go
        for show in season_shows:
            meta = src.meta_from_anilist(show)
            save_meta(con, f"al:{show['id']}", meta)
            if show.get("idMal"):
                save_meta(con, f"mal:{show['idMal']}", meta)

    have = base + at_songs
    known = set().union(*(src.anime_ids(s) for s in have)) if have else set()
    missing = [s for s in season_shows if s.get("idMal") and not ({("mal", s["idMal"]), ("al", s["id"])} & known)]
    missing.sort(key=lambda s: -(s.get("popularity") or 0))
    missing = missing[:40]  # the rest are mostly shorts and kids' shows with nothing listed
    job.update(step="Looking up the rest on MyAnimeList", total=len(missing), done=0)
    for show in missing:
        if job.get("cancel"):
            return
        ckey = f"jikan:{show['idMal']}"
        data = cache_get(ckey, DAY)
        if data is None:
            try:
                data = src.jikan_themes(show["idMal"])
                cache_put(ckey, data)
            except (requests.RequestException, ValueError):
                data = {}
                if "MyAnimeList" not in " ".join(job["warnings"]):
                    job["warnings"].append("MyAnimeList didn't answer for some shows")
            time.sleep(1.05)  # jikan allows 60 a minute
        extras += [s for s in src.jikan_songs(show, data, season, year) if not src.covered(s, have + extras)]
        job["done"] += 1

    job.update(step="Loading covers", total=0)
    out, waiting = finish(base + extras, f)
    for s in out:
        job["counts"][s["source"]] = job["counts"].get(s["source"], 0) + 1
    job.update(songs=out, artPending=waiting, state="finished")


@app.get("/api/suggest")
def suggest():
    q = request.args.get("q", "").strip()
    field = request.args.get("field", "all")
    if len(q) < 2:
        return jsonify([])
    kinds = ["anime", "artist", "song", "composer"] if field == "all" else [field]
    like = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    with db() as con:
        rows = con.execute(
            """SELECT name, kind FROM names WHERE kind IN (%s) AND name LIKE ? ESCAPE '\\'
               ORDER BY (name LIKE ? ESCAPE '\\') DESC,
                        CASE kind WHEN 'anime' THEN 0 WHEN 'artist' THEN 1 WHEN 'song' THEN 2 ELSE 3 END,
                        length(name) LIMIT 8""" % ",".join("?" * len(kinds)),
            (*kinds, "%" + like + "%", like + "%")).fetchall()
    out = [{"name": r["name"], "kind": r["kind"]} for r in rows]
    if "anime" in kinds and len(out) < 5 and len(q) >= 3:
        titles = SUGGEST_CACHE.get(q.lower())
        if titles is None:
            try:
                titles = src.anilist_titles(q)
                if len(SUGGEST_CACHE) > 500:
                    SUGGEST_CACHE.clear()
                SUGGEST_CACHE[q.lower()] = titles
            except (requests.RequestException, ValueError, KeyError, TypeError):
                titles = []
        have = {(o["kind"], o["name"].lower()) for o in out}
        for t in titles:
            if ("anime", t.lower()) not in have and len(out) < 8:
                have.add(("anime", t.lower()))
                out.append({"name": t, "kind": "anime"})
    return jsonify(out)


SUGGEST_CACHE = {}


@app.get("/api/library")
def library():
    """Which playlists each song is already in, for the badges in search results."""
    with db() as con:
        rows = con.execute("""SELECT ps.song_key, ps.score, p.id, p.name FROM playlist_songs ps
                              JOIN playlists p ON p.id = ps.playlist_id""").fetchall()
    out = {}
    for r in rows:
        out.setdefault(r["song_key"], []).append({"id": r["id"], "name": r["name"], "score": r["score"]})
    return jsonify(out)


# ----------------------------------------------------------------- playlists
@app.get("/api/playlists")
def list_playlists():
    with db() as con:
        rows = con.execute(
            """SELECT p.id, p.name, p.pinned, COUNT(ps.song_key) AS count,
                      SUM(ps.score IS NOT NULL) AS rated, ROUND(AVG(ps.score), 2) AS average
               FROM playlists p LEFT JOIN playlist_songs ps ON ps.playlist_id = p.id
               GROUP BY p.id ORDER BY p.pinned DESC, p.name COLLATE NOCASE""").fetchall()
    return jsonify([dict(r) | {"rated": r["rated"] or 0} for r in rows])


@app.post("/api/playlists")
def create_playlist():
    name = str((request.get_json(force=True) or {}).get("name") or "").strip()[:120]
    if not name:
        return jsonify(error="Give the playlist a name."), 400
    try:
        with db() as con:
            cur = con.execute("INSERT INTO playlists(name, created) VALUES (?,?)", (name, time.time()))
            return jsonify(id=cur.lastrowid, name=name)
    except sqlite3.IntegrityError:
        return jsonify(error="You already have a playlist called that."), 409


@app.get("/api/playlists/<int:pid>")
def get_playlist(pid):
    with db() as con:
        p = con.execute("SELECT id, name, pinned FROM playlists WHERE id=?", (pid,)).fetchone()
        if not p:
            abort(404)
        songs = playlist_rows(con, pid)
    waiting = enrich(songs)
    return jsonify(id=p["id"], name=p["name"], pinned=bool(p["pinned"]), songs=songs, artPending=waiting)


@app.patch("/api/playlists/<int:pid>")
def update_playlist(pid):
    body = request.get_json(force=True) or {}
    with db() as con:
        get_playlist_name(con, pid)
        if "pinned" in body:
            con.execute("UPDATE playlists SET pinned=? WHERE id=?", (int(bool(body["pinned"])), pid))
    if "name" in body:
        name = str(body.get("name") or "").strip()[:120]
        if not name:
            return jsonify(error="Give the playlist a name."), 400
        try:
            with db() as con:
                con.execute("UPDATE playlists SET name=? WHERE id=?", (name, pid))
        except sqlite3.IntegrityError:
            return jsonify(error="You already have a playlist called that."), 409
    return jsonify(ok=True)


@app.delete("/api/playlists/<int:pid>")
def delete_playlist(pid):
    with db() as con:
        con.execute("DELETE FROM playlists WHERE id=?", (pid,))
    return jsonify(ok=True)


@app.post("/api/playlists/<int:pid>/songs")
def add_songs(pid):
    songs = (request.get_json(force=True) or {}).get("songs") or []
    added = carried = 0
    with db() as con:
        get_playlist_name(con, pid)
        now = time.time()
        for i, s in enumerate(songs):
            if not isinstance(s, dict) or not s.get("key") or not s.get("songName"):
                continue
            key = str(s["key"])
            save_song(con, s)
            # rated it in another playlist already? bring the score along
            prev = con.execute("""SELECT score FROM playlist_songs WHERE song_key=? AND score IS NOT NULL
                                  ORDER BY rowid DESC LIMIT 1""", (key,)).fetchone()
            score = prev["score"] if prev else None
            cur = con.execute("""INSERT OR IGNORE INTO playlist_songs(playlist_id, song_key, score, added, pos)
                                 VALUES (?,?,?,?,?)""", (pid, key, score, now + i * 1e-4, now + i * 1e-4))
            added += cur.rowcount
            carried += cur.rowcount and score is not None
    return jsonify(added=added, skipped=len(songs) - added, carried=carried)


def parse_score(score):
    if score in ("", None):
        return None
    score = float(score)
    if not 0 <= score <= 10:
        raise ValueError
    return round(score, 2)


@app.patch("/api/playlists/<int:pid>/songs/<key>")
def update_song(pid, key):
    body = request.get_json(force=True) or {}
    with db() as con:
        if not con.execute("SELECT 1 FROM playlist_songs WHERE playlist_id=? AND song_key=?", (pid, key)).fetchone():
            return jsonify(error="That song isn't in this playlist any more."), 404
        if "score" in body:
            try:
                score = parse_score(body["score"])
            except (TypeError, ValueError):
                return jsonify(error="Score has to be between 0 and 10."), 400
            con.execute("UPDATE playlist_songs SET score=? WHERE playlist_id=? AND song_key=?", (score, pid, key))
            if score is not None:
                con.execute("""UPDATE playlist_songs SET score=? WHERE song_key=? AND score IS NULL
                               AND playlist_id != ?""", (score, key, pid))
        if "note" in body:
            con.execute("UPDATE playlist_songs SET note=? WHERE playlist_id=? AND song_key=?",
                        (str(body["note"] or "").strip()[:500], pid, key))
    return jsonify(ok=True)


@app.post("/api/playlists/<int:pid>/songs/<key>/move")
def move_song(pid, key):
    """Nudge a song past another one with the same score."""
    try:
        step = -1 if int((request.get_json(force=True) or {}).get("dir", 1)) < 0 else 1
    except (TypeError, ValueError):
        step = 1
    with db() as con:
        row = con.execute("SELECT score FROM playlist_songs WHERE playlist_id=? AND song_key=?", (pid, key)).fetchone()
        if not row or row["score"] is None:
            return jsonify(error="Only rated songs can be moved."), 400
        group = con.execute("""SELECT song_key, COALESCE(pos, added) AS pos FROM playlist_songs
                               WHERE playlist_id=? AND score=? ORDER BY COALESCE(pos, added), rowid""",
                            (pid, row["score"])).fetchall()
        keys = [g["song_key"] for g in group]
        i = keys.index(key)
        j = i + step
        if not 0 <= j < len(keys):
            return jsonify(ok=True, moved=False)
        slots = sorted(g["pos"] for g in group)
        slots = [p + n * 1e-7 for n, p in enumerate(slots)]  # keep them distinct
        keys[i], keys[j] = keys[j], keys[i]
        con.executemany("UPDATE playlist_songs SET pos=? WHERE playlist_id=? AND song_key=?",
                        [(p, pid, k) for p, k in zip(slots, keys)])
    return jsonify(ok=True, moved=True)


@app.post("/api/playlists/combine")
def combine_playlists():
    """Copy the songs of several playlists into a new or existing one. Sources are left alone."""
    body = request.get_json(force=True) or {}
    try:
        sources = [int(x) for x in body.get("sources") or []]
        into = int(body["into"]) if body.get("into") not in (None, "") else None
    except (TypeError, ValueError):
        return jsonify(error="Bad playlist ids."), 400
    if not sources:
        return jsonify(error="Pick at least one playlist to combine."), 400
    with db() as con:
        for pid in sources:
            get_playlist_name(con, pid)
        if into is None:
            name = str(body.get("name") or "").strip()[:120]
            if not name:
                return jsonify(error="Give the new playlist a name."), 400
            if con.execute("SELECT 1 FROM playlists WHERE name=?", (name,)).fetchone():
                return jsonify(error="You already have a playlist called that."), 409
            into = con.execute("INSERT INTO playlists(name, created) VALUES (?,?)", (name, time.time())).lastrowid
        else:
            name = get_playlist_name(con, into)
        added = filled = 0
        now = time.time()
        rows = con.execute("""SELECT song_key, score, note FROM playlist_songs
                              WHERE playlist_id IN (%s) AND playlist_id != ?
                              ORDER BY score IS NULL, score DESC, COALESCE(pos, added)""" % ",".join("?" * len(sources)),
                           (*sources, into)).fetchall()
        for i, r in enumerate(rows):
            t = now + i * 1e-4
            cur = con.execute("""INSERT OR IGNORE INTO playlist_songs(playlist_id, song_key, score, note, added, pos)
                                 VALUES (?,?,?,?,?,?)""", (into, r["song_key"], r["score"], r["note"] or "", t, t))
            if cur.rowcount:
                added += 1
            elif r["score"] is not None:  # already there but unrated: take the score over
                filled += con.execute("""UPDATE playlist_songs SET score=? WHERE playlist_id=? AND song_key=?
                                         AND score IS NULL""", (r["score"], into, r["song_key"])).rowcount
    return jsonify(id=into, name=name, added=added, filled=filled)


@app.delete("/api/playlists/<int:pid>/songs/<key>")
def remove_song(pid, key):
    with db() as con:
        con.execute("DELETE FROM playlist_songs WHERE playlist_id=? AND song_key=?", (pid, key))
    return jsonify(ok=True)


def clean_link(value):
    value = str(value or "").strip()[:500]
    if not value:
        return None
    if not re.match(r"^https?://", value, re.I):
        value = "https://" + value
    u = urlparse(value)
    if u.scheme in ("http", "https") and u.hostname and "." in u.hostname and not re.search(r'[\s"<>]', value):
        return value
    return None


@app.post("/api/playlists/<int:pid>/custom")
def add_custom(pid):
    body = request.get_json(force=True) or {}
    name = str(body.get("name") or "").strip()[:300]
    if not name:
        return jsonify(error="The song needs a name."), 400
    link = clean_link(body.get("link"))
    if str(body.get("link") or "").strip() and not link:
        return jsonify(error="That link doesn't look like a web address."), 400
    try:
        score = parse_score(body.get("score"))
    except (TypeError, ValueError):
        return jsonify(error="Score has to be between 0 and 10."), 400
    song = {k: None for k in SONG_FIELDS}
    song.update(key="c" + uuid.uuid4().hex[:16], source="custom", custom=True, link=link, songType="Custom",
                songName=name, artist=str(body.get("artist") or "").strip()[:300],
                anime=str(body.get("anime") or "").strip()[:300], animeJP="", vintage="", animeType="",
                composer="", arranger="", category="", isDub=False, isRebroadcast=False, artistList=[])
    with db() as con:
        get_playlist_name(con, pid)
        save_song(con, song)
        now = time.time()
        con.execute("INSERT INTO playlist_songs(playlist_id, song_key, score, added, pos) VALUES (?,?,?,?,?)",
                    (pid, song["key"], score, now, now))
    return jsonify(ok=True, key=song["key"])


# ------------------------------------------------------------------ matching
def anisongdb_for(song, lookups):
    """AniSongDB songs from the same anime as a new-season song (cached per run)."""
    if song.get("annId"):
        k = ("ann", song["annId"])
        if k not in lookups:
            lookups[k] = [src.normalize(x) for x in
                          (src.anisongdb_by_id(src.anisongdb_flags(), ann_id=song["annId"]) or [])]
            time.sleep(0.3)
        return lookups[k]
    if song.get("vintage"):
        k = ("season", song["vintage"])
        if k not in lookups:
            try:
                lookups[k] = [src.normalize(x) for x in fetch_season(song["vintage"], refresh=True)]
            except (requests.RequestException, ValueError, AttributeError):
                lookups[k] = []
        return lookups[k]
    return []


def swap_song(con, old_key, new):
    save_song(con, new)
    for row in con.execute("SELECT * FROM playlist_songs WHERE song_key=?", (old_key,)).fetchall():
        there = con.execute("SELECT score, note FROM playlist_songs WHERE playlist_id=? AND song_key=?",
                            (row["playlist_id"], new["key"])).fetchone()
        if there:
            con.execute("""UPDATE playlist_songs SET score=COALESCE(score, ?),
                           note=CASE WHEN note IS NULL OR note='' THEN ? ELSE note END
                           WHERE playlist_id=? AND song_key=?""",
                        (row["score"], row["note"], row["playlist_id"], new["key"]))
            con.execute("DELETE FROM playlist_songs WHERE playlist_id=? AND song_key=?",
                        (row["playlist_id"], old_key))
        else:
            con.execute("UPDATE playlist_songs SET song_key=? WHERE playlist_id=? AND song_key=?",
                        (new["key"], row["playlist_id"], old_key))
    con.execute("DELETE FROM songs WHERE key=? AND key NOT IN (SELECT song_key FROM playlist_songs)", (old_key,))


def run_match(job=None):
    job = job if job is not None else {}
    with db() as con:
        rows = con.execute("""SELECT DISTINCT s.key, s.data FROM songs s
                              JOIN playlist_songs ps ON ps.song_key = s.key""").fetchall()
    waiting = [json.loads(r["data"]) for r in rows]
    waiting = [s for s in waiting if s.get("source") in NEW_SOURCES]
    job.update(total=len(waiting), done=0, matched=0, step="Matching new-season songs")
    lookups = {}
    for song in waiting:
        try:
            match = src.find_match(song, anisongdb_for(song, lookups))
        except requests.RequestException:
            match = None
        if match:
            with db() as con:
                swap_song(con, song["key"], match)
            job["matched"] += 1
        job["done"] += 1
    job["left"] = len(waiting) - job["matched"]
    job["state"] = "finished"
    cache_put("match:last", {"at": time.time(), "matched": job["matched"]})
    return job


@app.post("/api/match")
def match_now():
    return jsonify(job=start_job(lambda job: run_match(job)))


def auto_match():
    time.sleep(20)
    while True:
        try:
            if cache_get("match:last", 12 * 3600) is None:
                run_match()
        except Exception as e:  # never let this thread die
            print("auto match failed:", e)
        time.sleep(3600)


# --------------------------------------------------------------------- stats
@app.get("/api/stats")
def stats():
    pid = request.args.get("playlist", type=int)
    with db() as con:
        if pid:
            playlists = [{"id": pid, "name": get_playlist_name(con, pid)}]
        else:
            playlists = [dict(r) for r in con.execute("SELECT id, name FROM playlists")]
        entries = []
        for p in playlists:
            for s in playlist_rows(con, p["id"]):
                s.update(playlist=p["name"], playlistId=p["id"])
                entries.append(s)
    enrich(entries, max_batches=3)
    return jsonify(entries=entries, playlists=len(playlists))


# ------------------------------------------------------- spreadsheet import
@app.post("/api/sheet/read")
def sheet_read():
    try:
        if request.files.get("file"):
            f = request.files["file"]
            name, data = f.filename or "sheet.csv", f.read(20 * 1024 * 1024 + 1)
            if len(data) > 20 * 1024 * 1024:
                return jsonify(error="That file is over 20 MB."), 400
        else:
            body = request.get_json(force=True) or {}
            name, data = body.get("name") or "Pasted rows", str(body.get("text") or "")
        found = sheets.read_upload(name, data)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    base = re.sub(r"\.(csv|tsv|txt|xlsx|xlsm)$", "", name, flags=re.I)
    return jsonify(name=base, sheets=[{**sh, "guess": sheets.guess(sh["rows"], f"{name} {sh['name']}")} for sh in found])


@app.post("/api/sheet/match")
def sheet_match():
    body = request.get_json(force=True) or {}
    if isinstance(body.get("items"), list):  # retrying some rows from an earlier run
        items = [it for it in body["items"][:5000] if isinstance(it, dict) and str(it.get("song") or "").strip()]
        for it in items:
            for k in ("anime", "animeClean", "song", "artist", "season", "type"):
                it[k] = str(it.get(k) or "")
            it["slot"] = it.get("slot") if isinstance(it.get("slot"), list) and len(it["slot"]) == 2 else None
        if not items:
            return jsonify(error="Nothing to retry."), 400
        return jsonify(job=start_job(run_sheet_match, items))
    rows, mapping = body.get("rows"), body.get("mapping") or {}
    roles = mapping.get("roles") or []
    if not isinstance(rows, list) or not rows or not all(isinstance(r, list) for r in rows):
        return jsonify(error="No rows to match."), 400
    if not ({"song", "songartist"} & set(roles)):
        return jsonify(error="Tell me which column has the song names."), 400
    if roles.count("score") > 1 or roles.count("anime") > 1:
        return jsonify(error="Only one column can be the score, and one the anime."), 400
    rows = [[str(c) for c in r] for r in rows[:5000]]
    items = sheets.build_items(rows, mapping)
    if not items:
        return jsonify(error="Couldn't find any songs with those columns."), 400
    return jsonify(job=start_job(run_sheet_match, items))


def ann_songs(ann):
    """Every song for one anime, cached for a day. None if AniSongDB didn't answer."""
    hit = cache_get(f"ann:{ann}", DAY)
    if hit is None:
        hit = src.anisongdb_by_id(src.anisongdb_flags(), ann_id=ann)
        if hit is None:
            return None
        if hit:
            cache_put(f"ann:{ann}", hit)
    return [src.normalize(x) for x in hit]


def run_sheet_match(job, items):
    todo = [it for it in items if it["song"]]
    for it in todo:
        it.update(match=None, confidence=None, checked=False)
    job.update(step="Loading seasons", total=0, done=0, paused=False)

    def settle(it, cands):
        m, conf = sheets.best_match(it, cands)
        if m:
            it.update(match=m, confidence=conf, checked=True)

    # 1. the seasons the sheet mentions, plus the year before (second cours, sequels)
    wanted = list(dict.fromkeys(s for it in todo for s in sheets.nearby_seasons(it["season"])))
    pools = {}
    job["total"] = len(wanted)
    for s in wanted:
        if job.get("cancel"):
            return
        try:
            pools[s] = [src.normalize(x) for x in fetch_season(s)]
        except (requests.RequestException, ValueError):
            pass
        job["done"] += 1
    for it in todo:
        settle(it, [c for s in sheets.nearby_seasons(it["season"]) for c in pools.get(s, [])])

    # 2. by anime: find each show once (AnimeThemes knows its AniSongDB id), then match all its rows
    left = [it for it in todo if not it["match"] and it["animeClean"]]
    names = list(dict.fromkeys(it["animeClean"] for it in left))
    job.update(step="Looking up each anime", total=len(names), done=0)
    for name in names:
        if job.get("cancel"):
            return
        hits = cache_get("at-find:" + name.lower(), 7 * DAY)
        if hits is None:
            try:
                hits = src.animethemes_find(name)
                cache_put("at-find:" + name.lower(), hits)
            except (requests.RequestException, ValueError, KeyError):
                hits = None
            time.sleep(0.4)  # AnimeThemes allows 90 a minute
        rows = [it for it in left if it["animeClean"] == name]
        if hits:
            scored = sorted(((max(src.similar(name, h[0]), src.similar(name, h[1])), h[2]) for h in hits), reverse=True)
            cands, complete = [], True
            for sim, ann in [x for x in scored if x[0] >= 0.6][:3]:
                songs = ann_songs(ann)
                if songs is None:
                    complete = False
                else:
                    cands += songs
            for it in rows:
                settle(it, cands)
                # the show itself was found and its whole list came back, so "not there" is a real answer
                if not it["match"] and complete and scored[0][0] >= 0.85:
                    it["checked"] = True
        job["done"] += 1

    # 3. what's still missing: AniSongDB's song name search, one row at a time
    left = [it for it in todo if not it["match"]]
    job.update(step="Searching song names", total=len(left), done=0)
    flags = src.anisongdb_flags()
    for it in left:
        if job.get("cancel"):
            return
        try:
            raw = src.anisongdb_text(it["song"], ["song"], True, flags)
            it["checked"] = True
            settle(it, [src.normalize(x) for x in raw[:300]])
        except src.SearchPaused:
            job["paused"] = True
            break
        except (requests.RequestException, ValueError):
            pass
        job["done"] += 1

    job.update(step="Loading covers", total=0)
    enrich([it["match"] for it in todo if it["match"]])
    for it in items:
        it.setdefault("match", None)
        it.setdefault("confidence", None)
        it["status"] = "found" if it["match"] else "notfound" if it.get("checked") else "unchecked" if it["song"] else "blank"
    job.update(items=items, state="finished")


@app.post("/api/sheet/import")
def sheet_import():
    body = request.get_json(force=True) or {}
    rows = body.get("items") or []
    if not rows:
        return jsonify(error="Nothing ticked to import."), 400
    with db() as con:
        if body.get("into"):
            pid = int(body["into"])
            name = get_playlist_name(con, pid)
        else:
            name = str(body.get("name") or "").strip()[:120]
            if not name:
                return jsonify(error="Give the playlist a name."), 400
            if con.execute("SELECT 1 FROM playlists WHERE name=?", (name,)).fetchone():
                return jsonify(error="You already have a playlist called that."), 409
            pid = con.execute("INSERT INTO playlists(name, created) VALUES (?,?)", (name, time.time())).lastrowid
        added = same = 0
        now = time.time()
        for i, r in enumerate(rows[:5000]):
            try:
                score = parse_score(r.get("score"))
            except (TypeError, ValueError):
                score = None
            if isinstance(r.get("song"), dict) and r["song"].get("key") and r["song"].get("songName"):
                song = r["song"]
            elif r.get("custom") and str(r["custom"].get("name") or "").strip():
                c = r["custom"]
                song = {k: None for k in SONG_FIELDS}
                song.update(key="c" + uuid.uuid4().hex[:16], source="custom", custom=True, songType="Custom",
                            songName=str(c["name"]).strip()[:300], artist=str(c.get("artist") or "").strip()[:300],
                            anime=str(c.get("anime") or "").strip()[:300], animeJP="", vintage="", animeType="",
                            composer="", arranger="", category="", isDub=False, isRebroadcast=False, artistList=[])
            else:
                continue
            save_song(con, song)
            t = now + i * 1e-4
            cur = con.execute("""INSERT OR IGNORE INTO playlist_songs(playlist_id, song_key, score, added, pos)
                                 VALUES (?,?,?,?,?)""", (pid, str(song["key"]), score, t, t))
            if cur.rowcount:
                added += 1
            else:
                same += 1
                if score is not None:
                    con.execute("UPDATE playlist_songs SET score=? WHERE playlist_id=? AND song_key=? AND score IS NULL",
                                (score, pid, str(song["key"])))
    return jsonify(id=pid, name=name, added=added, duplicates=same)


# --------------------------------------------------------- share / export / import
def fmt_score(x):
    return ("%.1f" % x).rstrip("0").rstrip(".")


def ascii_name(text):
    return text.encode("ascii", "replace").decode("ascii").replace("?", "_").replace('"', "_")


def safe_name(text, limit=150):
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(text)).strip(" .")
    return text[:limit].rstrip(" .") or "untitled"


def attachment(body, mimetype, filename):
    return Response(body, mimetype=mimetype,
                    headers={"Content-Disposition": f'attachment; filename="{ascii_name(filename)}"'})


@app.get("/api/playlists/<int:pid>/export.csv")
def export_csv(pid):
    with db() as con:
        name = get_playlist_name(con, pid)
        songs = playlist_rows(con, pid)
    enrich(songs, max_batches=0)
    rated, unrated = ranked(songs)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Rank", "Score", "Song", "Artist", "Anime", "Season", "Type", "Genres", "Note", "Link"])
    for i, s in enumerate(rated + unrated, 1):
        w.writerow([i if s["score"] is not None else "", "" if s["score"] is None else fmt_score(s["score"]),
                    s["songName"], s["artist"], s["anime"], s["vintage"], s["songType"],
                    ", ".join(s["genres"]), s["note"], s.get("link") or s["audio"] or s["hq"] or s["mq"] or ""])
    return attachment("﻿" + buf.getvalue(), "text/csv", safe_name(name) + ".csv")


@app.get("/api/playlists/<int:pid>/export.json")
def export_json(pid):
    with db() as con:
        name = get_playlist_name(con, pid)
        songs = playlist_rows(con, pid)
    songs.sort(key=lambda s: s["pos"])
    payload = {"format": "anisong-ranker-playlist", "version": 2, "name": name,
               "exported": time.strftime("%Y-%m-%d"),
               "songs": [{**stored(s), "score": s["score"], "note": s["note"]} for s in songs]}
    return attachment(json.dumps(payload, ensure_ascii=False, indent=1), "application/json",
                      safe_name(name) + ".anisong.json")


def media_ok(url):
    try:
        u = urlparse(url)
    except ValueError:
        return False
    host = (u.hostname or "").lower()
    return u.scheme in ("http", "https") and any(host == h or host.endswith("." + h) for h in MEDIA_HOSTS)


@app.post("/api/playlists/import")
def import_playlist():
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or data.get("format") != "anisong-ranker-playlist" \
            or not isinstance(data.get("songs"), list):
        return jsonify(error="That isn't a playlist file from this app."), 400
    base = str(data.get("name") or "").strip()[:120] or "Imported playlist"
    added = 0
    with db() as con:
        name, n = base, 2
        while con.execute("SELECT 1 FROM playlists WHERE name=?", (name,)).fetchone():
            name, n = f"{base} ({n})", n + 1
        pid = con.execute("INSERT INTO playlists(name, created) VALUES (?,?)", (name, time.time())).lastrowid
        now = time.time()
        for i, s in enumerate(data["songs"][:5000]):
            if not isinstance(s, dict) or not s.get("key") or not s.get("songName"):
                continue
            song = stored(s)
            song["key"] = str(song["key"])[:64]
            for k in ("anime", "animeJP", "vintage", "animeType", "songType", "songName", "artist",
                      "composer", "arranger", "category"):
                song[k] = str(song[k] or "")[:300]
            for k in ("audio", "hq", "mq"):
                song[k] = song[k] if isinstance(song[k], str) and media_ok(song[k]) else None
            song["artistList"] = song["artistList"] if isinstance(song["artistList"], list) else []
            song["custom"] = bool(song["custom"])
            song["source"] = "custom" if song["custom"] else (
                song["source"] if song["source"] in ("anisongdb",) + NEW_SOURCES else "anisongdb")
            song["link"] = clean_link(song["link"]) if song["custom"] else None
            score = s.get("score")
            score = round(float(score), 2) if isinstance(score, (int, float)) and 0 <= score <= 10 else None
            con.execute("INSERT OR IGNORE INTO songs(key, data) VALUES (?,?)", (song["key"], json.dumps(song)))
            t = now + i * 1e-4
            added += con.execute("""INSERT OR IGNORE INTO playlist_songs(playlist_id, song_key, score, note, added, pos)
                                    VALUES (?,?,?,?,?,?)""",
                                 (pid, song["key"], score, str(s.get("note") or "")[:500], t, t)).rowcount
    return jsonify(id=pid, name=name, added=added)


SHARE_CSS = """
*{box-sizing:border-box}body{margin:0;background:#0a0e16;color:#eceff6;font:15px/1.45 "Segoe UI",system-ui,-apple-system,sans-serif}
.wrap{max-width:820px;margin:0 auto;padding:44px 20px 60px}.brand{font-weight:700;color:#8f9bb3}
.brand b{color:#6ea8ff}h1{font-size:38px;margin:10px 0 18px;letter-spacing:-.5px}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:30px}.stat{background:#111622;border:1px solid #273047;border-radius:14px;padding:12px 20px}
.stat b{display:block;font-size:26px}.stat span{color:#8f9bb3;font-size:12px;text-transform:uppercase;letter-spacing:1px}
.stat.hi b{color:#6ea8ff}h2{font-size:13px;color:#8f9bb3;text-transform:uppercase;letter-spacing:1.2px;margin:30px 0 10px}
.row{display:flex;align-items:center;gap:16px;background:#111622;border:1px solid #273047;border-radius:14px;padding:10px 18px 10px 10px;margin-bottom:8px}
.rank{width:46px;text-align:center;font-size:20px;font-weight:800;color:#8f9bb3;flex:none}.top .rank{color:#ffc857}
.top{border-color:#34507f;background:linear-gradient(90deg,#14203a,#111622)}
.cover{width:54px;height:76px;border-radius:8px;object-fit:cover;background:#232c40;flex:none}
.main{flex:1;min-width:0}.song{font-size:17px;font-weight:700}.song a{color:inherit;text-decoration-color:#6ea8ff}
.artist{color:#c9d3e6}.meta{color:#8f9bb3;font-size:13px;margin-top:2px}.note{color:#c9d3e6;font-style:italic;font-size:13px;margin-top:4px}
.tag{display:inline-block;font-size:11px;font-weight:700;padding:1px 8px;border-radius:99px;background:rgba(110,168,255,.15);color:#6ea8ff;margin-left:6px}
.score{flex:none;min-width:62px;text-align:center;font-size:24px;font-weight:800;color:#fff;background:#2f7af5;border-radius:12px;padding:6px 10px}
.score small{font-size:12px;font-weight:600;opacity:.8}.score.none{background:#232c40;color:#8f9bb3;font-size:15px}
footer{color:#5d6880;font-size:12px;margin-top:34px;text-align:center}
@media(max-width:560px){h1{font-size:28px}.rank{width:30px;font-size:16px}.row{gap:10px}}
"""


def short_type(song_type):
    return re.sub(r"^Opening", "OP", re.sub(r"^Ending", "ED", re.sub(r"^Insert Song", "Insert", song_type or "")))


@app.get("/api/playlists/<int:pid>/share.html")
def share_page(pid):
    with db() as con:
        name = get_playlist_name(con, pid)
        songs = playlist_rows(con, pid)
    enrich(songs)
    rated, unrated = ranked(songs)
    e = html.escape

    def row(s, rank):
        cover = s.get("coverSmall") or ""
        img = f'<img class="cover" src="{e(cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">' \
            if cover.startswith("https://") else '<div class="cover"></div>'
        link = clean_link(s.get("link")) if s.get("custom") else None
        title = f'<a href="{e(link)}" target="_blank" rel="noopener noreferrer">{e(s["songName"])} ↗</a>' \
            if link else e(s["songName"])
        score = f'<div class="score">{fmt_score(s["score"])}<small>/10</small></div>' if rank \
            else '<div class="score none">–</div>'
        meta = " · ".join(x for x in (s["anime"], s["vintage"]) if x)
        note = f'<div class="note">“{e(s["note"])}”</div>' if s.get("note") else ""
        return (f'<div class="row{" top" if rank and rank <= 3 else ""}"><div class="rank">{"#%d" % rank if rank else ""}</div>'
                f'{img}<div class="main"><div class="song">{title}</div><div class="artist">{e(s["artist"])}</div>'
                f'<div class="meta">{e(meta)}<span class="tag">{e(short_type(s["songType"]))}</span></div>{note}</div>'
                f'{score}</div>')

    avg = fmt_score(sum(s["score"] for s in rated) / len(rated)) if rated else "–"
    body = "".join(row(s, i) for i, s in enumerate(rated, 1))
    if unrated:
        body += "<h2>Not rated yet</h2>" + "".join(row(s, 0) for s in unrated)
    page = (f'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1"><title>{e(name)}</title>'
            f'<style>{SHARE_CSS}</style></head><body><div class="wrap"><div class="brand">Nick\'s <b>AniSong</b> Ranker</div>'
            f'<h1>{e(name)}</h1><div class="stats"><div class="stat hi"><b>{avg}</b><span>Average</span></div>'
            f'<div class="stat"><b>{len(songs)}</b><span>Songs</span></div><div class="stat"><b>{len(rated)}</b><span>Rated</span></div></div>'
            f'{"<h2>Ranking</h2>" if rated else ""}{body}<footer>{time.strftime("%d %B %Y")}</footer></div></body></html>')
    return attachment(page, "text/html", safe_name(name) + " ranking.html")


IMG_CACHE = {}


@app.get("/api/img")
def image_proxy():
    """Covers go through here so the top-10 canvas isn't blocked by CORS."""
    url = request.args.get("url", "")
    host = (urlparse(url).hostname or "").lower()
    if not url.startswith("https://") or not any(host == h or host.endswith("." + h) for h in IMAGE_HOSTS):
        abort(400)
    if url not in IMG_CACHE:
        try:
            r = http.get(url, timeout=15)
            r.raise_for_status()
        except requests.RequestException:
            abort(502)
        if len(IMG_CACHE) > 300:
            IMG_CACHE.clear()
        IMG_CACHE[url] = (r.content, r.headers.get("Content-Type", "image/jpeg"))
    body, mime = IMG_CACHE[url]
    return Response(body, mimetype=mime, headers={"Cache-Control": "max-age=86400"})


# ----------------------------------------------------------------- downloads
def fetch_to(url, path):
    with http.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(path, "wb") as fh:
            for chunk in r.iter_content(1 << 16):
                fh.write(chunk)


def to_mp4(src_path, dst_path):
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", src_path, "-c:v", "libx264", "-preset", "veryfast",
                    "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                    "-movflags", "+faststart", "-f", "mp4", dst_path], check=True, timeout=900)


def pick_url(song, fmt):
    order = {"audio": ["audio"], "hq": ["hq", "mq"], "mq": ["mq", "hq"], "mp4": ["hq", "mq"]}
    for k in order.get(fmt, ["audio"]):
        if song.get(k) and media_ok(song[k]):
            return song[k]
    return None


def file_name(song, url, ext=None):
    ext = ext or os.path.splitext(urlparse(url).path)[1] or ".mp3"
    return safe_name(f'{song["anime"]} - {short_type(song["songType"])} - {song["songName"]} ({song["artist"]})') + ext


def run_download(job, pid, fmt):
    with db() as con:
        name = get_playlist_name(con, pid)
        songs = [s for s in playlist_rows(con, pid) if not s.get("custom")]
    folder = os.path.join(DOWNLOAD_DIR, safe_name(name))
    os.makedirs(folder, exist_ok=True)
    job.update(total=len(songs), done=0, saved=0, skipped=0, failed=[], folder=folder)
    if fmt == "mp4" and not FFMPEG:
        raise RuntimeError("MP4 needs ffmpeg installed (winget install Gyan.FFmpeg).")
    for song in songs:
        job["current"] = f'{song["anime"]} - {song["songName"]}'
        url = pick_url(song, fmt)
        if not url:
            job["failed"].append(job["current"] + " (no file)")
        else:
            dest = os.path.join(folder, file_name(song, url, ".mp4" if fmt == "mp4" else None))
            if os.path.exists(dest):
                job["skipped"] += 1
            else:
                try:
                    fetch_to(url, dest + ".part")
                    if fmt == "mp4":
                        try:
                            to_mp4(dest + ".part", dest + ".tmp")
                            os.replace(dest + ".tmp", dest)
                        finally:
                            for leftover in (dest + ".part", dest + ".tmp"):
                                if os.path.exists(leftover):
                                    os.remove(leftover)
                    else:
                        os.replace(dest + ".part", dest)
                    job["saved"] += 1
                    time.sleep(0.3)
                except Exception as e:
                    job["failed"].append(f'{job["current"]} ({e.__class__.__name__})')
                    if os.path.exists(dest + ".part"):
                        os.remove(dest + ".part")
        job["done"] += 1
    job["state"] = "finished"


@app.post("/api/playlists/<int:pid>/download")
def download_all(pid):
    fmt = (request.get_json(silent=True) or {}).get("format", "audio")
    with db() as con:
        get_playlist_name(con, pid)
    return jsonify(job=start_job(run_download, pid, fmt))


@app.get("/api/download")
def download_one():
    url = request.args.get("url", "")
    if not media_ok(url):
        return jsonify(error="Not allowed to download from there."), 400
    ext = os.path.splitext(urlparse(url).path)[1] or ".mp3"
    base = safe_name(request.args.get("name") or "song")
    if request.args.get("mp4"):
        if not FFMPEG:
            return jsonify(error="MP4 needs ffmpeg installed."), 400
        tmp = tempfile.mkdtemp(prefix="anisong_")
        try:
            fetch_to(url, os.path.join(tmp, "in" + ext))
            to_mp4(os.path.join(tmp, "in" + ext), os.path.join(tmp, "out.mp4"))
        except Exception as e:
            shutil.rmtree(tmp, ignore_errors=True)
            return jsonify(error=f"MP4 conversion failed ({e.__class__.__name__})."), 502

        def stream():
            try:
                with open(os.path.join(tmp, "out.mp4"), "rb") as fh:
                    while chunk := fh.read(1 << 16):
                        yield chunk
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
        size = os.path.getsize(os.path.join(tmp, "out.mp4"))
        return Response(stream(), mimetype="video/mp4", headers={
            "Content-Disposition": f'attachment; filename="{ascii_name(base + ".mp4")}"', "Content-Length": str(size)})
    try:
        r = http.get(url, stream=True, timeout=120)
        r.raise_for_status()
    except requests.RequestException as e:
        return jsonify(error=f"Download failed ({e.__class__.__name__})."), 502
    headers = {"Content-Disposition": f'attachment; filename="{ascii_name(base + ext)}"'}
    if r.headers.get("Content-Length"):
        headers["Content-Length"] = r.headers["Content-Length"]
    return Response(r.iter_content(1 << 16), headers=headers,
                    mimetype=r.headers.get("Content-Type", "application/octet-stream"))


# ---------------------------------------------------------------------- jobs
def start_job(fn, *args):
    for jid in [j for j, v in JOBS.items() if v["state"] != "running" and time.time() - v["started"] > 3600]:
        JOBS.pop(jid, None)
    job_id = uuid.uuid4().hex
    job = JOBS[job_id] = {"state": "running", "started": time.time(), "step": "", "done": 0, "total": 0}

    def run():
        try:
            fn(job, *args)
            job["state"] = "finished"
        except Exception as e:
            job.update(state="error", error=str(e) or e.__class__.__name__)
    threading.Thread(target=run, daemon=True).start()
    return job_id


@app.post("/api/jobs/<job_id>/cancel")
def cancel_job(job_id):
    if job_id in JOBS:
        JOBS[job_id]["cancel"] = True
    return jsonify(ok=True)


@app.get("/api/jobs/<job_id>")
def job_status(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify(error="That job has expired - try again."), 404
    if job["state"] == "running":
        return jsonify({k: v for k, v in job.items() if k != "songs"})
    return jsonify(job)


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(502)
def api_error(e):
    if request.path.startswith("/api/"):
        messages = {404: "That playlist or song doesn't exist any more.", 400: "Bad request.",
                    502: "Couldn't fetch that right now."}
        return jsonify(error=messages.get(e.code, str(e))), e.code
    return e


@app.get("/api/config")
def config():
    season, year = src.current_season()
    return jsonify(ffmpeg=bool(FFMPEG), season=season, year=year)


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


init_db()

if __name__ == "__main__":
    threading.Thread(target=auto_match, daemon=True).start()
    print("Running on http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False, threaded=True)
