# INSTALL.md
この手順はWindows 11向けです。管理者PowerShellではなく、通常のPowerShellを使います。最も安全なのは、このMCP専用の標準Windowsユーザーを作り、そのユーザーにはowner側の`.ssh`、Discord、GitHub CLI、Codex、ChatGPT関連ファイルへの権限を与えない構成です。
## 0. これは何のキーか
ここで使うのはOpenAI Secure MCP Tunnel用のruntime API keyです。モデルAPIを呼ぶためのキーではありません。このリポジトリはResponses APIやChat Completions APIを呼びません。runtime keyはファイルへ保存せず、Tunnelを初期化または起動するときにNode.jsがマスク入力で一時的に受け取ります。
## 1. 必要なソフトを一つずつ入れる
次を一行ずつ実行します。巨大な一括インストールスクリプトはありません。
```powershell
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Git.Git
winget install -e --id BurntSushi.ripgrep.MSVC
winget install -e --id Python.Python.3.12
winget install -e --id Google.Chrome
```
PowerShellを閉じて開き直し、各コマンドを確認します。
```powershell
node --version
npm --version
git --version
rg --version
py -3.12 --version
```
`node --version`は`v24.17.0`以上の`v24`であることを確認します。異なる場合は先へ進みません。
## 2. リポジトリの依存関係を入れる
リポジトリのルートで実行します。`package.json`で`chrome-devtools-mcp`を`1.6.0`へ固定し、npmのinstall scriptは実行しません。管理者権限は不要です。
```powershell
npm install --ignore-scripts --no-audit --no-fund --no-package-lock
```
## 3. OpenAI公式tunnel-clientを取得する
このリポジトリはtunnel-clientのダウンロードやZIP展開を自動化しません。ブラウザーで次の公開URLを開き、OpenAI公式ReleaseのWindows amd64 ZIPとSHA-256一覧を自分で保存します。GitHub APIキーは不要です。
```text
https://github.com/openai/tunnel-client/releases/latest/download/tunnel-client-v0.0.10-windows-amd64.zip
https://github.com/openai/tunnel-client/releases/latest/download/SHA256SUMS.txt
```
この手順が確認済みの版は`v0.0.10`です。最新版のasset名が変わった場合は、URLのファイル名だけを推測して置き換えず、次のReleaseページで実際のasset名を確認します。
```text
https://github.com/openai/tunnel-client/releases/latest
```
ダウンロードした2ファイルを確認します。次のコマンドは展開も移動もせず、ZIPのSHA-256表示と公式一覧内の該当行表示だけを行います。
```powershell
$zip = "$HOME\Downloads\tunnel-client-v0.0.10-windows-amd64.zip"
$sums = "$HOME\Downloads\SHA256SUMS.txt"
(Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Select-String -Path $sums -Pattern 'tunnel-client-v0\.0\.10-windows-amd64\.zip'
```
2つのSHA-256が一致したら、エクスプローラーでZIPを開きます。リポジトリ直下に`.tools\tunnel-client`を作り、ZIP内の`tunnel-client.exe`を次の場所へ自分でコピーします。
```text
<repository>\.tools\tunnel-client\tunnel-client.exe
```
配置後に確認します。
```powershell
.\.tools\tunnel-client\tunnel-client.exe help quickstart
```
## 4. ローカル設定とWorkspaceを作る
```powershell
node scripts/node/init-workspace.mjs
```
この処理は`config\gateway.json`、`config\dq9-runtime.json`、`workspace`、`.runtime`だけを作ります。`workspace\.chatgpt-local-mcp-root`は、このディレクトリ以下をファイルMCPへ明示許可した印です。
## 5. 読ませるWorkspaceを設定する
`config\gateway.json`を開きます。最初は次のままで構いません。
```json
{
  "privateUseOnly": true,
  "workspaceRoots": ["../workspace"],
  "workspaceRootMarker": ".chatgpt-local-mcp-root",
  "dq9Config": "./dq9-runtime.json",
  "ghidraUrl": "http://127.0.0.1:8089",
  "ghidraDebuggerUrl": "http://127.0.0.1:8099",
  "enabledServers": ["files", "dq9", "chrome", "ghidra"]
}
```
別のプロジェクトを許可する場合は、そのプロジェクトだけを`workspaceRoots`へ追加し、直下に空のマーカーを作ります。
```powershell
New-Item -ItemType File C:\path\to\project\.chatgpt-local-mcp-root
```
`C:\Users\owner`、`C:\Users`、ドライブ全体、`.ssh`、`.codex`、パスワード置場を指定してはいけません。コードが複数の場所にあるなら、必要なプロジェクトを一つずつ列挙します。
## 6. Ghidra MCPを使う場合だけPython環境を作る
```powershell
py -3.12 -m venv .venv
Get-Content mcp\ghidra\requirements.txt
.\.venv\Scripts\python.exe -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: -r mcp\ghidra\requirements.txt
```
Ghidraをまだ使わない場合は、`enabledServers`から`ghidra`を外せばこの手順を飛ばせます。DQ9やChromeも同様に個別に外せます。
## 7. Gitの秘密情報検査を有効にする
```powershell
node scripts/node/enable-git-hooks.mjs
```
## 8. ローカルだけで検査する
```powershell
node app/doctor.mjs
npm test
```
## 9. Platformで個人用Tunnelを作る
公式画面と仕様は次です。
```text
https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
```
OpenAI PlatformのTunnel settingsでTunnelを作ります。関連付け先は自分のPlatform Organizationと、このMCPを使う自分のChatGPT Workspaceだけにします。他人のOrganization、共有Workspace、配布先を追加しません。
Tunnelを作成・編集する管理者側の権限は`Tunnels Read + Manage`です。常時起動に使うruntime主体には`Tunnels Read + Use`だけを与えます。モデル要求、Organization管理、Project管理、Users、Filesなど、Tunnel以外の権限は付けません。
Runtime API keys画面でruntime keyを一つ発行します。このキーをGit、JSON、`.env`、PowerShellスクリプト、メモ帳、ブラウザー同期、チャットへ貼り付けません。漏れた場合はPlatformで直ちに失効します。
## 10. Tunnelプロファイルを初期化する
Platform画面の`tunnel_id`を使います。
```powershell
node scripts/node/initialize-tunnel.mjs --tunnel-id tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
`Tunnel runtime API key (not saved):`と表示されたらruntime keyを貼り付けてEnterを押します。入力文字は`*`表示になり、ファイルへ保存されません。初期化後、同じスクリプトが`doctor --explain`を実行するため、どこで失敗したか確認できます。
## 11. Tunnelを起動する
```powershell
node scripts/node/run-tunnel.mjs
```
runtime keyを再度マスク入力します。このウィンドウを開いている間だけ、公式`tunnel-client`がOpenAIへ外向きHTTPS接続します。ルーターのポート開放や公開URLは不要です。
別ウィンドウで診断だけ行う場合は次です。
```powershell
node scripts/node/doctor-tunnel.mjs
```
## 12. ChatGPTへ自分専用で接続する
ChatGPTの`Settings`から`Security and login`を開き、`Developer mode`を有効にします。Plugins画面の追加ボタンを押し、Connectionで`Tunnel`を選び、手順9で作ったTunnelを選択します。検出されたツールを確認し、公開申請や配布は行いません。
Secure MCP Tunnelはprivate MCPのDeveloper Mode接続用です。OpenAI公式資料でも、Tunnel自体は公開Pluginの提出や配布には使わないと説明されています。
## 13. 問題が起きたときの最小コマンド
```powershell
node app/doctor.mjs
node scripts/node/doctor-tunnel.mjs
.\.tools\tunnel-client\tunnel-client.exe help quickstart
git status --short
```
runtime keyを保存した古いファイルが残っている場合は、Platformで古いキーを失効してから、そのファイルを手動で削除してください。このリポジトリの新しいスクリプトはキー保存ファイルを作りません。
