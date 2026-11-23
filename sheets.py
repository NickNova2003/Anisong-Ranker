"""Reading people's own rating spreadsheets and lining their rows up with AniSongDB songs."""
import csv
import io
import re

from sources import parse_theme_line, similar, simplify, type_code

ROLES = ("ignore", "anime", "song", "artist", "songartist", "score", "season", "type")
HEADER_WORDS = {
    "anime": ("anime", "show", "series"),
    "song": ("song", "track", "opening", "ending", "theme", "op", "ed"),
    "artist": ("artist", "singer", "performer", "band", "by"),
    "score": ("score", "rating", "rate", "points", "grade", "mark", "/10", "out of"),
    "season": ("season", "cour"),
    "type": ("type", "kind"),
}
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
    delim = "\t" if sample.count("\t") >= sample.count("\n") * 0.5 and "\t" in sample else None
    if not delim:
        try:
            delim = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
        except csv.Error:
            delim = ","
    rows = [[c.strip() for c in row] for row in csv.reader(io.StringIO(text), delimiter=delim)]
    return trim(rows)


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
            low = cell.strip().lower()
            for role, words in HEADER_WORDS.items():
                if role not in roles and any(re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", low) for w in words):
                    roles[i] = role
                    break

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


def looks_like_header(row):
    cells = [c.strip().lower() for c in row if c.strip()]
    if not cells or any(number(c) is not None for c in cells):
        return False
    return any(any(re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", c) for ws in HEADER_WORDS.values() for w in ws)
               for c in cells) or (len(cells) >= 2 and all(len(c) <= 20 for c in cells))


# -------------------------------------------------------------- turning rows into items
def split_song(cell):
    """'"Enter" by L.E.I.' / 'Enter by L.E.I.' / 'Enter - L.E.I.' / 'Enter'"""
    cell = (cell or "").strip()
    parsed = parse_theme_line(cell)
    if parsed:
        return parsed[1], parsed[2]
    m = re.match(r"^(.+?)\s+by\s+(.+)$", cell, re.I)
    if m:
        return m.group(1).strip(' "“”'), m.group(2).strip()
    return cell.strip(' "“”'), ""


def clean_anime(name):
    """Drops the bits people add to tell entries apart: '(2)', '(59/72)', 'EP 8 OP', '(Rebroadcast)'."""
    name = re.sub(r"\s+EP\s*\d+.*$", "", name, flags=re.I)
    name = re.sub(r"\s+(OP|ED)\s*\d*\s*$", "", name, flags=re.I)
    name = re.sub(r"\s*\((?:\d+(?:/\d+)*|v\d+|rebroadcast|movie|tv)\)", "", name, flags=re.I)
    return re.sub(r"\s+", " ", name).strip()


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
        else:
            song, artist = split_song(get("song")) if get("song") else ("", "")
            artist = get("artist") or artist
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
        slot = None
        m = re.search(r"\b(OP|ED)\s*(\d+)?\s*$", anime, re.I)  # "Naruto OP3"
        if m:
            slot = (m.group(1).upper(), int(m.group(2) or 1))
            kind = kind or slot[0]
        t = get("type").lower()
        if t:
            kind = "OP" if t.startswith("op") else "ED" if t.startswith(("ed", "end")) else "IN" if t.startswith("in") else kind
        if not anime and not song:
            continue  # blank or a totals row
        items.append({"row": n + 1, "anime": anime, "animeClean": clean_anime(anime), "song": song, "artist": artist,
                      "rawScore": get("score"), "score": score, "season": row_season, "type": kind, "slot": slot})
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


def best_match(item, candidates):
    best, best_score, best_parts = None, 0, None
    anime = clean_anime(item["anime"])
    for c in candidates:
        if item["type"] and type_code(c["songType"]) != item["type"]:
            continue
        t = title_sim(item["song"], c["songName"])
        if t < 0.4:
            continue
        n = max(similar(anime, c["anime"]), similar(anime, c.get("animeJP"))) if anime else 0
        a = similar(item["artist"], c["artist"]) if item["artist"] else 0
        # same anime, same OP/ED number and the same artist is good evidence even if the title is spelt differently
        same_slot = item.get("slot") and tuple(item["slot"]) == slot_of(c) and n >= 0.8 and a >= 0.7
        if not ((t >= 0.85 and (n >= 0.6 or a >= 0.6)) or (t >= 0.6 and n >= 0.8 and a >= 0.7) or same_slot):
            continue
        total = 2 * t + n + a
        if total > best_score:
            best, best_score, best_parts = c, total, (t, n, a)
    if not best:
        return None, None
    t, n, a = best_parts
    return best, ("sure" if t >= 0.95 and (n >= 0.8 or a >= 0.8) else "likely")


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
