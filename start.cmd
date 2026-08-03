@echo off
setlocal

set "mcp=command=node app/gateway.mjs --config config/gateway.toml,channel=main"

.\.tools\tunnel-client\tunnel-client.exe doctor --mcp.command="%mcp%" --explain || exit /b 1
.\.tools\tunnel-client\tunnel-client.exe run --mcp.command="%mcp%" || exit /b 1

endlocal
exit /b 0