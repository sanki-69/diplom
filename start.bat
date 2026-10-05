@echo off
echo ============================================
echo   AI Shop - Start Script
echo ============================================

:: MongoDB runs as the Windows service "MongoDB" (installed with MongoDB).
:: Its data folder belongs to the service account, so launching mongod.exe
:: directly as a normal user fails with "Access is denied". We start the
:: service instead; that needs administrator rights the first time.

echo [1/3] Checking MongoDB...
netstat -an | find "127.0.0.1:27017" | find "LISTENING" >nul
if not errorlevel 1 (
    echo       MongoDB already running.
    goto backend
)

sc query MongoDB >nul 2>&1
if errorlevel 1 (
    echo       [!] MongoDB service is not installed. Install MongoDB Server first.
    goto backend
)

net start MongoDB >nul 2>&1
if errorlevel 1 (
    echo       [!] Could not start the MongoDB service.
    echo           Right-click start.bat and choose "Run as administrator",
    echo           or run this once in an admin terminal:  net start MongoDB
    echo           Also check free disk space - MongoDB stops when the disk is full.
    echo           The backend will still start, but login, history and admin won't work.
) else (
    echo       MongoDB service started on port 27017.
)

:backend
echo [2/3] Starting Python backend...
cd /d "%~dp0backend"
if not exist "venv\Scripts\uvicorn.exe" (
    echo       [!] backend\venv is missing. Create it with:
    echo           python -m venv venv ^&^& venv\Scripts\pip install -r requirements.txt
    goto frontend
)
start "Backend" cmd /k "venv\Scripts\uvicorn main:app --host 127.0.0.1 --port 8000 --reload"

:frontend
echo [3/3] Starting Frontend...
cd /d "%~dp0extension"
start "Frontend" cmd /k "npm run dev"

echo.
echo ============================================
echo   All services started!
echo   Frontend : http://localhost:5173
echo   Backend  : http://localhost:8000
echo   Health   : http://localhost:8000/health
echo   Admin    : http://localhost:5173/admin
echo ============================================
pause
