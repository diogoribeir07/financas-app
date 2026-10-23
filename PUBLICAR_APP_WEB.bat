@echo off
chcp 65001 >nul
title Finanças Pessoais - Publicar na Web (GitHub Pages)

echo ========================================================
echo       Financas Pessoais - Publicar / Atualizar na Web
echo ========================================================
echo.

cd /d "%~dp0"

git rev-parse --is-inside-work-tree >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [1/4] A inicializar repositorio Git local...
    git init -b main
)

git remote get-url origin >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [2/4] A configurar o repositorio remoto...
    git remote add origin https://github.com/diogoribeir07/financas-app.git
) else (
    git remote set-url origin https://github.com/diogoribeir07/financas-app.git
)

echo [3/4] A preparar e gravar ficheiros...
git add .
git commit -m "Publicar versao web com sincronizacao 24/7" >nul 2>&1

echo [4/4] A enviar ficheiros para o GitHub...
git push -u origin main
if %ERRORLEVEL% NEQ 0 (
    echo A tentar sincronizar historico inicial...
    git push -u origin main --force
)

echo.
echo ========================================================
if %ERRORLEVEL% EQU 0 (
    echo Envio concluido com sucesso!
    echo.
    echo O teu link Web (GitHub Pages):
    echo https://diogoribeir07.github.io/financas-app/
    echo.
    echo Agora volta ao teu browser e em Settings -> Pages:
    echo 1. Atualiza a pagina (F5)
    echo 2. Em 'Branch', seleciona 'main' e '/ (root)'
    echo 3. Clica em 'Save'
) else (
    echo.
    echo AVISO: Ocorreu um erro no envio para o GitHub.
    echo Possiveis motivos:
    echo 1. O repositorio 'financas-app' ainda nao foi criado: https://github.com/new
    echo 2. O repositorio esta como 'Private' (muda para 'Public' em Settings -> Danger Zone)
    echo 3. O Git precisa de autorizacao (faz login no browser se abrir uma janela)
)
echo ========================================================
echo.
pause
