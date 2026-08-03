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
`gateway.example.toml`内の`C:\ABSOLUTE\PATH\TO`は説明用のダミーです。`args`にはこのリポジトリ内の`mcp\safe-files\server.mjs`の絶対パスを、`cwd`と`allowed_directories`には実際に操作するWorkspaceの絶対パスを書きます。ダミーが残っていないことを確認します。
```powershell
rg -n -F 'C:\ABSOLUTE\PATH\TO' config\gateway.toml
```
何も表示されなければダミーパスは残っていません。ダミーのまま起動すると、Node.jsは`Cannot find module 'C:\ABSOLUTE\PATH\TO\...'`と`MODULE_NOT_FOUND`を出します。これはnpmパッケージのインストール不足ではなく、`gateway.toml`のパス未設定です。
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
有効なMCPの一部が起動できなくても、Gateway自体は初期化を続行し、起動できたMCPのツールだけを公開します。起動できなかったMCPは標準エラーへ`unavailable and was skipped`として記録されます。すべてを一時的に無効化した設定でもGatewayは起動し、ツール一覧は空になります。`initialize`と`tools/list`が連続して届いた場合も、子MCPの起動判定が終わるまで`tools/list`を待機させ、`Server not initialized`を返しません。
Codex設定からコピーした`tool_output_token_limit`、`[mcp_servers.<name>.tools.<tool>]`の承認設定、その他Gatewayが使わない項目は、そのまま残して構いません。Gatewayは認識する項目だけを読み、未対応項目を無視します。トークン数の計測やCodexの承認UIは実装していないため、無視された項目はこのGatewayでは効果を持ちません。
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
## 7. Tunnel実行専用のロールを作る
Organization Rolesを開きます。
```text
https://platform.openai.com/settings/organization/people/roles
```
新しいロールを作り、名前を`Local MCP Tunnel Runtime - No Model API`のようにします。権限は`Tunnels Read + Use`だけにし、`Tunnels Manage`、モデルAPI、Files、Organization管理などは付けません。このロールはTunnelの常駐実行専用です。
ロールを作っただけでは権限は有効になりません。Organization Groupsで自分だけを含むグループへ割り当てます。
```text
https://platform.openai.com/settings/organization/people/groups
```
Tunnelを作成・編集する人には別途`Tunnels Read + Manage`が必要です。常駐するruntime keyへManage権限は付けません。
## 8. モデルAPI権限のないruntime API keyを作る
Runtime API keysを開きます。
```text
https://platform.openai.com/settings/organization/api-keys
```
`Create new secret key`で次のように設定します。
1. `Owned by`: `You`
2. `Name`: `local-mcp-tunnel-runtime-no-model-api`
3. `Project`: Tunnelを作成したOrganization内のProject
4. `Permissions`: `Restricted`
5. `Tunnels`: `Read + Use`だけを有効化
6. `List models`、`Responses`、`Chat completions`、`Embeddings`、`Images`、`Files`など、Tunnel以外はすべて`None`
この名前は、モデルAPIに使えないTunnel専用キーであることを後から見ても判別できるようにするためです。`All`権限のキー、Admin API key、既存のモデルAPI keyは使い回しません。
## 9. Tunnel IDとruntime API keyをユーザー環境変数へ保存する
`tunnel-client`は`CONTROL_PLANE_TUNNEL_ID`と`CONTROL_PLANE_API_KEY`を自動で読みます。起動コマンドへ`--control-plane.tunnel-id`や`--control-plane.api-key`を書く必要はありません。
通常権限のPowerShellで次を実行し、API keyと`tunnel_...`を自分の値へ置き換えます。`Read-Host`や`SecureString`変換は使いません。
```powershell
$apiKey = 'ここにTunnel runtime API keyを貼る'
$tunnelId = 'tunnel_0123456789abcdef0123456789abcdef'

if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw 'CONTROL_PLANE_API_KEY is empty.'
}
if ([string]::IsNullOrWhiteSpace($tunnelId)) {
    throw 'CONTROL_PLANE_TUNNEL_ID is empty.'
}

# 現在のPowerShellと、ここから起動するtunnel-clientへ即時反映
$env:CONTROL_PLANE_API_KEY = $apiKey
$env:CONTROL_PLANE_TUNNEL_ID = $tunnelId

# Windowsのユーザー環境変数へ永続保存
[Environment]::SetEnvironmentVariable(
    'CONTROL_PLANE_API_KEY',
    $apiKey,
    [EnvironmentVariableTarget]::User
)
[Environment]::SetEnvironmentVariable(
    'CONTROL_PLANE_TUNNEL_ID',
    $tunnelId,
    [EnvironmentVariableTarget]::User
)

Remove-Variable apiKey, tunnelId
```
これは現在のPowerShellへ即時反映し、Windowsのユーザー環境変数としても永続保存します。Machine環境変数にはせず、管理者PowerShellも使いません。既に起動している別のPowerShellやアプリへは反映されないため、そちらで使う場合は新しく起動します。
同じWindowsユーザーで動く別プロセスからはユーザー環境変数を読めるため、SSH鍵や他サービスの資格情報と強く分離したい場合は、このTunnel専用の標準Windowsユーザーで設定します。
確認時も値そのものは表示しません。
```powershell
if ($env:CONTROL_PLANE_API_KEY) { 'CONTROL_PLANE_API_KEY: set' } else { 'CONTROL_PLANE_API_KEY: missing' }
$env:CONTROL_PLANE_TUNNEL_ID
```
`OPENAI_API_KEY`もfallbackとして読まれますが、モデルAPI権限を持つキーとの取り違えを防ぐため、この手順では必ず`CONTROL_PLANE_API_KEY`を使います。
## 10. doctorで検査して起動する
リポジトリ直下の通常PowerShellで実行します。`main`チャンネルは必須です。
```powershell
$mcp = 'command=node app/gateway.mjs --config config/gateway.toml,channel=main'

.\.tools\tunnel-client\tunnel-client.exe doctor --mcp.command="$mcp" --explain
.\.tools\tunnel-client\tunnel-client.exe run --mcp.command="$mcp"
```
キーやTunnel IDは環境変数から自動取得されます。生のキーをコマンド引数、`gateway.toml`、`.env`、リポジトリ内ファイルへ書きません。Node.jsラッパーも追加しません。
## 11. ChatGPTへ接続する
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
