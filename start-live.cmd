@echo off
node server.js 1>server.log 2>server.err
echo exited code=%ERRORLEVEL% at %DATE% %TIME%>> death.log
