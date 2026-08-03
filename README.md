# DQ9 ChatGPT Local MCP
ChatGPT Developer ModeからOpenAI公式Secure MCP Tunnelを通して、Windows上の個人用MCPへ接続するリポジトリです。独自AIハーネス、Responses API、モデル呼出し、課金処理、公開MCP URL、受信インターネットポートは実装しません。
## 最初に読むもの
導入とruntime API keyの手順は`INSTALL.md`に分離しました。一括インストールPowerShell、管理者権限スクリプト、キー保存スクリプトは廃止しています。
## 構成
```text
ChatGPT Developer Mode（自分のWorkspaceだけ）
  ↓ OpenAI Secure MCP Tunnel
tunnel-client.exe（外向きHTTPSのみ）
  ↓ stdio
Node.js gateway
  ├─ files__*  明示許可Workspaceだけを読む、rg検索、編集、ファイル転送
  ├─ dq9__*    DQ9 Test MCP
  ├─ chrome__* Chrome DevTools MCP
  └─ ghidra__* Ghidra MCP bridge
```
gatewayとファイルMCPはstdioだけを使用し、公開HTTPサーバーを作りません。Secure MCP TunnelはローカルMCPを公開インターネットへ出さずに接続する仕組みです。
## 個人専用
このMCPは任意コード実行能力を含むローカル開発環境向けです。Tunnelの関連付け先は自分のPlatform Organizationと自分のChatGPT Workspaceだけに限定し、Pluginの公開申請、他人への配布、共有Workspaceへの登録を行わないでください。`config/gateway.json`は`"privateUseOnly": true`がないと起動しません。
## ファイル境界
`workspaceRoots`に書いたディレクトリでも、直下に`.chatgpt-local-mcp-root`がなければ拒否します。ユーザープロファイル全体やその上位ディレクトリは許可できません。`.ssh`、`.git`、`.codex`、`.env`、秘密鍵、資格情報らしいファイルはルート内にあっても読みません。
`files__search_text`は固定引数で`rg`を起動します。任意コマンドや任意引数は渡せません。`files__read_file_chunk`と`files__write_file`は16MiB以下のファイル転送用で、ROM、State、鍵、実行ファイル、PowerShellやバッチは拒否します。DQ9の`run_cases`も同じ明示許可Workspace内のUTF-8 JSONだけを読みます。
## OS権限の限界
パス検査はChatGPTへ公開するファイルAPIを制限しますが、同じWindowsユーザーで動くMCPプログラム自体をOSサンドボックス化するものではありません。ownerアカウントのSSH鍵、Discord、GitHub、ChatGPT情報を本当に隔離するには、専用の標準Windowsユーザーでこのリポジトリ、Chrome専用プロファイル、Ghidra、ROM、Stateだけを管理してください。管理者PowerShellでは起動しないでください。
## 公式資料
https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
https://developers.openai.com/plugins/deploy/connect-chatgpt
https://github.com/openai/tunnel-client/releases/latest
