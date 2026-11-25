"""Everything that talks to the outside world: AniSongDB, AniList, AnimeThemes, Jikan."""
import hashlib
import os
import re
import threading
import time
import unicodedata
from difflib import SequenceMatcher

import requests

ANISONGDB = os.environ.get("ANISONGDB_BASE", "https://anisongdb.com").rstrip("/")
ANILIST = os.environ.get("ANILIST_URL", "https://graphql.anilist.co")
ANIMETHEMES = os.environ.get("ANIMETHEMES_URL", "https://graphql.animethemes.moe/")
JIKAN = os.environ.get("JIKAN_URL", "https://api.jikan.moe/v4").rstrip("/")
# newer anisongdb rows only give a file name, the files live here
MEDIA_BASE = os.environ.get("ANISONG_MEDIA_BASE", "https://naedist.animemusicquiz.com").rstrip("/")

SEASONS = ["Winter", "Spring", "Summer", "Fall"]
FORMATS = {"TV": "TV", "TV_SHORT": "TV", "MOVIE": "Movie", "OVA": "OVA", "ONA": "ONA", "SPECIAL": "Special"}

http = requests.Session()
http.headers.update({"User-Agent": "nicks-anisong-ranker/1.0"})


def current_season():
    t = time.localtime()
    return SEASONS[(t.tm_mon - 1) // 3], t.tm_year


def type_code(song_type):
    s = (song_type or "").lower()
    if s.startswith("op"):
        return "OP"
    if s.startswith("ed"):
        return "ED"
    if s.startswith("custom"):
        return "CU"
    return "IN"


def type_number(song_type):
    m = re.search(r"(\d+)", song_type or "")
    return int(m.group(1)) if m else 1


def song_type_name(code, number):
    if code == "OP":
        return f"Opening {number}"
    if code == "ED":
        return f"Ending {number}"
    return "Insert Song"


def simplify(text):
    # "Ryōran" and "Ryouran" should land close together, so drop accents before stripping
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def similar(a, b):
    a, b = simplify(a), simplify(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


# ------------------------------------------------------------------ AniSongDB
def media_url(value):
    if not value:
        return None
    value = str(value)
    if value.startswith(("http://", "https://")):
        return value
    return MEDIA_BASE + "/" + value.lstrip("/")


def normalize(raw):
    key = raw.get("annSongId") or raw.get("amqSongId")
    if key in (None, "", -1):
        blob = "|".join(str(raw.get(k, "")) for k in ("annId", "songType", "songName", "songArtist"))
        key = "h" + hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]
    linked = raw.get("linked_ids") or {}
    return {
        "key": str(key),
        "source": "anisongdb",
        "anime": raw.get("animeENName") or raw.get("animeJPName") or "",
        "animeJP": raw.get("animeJPName") or "",
        "vintage": raw.get("animeVintage") or "",
        "animeType": raw.get("animeType") or "",
        "songType": raw.get("songType") or "",
        "songName": raw.get("songName") or "",
        "artist": raw.get("songArtist") or "",
        "composer": raw.get("songComposer") or "",
        "arranger": raw.get("songArranger") or "",
        "category": raw.get("songCategory") or "",
        "difficulty": raw.get("songDifficulty"),
        "length": raw.get("songLength"),
        "isDub": bool(raw.get("isDub")),
        "isRebroadcast": bool(raw.get("isRebroadcast")),
        "annId": raw.get("annId"),
        "malId": linked.get("myanimelist"),
        "anilistId": linked.get("anilist"),
        "artistList": [{"id": a.get("id"), "name": (a.get("names") or [""])[0]}
                       for a in (raw.get("artists") or [])
                       if isinstance(a, dict) and a.get("id") is not None and a.get("names")][:12],
        "audio": media_url(raw.get("audio")),
        "hq": media_url(raw.get("HQ")),
        "mq": media_url(raw.get("MQ")),
    }


class SearchPaused(Exception):
    """AniSongDB switches off name searches while AMQ ranked games are on."""


# AniSongDB starts refusing if we fire requests at it too quickly, so space them out
_gap_lock = threading.Lock()
_last_call = [0.0]
MIN_GAP = float(os.environ.get("ANISONGDB_GAP", "0.35"))


def anisongdb_post(path, payload):
    for attempt in range(4):
        with _gap_lock:
            wait = _last_call[0] + MIN_GAP - time.time()
            if wait > 0:
                time.sleep(wait)
            _last_call[0] = time.time()
        r = http.post(ANISONGDB + path, json=payload, timeout=90)
        if r.status_code == 503:
            try:
                detail = r.json().get("detail", "")
            except ValueError:
                detail = ""
            if "ranked" in detail.lower():
                raise SearchPaused(detail)
        if r.status_code in (429, 500, 502, 503, 504) and attempt < 3:
            try:
                pause = float(r.headers.get("Retry-After") or 0)
            except ValueError:
                pause = 0
            time.sleep(min(pause or 1.5 * 2 ** attempt, 20))
            continue
        r.raise_for_status()
        return r.json()


def anisongdb_flags(types=("OP", "ED", "IN"), categories=("Standard", "Instrumental", "Chanting", "Character"),
                    dub=False, rebroadcast=False):
    return {
        "and_logic": False, "ignore_duplicate": False, "normal_broadcast": True,
        "opening_filter": "OP" in types, "ending_filter": "ED" in types, "insert_filter": "IN" in types,
        "dub": dub, "rebroadcast": rebroadcast,
        "standard": "Standard" in categories, "instrumental": "Instrumental" in categories,
        "chanting": "Chanting" in categories, "character": "Character" in categories,
    }


def anisongdb_season(season):
    try:
        data = anisongdb_post("/api/season_request", {"season": season})
    except requests.HTTPError:
        r = http.get(ANISONGDB + "/api/filter_season", params={"season": season}, timeout=90)
        r.raise_for_status()
        data = r.json()
    if not isinstance(data, list):
        raise ValueError("Unexpected response from AniSongDB for " + season)
    return data


def anisongdb_text(query, fields, partial, flags):
    payload = dict(flags)
    if "anime" in fields:
        payload["anime_search_filter"] = {"search": query, "partial_match": partial}
    if "song" in fields:
        payload["song_name_search_filter"] = {"search": query, "partial_match": partial}
    if "artist" in fields:
        payload["artist_search_filter"] = {"search": query, "partial_match": partial,
                                           "group_granularity": 0, "max_other_artist": 99}
    if "composer" in fields:
        payload["composer_search_filter"] = {"search": query, "partial_match": partial, "arrangement": True}
    return anisongdb_post("/api/search_request", payload)


def anisongdb_by_id(flags, artist_id=None, ann_id=None):
    """All songs by one artist, or from one anime. None if the lookup fails."""
    try:
        if artist_id:
            data = anisongdb_post("/api/artist_ids_request", {**flags, "artist_ids": [int(artist_id)],
                                                              "group_granularity": 0, "max_other_artist": 99})
        else:
            data = anisongdb_post("/api/annId_request", {**flags, "annId": int(ann_id)})
    except (requests.RequestException, ValueError, TypeError):
        return None
    return data if isinstance(data, list) else None


# -------------------------------------------------------------------- AniList
ANILIST_META = """
query ($ids: [Int]) { Page(page: 1, perPage: 50) { media(%s: $ids, type: ANIME) {
  id idMal siteUrl coverImage { large medium color } genres
  tags { name rank isMediaSpoiler isGeneralSpoiler isAdult } } } }"""

ANILIST_SEASON = """
query ($season: MediaSeason, $year: Int, $page: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    media(season: $season, seasonYear: $year, type: ANIME, isAdult: false, countryOfOrigin: "JP") {
      id idMal format popularity siteUrl title { romaji english }
      coverImage { large medium color } genres
      tags { name rank isMediaSpoiler isGeneralSpoiler isAdult } } } }"""

ANILIST_SEARCH = """query ($s: String) { Page(page: 1, perPage: 6) {
  media(search: $s, type: ANIME) { title { romaji english } } } }"""


def anilist(query, variables, timeout=30):
    r = http.post(ANILIST, json={"query": query, "variables": variables}, timeout=timeout)
    r.raise_for_status()
    return r.json()["data"]


def meta_from_anilist(m):
    cover = m.get("coverImage") or {}
    tags = [t["name"] for t in (m.get("tags") or [])
            if (t.get("rank") or 0) >= 70 and not t.get("isMediaSpoiler")
            and not t.get("isGeneralSpoiler") and not t.get("isAdult")]
    return {
        "cover": cover.get("large") or cover.get("medium"),
        "coverSmall": cover.get("medium") or cover.get("large"),
        "color": cover.get("color"), "genres": m.get("genres") or [],
        "tags": tags[:12], "anilistUrl": m.get("siteUrl"),
    }


def anilist_meta(kind, ids):
    """kind is 'al' or 'mal'. Returns {"al:123": meta} for whatever AniList knows."""
    data = anilist(ANILIST_META % ("id_in" if kind == "al" else "idMal_in"), {"ids": ids})
    out = {}
    for m in (data.get("Page") or {}).get("media") or []:
        ident = m.get("id") if kind == "al" else m.get("idMal")
        if ident:
            out[f"{kind}:{ident}"] = meta_from_anilist(m)
    return out


def anilist_season(season, year):
    shows, page = [], 1
    while page <= 8:
        data = anilist(ANILIST_SEASON, {"season": season.upper(), "year": int(year), "page": page})["Page"]
        shows += [m for m in data.get("media") or [] if m.get("format") in FORMATS]
        if not (data.get("pageInfo") or {}).get("hasNextPage"):
            break
        page += 1
        time.sleep(0.7)
    return shows


def anilist_titles(text):
    data = anilist(ANILIST_SEARCH, {"s": text}, timeout=8)
    titles = []
    for m in data["Page"]["media"]:
        titles += [t for t in (m["title"].get("english"), m["title"].get("romaji")) if t]
    return titles


# ---------------------------------------------------------------- AnimeThemes
ANIMETHEMES_SEASON = """
query ($year: Int, $season: AnimeSeason, $page: Int) {
  animePagination(year: $year, season: $season, first: 50, page: $page) {
    paginatorInfo { hasMorePages }
    data {
      slug format year season title { romaji english }
      resources(first: 15) { nodes { site externalId } }
      animethemes { type sequence slug
        song { title { romaji native } performances { as artist { name { main } } } }
        animethemeentries { version
          videos(first: 6) { nodes { link resolution nc audio { link } } } } }
    } } }"""


ANIMETHEMES_SEARCH = """
query ($s: String) { animePagination(search: $s, first: 5) {
  data { year season title { romaji english } resources(first: 15) { nodes { site externalId } } } } }"""


def animethemes_find(name):
    """Anime by name -> [(title, english, annId)], best guesses first."""
    r = http.post(ANIMETHEMES, json={"query": ANIMETHEMES_SEARCH, "variables": {"s": name}},
                  headers={"Accept": "application/json"}, timeout=30)
    r.raise_for_status()
    out = []
    for a in ((r.json().get("data") or {}).get("animePagination") or {}).get("data") or []:
        ann = next((x["externalId"] for x in (a.get("resources") or {}).get("nodes") or []
                    if x.get("site") == "ANN" and x.get("externalId")), None)
        if ann:
            out.append(((a.get("title") or {}).get("romaji") or "", (a.get("title") or {}).get("english") or "", ann))
    return out


def _pick_video(theme):
    entries = sorted(theme.get("animethemeentries") or [], key=lambda e: e.get("version") or 1)
    for entry in entries:
        videos = (entry.get("videos") or {}).get("nodes") or []
        if videos:
            videos.sort(key=lambda v: (not v.get("nc"), -(v.get("resolution") or 0)))
            return videos[0]
    return None


def animethemes_season(season, year):
    """Songs for a season from AnimeThemes, already in the app's song shape."""
    songs, page = [], 1
    while page <= 10:
        r = http.post(ANIMETHEMES, json={"query": ANIMETHEMES_SEASON,
                                         "variables": {"year": int(year), "season": season.upper(), "page": page}},
                      headers={"Accept": "application/json"}, timeout=60)
        r.raise_for_status()
        body = r.json()
        if body.get("errors"):
            raise ValueError(body["errors"][0].get("message", "AnimeThemes error"))
        block = body["data"]["animePagination"]
        for anime in block.get("data") or []:
            songs += _animethemes_songs(anime, season, year)
        if not (block.get("paginatorInfo") or {}).get("hasMorePages"):
            break
        page += 1
        time.sleep(0.8)
    return songs


def _animethemes_songs(anime, season, year):
    ids = {}
    for res in (anime.get("resources") or {}).get("nodes") or []:
        if res.get("externalId"):
            ids[res.get("site")] = res["externalId"]
    title = anime.get("title") or {}
    out = []
    for theme in anime.get("animethemes") or []:
        code = theme.get("type") if theme.get("type") in ("OP", "ED", "IN") else "IN"
        number = theme.get("sequence") or type_number(theme.get("slug")) or 1
        song = theme.get("song") or {}
        names = []
        for perf in song.get("performances") or []:
            name = ((perf.get("artist") or {}).get("name") or {}).get("main")
            if name:
                names.append(f"{perf['as']} (CV: {name})" if perf.get("as") else name)
        video = _pick_video(theme)
        song_title = (song.get("title") or {}).get("romaji") or (song.get("title") or {}).get("native") or ""
        out.append({
            "key": f"at-{anime.get('slug')}-{theme.get('slug') or code + str(number)}",
            "source": "animethemes",
            "anime": title.get("english") or title.get("romaji") or anime.get("slug") or "",
            "animeJP": title.get("romaji") or "",
            "vintage": f"{season.title()} {year}",
            "animeType": FORMATS.get(anime.get("format"), anime.get("format") or ""),
            "songType": song_type_name(code, number),
            "songName": song_title or "(untitled)",
            "artist": ", ".join(names),
            "composer": "", "arranger": "", "category": "",
            "difficulty": None, "length": None, "isDub": False, "isRebroadcast": False,
            "annId": ids.get("ANN"), "malId": ids.get("MAL"), "anilistId": ids.get("ANILIST"),
            "artistList": [],
            "audio": ((video or {}).get("audio") or {}).get("link"),
            "hq": (video or {}).get("link"), "mq": None,
        })
    return out


# ---------------------------------------------------------------------- Jikan
THEME_LINE = re.compile(r'^\s*(?:#?(\d+)\s*[:.]\s*)?"(.+?)"\s*(?:by\s+(.+?))?\s*(?:\((?:eps?|episodes?)\b[^)]*\))?\s*$',
                        re.I)


def parse_theme_line(line):
    """'1: "Title (タイトル)" by Artist (eps 1-12)' -> (1, 'Title', 'Artist')"""
    m = THEME_LINE.match(line or "")
    if not m:
        return None
    number, title, artist = m.group(1), m.group(2).strip(), (m.group(3) or "").strip()
    # MAL often adds the native title in brackets after the romaji one
    native = re.match(r"^(.*\S)\s*\(([^)]*[^\x00-\x7f][^)]*)\)$", title)
    if native and native.group(1):
        title = native.group(1)
    artist = re.sub(r"\s*\((?:eps?|episodes?)\b[^)]*\)\s*$", "", artist, flags=re.I)
    return (int(number) if number else None), title, artist


def jikan_themes(mal_id):
    for attempt in range(3):
        r = http.get(f"{JIKAN}/anime/{int(mal_id)}/themes", timeout=20)
        if r.status_code == 429:
            time.sleep(2 + attempt * 2)
            continue
        if r.status_code == 404:
            return {"openings": [], "endings": []}
        r.raise_for_status()
        return r.json().get("data") or {}
    raise requests.HTTPError("Jikan rate limit")


def jikan_songs(show, themes, season, year):
    title = show.get("title") or {}
    out = []
    for code, lines in (("OP", themes.get("openings") or []), ("ED", themes.get("endings") or [])):
        for i, line in enumerate(lines, 1):
            parsed = parse_theme_line(line)
            if not parsed:
                continue
            number, name, artist = parsed
            number = number or i
            out.append({
                "key": f"mal-{show.get('idMal')}-{code}{number}",
                "source": "mal",
                "anime": title.get("english") or title.get("romaji") or "",
                "animeJP": title.get("romaji") or "",
                "vintage": f"{season.title()} {year}",
                "animeType": FORMATS.get(show.get("format"), ""),
                "songType": song_type_name(code, number),
                "songName": name, "artist": artist,
                "composer": "", "arranger": "", "category": "",
                "difficulty": None, "length": None, "isDub": False, "isRebroadcast": False,
                "annId": None, "malId": show.get("idMal"), "anilistId": show.get("id"),
                "artistList": [], "audio": None, "hq": None, "mq": None,
            })
    return out


# ------------------------------------------------------------------- matching
def anime_ids(song):
    return {("ann", song.get("annId")), ("mal", song.get("malId")), ("al", song.get("anilistId"))} - \
        {("ann", None), ("mal", None), ("al", None)}


def slot(song):
    code = type_code(song.get("songType"))
    return code, (type_number(song.get("songType")) if code in ("OP", "ED") else 0)


def find_match(song, candidates):
    """Pick the AniSongDB song that is the same song as a new-season one, or None."""
    ids = anime_ids(song)
    same_show = [c for c in candidates if anime_ids(c) & ids]
    if not same_show:
        return None
    code, number = slot(song)
    if code in ("OP", "ED"):
        same_slot = [c for c in same_show if slot(c) == (code, number)]
        if len(same_slot) == 1:
            return same_slot[0]
        if same_slot:
            best = max(same_slot, key=lambda c: similar(c["songName"], song["songName"]))
            return best if similar(best["songName"], song["songName"]) >= 0.5 else None
    by_title = [c for c in same_show if type_code(c["songType"]) == code
                and similar(c["songName"], song["songName"]) >= 0.8]
    return by_title[0] if len(by_title) == 1 else None


def covered(song, existing):
    """True if a song from another source already sits in the same slot of the same anime."""
    ids, s = anime_ids(song), slot(song)
    for other in existing:
        if anime_ids(other) & ids:
            if s[0] in ("OP", "ED") and slot(other) == s:
                return True
            if s[0] == "IN" and type_code(other["songType"]) == "IN" \
                    and similar(other["songName"], song["songName"]) >= 0.8:
                return True
    return False


# ---------------------------------------------------------- YouTube Music
YT_LIST = re.compile(r"[?&]list=([\w-]+)")
YT_VIDEO = re.compile(r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|live/)|youtu\.be/)([\w-]{11})")


