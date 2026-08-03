# DQ9 ChatGPT Local MCP
ChatGPTのDeveloper ModeからSecure MCP Tunnelを通して、Windowsホスト上のローカルMCP群を利用するためのGit管理リポジトリです。独自のAIハーネス、Responses API呼出し、モデル選択、トークン課金処理、受信HTTPサーバー、Dockerは含みません。
## 構成
```text
ChatGPT Developer Mode
  ↓ OpenAI管理のSecure MCP Tunnel
tunnel-client.exe（Windows、外向きHTTPS 443のみ）
  ↓ stdio
Node.js MCP gateway
  ├─ files__*  UTF-8限定ファイル操作、作業ディレクトリ変更、apply_patch
  ├─ dq9__*    DQ9 Test MCP
  ├─ chrome__* Chrome DevTools MCP
  └─ ghidra__* Ghidra MCP bridge
```
Chrome、Ghidra、Node.js、tunnel-clientは同じWindowsホストで動きます。ルーターのポート開放は不要です。MCP gatewayはstdioだけを使用し、待受ポートを作りません。
Chrome DevTools MCPは起動時には接続しません。最初に`dq9__prepare_test_runtime`を呼び、DQ9専用Chromeが`127.0.0.1:9222`で起動した後、gatewayがChrome MCPを遅延追加して`tools/list_changed`を通知します。`dq9__stop_test_runtime`後はChrome MCPも解除します。
## Dockerを使わない理由
Dockerは必須ではありません。今回の対象はWindows上のChrome、Ghidra、ROM、State、永続スクリプトなので、Windowsネイティブの方が`127.0.0.1`、ファイルパス、Chromeプロセス所有権をそのまま共有できます。Node.jsは4つのMCPを単一のstdio MCPへ統合するためにだけ必要です。MCPを一つだけ接続する場合や、トンネルをMCPごとに分ける場合はgatewayも不要です。
## 安全境界
- OpenAIモデルAPIを呼ぶコードと`openai` SDKはありません。
- tunnel runtime keyはSecure MCP Tunnelの制御面にだけ使用し、ソース、環境ファイル、Git、ブラウザーへ保存しません。
- Platform側ではTunnel runtime用の専用ロールと主体を作り、`Tunnels: Read + Use`だけを許可します。`Model capabilities: Request`を含む、Tunnels以外のAPI権限は許可しません。
- Ghidraの`run_ghidra_script`と`run_script_inline`はブリッジとgatewayの両方で遮断します。
- ファイルMCPにシェル、任意コマンド、削除コマンドのAPIはありません。`apply_patch`だけが固定実装として存在し、標準diffの場合も固定の`git apply`だけを起動します。
- ファイルはUTF-8だけを扱い、UTF-16、UTF-32、不正UTF-8、許可ルート外、シンボリックリンク経由の書込みを拒否します。
- Chrome CDPとGhidra HTTPはWindowsの`127.0.0.1`だけで待受させます。
## 1. 依存関係を入れる
通常のPowerShellで実行します。
```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\Install-Dependencies.ps1
```
このスクリプトはwingetでNode.js LTS、Python 3.12、Git、Google Chromeを導入し、OpenAI公式`openai/tunnel-client`の最新安定版Windows ZIPをSHA-256検証後に`.tools\tunnel-client`へ展開します。インストール後にPowerShellを開き直してください。
`apply_patch`という正体の確認できるwingetパッケージは前提にしていません。本リポジトリは専用の`files__apply_patch`を実装し、標準Unified Diffだけはwingetで導入したGitの`git apply`へ渡します。任意の実行ファイル名や引数は指定できません。
## 2. ローカル環境を初期化する
```powershell
.\scripts\windows\Initialize-LocalMcp.ps1
```
次が生成されます。
```text
config\gateway.json
config\dq9-runtime.json
.venv\
node_modules\
workspace\
.runtime\
```
生成物と秘密情報は`.gitignore`対象です。
## 3. 設定する
`config\gateway.json`でファイル操作を許可するルートと、有効にするMCPを指定します。
```json
{
  "workspaceRoots": ["../workspace"],
  "dq9Config": "./dq9-runtime.json",
  "ghidraUrl": "http://127.0.0.1:8089",
  "ghidraDebuggerUrl": "http://127.0.0.1:8099",
  "enabledServers": ["files", "dq9", "chrome", "ghidra"]
}
```
`config\dq9-runtime.json`にはChrome、ROM、State、永続スクリプト、プロファイルをWindowsパスまたは設定ファイル基準の相対パスで指定します。ROMとStateはGitへ追加しないでください。
Ghidraプラグインは`127.0.0.1:8089`、デバッガー使用時は`127.0.0.1:8099`で待受させます。SSHリレーや外部bindは不要です。
## 4. ローカル検証する
```powershell
.\scripts\windows\Test-LocalMcp.ps1
```
`doctor`は設定、Chrome、Node.js、Git、Python環境、tunnel-clientを確認します。この処理はOpenAIモデルAPIを呼びません。
## 5. Tunnel専用runtime keyを作る
OpenAI PlatformのOrganization rolesでruntime用カスタムロールを作り、runtime keyを発行する主体へ割り当てます。権限は次のように制限します。
```text
Tunnels: Read + Use
Model capabilities: Request = Off
Tunnels以外の権限 = No access
```
Tunnelを作成・編集する管理者には別ロールとして`Tunnels: Read + Manage`を付けます。長時間動かすruntime keyへManage権限やAdmin keyを渡さないでください。PlatformのRuntime API keysでキーを取得したら次を実行します。
```powershell
.\scripts\windows\Set-TunnelRuntimeKey.ps1
```
キーは既定で`%USERPROFILE%\.dq9-mcp\tunnel-runtime-key`へUTF-8、継承なしACLで保存されます。実行時だけ`CONTROL_PLANE_API_KEY`へ読み込み、終了時に元の環境値へ戻します。
この構成にはモデルAPIの呼出し口がなく、権限側でもモデル要求を拒否します。ただし、OpenAIが将来Secure MCP Tunnel自体に料金体系を設定しないことまで、このリポジトリから保証するものではありません。
## 6. Tunnelを初期化する
PlatformのTunnels画面で取得した`tunnel_id`を指定します。
```powershell
.\scripts\windows\Initialize-Tunnel.ps1 -TunnelId tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
スクリプトは次と同等の処理を行います。
```powershell
tunnel-client.exe init --sample sample_mcp_stdio_local --profile dq9-local --tunnel-id tunnel_xxx --mcp-command '"C:\Program Files\nodejs\node.exe" "C:\path\app\gateway.mjs"'
tunnel-client.exe doctor --profile dq9-local --explain
```
## 7. Tunnelを起動する
```powershell
.\scripts\windows\Run-Tunnel.ps1
```
このウィンドウを開いている間、tunnel-clientがOpenAIへ外向きHTTPS接続し、ChatGPTからのMCP要求をgatewayへstdio転送します。
## 8. ChatGPTへ接続する
ChatGPTでDeveloper Modeを有効にし、Pluginsの追加画面から接続方式`Tunnel`を選び、作成済みのTunnelまたは`tunnel_id`を選択します。検出された`files__*`、`dq9__*`、`chrome__*`、`ghidra__*`を確認してください。
## ファイル編集API
`files__set_working_directory`で、後続の相対パスの基準を許可ルート内の既存ディレクトリへ変更できます。
`files__apply_patch`は次の二形式を受け付けます。
```text
*** Begin Patch
*** Update File: src/example.js
@@
-old
+new
*** End Patch
```
```diff
diff --git a/src/example.js b/src/example.js
--- a/src/example.js
+++ b/src/example.js
@@ -1 +1 @@
-old
+new
```
`dryRun: true`で事前検査だけを行えます。バイナリパッチ、ルート外パス、`.git`内部、rename/copy形式、UTF-16/UTF-32対象は拒否されます。
## Git管理
```powershell
.\scripts\windows\Enable-GitHooks.ps1
git status --short
```
pre-commit hookはTunnel key、OpenAI形式のAPIキー、秘密鍵、証明書秘密鍵、ROM、Stateのコミットを拒否します。