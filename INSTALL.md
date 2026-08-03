# INSTALL.md
この手順はWindows 11向けです。管理者PowerShellではなく、通常のPowerShellを使います。自動インストール、自動ZIP展開、自動設定生成、Git hook変更は行いません。
## 1. 必要なソフトを手動で入れる
必要なものだけを一行ずつ入れます。既に入っているものは飛ばしてください。
```powershell
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Git.Git
winget install -e --id BurntSushi.ripgrep.MSVC
winget install -e --id Python.Python.3.12
```
Chrome、Ghidra、その他のMCPは、実際に使うものだけを各公式手順で入れます。このリポジトリは勝手に入れません。
## 2. tunnel-clientを手動で置く
ブラウザーで次を開きます。GitHub APIは使いません。
```text
https://github.com/openai/tunnel-client/releases/latest/download/tunnel-client-v0.0.10-windows-amd64.zip
https://github.com/openai/tunnel-client/releases/latest/download/SHA256SUMS.txt
https://github.com/openai/tunnel-client/releases/latest
```
ZIP名が変わっていた場合は、Releaseページで実際のasset名を確認してください。自動で最新版名を推測しません。
```powershell
$zip = "$HOME\Downloads\tunnel-client-v0.0.10-windows-amd64.zip"
$sums = "$HOME\Downloads\SHA256SUMS.txt"
(Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Select-String -Path $sums -Pattern 'tunnel-client-v0\.0\.10-windows-amd64\.zip'
```
2つのSHA-256が一致したら、自分でZIPを展開し、`tunnel-client.exe`を次へコピーします。
```text
<repository>\.tools\tunnel-client\tunnel-client.exe
```
## 3. 先にhelpを読む
設定を推測せず、実際のバイナリとファイルMCPのhelpを出します。
```powershell
.\.tools\tunnel-client\tunnel-client.exe --help
.\.tools\tunnel-client\tunnel-client.exe help doctor
node mcp\safe-files\server.mjs --help
```
この3つの出力、リポジトリとWorkspaceの絶対パス、接続したいMCPの起動コマンドをAIへ渡せば、AIが`gateway.toml`とTunnel起動コマンドを組み立てられます。`.chatgpt-local-mcp-root`のようなマーカーファイルや`--root`引数は不要です。
## 4. gateway.tomlを自分で作る
例をコピーして、必ず自分のパスへ書き換えます。
```powershell
Copy-Item config\gateway.example.toml config\gateway.toml
code config\gateway.toml
```
形式はCodexのMCP設定に近い`[mcp_servers.<name>]`です。
```toml
private_use_only = true
[mcp_servers.files]
command = "node"
args = ['C:\Users\owner\Documents\local-mcp-chatgpt-tunnel\mcp\safe-files\server.mjs']
cwd = 'C:\Users\owner\Documents\my-project'
enabled = true
prefix = "files"
startup_timeout_sec = 30
tool_timeout_sec = 1800
allowed_directories = ['C:\Users\owner\Documents\my-project']
allowed_files = []
```
`safe-files`は`cwd`をWorkspaceのルートとして使います。複数Workspaceが必要なら、`files_project_a`と`files_project_b`のようにMCPエントリを分け、それぞれ別の`cwd`と`prefix`を指定します。
任意のstdio MCPも同じ形で追加できます。
```toml
[mcp_servers.example]
command = "py"
args = ['C:\path\to\server.py']
cwd = 'C:\path\to'
enabled = false
prefix = "example"
startup_timeout_sec = 30
tool_timeout_sec = 1800
allowed_directories = ['C:\work\project']
allowed_files = ['C:\Users\owner\Downloads\one-upload-file.png']
[mcp_servers.example.env]
EXAMPLE_CONFIG = 'C:\path\to\config.json'
```
`allowed_directories`は指定ディレクトリとその配下を許可します。`allowed_files`は列挙した絶対パスだけを完全一致で許可します。Chrome DevTools MCPのアップロード元など、Workspace全体を許可する必要がないファイルは`allowed_files`へ一つずつ書きます。Windowsの`\`と`/`、JSONで二重にエスケープされた`\\`は正規化して比較され、相対パスはそのMCPの`cwd`から解決されます。
Gatewayは全MCPのツール引数を再帰的に検査します。`path`、`filePath`、`files`、`directory`などのパスらしいキー、または絶対パスらしい文字列を検出し、許可リスト外なら子MCPへ渡しません。パス引数を持たないツールは許可リストが空でも動きます。
`enabled = false`なら起動しません。GatewayはMCP名、実行ファイル、引数、作業ディレクトリ、環境変数をハードコードしません。現在のGatewayが直接集約するのは`command`で起動するstdio MCPです。Ghidra MCPやDQ9 MCPの実装は同梱せず、必要な外部MCPを利用者自身が設定します。
Codex設定からコピーする場合、`tool_output_token_limit`と`[mcp_servers.<name>.tools.<tool>]`の承認設定は削除してください。Gatewayはトークン数の計測やCodexの承認UIを持たないため、これらが書かれている有効MCPは明示エラーにします。
## 5. Node.jsで最終検証する
Node.jsが導入作業を変更することはありません。次のコマンドは`node`、`npm`、`git`、`rg`、`py`を全部確認し、途中の失敗で止まらず、最後に問題のあるコマンドをまとめます。バージョン番号が例と違うだけでは失敗にしません。
```powershell
node app\doctor.mjs
```
リポジトリのテストも実行できます。外部npm依存はありません。
```powershell
npm test
```
## 6. OpenAI Platformで自分専用のTunnelを作る
次のTunnel管理画面を開きます。
```text
https://platform.openai.com/settings/organization/tunnels
https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
```
画面右上の`Create tunnel`を押し、次のように入力します。
1. `Name`: PCを識別できる名前を入力します。例は`local_my_pc`です。
2. `Description`: `Private tunnel for my local Windows MCP servers. Personal use only.`のように、個人用であることを書きます。
3. `Organizations`: 自分の`Personal (...)`だけを選びます。
4. `ChatGPT workspaces`: 自分の`Personal workspace (...)`だけを選びます。
5. 共有Workspace、他人のOrganization、公開用Workspaceは追加せず、`Create`を押します。
   スクリーンショットの状態では`Description`が空です。`Create`が無効のままなら、まずDescriptionを入力し、それでも無効ならダイアログ内を最下部までスクロールして残りの必須項目を確認します。
   作成後、Tunnelの詳細画面に表示される`tunnel_id`を控えます。これは次の起動コマンドで使います。
   runtime主体には`Tunnels Read + Use`だけを与えます。Tunnelの作成や編集には`Tunnels Read + Manage`が必要ですが、普段`tunnel-client`を動かすキーへ管理権限、モデルAPI、Organization管理、Filesなどの不要な権限は与えません。
## 7. runtime API keyを用意する
Tunnel画面またはOpenAI Platformの案内に従い、`tunnel-client`用のruntime API keyを作ります。このキーは`tunnel-client`の実行専用です。リポジトリ、`gateway.toml`、`.env`、メモ帳へ保存しません。
公式仕様では、Tunnelの作成・編集と、`tunnel-client`の実行に必要な権限は別です。個人利用でも、実行用キーには`Tunnels Read + Use`だけを与えます。
## 8. API keyを引数で渡して検査・起動する
`tunnel_id`を自分の値へ置き換えます。現在の`tunnel-client`では、`--control-plane.api-key`へAPI keyそのものではなく、`env:変数名`または`file:パス`形式の参照を渡します。次の例はruntime API keyを一時的な環境変数へ入れ、`tunnel-client`の引数ではその変数を参照します。このリポジトリはキーを保存しません。
```powershell
$secureKey = Read-Host 'Runtime API key' -AsSecureString
$env:OPENAI_TUNNEL_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
$mcp = 'command=node app/gateway.mjs --config config/gateway.toml,channel=local-mcp'

