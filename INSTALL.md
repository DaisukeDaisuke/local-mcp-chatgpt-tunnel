# Windows 11への導入
この手順では、Windows 11上のstdio MCPサーバーをGatewayへ登録し、OpenAI Secure MCP Tunnel経由でChatGPTから呼び出せる状態にします。管理者PowerShellは使いません。自動インストール、自動ZIP展開、自動設定生成、Git hook変更も行いません。
## 作業の流れ
1. Windowsへ必要なコマンドを導入する
2. OpenAI公式の`tunnel-client.exe`を配置する
3. `config/gateway.toml`へローカルMCPを登録する
4. OpenAI Platformで個人用Tunnelと実行用API keyを作る
5. Tunnelを起動し、ChatGPTへカスタムアプリとして接続する
## 1. 必要なソフトを導入する
通常権限のPowerShellで、必要なものだけを一行ずつ実行します。既に導入済みのものは飛ばしてください。
```powershell
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Git.Git
winget install -e --id BurntSushi.ripgrep.MSVC
winget install -e --id Python.Python.3.12
```
Chrome、Ghidra、その他の外部MCPは、実際に使うものだけを各プロジェクトの公式手順で導入します。このリポジトリから自動では導入しません。
## 2. tunnel-clientを配置する
### 2.1 Windows用ZIPをダウンロードする
[tunnel-client Windows amd64版ZIPをダウンロード](https://github.com/openai/tunnel-client/releases/latest/download/tunnel-client-v0.0.10-windows-amd64.zip)
このリンクを開くとZIPのダウンロードが始まります。ブラウザーのダウンロード先へ`tunnel-client-v0.0.10-windows-amd64.zip`が保存されたことを確認します。
`<url: tunnel-clientのWindows用ZIPがダウンロードされたことを確認する図>`
### 2.2 SHA256SUMS.txtをダウンロードする
[SHA256SUMS.txtをダウンロード](https://github.com/openai/tunnel-client/releases/latest/download/SHA256SUMS.txt)
このリンクを開き、ZIPと同じダウンロード先へ`SHA256SUMS.txt`を保存します。
`<url: SHA256SUMS.txtがダウンロードされたことを確認する図>`
### 2.3 Releaseページで実際のファイル名を確認する
[tunnel-clientの最新Releaseを開く](https://github.com/openai/tunnel-client/releases/latest)
ZIP名が変わっている場合だけ、ReleaseページのAssetsを開き、Windows amd64用ZIPの実際の名前を確認します。自動で最新版のasset名を推測しません。
`<url: Assetsを開き、Windows amd64用ZIPの名前を確認する図>`
### 2.4 SHA-256を照合する
ダウンロードしたファイル名が異なる場合は、次の`$zip`と検索文字列も実際の名前へ変更します。
```powershell
$zip = "$HOME\Downloads\tunnel-client-v0.0.10-windows-amd64.zip"
$sums = "$HOME\Downloads\SHA256SUMS.txt"
(Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Select-String -Path $sums -Pattern 'tunnel-client-v0\.0\.10-windows-amd64\.zip'
```
`Get-FileHash`の値と、`SHA256SUMS.txt`に書かれた値が一致した場合だけ続行します。
### 2.5 tunnel-client.exeを配置する
自分でZIPを展開し、`tunnel-client.exe`を次の場所へコピーします。フォルダーが存在しない場合は作成します。
```text
<repository>\.tools\tunnel-client\tunnel-client.exe
```
配置後、リポジトリ直下のPowerShellでhelpを表示します。
```powershell
.\.tools\tunnel-client\tunnel-client.exe --help
.\.tools\tunnel-client\tunnel-client.exe help doctor
```
## 3. 同梱MCPのhelpを確認する
設定を推測する前に、実際に使うMCPのhelpを確認します。
```powershell
node mcp\safe-files\server.mjs --help
node mcp\safe-images\server.mjs --help
node mcp\safe-download\server.mjs --help
```
これらの出力、リポジトリとWorkspaceの絶対パス、追加したいstdio MCPの起動コマンドがあれば、`gateway.toml`を組み立てるための情報が揃います。`.chatgpt-local-mcp-root`のようなマーカーファイルや`--root`引数は不要です。
## 4. gateway.tomlを作成する
### 4.1 設定例をコピーする
```powershell
Copy-Item config\gateway.example.toml config\gateway.toml
code config\gateway.toml
```
`gateway.example.toml`内の`C:\ABSOLUTE\PATH\TO`は説明用のダミーです。`args`にはこのリポジトリ内のMCPサーバーの絶対パスを、`cwd`と`allowed_directories`には実際に操作するWorkspaceの絶対パスを書きます。
### 4.2 ダミーパスが残っていないことを確認する
```powershell
rg -n -F 'C:\ABSOLUTE\PATH\TO' config\gateway.toml
```
何も表示されなければ、対象のダミーパスは残っていません。ダミーのまま起動すると、Node.jsは`Cannot find module 'C:\ABSOLUTE\PATH\TO\...'`と`MODULE_NOT_FOUND`を出します。これはnpmパッケージの不足ではなく、`gateway.toml`のパスが未設定であることを示します。
### 4.3 safe-filesを設定する
設定形式はCodexのMCP設定に近い`[mcp_servers.<name>]`です。
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
`safe-files`は`cwd`をWorkspaceのルートとして使います。複数のWorkspaceを扱う場合は、`files_project_a`と`files_project_b`のようにMCPエントリを分け、それぞれに別の`cwd`と`prefix`を指定します。
`list_files`は固定された`rg --files --hidden`経路で再帰一覧を返します。`excludePaths`へ無視するファイルまたはフォルダーを複数指定でき、`globs`は相対globだけを受け付けます。任意のrg引数、親ディレクトリへ出るglob、改行、NUL、オプションに見える先頭`-`は拒否します。`.git`内部は常に除外します。
### 4.4 safe-imagesを必要な場合だけ有効にする
Downloads内のPNG、JPEG、WebPをChatGPTへ画像として渡す場合は、読み取り専用の`safe-images`を追加または有効化します。
```toml
[mcp_servers.images]
command = "node"
args = ['C:\Users\owner\Documents\local-mcp-chatgpt-tunnel\mcp\safe-images\server.mjs']
cwd = 'C:\Users\owner\Downloads'
enabled = true
prefix = "images"
startup_timeout_sec = 30
tool_timeout_sec = 120
allowed_directories = ['C:\Users\owner\Downloads']
allowed_files = []

[mcp_servers.images.env]
SAFE_IMAGES_MAX_BYTES = "8388608"
SAFE_IMAGES_MAX_PIXELS = "52428800"
```
ChatGPTからは`images__read_image`へ`{"path":"画像.png"}`を渡します。画像base64はMCP画像コンテンツとして返り、通常のテキスト転送ツールには入りません。Downloads全体を許可しない場合は`allowed_directories = []`にし、`allowed_files`へ対象画像の絶対パスだけを書きます。
### 4.5 safe-downloadを必要な場合だけ有効にする
ソースコードなどをZIPで受け取る場合は、`safe-download`を`safe-files`や`safe-images`とは別のMCPエントリとして追加します。`cwd`と`allowed_directories`には、ChatGPTへ渡してよいソースだけを含む専用ディレクトリを指定します。
```toml
[mcp_servers.downloads]
command = "node"
args = ['C:\Users\owner\Documents\local-mcp-chatgpt-tunnel\mcp\safe-download\server.mjs']
cwd = 'C:\Users\owner\Documents\downloadable-source'
enabled = true
prefix = "downloads"
startup_timeout_sec = 30
tool_timeout_sec = 300
allowed_directories = ['C:\Users\owner\Documents\downloadable-source']
allowed_files = []

[mcp_servers.downloads.env]
SAFE_DOWNLOAD_MAX_FILES = "500"
SAFE_DOWNLOAD_MAX_INPUT_BYTES = "16777216"
SAFE_DOWNLOAD_MAX_ZIP_BYTES = "20971520"
SAFE_DOWNLOAD_MAX_RG_OUTPUT_BYTES = "8388608"
```
ChatGPTからは`downloads__download_zip`へ`path`を渡します。単一の`.js`や`.mjs`を指定してもZIPで返します。ディレクトリでは固定された`rg --files`で列挙し、`globs`、`excludePaths`、`includeIgnored`を使用できます。ROM、Save、State、秘密鍵形式、資格情報らしい内容、シンボリックリンク、許可ルート外は拒否します。
### 4.6 任意のstdio MCPを追加する
任意のstdio MCPも同じ形式で追加できます。
```toml
[mcp_servers.example]
command = "py"
args = ['C:\path\to\server.py']
cwd = 'C:\path\to'
enabled = false
prefix = "example"
startup_timeout_sec = 30
tool_timeout_sec = 1800
blocked_tools = ["dangerous_tool"]
blocked_tool_substrings = ["script", "shell", "execute"]
allowed_directories = ['C:\work\project']
allowed_files = ['C:\Users\owner\Downloads\one-upload-file.png']

[mcp_servers.example.env]
EXAMPLE_CONFIG = 'C:\path\to\config.json'
```
`blocked_tools`は元のツール名との完全一致で非公開にします。`blocked_tool_substrings`は大文字と小文字を区別しない単純な部分一致です。globや正規表現ではありません。たとえば`"script"`を指定すると、`evaluate_script`、`runScript`、`SCRIPT_debug`など、元のツール名に`script`を含むツールを公開しません。
`allowed_directories`は指定ディレクトリとその配下を許可します。`allowed_files`は列挙した絶対パスだけを完全一致で許可します。Chrome DevTools MCPのアップロード元など、Workspace全体を許可する必要がないファイルは`allowed_files`へ一つずつ書きます。Windowsの`\`と`/`、JSONで二重にエスケープされた`\\`は正規化して比較され、相対パスはそのMCPの`cwd`から解決されます。
Gatewayは全MCPのツール引数を再帰的に検査します。`path`、`filePath`、`files`、`directory`などのパスらしいキー、または絶対パスらしい文字列を検出し、許可リスト外なら子MCPへ渡しません。パス引数を持たないツールは許可リストが空でも動きます。
`enabled = false`のMCPは起動しません。GatewayはMCP名、実行ファイル、引数、作業ディレクトリ、環境変数をハードコードしません。現在直接集約するのは、`command`で起動するstdio MCPです。Ghidra MCPやDQ9 MCPなどの外部MCP本体は同梱していません。
有効なMCPの一部が起動できなくても、Gatewayは初期化を続行し、起動できたMCPのツールだけを公開します。起動できなかったMCPは標準エラーへ`unavailable and was skipped`として記録されます。すべてを一時的に無効化した設定でもGatewayは起動し、ツール一覧は空になります。
Codex設定からコピーした`tool_output_token_limit`、`[mcp_servers.<name>.tools.<tool>]`の承認設定、その他Gatewayが使わない項目は残しても読み飛ばされます。トークン数の計測やCodexの承認UIは実装していないため、無視された項目はこのGatewayでは効果を持ちません。
## 5. ローカル設定を検証する
次の診断は`node`、`npm`、`git`、`rg`、`py`を確認し、途中で止まらず、最後に問題のあるコマンドをまとめます。バージョン番号が例と異なるだけでは失敗にしません。
```powershell
node app\doctor.mjs
```
外部npm依存を追加せず、リポジトリのテストも実行できます。
```powershell
npm test
```
## 6. OpenAI Platformで個人用Tunnelを作成する
### 6.1 Tunnel管理画面を開く
[OpenAI PlatformのTunnel管理画面を開く](https://platform.openai.com/settings/organization/tunnels)
画面右上の`Create tunnel`を押します。
`<url: 画面右上の「Create tunnel」を押す図>`
### 6.2 Tunnelの公開範囲を入力する
作成画面では次の内容を設定します。
1. `Name`: PCを識別できる名前を入力します。例は`local_my_pc`です。
2. `Description`: `Private tunnel for my local Windows MCP servers. Personal use only.`のように個人用であることを書きます。
3. `Organizations`: 自分の`Personal (...)`だけを選びます。
4. `ChatGPT workspaces`: 自分の`Personal workspace (...)`だけを選びます。
5. 共有Workspace、他人のOrganization、公開用Workspaceを追加せず、`Create`を押します。
`<url: NameとDescriptionを入力する図>`
`<url: 自分のPersonal Organizationだけを選択する図>`
`<url: 自分のPersonal ChatGPT workspaceだけを選択する図>`
`<url: 公開範囲を確認して「Create」を押す図>`
`Create`が無効のままなら、まず`Description`を入力します。それでも無効なら、ダイアログ内を最下部までスクロールし、残っている必須項目を確認します。
作成後、Tunnelの詳細画面に表示される`tunnel_id`を控えます。後で`CONTROL_PLANE_TUNNEL_ID`へ設定します。
`<url: 作成したTunnelの詳細画面でtunnel_idを控える図>`
### 6.3 公式仕様を確認する
[OpenAI Secure MCP Tunnelsの公式ガイドを開く](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
Tunnelの権限名、環境変数、`tunnel-client`の動作条件が変更されていないかを確認します。このページではTunnelを作成せず、仕様確認だけを行います。
`<url: Tunnels Read + Useとtunnel-clientの起動条件を確認する図>`
## 7. Tunnel実行専用ロールを作成する
### 7.1 Organization Rolesを開く
[OpenAI PlatformのOrganization Rolesを開く](https://platform.openai.com/settings/organization/people/roles)
新しいロールを作り、名前を`Local MCP Tunnel Runtime - No Model API`のようにします。権限は`Tunnels Read + Use`だけにし、`Tunnels Manage`、モデルAPI、Files、Organization管理などは付けません。
`<url: 新しいOrganization Roleの作成を開始する図>`
`<url: Tunnels Read + Useだけを有効にする図>`
`<url: モデルAPIやOrganization管理権限が無効であることを確認する図>`
Tunnelの作成や編集には別途`Tunnels Read + Manage`が必要ですが、普段`tunnel-client`を動かすruntime主体にはManage権限を付けません。
### 7.2 自分だけのGroupへロールを割り当てる
[OpenAI PlatformのOrganization Groupsを開く](https://platform.openai.com/settings/organization/people/groups)
自分だけを含むGroupを作成または選択し、先ほど作ったTunnel実行専用ロールを割り当てます。ロールを作成しただけでは権限は有効になりません。
`<url: 自分だけを含むGroupを選択または作成する図>`
`<url: Tunnel実行専用ロールをGroupへ割り当てる図>`
## 8. モデルAPI権限のないruntime API keyを作成する
### 8.1 Runtime API keysを開く
[OpenAI PlatformのRuntime API keysを開く](https://platform.openai.com/settings/organization/api-keys)
`Create new secret key`を押します。
`<url: 「Create new secret key」を押す図>`
### 8.2 Tunnel専用権限を設定する
作成画面で次のように設定します。
1. `Owned by`: `You`
2. `Name`: `local-mcp-tunnel-runtime-no-model-api`
3. `Project`: Tunnelを作成したOrganization内のProject
4. `Permissions`: `Restricted`
5. `Tunnels`: `Read + Use`だけを有効化
6. `List models`、`Responses`、`Chat completions`、`Embeddings`、`Images`、`Files`など、Tunnel以外はすべて`None`
`<url: Owned by、Name、Projectを設定する図>`
`<url: PermissionsをRestrictedへ変更する図>`
`<url: TunnelsをRead + Useにし、他の権限をNoneにする図>`
この名前は、モデルAPIに使えないTunnel専用キーであることを後から見ても判別できるようにするためです。`All`権限のキー、Admin API key、既存のモデルAPI keyは使い回しません。
作成直後に表示されるAPI keyを安全な場所へ一時的に控えます。後から同じ値を再表示できない場合があります。
`<url: 作成直後に表示されたruntime API keyを控える図>`
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
同じWindowsユーザーで動く別プロセスからはユーザー環境変数を読めます。SSH鍵や他サービスの資格情報と強く分離したい場合は、このTunnel専用の標準Windowsユーザーで設定します。
確認時もAPI keyの値そのものは表示しません。
```powershell
if ($env:CONTROL_PLANE_API_KEY) { 'CONTROL_PLANE_API_KEY: set' } else { 'CONTROL_PLANE_API_KEY: missing' }
$env:CONTROL_PLANE_TUNNEL_ID
```
`OPENAI_API_KEY`もfallbackとして読まれますが、モデルAPI権限を持つキーとの取り違えを防ぐため、この手順では必ず`CONTROL_PLANE_API_KEY`を使います。
## 10. Tunnelを検査して起動する
リポジトリ直下の通常PowerShellで実行します。`main`チャンネルは必須です。
```powershell
$mcp = 'command=node app/gateway.mjs --config config/gateway.toml,channel=main'

.\.tools\tunnel-client\tunnel-client.exe doctor --mcp.command="$mcp" --explain
.\.tools\tunnel-client\tunnel-client.exe run --mcp.command="$mcp"
```
同じ処理はリポジトリ直下の`start.cmd`でも実行できます。`doctor`が失敗した場合はTunnelを起動しません。
```powershell
.\start.cmd
```
API keyとTunnel IDは環境変数から取得されます。生のキーをコマンド引数、`gateway.toml`、`.env`、リポジトリ内ファイルへ書きません。
## 11. ChatGPTへ接続する
### 11.1 Developer modeを有効にする
[ChatGPTのDeveloper mode設定を開く](https://chatgpt.com/plugins#settings/Security?section=developer-mode)
Developer modeを有効にし、カスタムMCPを利用する際の警告を確認します。
`<url: Developer modeを有効にする図>`
### 11.2 カスタムアプリ作成画面を開く
[ChatGPTのカスタムアプリ作成画面を開く](https://chatgpt.com/plugins#settings/Connectors?create-connector=true)
名前と説明を入力し、Connectionで`Tunnel`を選び、手順6で作成したTunnelを選択します。Tunnelが選べない場合は、そのTunnelへ自分のChatGPT Workspaceが関連付けられているかを確認します。
`<url: カスタムアプリの名前と説明を入力する図>`
`<url: ConnectionでTunnelを選択する図>`
`<url: 作成済みの個人用Tunnelを選択する図>`
`<url: 内容と警告を確認してカスタムアプリを作成する図>`
### 11.3 ChatGPT接続手順の公式資料を確認する
[OpenAIのChatGPT接続ガイドを開く](https://developers.openai.com/plugins/deploy/connect-chatgpt)
ChatGPT側の画面名や接続方式が変更されていないかを確認します。このページでは新しい接続先を作らず、仕様確認だけを行います。
`<url: Developer modeとカスタムアプリ接続の最新手順を確認する図>`
## 12. 公開されたツールを確認する
ChatGPTで作成したカスタムアプリを有効にし、表示されたツール名を確認します。想定外のMCPやツールが公開されている場合は、`gateway.toml`で対象MCPを`enabled = false`にするか、`blocked_tools`または`blocked_tool_substrings`へ追加してTunnelを再起動します。
このTunnelは自分専用として扱い、公開申請、第三者共有、共有Workspaceへの追加は行いません。