def youtube_link(video_id):
    return f"https://www.youtube.com/watch?v={video_id}" if video_id else None


def _ytmusic():
    try:
        from ytmusicapi import YTMusic
    except ImportError:
        raise ValueError("YouTube Music import needs Python 3.10 or newer. Install a newer Python from python.org, "
                         "then start the app with run.bat again.")
    return YTMusic(language="en")


def ytm_playlist(link):
    """(title, tracks) for a public or unlisted YouTube / YouTube Music playlist."""
    m = YT_LIST.search(link or "")
    if not m or not re.search(r"youtu\.?be", link):
        raise ValueError("That doesn't look like a YouTube Music playlist link - open the playlist, tap Share and copy the link.")
    pid = m.group(1)
    if pid in ("LM", "LL", "WL") or pid.startswith("RD"):
        raise ValueError("That's your Liked music, Watch later or an auto mix, which YouTube keeps private. "
                         "Copy the songs into a normal playlist set to Public or Unlisted, then use that link.")
    try:
        data = _ytmusic().get_playlist(pid, limit=None)
    except ValueError:
        raise
    except Exception:
        raise ValueError("YouTube Music wouldn't share that playlist. Make sure it's set to Public or Unlisted, then try again.")
    tracks = [{"title": t.get("title") or "", "artists": [a.get("name") for a in t.get("artists") or [] if a.get("name")],
               "album": (t.get("album") or {}).get("name") or "", "videoId": t["videoId"], "kind": t.get("videoType") or ""}
              for t in data.get("tracks") or [] if t.get("videoId") and t.get("title")]
    if not tracks:
        raise ValueError("That playlist is empty, or YouTube didn't show its songs.")
    return data.get("title") or "YouTube Music playlist", tracks


def ytm_find(query):
    """YouTube link for the closest song (or video) to "title artist". None if nothing comes up."""
    try:
        yt = _ytmusic()
        for kind in ("songs", "videos"):
            for r in yt.search(query, filter=kind, limit=3):
                if r.get("videoId"):
                    return youtube_link(r["videoId"])
    except Exception:
        return None
    return None
