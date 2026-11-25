"""Reading people's own rating spreadsheets and lining their rows up with AniSongDB songs."""
import csv
import io
import re

from sources import parse_theme_line, similar, simplify, type_code

ROLES = ("ignore", "anime", "song", "artist", "songartist", "score", "season", "type", "link")
HEADER_WORDS = {
    "anime": ("anime", "show", "series", "anime name", "show name"),
    "song": ("song", "track", "song name", "title", "song title", "opening", "ending", "theme"),
    "artist": ("artist", "singer", "performer", "band", "artists", "by"),
    "score": ("score", "rating", "rate", "points", "grade", "mark", "/10", "out of"),
    "season": ("season", "cour", "vintage"),
    "type": ("type", "kind", "op/ed", "op / ed"),
    "link": ("link", "url", "youtube", "youtube link", "yt", "video"),
}
# "Grand Blue Ending 4", "Naruto OP3", "Kingdom ED 7", "Op.2", "Opening Theme 2", "#4"
SLOT = re.compile(r"(?:^|\s|\b)(op|ed|opening|ending|insert(?: song)?)(?:\s*theme)?\s*[#.]?\s*(\d+)?\s*$", re.I)
SEASON_WORDS = {"winter": "Winter", "spring": "Spring", "summer": "Summer", "fall": "Fall", "autumn": "Fall"}
SEASON_ROW = re.compile(r"^\s*(winter|spring|summer|fall|autumn)\b[\s,\-]*((?:19|20)\d\d)?\s*$", re.I)


# ------------------------------------------------------------------ reading
def read_upload(filename, data):
    """Returns [{"name": sheet, "rows": [[cell, ...]]}] for csv/tsv/txt or xlsx."""
    name = (filename or "").lower()
    if name.endswith((".xlsx", ".xlsm")):
        try:
            import openpyxl
        except ImportError:
            raise ValueError("Reading Excel files needs openpyxl - run: pip install openpyxl")
        try:
            book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except Exception:
            raise ValueError("Couldn't open that Excel file.")
        sheets = []
        for ws in book.worksheets:
            rows = [["" if v is None else str(v).strip() for v in row] for row in ws.iter_rows(values_only=True)]
            rows = trim(rows)
            if rows:
                sheets.append({"name": ws.title, "rows": rows})
        if not sheets:
            raise ValueError("That workbook looks empty.")
        return sheets
    if isinstance(data, bytes):
        for enc in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                text = data.decode(enc)
                break
            except UnicodeDecodeError:
                continue
    else:
        text = data
    rows = read_text(text)
    if not rows:
        raise ValueError("Couldn't find any rows in that.")
    return [{"name": filename or "Pasted rows", "rows": rows}]


