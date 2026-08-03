# Local MCP ChatGPT Tunnel
OpenAI公式Secure MCP Tunnelを使い、Windows上の個人用stdio MCPをChatGPT Developer Modeへ接続するためのGatewayです。独自AIハーネス、Responses API、モデルAPI課金処理、公開MCP URL、受信インターネットポートは実装しません。
## 設定方式
接続するMCPは`config/gateway.toml`の`[mcp_servers.<name>]`で指定します。`command`、`args`、`cwd`、`enabled`、`env`を使うCodexに近い形式で、Gatewayコード内にDQ9、Chrome、Ghidraなどの起動設定はありません。
```toml
private_use_only = true
[mcp_servers.files]
command = "node"
args = ["mcp/safe-files/server.mjs", "--root", 'C:\work\project']
cwd = ".."
enabled = true
prefix = "files"
startup_timeout_sec = 30
tool_timeout_sec = 1800
[mcp_servers.files.env]
EXAMPLE = "value"
```
`enabled = false`のMCPは起動しません。Gatewayは有効なstdio MCPだけを子プロセスとして起動し、ツール名を`<prefix>__<tool>`へ名前空間化します。
Codex固有の`tool_output_token_limit`とツール別`approval_mode`は実装していません。有効MCPに書かれている場合は、効いたように見せず設定エラーにします。
競合を避けるため同時実行を直列化する場合は`serial_group`、公開したくないツールは`blocked_tools`を指定できます。別MCPのツール成功後だけ起動・停止する構成も設定側へ書けます。
```toml
[mcp_servers.browser]
command = "node"
args = ["browser-server.mjs"]
cwd = ".."
enabled = true
deferred = true
serial_group = "browser"
blocked_tools = ["dangerous_tool"]
[mcp_servers.browser.start_after]
server = "controller"
tool = "prepare_browser"
[mcp_servers.browser.stop_after]
server = "controller"
tool = "stop_browser"
```
## ファイルMCP
許可パスはマーカーファイルではなく起動引数で明示します。
```powershell
node mcp\safe-files\server.mjs --help
node mcp\safe-files\server.mjs --root C:\work\project-a --root D:\work\project-b
```
AIへhelp出力と実際のWorkspaceパスを渡せば、AIが`gateway.toml`の`args`を組み立てられます。許可ルート外、シンボリックリンク脱出、`.ssh`、`.codex`、`.git`、`.env`、鍵、資格情報らしい名前と内容は拒否します。
`search_text`は固定された`rg`だけを起動します。検索式、許可ルート内の対象パス、globは指定できますが、実行ファイルや任意コマンドは指定できません。`read_file_chunk`と`write_file`は境界内のファイル転送用です。
## Node.jsの役割
導入時のNode.jsスクリプトは`app/doctor.mjs`だけです。`node`、`npm`、`git`、`rg`、`py`のバージョンをすべて出力し、一つ失敗しても残りを確認します。インストール、ZIP展開、設定生成、runtime key入力、Git hook変更は行いません。
Gateway本体と同梱MCPは実行時にNode.jsを使います。Tunnelの初期化、診断、起動は公式`tunnel-client.exe`を直接実行します。
## 個人専用
このGatewayへ任意コード実行能力を持つMCPを登録できます。Tunnelは自分のOrganizationと自分のChatGPT Workspaceだけに関連付け、共有・公開しないでください。OSレベルで資格情報を隔離する必要がある場合は、専用の標準Windowsユーザーを使います。
## 導入
手順は`INSTALL.md`にあります。