.\.tools\tunnel-client\tunnel-client.exe doctor --control-plane.tunnel-id=tunnel_0123456789abcdef0123456789abcdef --control-plane.api-key=env:OPENAI_TUNNEL_API_KEY --mcp.command="$mcp" --explain
.\.tools\tunnel-client\tunnel-client.exe run --control-plane.tunnel-id=tunnel_0123456789abcdef0123456789abcdef --control-plane.api-key=env:OPENAI_TUNNEL_API_KEY --mcp.command="$mcp"
```
`run`を終了した後は、同じPowerShellで次を実行して一時的な環境変数を消します。
```powershell
Remove-Item Env:OPENAI_TUNNEL_API_KEY
```
`--control-plane.api-key=sk-...`のように生のキーを引数へ直接書く例は使いません。現在のhelpが案内する形式は`env:VARNAME`または`file:/path/to/secret`です。生のキーをコマンド履歴やプロセス引数へ残さず、Node.jsラッパーも追加しません。
## 9. ChatGPTへ接続する
最初にDeveloper modeを直接開き、有効にします。
```text
https://chatgpt.com/plugins#settings/Security?section=developer-mode
```
次に新しいカスタムアプリ作成画面を直接開きます。
```text
https://chatgpt.com/plugins#settings/Connectors?create-connector=true
https://developers.openai.com/plugins/deploy/connect-chatgpt
```
名前と説明を入力し、Connectionで`Tunnel`を選び、先ほど作成したTunnelを選択します。Tunnelが選べない場合は、Tunnelへ自分のChatGPT Workspaceが関連付けられているか確認します。カスタムMCPの警告を読み、個人用Tunnelであることを確認して作成します。
表示されたツール名を確認し、想定外のMCPがあれば`gateway.toml`で`enabled = false`にしてTunnelを再起動します。公開申請や第三者共有は行いません。
