@echo off
cd /d "%~dp0"
where python >nul 2>nul || (echo Python isn^'t installed or isn^'t on PATH. Get it from python.org and tick "Add python.exe to PATH". & pause & exit /b)
python -m pip install -q -r requirements.txt
start "" http://127.0.0.1:5000
python app.py
pause