def read_text(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    if not text.strip():
        return []
    sample = text[:5000]
    # pasted from google sheets / excel is tab separated
    if "\t" in sample and sample.count("\t") >= sample.count("\n") * 0.5:
        # a plain paste keeps "Song" by Artist as typed; only treat quotes as CSV quoting when
        # the cells really were escaped ("""Song"" by Artist")
        escaped = looks_escaped(sample)
        reader = csv.reader(io.StringIO(text), delimiter="\t", quoting=csv.QUOTE_MINIMAL if escaped else csv.QUOTE_NONE)
        return trim([[c.strip() for c in row] for row in reader])
    try:
        delim = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        delim = ","
    rows = [[c.strip() for c in row] for row in csv.reader(io.StringIO(text), delimiter=delim)]
    return trim(rows)


def looks_escaped(sample):
    # Google Sheets wraps cells that contain quotes: '"""Song"" by X"'. A plain paste is just '"Song" by X'.
    quoted = [c for line in sample.split("\n") for c in line.split("\t") if c.startswith('"')]
    if not quoted:
        return False
    wrapped = sum(1 for c in quoted if re.fullmatch(r'"(?:[^"]|"")*"', c))
    return wrapped >= len(quoted) * 0.8


def trim(rows):
    rows = [r for r in rows if any(c.strip() for c in r)]
    width = max((len(r) for r in rows), default=0)
    rows = [r + [""] * (width - len(r)) for r in rows]
    # drop columns that are empty everywhere
    keep = [i for i in range(width) if any(r[i].strip() for r in rows)]
    return [[r[i] for i in keep] for r in rows][:5000]


# ----------------------------------------------------------------- guessing
def number(cell):
    try:
        return float(str(cell).strip().replace(",", "."))
    except ValueError:
        return None


def season_of(cell):
    m = SEASON_ROW.match(cell or "")
    return (SEASON_WORDS[m.group(1).lower()], m.group(2)) if m else None


def is_season_row(row):
    filled = [c for c in row if c.strip()]
    return len(filled) == 1 and season_of(filled[0]) is not None


def guess(rows, filename=""):
    """Best guess at which column is what, plus year, score scale and song type."""
    header = 0 < len(rows) and looks_like_header(rows[0])
    body = [r for r in rows[1 if header else 0:] if not is_season_row(r)]
    width = len(rows[0]) if rows else 0
    roles = ["ignore"] * width

    if header:
        for i, cell in enumerate(rows[0]):
            role = header_role(cell)
            if role and role not in roles:
                roles[i] = role

    def column(i):
        return [r[i] for r in body if i < len(r) and r[i].strip()]

    for i in range(width):
        values = column(i)
        if not values:
            continue
        combined = sum(1 for v in values if parse_theme_line(v) and parse_theme_line(v)[2]) / len(values)
        if roles[i] in ("song", "ignore") and combined >= 0.6 and "songartist" not in roles:
            roles[i] = "songartist"
            continue
        if roles[i] == "ignore" and "link" not in roles and sum(v.lower().startswith("http") for v in values) / len(values) >= 0.6:
            roles[i] = "link"
            continue
        nums = [number(v) for v in values]
        if all(n is not None for n in nums):
            sequential = all(b == a + 1 for a, b in zip(nums, nums[1:])) and len(nums) > 3
            if roles[i] in ("ignore", "score") and not sequential and "score" not in roles[:i] + roles[i + 1:] \
                    and max(nums) <= 100 and min(nums) >= 0:
                roles[i] = "score"
            elif sequential and roles[i] != "score":
                roles[i] = "ignore"
    # whatever text columns are left: longest one is the anime, next the song
    if "anime" not in roles or ("song" not in roles and "songartist" not in roles):
        texts = []
        for i in range(width):
            values = column(i)
            if roles[i] == "ignore" and values and sum(number(v) is None for v in values) / len(values) > 0.8:
                texts.append((sum(len(v) for v in values) / len(values), i))
        texts.sort(reverse=True)
        for _, i in texts:
            if "anime" not in roles:
                roles[i] = "anime"
            elif "song" not in roles and "songartist" not in roles:
                roles[i] = "song"

    year = ""
    m = re.search(r"(?:19|20)\d\d", filename or "")
    if m:
        year = m.group()
    scores = [number(r[roles.index("score")]) for r in body if "score" in roles] if "score" in roles else []
    scores = [s for s in scores if s is not None]
    top = max(scores, default=10)
    out_of = 100 if top > 10 else 5 if top <= 5 and len(scores) >= 10 else 10
    if header and "score" in roles:  # "Score /5", "Rating (out of 100)"
        m = re.search(r"(?:/|out of)\s*(5|10|100)\b", rows[0][roles.index("score")].lower())
        if m and float(m.group(1)) >= top:
            out_of = int(m.group(1))
    kind = ""
    if re.search(r"(?<![a-z])(op|ops|openings?)(?![a-z])", (filename or "").lower()):
        kind = "OP"
    elif re.search(r"(?<![a-z])(ed|eds|endings?)(?![a-z])", (filename or "").lower()):
        kind = "ED"
    return {"header": header, "roles": roles, "year": year, "outOf": out_of, "type": kind}


def header_role(cell):
    """'Anime Name' -> anime, 'Score /10' -> score. Only short cells count, so 'Grand Blue ED1' isn't a heading."""
    low = re.sub(r"\s+", " ", cell.strip().lower())
    if not low or len(low) > 30 or '"' in low or SLOT.search(low) and SLOT.search(low).group(2):
        return None
    for role, words in HEADER_WORDS.items():
        for w in words:
            if low == w or (len(w) > 2 and re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", low)):
                return role
    return None


def looks_like_header(row):
    cells = [c.strip() for c in row if c.strip()]
    if not cells or any(number(c) is not None for c in cells):
        return False
    if any(parse_theme_line(c) or len(c) > 30 for c in cells):  # a real song row, not headings
        return False
    return any(header_role(c) for c in cells)


# -------------------------------------------------------------- turning rows into items
def split_song(cell):
    """'"Enter" by L.E.I.' / 'Enter by L.E.I.' / 'Enter - L.E.I.' / 'Enter'"""
    cell = (cell or "").strip()
    parsed = parse_theme_line(cell)
    if parsed:
        return parsed[1], parsed[2]
    m = re.match(r"^(.+?)\s+by\s+(.+)$", cell, re.I)
    if m:
        return unquote(m.group(1)), m.group(2).strip()
    return unquote(cell), ""


def unquote(text):
    """Takes off one pair of wrapping quotes, so 'Don't say "lazy"' keeps its own."""
    text = text.strip()
    if len(text) >= 2 and text[0] in '"“' and text[-1] in '"”':
        text = text[1:-1].strip()
    return text


def drop_tags(name):
    return re.sub(r"\s*\((?:\d+(?:/\d+)*|v\d+|rebroadcast|movie|tv)\)", "", name, flags=re.I).strip()


def find_slot(name):
    """('ED', 4) for 'Grand Blue Ending 4', ('OP', 1) for 'Naruto OP', None if it doesn't say."""
    m = SLOT.search(drop_tags(name))
    if not m:
        return None
    word = m.group(1).lower()
    code = "OP" if word.startswith("op") else "ED" if word.startswith(("ed", "end")) else "IN"
    return code, int(m.group(2) or 1)


def clean_anime(name):
    """Drops the bits people add to tell entries apart: '(2)', '(59/72)', 'EP 8 OP', 'Ending 4', '(Rebroadcast)'."""
    name = drop_tags(name)
    name = re.sub(r"\s+EP\s*\d+.*$", "", name, flags=re.I)
    name = SLOT.sub("", name)
    return re.sub(r"\s+", " ", name).strip(" -:")


def build_items(rows, mapping):
    """Applies the column mapping. Returns one dict per row worth looking up."""
    roles, year = mapping["roles"], str(mapping.get("year") or "").strip()
    out_of = float(mapping.get("outOf") or 10)
    start = 1 if mapping.get("header") else 0
    col = {r: roles.index(r) for r in ROLES if r in roles and r != "ignore"}
    season = ""
    items = []
    for n, row in enumerate(rows[start:], start=start):
        if is_season_row(row):
            s, y = season_of(next(c for c in row if c.strip()))
            season = f"{s} {y or year}".strip() if (y or year) else ""
            continue
        get = lambda role: row[col[role]].strip() if role in col and col[role] < len(row) else ""
        anime = get("anime")
        if "songartist" in col:
            song, artist = split_song(get("songartist"))
        elif "artist" in col:  # artist has its own column, so leave titles like "Stand by Me" alone
            song, artist = unquote(get("song")), get("artist")
        else:
            song, artist = split_song(get("song")) if get("song") else ("", "")
        raw = number(get("score")) if get("score") else None
        score = None
        if raw is not None and 0 <= raw <= out_of:
            score = round(raw / out_of * 10, 2)
        row_season = season
        if get("season"):
            s = season_of(get("season"))
            if s:
                row_season = f"{s[0]} {s[1] or year}" if (s[1] or year) else ""
        kind = mapping.get("type") or ""
        slot = find_slot(anime)  # "Naruto OP3", "Grand Blue Ending 4", "Gintama ED1 (Rebroadcast)"
        if slot:
            kind = kind or slot[0]
        t = get("type").lower()
        if t:
            kind = "OP" if t.startswith("op") else "ED" if t.startswith(("ed", "end")) else "IN" if t.startswith("in") else kind
        if not anime and not song:
            continue  # blank or a totals row
        link = get("link") if re.match(r"https?://", get("link"), re.I) else ""
        items.append({"row": n + 1, "anime": anime, "animeClean": clean_anime(anime), "song": song, "artist": artist,
                      "rawScore": get("score"), "score": score, "season": row_season, "type": kind, "slot": slot,
                      "link": link})
    return items


# -------------------------------------------------------------- matching
def title_sim(a, b):
    a, b = simplify(a), simplify(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    short, long_ = sorted((a, b), key=len)
    if short in long_ and len(short) / len(long_) >= 0.6:
        return 0.95
    from difflib import SequenceMatcher
    return SequenceMatcher(None, a, b).ratio()


def slot_of(song):
    code = type_code(song["songType"])
    m = re.search(r"(\d+)", song["songType"])
    return code, int(m.group(1)) if m else 1


def _scored(item, candidates, min_title=0.0):
    """(candidate, title, anime, artist, same type, same slot) for every song worth a look.
    A row's OP/ED/Insert label is only a hint: lists often call everything an OP, or AniSongDB files a
    theme as an insert song, so a different type just has to be backed by a near-exact title."""
    anime = item.get("animeClean") or clean_anime(item.get("anime") or "")
    for c in candidates:
        t = title_sim(item["song"], c["songName"])
        if t < min_title:
            continue
        kind = not item.get("type") or type_code(c["songType"]) == item["type"]
        n = max(similar(anime, c["anime"]), similar(anime, c.get("animeJP"))) if anime else 0
        a = similar(item["artist"], c["artist"]) if item.get("artist") else 0
        slot = bool(item.get("slot")) and tuple(item["slot"]) == slot_of(c)
        yield c, t, n, a, kind, slot


def best_match(item, candidates):
    best, best_score, sure = None, 0, False
    for c, t, n, a, kind, slot in _scored(item, candidates, 0.4):
        # same anime, same OP/ED number and the same artist is good evidence even if the title is spelt differently
        ok = (t >= 0.85 and max(n, a) >= 0.6) or (t >= 0.6 and n >= 0.8 and a >= 0.7) or (slot and n >= 0.8 and a >= 0.7)
        if not ok or (not kind and t < 0.95):
            continue
        total = 2 * t + n + a + 0.3 * kind
        if total > best_score:
            best, best_score, sure = c, total, kind and t >= 0.95 and max(n, a) >= 0.8
    return (best, "sure" if sure else "likely") if best else (None, None)


SEASON_ORDER = ["Winter", "Spring", "Summer", "Fall"]


def nearby_seasons(label, back=3):
    """'Winter 2025' -> itself and the three before it, for shows that started earlier."""
    m = re.match(r"(Winter|Spring|Summer|Fall) ((?:19|20)\d\d)$", label or "")
    if not m:
        return []
    i, year = SEASON_ORDER.index(m.group(1)), int(m.group(2))
    out = []
    for k in range(back + 1):
        j = i - k
        out.append(f"{SEASON_ORDER[j % 4]} {year + j // 4}")
    return out


def auto_pick(item, candidates):
    """Looser than best_match, for the Auto-pick button: the closest song wins as long as it's
    plausibly the same one. These get marked so they're easy to look over."""
    best, best_score = None, 0
    for c, t, n, a, kind, slot in _scored(item, candidates):
        if not (t >= 0.75 or (t >= 0.5 and max(n, a) >= 0.6) or (slot and n >= 0.8 and a >= 0.5)):
            continue
        if not kind and t < 0.85:
            continue
        total = 3 * t + n + a + 0.5 * slot + 0.5 * kind
        if total > best_score:
            best, best_score = c, total
    return best


GOOGLE = re.compile(r"^https?://docs\.google\.com/spreadsheets/d/(e/)?([A-Za-z0-9_-]{20,})")


def google_export_url(link):
    """A normal or 'published to the web' Google Sheets link -> its download-as-Excel address (all tabs)."""
    m = GOOGLE.match((link or "").strip())
    if not m:
        return None
    if m.group(1):
        return f"https://docs.google.com/spreadsheets/d/e/{m.group(2)}/pub?output=xlsx"
    return f"https://docs.google.com/spreadsheets/d/{m.group(2)}/export?format=xlsx"


# ---------------------------------------------------- YouTube video titles
NOISE = re.compile(r"""\s*[(\[【]\s*(?:[^)\]】]*\b(?:tv[\s-]*size|tv\s*ver(?:sion)?|official|music\s*video|mv|m/v|lyrics?|lyric\s*video|audio|full|
                       full\s*ver(?:sion)?|creditless|nc(?:op|ed)|hd|hq|4k|1080p|remaster(?:ed)?|visuali[sz]er|anime\s*edit)\b[^)\]】]*)[)\]】]""",
                   re.I | re.X)
THEME = re.compile(r"""(?:\b(?:from|tv\s*anime|anime)\s*)?["“「『]?([^"”」』()\[\]【】]{2,80}?)["”」』]?\s*
                       (?:\(|\b)(?:opening|ending|op|ed|insert\s*song|theme\s*song)\s*(?:theme)?\s*(\d*)\b""", re.I | re.X)
CHANNEL = re.compile(r"\s*(?:-\s*topic|vevo|official(?:\s*(?:channel|youtube))?|channel|music)\s*$", re.I)


def video_row(title, artists, album=""):
    """A YouTube title like 'Vaundy - Hashire SAKAMOTO (TV Size) [SAKAMOTO DAYS Opening]' as
    (song, artist, anime hint, OP/ED/IN or "")."""
    artist = ", ".join(CHANNEL.sub("", a).strip() for a in artists if a) if artists else ""
    hint = kind = ""
    title = re.sub(r"\s+(?:official\s+)?(?:music\s+video|mv|lyrics?(?:\s+video)?|audio|video)\s*$", "", title, flags=re.I)
    by = re.search(r'["“]([^"”]+)["”]\s*by\s+([^()\[\]【】]+)', title)
    if by:  # fan uploads: 'Mashle Season 2 - Opening Full "Bling-Bang-Bang-Born" by Creepy Nuts'
        before = title[:by.start()]
        m = THEME.search(before)
        hint = (m.group(1) if m else re.sub(r"[-|:]\s*$", "", before)).strip(" -|:")
        return by.group(1).strip(), by.group(2).strip(), hint, "OP" if re.search(r"\bop|opening", before, re.I) else \
            "ED" if re.search(r"\bed\b|ending", before, re.I) else ""
    quoted = re.findall(r"[「『]([^」』]+)[」』]", title)
    if quoted:  # 'YOASOBI「アイドル」' or 'TVアニメ「Show」OPテーマ「Song」': the last one is the song
        if len(quoted) > 1:
            hint = quoted[0]
        kind = title
        return quoted[-1].strip(), artist, hint, "OP" if re.search(r"op|オープニング", kind, re.I) else \
            "ED" if re.search(r"ed|エンディング", kind, re.I) and len(quoted) > 1 else ""
    for part in re.findall(r"[(\[【]([^)\]】]+)[)\]】]", title):  # the anime usually sits in brackets
        m = THEME.search(part)
        if m and m.group(1).strip():
            hint, kind = m.group(1).strip(" -:"), m.group(0)
            title = title.replace(part, " ")
            break
    song = NOISE.sub(" ", title)
    song = re.sub(r"[(\[【]\s*[)\]】]", " ", song)
    song = re.sub(r"\s*[(\[]\s*(?:feat\.?|ft\.?|with)\s[^)\]]*[)\]]", " ", song, flags=re.I)  # (feat. X)
    if " - " in song:  # "Artist - Song" or "Song - Artist"
        left, right = (x.strip() for x in song.split(" - ", 1))
        if artist and similar_text(left, artist) >= 0.6:
            song = right
        elif artist and similar_text(right, artist) >= 0.6:
            song = left
        elif not artist:
            artist, song = left, right
    song = re.sub(r"\s+", " ", song).strip(" -|/").strip("「」『』\"“”")
    if not hint and album and album.lower() not in (song.lower(), title.lower()):
        hint = ""  # albums on YouTube Music are usually the single, not the anime
    kind = "OP" if re.search(r"\b(?:op|opening)", kind, re.I) else "ED" if re.search(r"\b(?:ed|ending)", kind, re.I) \
        else "IN" if re.search(r"insert", kind, re.I) else ""
    return song, artist, hint, kind


def similar_text(a, b):
    from difflib import SequenceMatcher
    a, b = simplify(a), simplify(b)
    return SequenceMatcher(None, a, b).ratio() if a and b else 0.0
