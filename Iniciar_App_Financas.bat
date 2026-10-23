@echo off
chcp 65001 >nul
title Finanças Pessoais - Servidor Local e Excel Sync
cd /d "%~dp0"
echo =================================================================
echo A iniciar Aplicacao de Financas Pessoais + Sincronizacao Excel
echo =================================================================
start "" "http://localhost:8000"
python -m sync_service.server
pause
