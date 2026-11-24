# Nick's AniSong Ranker

A local web app for rating anime openings and endings. Search [AniSongDB](https://anisongdb.com),
build playlists, play songs (audio or video), score them, and see your stats. Import your old
ratings from a spreadsheet or Google Sheet, and share rankings with friends.

![Python](https://img.shields.io/badge/python-3.9%2B-blue)

## Running it

You need [Python 3.9 or newer](https://www.python.org/downloads/). On Windows, tick
"Add python.exe to PATH" when installing.

**Windows:** double-click `run.bat`.

**Mac / Linux:**
```
chmod +x run.sh
./run.sh
```

**Or by hand, anywhere:**
```
pip install -r requirements.txt
python app.py
```

Then open http://127.0.0.1:5000 (the launchers open it for you).

**MP4 downloads** need ffmpeg (optional): `winget install Gyan.FFmpeg` on Windows,
`brew install ffmpeg` on Mac, or your package manager on Linux.

## What's where

- `anisong.db` holds your playlists and scores. It's created on first run. Back it up, and keep
  it when you update the app. It's in `.gitignore` so it never ends up on GitHub.
- `downloads/` is where "Download all" saves songs.

## How it works

- **Songs** come from AniSongDB. Brand-new seasons it hasn't added yet come from
  [AnimeThemes](https://animethemes.moe) and MyAnimeList (via [Jikan](https://jikan.moe)), and
  get swapped for the AniSongDB version automatically later, keeping your scores.
- **Covers and genres** come from [AniList](https://anilist.co).
- **Scores** are one per song: rate it anywhere and it's the same everywhere. *All songs* collects
  everything you've rated or added to a playlist.
- **Friends' playlists** (the playlist file from Share) come in with their scores, shown next to
  yours. Importing one never changes your own scores.
- **Spreadsheet import** works with most layouts: separate columns, `"Song" by Artist` cells,
  `Naruto OP3` / `Grand Blue Ending 4` style names, season headings, and scores out of 5, 10 or 100.

AniSongDB switches off song and artist name searches while AMQ ranked games are on (a few short
windows a day). Season searches, artist/anime clicks and imports by anime still work then.

## Phone app

`phone/` is an offline companion for Android: listen to your playlists and rate them with no
internet (on a plane, say), then send the scores back. It's hosted free with GitHub Pages.

**Set up once**
1. On GitHub, open this repo → **Settings** → **Pages**.
2. Under *Build and deployment*, set Source to **Deploy from a branch**, pick **main** and
   **/ (root)**, and press **Save**.
3. After a minute the page shows your site address. Your phone app is that address plus `phone/`,
   e.g. `https://yourname.github.io/anisong-ranker/phone/`.
4. Open it in Chrome on your phone, tap **⋮** → **Add to Home screen** (or **Install app**).

**Using it**
1. PC app: **Send to phone**, tick the playlists, save the file and send it to your phone
   (WhatsApp, Drive, email).
2. Phone app: **Sync** → **Import from PC**. Songs download over the internet straight away.
3. Listen and rate anywhere. Custom songs (YouTube links) can't download, so use **⋮ → Add audio
   file** on them to pick an MP3 from your phone.
4. Phone app: **Sync** → **Send scores to PC**, then open that file in the PC app with **Import**.
   If a song was changed on both, the newer change wins.

Your scores and songs stay on your phone. Nothing is uploaded anywhere.

## Thanks

All song data belongs to AniSongDB, AnimeThemes, MyAnimeList and AniList, and the songs to their
owners. This is a personal, non-commercial tool. Please keep the request rates polite.
