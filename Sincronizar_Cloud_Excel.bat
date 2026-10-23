@echo off
chcp 65001 >nul
title Sincronizar Cloud 24/7 com Gestao_Financeira.xlsx
cd /d "%~dp0"
python -m sync_service.cloud_sync
echo.
pause
