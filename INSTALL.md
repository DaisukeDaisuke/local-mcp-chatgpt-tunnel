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
.\.tools\tunnel-client\tunnel-client.exe help quickstart
.\.tools\tunnel-client\tunnel-client.exe help doctor
node mcp\safe-files\server.mjs --help
```
この3つの出力、読ませたいWorkspaceの絶対パス、接続したいMCPの起動コマンドをAIへ渡せば、AIが`gateway.toml`の`args`とTunnel起動コマンドを組み立てられます。`.chatgpt-local-mcp-root`のようなマーカーファイルは不要です。
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
args = ["mcp/safe-files/server.mjs", "--root", 'C:\Users\owner\Documents\my-project']
cwd = ".."
enabled = true
prefix = "files"
startup_timeout_sec = 30
tool_timeout_sec = 1800
```
複数Workspaceを許可する場合は`--root`を繰り返します。
```toml
args = ["mcp/safe-files/server.mjs", "--root", 'C:\work\project-a', "--root", 'D:\work\project-b']
```
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
[mcp_servers.example.env]
EXAMPLE_CONFIG = 'C:\path\to\config.json'
```
`enabled = false`なら起動しません。GatewayはMCP名、実行ファイル、引数、作業ディレクトリ、環境変数をハードコードしません。現在のGatewayが直接集約するのは`command`で起動するstdio MCPです。
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
## 6. 自分専用のTunnelとruntime keyを作る
公式手順を開きます。
```text
https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
https://developers.openai.com/plugins/deploy/connect-chatgpt
```
OpenAI PlatformでTunnelを作り、関連付け先を自分のOrganizationと自分のChatGPT Workspaceだけにします。共有Workspace、他人のOrganization、公開Pluginには関連付けません。
runtime主体には`Tunnels Read + Use`だけを与えます。Tunnel管理用の`Read + Manage`、モデルAPI、Organization管理、Filesなどの権限は与えません。
## 7. API keyを引数で渡して検査・起動する
`tunnel_id`、runtime API key、Gatewayコマンドを自分の値へ置き換えます。このリポジトリはキーを保存しません。
```powershell
$gateway = 'node app/gateway.mjs --config config/gateway.toml'
.\.tools\tunnel-client\tunnel-client.exe doctor --control-plane.tunnel-id=tunnel_0123456789abcdef0123456789abcdef --control-plane.api-key=sk_REPLACE_ME --mcp.command="$gateway" --explain
.\.tools\tunnel-client\tunnel-client.exe run --control-plane.tunnel-id=tunnel_0123456789abcdef0123456789abcdef --control-plane.api-key=sk_REPLACE_ME --mcp.command="$gateway"
```
引数方式では、実行したシェルの履歴や同一PC上のプロセス情報にキーが見える可能性があります。これはNode.jsラッパーで隠しません。許容できない環境では、`tunnel-client help quickstart`に表示される環境変数またはファイル参照方式を使ってください。
## 8. ChatGPTへ接続する
ChatGPTのDeveloper modeを有効にし、Connectionで作成したTunnelを選びます。表示されたツール名を確認し、想定外のMCPがあれば`gateway.toml`で`enabled = false`にしてTunnelを再起動します。公開申請や第三者共有は行いません。
