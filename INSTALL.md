> [!CAUTION]
> ChatGPT Freeプランでは絶対に試さないでください。GPT5.5 Instantが暴走する可能性があります。

# Windows 11への導入
この手順では、Windows 11上のstdio MCPサーバーをGatewayへ登録し、OpenAI Secure MCP Tunnel経由でChatGPTから呼び出せる状態にします。<br>管理者PowerShellは使いません。<br>自動インストール、自動ZIP展開、自動設定生成、Git hook変更も行いません。<br>
## 作業の流れ
1. Windowsへ必要なコマンドを導入する
2. OpenAI公式の`tunnel-client.exe`を配置する
3. `config/gateway.toml`を完全に記入し、ローカルMCPを登録する
4. OpenAI Platformで個人用Tunnelと実行用API keyを作る
5. Tunnelを起動し、ChatGPTへカスタムアプリとして接続する
6. カスタムアプリを更新し、公開されたツールを確認する
## 1. 必要なソフトを導入する
通常権限のPowerShellで、必要なものだけを一行ずつ実行します。<br>既に導入済みのものは飛ばしてください。<br>
```powershell
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Git.Git
winget install -e --id BurntSushi.ripgrep.MSVC
winget install -e --id Python.Python.3.12
```
Chrome、Ghidra、その他の外部MCPは、実際に使うものだけを各プロジェクトの公式手順で導入します。<br>安全上の理由から、このスクリプトで一括導入はしません。<br>
## 2. tunnel-clientを配置する
### 2.1 Windows用ZIPをダウンロードする
[tunnel-client Windows amd64版ZIPをダウンロード](https://github.com/openai/tunnel-client/releases/latest/download/tunnel-client-v0.0.10-windows-amd64.zip)<br>
このリンクを開くとZIPのダウンロードが始まります。<br>ブラウザーのダウンロード先へ`tunnel-client-v0.0.10-windows-amd64.zip`が保存されたことを確認します。<br>

### 2.2 SHA256SUMS.txtをダウンロードする
[SHA256SUMS.txtをダウンロード](https://github.com/openai/tunnel-client/releases/latest/download/SHA256SUMS.txt)<br>
このリンクを開き、ZIPと同じダウンロード先へ`SHA256SUMS.txt`を保存します。<br>
<img width="1195" height="188" alt="image" src="https://github.com/user-attachments/assets/7bee9d3b-d2cc-4aba-9a4c-a225102c8a61" />
### 2.3 最新のReleaseページで実際のファイル名を確認する
[tunnel-clientの最新Releaseを開く](https://github.com/openai/tunnel-client/releases/latest)<br>
ZIP名が変わっている場合だけ、ReleaseページのAssetsを開き、Windows amd64用ZIPの実際の名前を確認します。<br>ダウンロードできない場合はこちらを試してください。
<img width="1209" height="604" alt="image" src="https://github.com/user-attachments/assets/0b33d8dd-db5c-4b1a-a05b-abbc112583da" />
### 2.4 SHA-256を照合する
ダウンロードしたファイル名が異なる場合は、次の`$zip`と検索文字列も実際の名前へ変更します。<br>
```powershell
$zip = "$HOME\Downloads\tunnel-client-v0.0.10-windows-amd64.zip"
$sums = "$HOME\Downloads\SHA256SUMS.txt"
(Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Select-String -Path $sums -Pattern 'tunnel-client-v0\.0\.10-windows-amd64\.zip'
```
`Get-FileHash`の値と、`SHA256SUMS.txt`に書かれた値が一致した場合だけ続行します。<br>
### 2.5 tunnel-client.exeを配置する
自分でZIPを展開し、`tunnel-client.exe`を次の場所へコピーします。<br>フォルダーが存在しない場合は作成します。<br>
```text
<repository>\.tools\tunnel-client\tunnel-client.exe
```
配置後、リポジトリ直下のPowerShellでhelpを表示します。<br>
```powershell
.\.tools\tunnel-client\tunnel-client.exe --help
.\.tools\tunnel-client\tunnel-client.exe help doctor
```
## 3. 同梱MCPのhelpを確認する
設定を推測する前に、実際に使うMCPのhelpを確認します。<br>
```powershell
node mcp\safe-files\server.mjs --help
node mcp\safe-images\server.mjs --help
node mcp\safe-download\server.mjs --help
```
これらの出力、リポジトリとWorkspaceの絶対パス、追加したいstdio MCPの起動コマンドがあれば、`gateway.toml`を組み立てるための情報が揃います。<br>
`.chatgpt-local-mcp-root`のようなマーカーファイルや`--root`引数は不要です。<br>
## 4. gateway.tomlを作成する
### 4.1 設定例をコピーする
```powershell
Copy-Item config\gateway.example.toml config\gateway.toml
code config\gateway.toml
```
`gateway.example.toml`内の`C:\ABSOLUTE\PATH\TO`は説明用のダミーです。<br>
`args`にはこのリポジトリ内のMCPサーバーの絶対パスを、`cwd`と`allowed_directories`には実際に操作するWorkspaceの絶対パスを書きます。<br>
> [!IMPORTANT]
> `config/gateway.toml`は途中まで記入した状態で起動しないでください。<br>
> 使用するすべてのMCPについて、起動コマンド、絶対パス、`cwd`、`prefix`、許可するディレクトリまたはファイルを実際の値で完全に記入してから、手順10へ進みます。<br>
> 使用しない設定例は、削除するか`enabled = false`にしてください。
### 4.2 ダミーパスが残っていないことを確認する
```powershell
rg -n -F 'C:\ABSOLUTE\PATH\TO' config\gateway.toml
```
何も表示されなければ、対象のダミーパスは残っていません。<br>ダミーのまま起動すると、Node.jsは`Cannot find module 'C:\ABSOLUTE\PATH\TO\...'`と`MODULE_NOT_FOUND`を出します。<br>これはnpmパッケージの不足ではなく、`gateway.toml`のパスが未設定であることを示します。<br>

<img width="407" height="416" alt="image" src="https://github.com/user-attachments/assets/62407ca5-152c-4dd5-b21a-859f6759cf97" /><br>

### 4.3 safe-filesを設定する
設定形式はCodexのMCP設定に近い`[mcp_servers.<name>]`です。<br>
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
`safe-files`は`cwd`をWorkspaceのルートとして使います。<br>複数のWorkspaceを扱う場合は、`files_project_a`と`files_project_b`のようにMCPエントリを分け、それぞれに別の`cwd`と`prefix`を指定します。
`list_files`は固定された`rg --files --hidden`経路で再帰一覧を返します。<br>
`excludePaths`へ無視するファイルまたはフォルダーを複数指定でき、`globs`は相対globだけを受け付けます。<br>任意のrg引数、親ディレクトリへ出るglob、改行、NUL、オプションに見える先頭`-`は拒否します。<br>
`.git`内部は常に除外します。<br>
### 4.4 safe-imagesを必要な場合だけ有効にする
Downloads内などのPNG、JPEG、WebPをChatGPTへ画像として渡す場合は、読み取り専用の`safe-images`を追加または有効化します。<br>
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
ChatGPTからは`images__read_image`へ`{"path":"画像.png"}`を渡します。<br>画像base64はMCP画像コンテンツとして返り、通常のテキスト転送ツールには入りません。<br>Downloads全体を許可しない場合は`allowed_directories = []`にし、`allowed_files`へ対象画像の絶対パスだけを書きます。<br>
### 4.5 safe-downloadを必要な場合だけ有効にする
ソースコードなどをZIPで受け取る場合は、`safe-download`を`safe-files`や`safe-images`とは別のMCPエントリとして追加します。<br>
`cwd`と`allowed_directories`には、ChatGPTへ渡してよいソースだけを含む専用ディレクトリを指定します。<br>
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
ChatGPTからは`downloads__download_zip`へ`path`を渡します。<br>単一の`.js`や`.mjs`を指定してもZIPで返します。<br>ディレクトリでは固定された`rg --files`で列挙し、`globs`、`excludePaths`、`includeIgnored`を使用できます。<br>ROM、Save、State、秘密鍵形式、資格情報らしい内容、シンボリックリンク、許可ルート外は拒否します。<br>
### 4.6 任意のstdio MCPを追加する
任意のstdio MCPも同じ形式で追加できます。<br>
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
`blocked_tools`は元のツール名との完全一致で非公開にします。<br>
`blocked_tool_substrings`は大文字と小文字を区別しない単純な部分一致です。<br>globや正規表現ではありません。<br>たとえば`"script"`を指定すると、`evaluate_script`、`runScript`、`SCRIPT_debug`など、元のツール名に`script`を含むツールを公開しません。<br>
`allowed_directories`は指定ディレクトリとその配下を許可します。<br>
`allowed_files`は列挙した絶対パスだけを完全一致で許可します。<br>Chrome DevTools MCPのアップロード元など、Workspace全体を許可する必要がないファイルは`allowed_files`へ一つずつ書きます。<br>Windowsの`\`と`/`、JSONで二重にエスケープされた`\\`は正規化して比較され、相対パスはそのMCPの`cwd`から解決されます。<br>
Gatewayは全MCPのツール引数を再帰的に検査します。<br>
`path`、`filePath`、`files`、`directory`などのパスらしいキー、または絶対パスらしい文字列を検出し、許可リスト外なら子MCPへ渡しません。<br>パス引数を持たないツールは許可リストが空でも動きます。<br>
`enabled = false`のMCPは起動しません。<br>GatewayはMCP名、実行ファイル、引数、作業ディレクトリ、環境変数をハードコードしません。<br>現在直接集約するのは、`command`で起動するstdio MCPです。<br>Ghidra MCPやDQ9 MCPなどの外部MCP本体は同梱していません。<br>
有効なMCPの一部が起動できなくても、Gatewayは初期化を続行し、起動できたMCPのツールだけを公開します。<br>起動できなかったMCPは標準エラーへ`unavailable and was skipped`として記録されます。<br>すべてを一時的に無効化した設定でもGatewayは起動し、ツール一覧は空になります。<br>
Codex設定からコピーした`tool_output_token_limit`、`[mcp_servers.<name>.tools.<tool>]`の承認設定、その他Gatewayが使わない項目は残しても読み飛ばされます。<br>トークン数の計測やCodexの承認UIは実装していないため、無視された項目はこのGatewayでは効果を持ちません。<br>
### 4.7 起動前にgateway.tomlを完成させる
手順10へ進む前に、`config/gateway.toml`のすべての`enabled = true`のMCPを見直します。<br>
`command`、`args`、`cwd`、`prefix`、`allowed_directories`、`allowed_files`など、使用するMCPに必要な項目を完全に記入してください。<br>
説明用のダミーパス、未記入の値、意図していない許可範囲が一つでも残っている場合は、GatewayとTunnelを起動しません。<br>
## 5. ローカル設定を検証する
次の診断は`node`、`npm`、`git`、`rg`、`py`を確認し、途中で止まらず、最後に問題のあるコマンドをまとめます。<br>バージョン番号が例と異なるだけでは失敗にしません。<br>
```powershell
node app\doctor.mjs
```
外部npm依存を追加せず、リポジトリのテストも実行できます。<br>
```powershell
npm test
```
## 6. OpenAI Platformで個人用Tunnelを作成する
### 6.1 Tunnel管理画面を開く
[OpenAI PlatformのTunnel管理画面を開きます](https://platform.openai.com/settings/organization/tunnels)<br>
画面右上の`Create tunnel`を押します。<br>

<img width="2298" height="743" alt="image" src="https://github.com/user-attachments/assets/1d5b7609-4c3b-4fc9-973f-21b0b9af459e" />

### 6.2 Tunnelの公開範囲を入力する
作成画面では次の内容を設定します。<br>
1. `Name`: PCを識別できる名前を入力します。<br>例は`local_my_pc`です。<br>
2. `Description`: `Private tunnel for my local Windows MCP servers. Personal use only.`のように個人用であることを書きます。<br>
3. `Organizations`: 自分の`Personal (...)`だけを選びます。<br>
4. `ChatGPT workspaces`: 自分の`Personal workspace (...)`だけを選びます。<br>
5. 共有Workspace、他人のOrganization、公開用Workspaceを追加せず、`Create`を押します。<br>

<img width="652" height="577" alt="image" src="https://github.com/user-attachments/assets/4460b5c2-4a7d-4ea3-9023-166387ef7c00" />

`Create`が無効のままなら、まず`Description`を入力します。<br>それでも無効なら、ダイアログ内を最下部までスクロールし、残っている必須項目を確認します。<br>
作成後、Tunnelの詳細画面に表示される`tunnel_id`を**控えます**。<br>後で`CONTROL_PLANE_TUNNEL_ID`へ設定します。<br>
> [!WARNING]
> #### このIDはあとで使います
> #### このTunnel IDはパスワードと同じように扱い、絶対に流出させないでください。
> 流出した場合、第三者によって任意コード実行が行われる可能性があります。

<img width="2559" height="668" alt="image" src="https://github.com/user-attachments/assets/42bb5cf1-3ee2-4d32-8efc-5cf4597e6276" />

### 6.3 公式仕様を確認する
[OpenAI Secure MCP Tunnelsの公式ガイドを開く](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)<br>
Tunnelの権限名、環境変数、`tunnel-client`の動作条件が変更されていないかを確認します。<br>このページではTunnelを作成せず、仕様確認だけを行います。<br>
## 7. Tunnel実行専用ロールを作成する
### 7.1 Organization Rolesを開く
[OpenAI PlatformのOrganization Rolesを開く](https://platform.openai.com/settings/organization/people/roles)<br>
新しいロールを作り、名前を`Local MCP Tunnel Runtime - No Model API`のようにします。<br>権限は`Tunnels Read + Use`だけにし、`Tunnels Manage`、モデルAPI、Files、Organization管理などは付けません。<br>

Create roleをクリックします。<br>

<img width="2559" height="412" alt="image" src="https://github.com/user-attachments/assets/56a637a2-1fc8-467f-a038-779cc0eb02ad" />

適当に入力し、Createをクリックします。<br>

<img width="2559" height="950" alt="image" src="https://github.com/user-attachments/assets/73a3abc8-c5cf-4447-ae1b-efc4182b957a" />

作成したら、Permissionsをクリックします。<br>

<img width="2559" height="562" alt="image" src="https://github.com/user-attachments/assets/d88b93b1-4f4f-4128-8c9c-bb05cb0da79c" />

このような画面が表示されたら、Tunnelsの項目を探します。

<img width="700" height="1168" alt="image" src="https://github.com/user-attachments/assets/cfeb6a30-b2c4-4a9a-9dca-221c2aa1c827" />

Tunnelsの権限にReadとUseを設定します。Manageは付与してはいけません。

<img width="828" height="169" alt="image" src="https://github.com/user-attachments/assets/2411441a-a14c-4191-a2ae-74fd185762e1" />

次のようになりました。

<img width="2559" height="492" alt="image" src="https://github.com/user-attachments/assets/6a81e9f5-c8a9-42e0-b90c-2438cac14f60" />
Tunnelの作成や編集には別途`Tunnels Read + Manage`が必要ですが、普段`tunnel-client`を動かすruntime主体にはManage権限を付けません。<br>

### 7.2 自分だけのGroupへロールを割り当てる

[OpenAI PlatformのOrganization Groupsを開く](https://platform.openai.com/settings/organization/people/groups)<br>
自分だけを含むGroupを作成または選択し、先ほど作ったTunnel実行専用ロールを割り当てます。<br>ロールを作成しただけでは権限は有効になりません。<br>

Create groupをクリックします。

<img width="2559" height="734" alt="image" src="https://github.com/user-attachments/assets/464a8f8d-9b5f-4c7d-a7c9-fc738a4f127b" />

グループ名を適当にし、Createをクリックします。

<img width="529" height="213" alt="image" src="https://github.com/user-attachments/assets/905c6f0a-bb44-44dd-aaa8-d90b301a1d3c" />

Rolesをクリックします。

<img width="2559" height="453" alt="image" src="https://github.com/user-attachments/assets/c932d038-6c4a-457e-84b9-54a820f47aeb" />

先ほど作成したロールを選択し、Saveをクリックします。

<img width="503" height="348" alt="image" src="https://github.com/user-attachments/assets/6c9b7a66-2eb0-4ab3-be4e-bf30340c854f" />

Membersをクリックします。

<img width="2559" height="511" alt="image" src="https://github.com/user-attachments/assets/1eb687bb-ea27-486a-a58f-09de46dab9a0" />

Add membersをクリックします。

<img width="746" height="511" alt="image" src="https://github.com/user-attachments/assets/b2ca166a-0228-4f4c-98ae-40d32d3a2c6c" />

`Add members to ...`の画面で、自身のアカウントを選択し、`Add members`をクリックします。
<img width="805" height="528" alt="image" src="https://github.com/user-attachments/assets/6b2613c6-2823-4d87-8355-27a1fa896818" />

Cancelを押してページを閉じます。

<img width="761" height="521" alt="image" src="https://github.com/user-attachments/assets/a7739708-d619-4cf9-b170-83a9e5c983d9" />

## 8. モデルAPI権限のないruntime API keyを作成する
> [!CAUTION]
> このセクションは正確に従ってください。<br>
> 課金可能なAPI keyを作成した場合、流出時に課金が発生し、高額請求、またはクレジットがマイナス（借金）になる可能性があります。<br>
> また、誤ってWebサイトへ貼り付けないように、PowerShellと該当するブラウザーを閉じたうえで作業することをお勧めします。<br>
> 作業完了後は、クリップボードを別の内容で上書きしてください。
### 8.1 Runtime API keysを開く
[OpenAI PlatformのRuntime API keysを開く](https://platform.openai.com/settings/organization/api-keys)<br>
`Create new secret key`を押します。<br>
### 8.2 Tunnel専用権限を設定する
作成画面で次のように設定します。<br>
1. `Name`: `local-mcp-tunnel-runtime-no-model-api`
2. `Project`: Tunnelを作成したOrganization内のProject
3. `Permissions`: **Restricted**
4. `Tunnels`: **`Read + Use`だけを有効化**
5. `List models`、`Responses`、`Chat completions`、`Embeddings`、`Images`、`Files`など、Tunnel以外はすべて`None`

<img width="2552" height="428" alt="image" src="https://github.com/user-attachments/assets/e0f7ab39-afa1-4441-8613-0e0c0a57dfa3" /> <br>
<img width="506" height="550" alt="image" src="https://github.com/user-attachments/assets/5dc5f1aa-96c6-4e7a-8a32-9ab4be6c7352" /> <br>
<img width="656" height="1106" alt="image" src="https://github.com/user-attachments/assets/864a6586-93c4-4578-be00-15e7c729953a" /> <br>
<img width="465" height="1102" alt="image" src="https://github.com/user-attachments/assets/90732951-56b2-40fa-8e20-360b9708bfc1" /> <br>
<img width="497" height="1024" alt="image" src="https://github.com/user-attachments/assets/67965ddd-eb9f-4b4b-920c-460e4b050985" /> <br>
この名前は、モデルAPIに使えないTunnel専用キーであることを後から見ても判別できるようにするためです。<br>
`All`権限のキー、Admin API key、既存のモデルAPI keyは使い回しません。<br>
作成直後に表示されるAPI keyを安全な場所へ一時的に控えます。<br>後から同じ値を再表示できない場合があります。<br>
## 9. Tunnel IDとruntime API keyをユーザー環境変数へ保存する
`tunnel-client`は`CONTROL_PLANE_TUNNEL_ID`と`CONTROL_PLANE_API_KEY`を自動で読みます。<br>起動コマンドへ`--control-plane.tunnel-id`や`--control-plane.api-key`を書く必要はありません。<br>
通常権限のPowerShellで次を実行し、API keyと`tunnel_...`を自分の値へ置き換えます。<br>
`Read-Host`や`SecureString`変換は使いません。<br>
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
これは現在のPowerShellへ即時反映し、Windowsのユーザー環境変数としても永続保存します。<br>Machine環境変数にはせず、管理者PowerShellも使いません。<br>既に起動している別のPowerShellやアプリへは反映されないため、そちらで使う場合は新しく起動します。<br>
同じWindowsユーザーで動く別プロセスからはユーザー環境変数を読めます。<br>SSH鍵や他サービスの資格情報と強く分離したい場合は、このTunnel専用の標準Windowsユーザーで設定します。<br>
確認時もAPI keyの値そのものは表示しません。<br>
```powershell
if ($env:CONTROL_PLANE_API_KEY) { 'CONTROL_PLANE_API_KEY: set' } else { 'CONTROL_PLANE_API_KEY: missing' }
$env:CONTROL_PLANE_TUNNEL_ID
```
`OPENAI_API_KEY`もfallbackとして読まれますが、モデルAPI権限を持つキーとの取り違えを防ぐため、この手順では必ず`CONTROL_PLANE_API_KEY`を使います。<br>
## 10. Tunnelを検査して起動する
リポジトリ直下の通常PowerShellで実行します。<br>
> [!IMPORTANT]
> 手順4で`config/gateway.toml`を完全に記入し、手順5の検証を終えるまで、GatewayとTunnelを起動しないでください。<br>
> ダミーパス、未記入の値、不要な`enabled = true`のMCPが残っている場合は、先に設定を修正します。
この手順ではWindows用の`tunnel-client.exe`を直接実行します。Gatewayの大部分はNode.jsで書かれていますが、この導入手順はWindows 11を対象とします。<br>
`main`チャンネルは必須です。<br>
```powershell
$mcp = 'command=node app/gateway.mjs --config config/gateway.toml,channel=main'

.\.tools\tunnel-client\tunnel-client.exe doctor --mcp.command="$mcp" --explain
.\.tools\tunnel-client\tunnel-client.exe run --mcp.command="$mcp"
```
同じ処理はリポジトリ直下の`start.cmd`でも実行できます。<br>
`doctor`が失敗した場合はTunnelを起動しません。<br>
```powershell
.\start.cmd
```
API keyとTunnel IDは環境変数から取得されます。<br>生のキーをコマンド引数、`gateway.toml`、`.env`、リポジトリ内ファイルへ書きません。<br>
## 11. ChatGPTへ接続する
### 11.1 Developer modeを有効にする
[ChatGPTのDeveloper mode設定を開く](https://chatgpt.com/plugins#settings/Security?section=developer-mode)<br>
Developer modeを有効にし、カスタムMCPを利用する際の警告を確認します。<br>

<img width="2559" height="605" alt="image" src="https://github.com/user-attachments/assets/906e6564-ba06-43c1-be27-23baa7708f62" />

<img width="453" height="138" alt="image" src="https://github.com/user-attachments/assets/e338ca3e-9394-4978-9ce8-ed82bf09af25" />

### 11.2 カスタムアプリ作成画面を開く
[ChatGPTのカスタムアプリ作成画面を開く](https://chatgpt.com/plugins#settings/Connectors?create-connector=true)<br>
名前と説明を入力し、Connectionで`Tunnel`を選び、手順6で作成したTunnelを選択します。<br>Tunnelが選べない場合は、そのTunnelへ自分のChatGPT Workspaceが関連付けられているかを確認します。<br>

<img width="2566" height="1156" alt="image" src="https://github.com/user-attachments/assets/c5636bd8-ad76-45e3-9156-71d9a42a3be7" />

この時点で動作確認が行われます。エラーが発生する場合は、ローカルプロキシの出力をAIに丸投げしてください。

<img width="782" height="1061" alt="image" src="https://github.com/user-attachments/assets/db976858-3d45-48ab-992b-6f557872a101" />

作成後、次に表示される画面で有効化してください。

### 11.3 ChatGPT接続手順の公式資料を確認する
[OpenAIのChatGPT接続ガイドを開く](https://developers.openai.com/plugins/deploy/connect-chatgpt)<br>
ChatGPT側の画面名や接続方式が変更されていないかを確認します。<br>このページでは新しい接続先を作らず、仕様確認だけを行います。<br>
## 12. カスタムアプリを更新して公開ツールを確認する
### 12.1 カスタムアプリを更新する
> [!NOTE]
> GatewayまたはTunnelを起動・再起動した後は、ChatGPT側でカスタムアプリを更新してください。<br>
> `config/gateway.toml`でMCPや公開ツールを変更した場合も、更新するまでChatGPTには古いツール一覧が表示されることがあります。<br>
[カスタムアプリの設定を開く](https://chatgpt.com/#settings/Plugins)<br>
作成したカスタムアプリ（コネクター）をクリックします。<br>
<img width="745" height="677" alt="image" src="https://github.com/user-attachments/assets/e3332e2d-a854-4f2f-86cd-9c24b8c4227e" /><br>
詳細設定が表示されたら、一番下までスクロールします。<br>
<img width="764" height="631" alt="image" src="https://github.com/user-attachments/assets/76bf233d-d2d9-49cf-8d51-7bab33461c70" /><br>
`更新`をクリックします。<br>
<img width="675" height="328" alt="image" src="https://github.com/user-attachments/assets/70a0d485-d980-4be4-9d53-f311e51cc1aa" /><br>
更新が完了すると、起動中のGatewayから最新のツール一覧が読み込まれます。<br>
### 12.2 公開されたツールを確認する
ChatGPTで作成したカスタムアプリを有効にし、表示されたツール名を確認します。<br>想定外のMCPやツールが公開されている場合は、`gateway.toml`で対象MCPを`enabled = false`にするか、`blocked_tools`または`blocked_tool_substrings`へ追加し、Tunnelを再起動してカスタムアプリを再度更新します。<br>
このTunnelは自分専用として扱い、公開申請、第三者共有、共有Workspaceへの追加は行いません。
### 12.3 動作確認する
ChatGPTに、作成したカスタムアプリのツールが利用可能になったか確認させてください。
> [!IMPORTANT]
> お疲れさまでした。ChatGPTからローカルMCPを使用できるようになりました。


### 13 参考文献


https://x.com/nakasyou0/status/2083740389471904012 <br>

https://azukiazusa.dev/blog/openai-secure-mcp-tunnel/ <br>
