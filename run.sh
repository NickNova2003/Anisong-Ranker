#!/usr/bin/env sh
cd "$(dirname "$0")"
PY=python3
command -v $PY >/dev/null 2>&1 || PY=python
$PY -m pip install -q -r requirements.txt || { echo "Couldn't install the requirements - is Python 3.9+ installed?"; exit 1; }
( sleep 2; command -v xdg-open >/dev/null 2>&1 && xdg-open http://127.0.0.1:5000 || open http://127.0.0.1:5000 ) >/dev/null 2>&1 &
$PY app.py
