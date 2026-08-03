# Local MCP ChatGPT Tunnel
OpenAI公式Secure MCP Tunnelを使い、Windows上の個人用stdio MCPをChatGPT Developer Modeへ接続するためのGatewayです。独自AIハーネス、Responses API、モデルAPI課金処理、公開MCP URL、受信インターネットポートは実装しません。
## 設定方式
接続するMCPは`config/gateway.toml`の`[mcp_servers.<name>]`で指定します。`command`、`args`、`cwd`、`enabled`、`env`を使うCodexに近い形式で、Gatewayコード内に特定MCPの起動設定はありません。Ghidra MCP、DQ9 MCP、Chrome DevTools MCPなどの第三者実装も再配布しません。
```toml
private_use_only = true
[mcp_servers.files]
command = "node"
args = ['C:\work\local-mcp-chatgpt-tunnel\mcp\safe-files\server.mjs']
cwd = 'C:\work\project'
enabled = true
prefix = "files"
startup_timeout_sec = 30
tool_timeout_sec = 1800
allowed_directories = ['C:\work\project']
allowed_files = []
[mcp_servers.files.env]
EXAMPLE = "value"
```
`enabled = false`のMCPは起動しません。Gatewayは有効なstdio MCPだけを子プロセスとして起動し、ツール名を`<prefix>__<tool>`へ名前空間化します。
Codex固有の`tool_output_token_limit`、ツール別`approval_mode`、Gatewayが使わない未知の項目は無視します。Codexの設定をコピーするときに、それらを削除する必要はありません。ただし、このGateway上では効果もありません。
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
## パス許可
Gatewayは全MCPのツール引数を再帰的に検査し、パスらしい値を`allowed_directories`と`allowed_files`へ照合します。
```toml
allowed_directories = ['C:\work\project']
allowed_files = ['C:\Users\owner\Downloads\upload.png']
```
`allowed_directories`は指定ディレクトリとその配下、`allowed_files`は指定ファイルだけを完全一致で許可します。Windowsの`\`、`/`、JSONで二重にエスケープされた`\\`は正規化し、相対パスはMCPの`cwd`から解決します。既存パスはシンボリックリンクの実体も確認します。
`path`、`filePath`、`files`、`directory`などのキー、または絶対パスらしい文字列を検出します。パスらしい引数が許可リスト外なら、子MCPへ渡す前に拒否します。URLはファイルパスとして扱いません。
この検査はChatGPTからMCPへ渡る引数のガードです。悪意あるMCP自身が内部で勝手にファイルを読むことをOSレベルで防ぐものではありません。
## ファイルMCP
`safe-files`はプロセスの`cwd`をWorkspaceルートとして使います。`--root`やマーカーファイルは不要です。
```powershell
node mcp\safe-files\server.mjs --help
```
AIへhelp出力、リポジトリの絶対パス、Workspaceの絶対パスを渡せば、AIが`args`、`cwd`、`allowed_directories`を組み立てられます。複数WorkspaceはMCPエントリを分けます。許可ルート外とシンボリックリンク脱出を拒否し、高確度の資格情報らしい内容も返しません。危険そうなフォルダ名を一律ブラックリスト化せず、Gatewayの明示許可パスを境界にします。
`search_text`は固定された`rg`だけを起動します。検索式、許可ルート内の対象パス、globは指定できますが、実行ファイルや任意コマンドは指定できません。`read_file_chunk`と`write_file`は境界内のファイル転送用です。
## 画像MCP
`safe-images`はPNG、JPEG、WebPをMCPの画像コンテンツとしてChatGPTへ返す読み取り専用MCPです。`cwd`を画像ルートとして使い、初期状態では8 MiB、50メガピクセルまでに制限します。
```powershell
node mcp\safe-images\server.mjs --help
```
```toml
[mcp_servers.images]
command = "node"
args = ['C:\work\local-mcp-chatgpt-tunnel\mcp\safe-images\server.mjs']
cwd = 'C:\Users\owner\Downloads'
enabled = true
prefix = "images"
startup_timeout_sec = 30
tool_timeout_sec = 120
allowed_directories = ['C:\Users\owner\Downloads']
allowed_files = []
```
公開ツールは`images__read_image`だけです。拡張子とマジックバイトの不一致、SVG、HEIC、空ファイル、サイズ超過、寸法超過、許可ルート外、シンボリックリンク、NTFS代替データストリームを拒否します。base64はMCPの画像ブロックだけへ格納し、`structuredContent`には重複させません。Tunnel側の確認結果は`docs/tunnel-client-image-forwarding.md`にあります。
## Node.jsの役割
導入時のNode.jsスクリプトは`app/doctor.mjs`だけです。`node`、`npm`、`git`、`rg`、`py`のバージョンをすべて出力し、一つ失敗しても残りを確認します。インストール、ZIP展開、設定生成、runtime key入力、Git hook変更は行いません。
Gateway本体と同梱MCPは実行時にNode.jsを使います。Tunnelの初期化、診断、起動は公式`tunnel-client.exe`を直接実行します。
## 個人専用
このGatewayへ任意コード実行能力を持つMCPを登録できます。Tunnelは自分のOrganizationと自分のChatGPT Workspaceだけに関連付け、共有・公開しないでください。OSレベルで資格情報を隔離する必要がある場合は、専用の標準Windowsユーザーを使います。
## 導入
手順は`INSTALL.md`にあります。