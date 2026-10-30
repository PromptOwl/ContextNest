@echo off
rem `ctx` for Claude on Windows: the CLI installed with this plugin (see bin/ctx).
set "CN_CLI=%~dp0..\node_modules\@promptowl\contextnest-cli\dist\index.js"
if exist "%CN_CLI%" (node "%CN_CLI%" %*) else (npx -y @promptowl/contextnest-cli %*)
