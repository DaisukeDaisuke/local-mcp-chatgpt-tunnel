# Local MCP ChatGPT Tunnel
Windows上で動くstdio形式のMCPサーバーを、OpenAI公式Secure MCP Tunnel経由でChatGPT Developer Modeへ接続するためのローカルGatewayです。<br>
複数のstdio MCPを1つに集約し、ツール名の名前空間化、公開ツールの除外、パス許可、直列実行、遅延起動を設定ファイルから制御できます。<br>

<br>

![ChatGPTからローカルstdio MCPへ接続する構成](./docs/images/architecture.svg)

## インストール方法

> [!IMPORTANT]
> Windows環境での導入手順は[INSTALL.md](./INSTALL.md)を参照してください。

## セキュリティ警告

> [!WARNING]
> 自分のWindows PC、自分のOpenAI Platform Organization、自分のChatGPT Workspaceだけで使う個人専用ツールです。<br>
> 任意コード実行能力を持つMCPを接続できるため、第三者への共有や公開Pluginとしての運用は想定していません。<br>

## AIによる実装について
> [!CAUTION]
> このリポジトリは、ChatGPT 5.6 Sol Highによって実装されました。<br>
> AIが生成したコードを含むため、誤りや脆弱性が残っている可能性があります。<br>
> 実際に使用する前にコードと設定内容を確認し、利用者自身の責任で使用してください。<br>

## 何ができるか
- ChatGPTからWindows上のstdio MCPサーバーを呼び出す
- 複数のMCPを`<prefix>__<tool>`形式のツール名へまとめる
- 任意のstdio MCPを`config/gateway.toml`へ追加する
- MCPごとに許可するディレクトリとファイルを制限する
- 危険なツールを名前または部分文字列で非公開にする
- 同時実行させたくないMCPを`serial_group`で直列化する
- 必要に応じて、特定のMCP全体を無効化する
## このリポジトリが行わないこと
- OpenAI Responses APIやChat Completions APIの呼び出し
- 独自AIエージェント、独自ハーネス、モデル課金処理の実装
- 公開MCP URLやローカル受信ポートの提供
- Node.js、Git、ripgrep、Python、tunnel-clientの自動インストール
- Ghidra MCP、Chrome DevTools MCP、DQ9 MCPなど第三者MCPの再配布

<br>

Secure MCP Tunnelへの接続は公式`tunnel-client.exe`が担当します。<br>このリポジトリは、その標準入出力へ接続するローカルMCP Gatewayと同梱MCPを提供します。
## 対応環境
現在の導入手順はWindows 11向けです。<br>実行にはNode.js LTSとOpenAI公式`tunnel-client.exe`を使います。<br>同梱のファイル検索機能にはripgrepを使い、診断スクリプトは`node`、`npm`、`git`、`rg`、`py`を確認します。
macOSとLinux向けの導入手順、Docker構成、受信ポートを開く構成は用意していません。
## 使い始めるまで
使えるようになるまでの手順は、[INSTALL.md](./INSTALL.md)にまとめています。<br>
大まかな流れは次のとおりです。<br>
1. 必要なソフトと公式`tunnel-client.exe`を手動で用意する
2. `config/gateway.example.toml`を`config/gateway.toml`へコピーして絶対パスを書き換える
3. OpenAI Platformで個人用Tunnelと実行専用runtime API keyを作る
4. Tunnel IDとruntime API keyをWindowsのユーザー環境変数へ保存する
5. `start.cmd`で診断後にTunnelを起動する
6. ChatGPT Developer Modeから個人用Tunnelを選択する<br>
設定や権限を推測して進めず、必ず[INSTALL.md](./INSTALL.md)を上から確認してください。<br>
## 同梱MCP
| MCP | 公開ツールの例 | 用途 |
| --- | --- | --- |
| `safe-files` | `list_files`、`search_text`、`read_text_file`、`write_text_file`、`replace_text`、`apply_patch` | 許可したWorkspace内の一覧、UTF-8検索、読み書き、限定されたパッチ適用 |
| `safe-images` | `read_image` | PNG、JPEG、WebPをChatGPTの画像コンテンツとして読み取る |
| `safe-download` | `download_zip` | 許可したソースを単一ファイルでもZIPとしてChatGPTへ渡す |
| `gitmcp` | `status`、`diff`、`log`、`branches`、`switch_branch`、`add_all`、`commit`、`push`、`pull`、`clone_repository` | 許可したリポジトリに対する限定されたGit操作 |
同梱MCPは外部npm依存を持ちません。すべてのツールが`outputSchema`を宣言します。<br>
### safe-files
`safe-files`は、`gateway.toml`で指定された`cwd`をプロセスの作業ディレクトリ兼Workspaceルートとして使います。<br>
主な機能は次のとおりです。<br>
- 固定された`rg --files --hidden`による再帰一覧
- 固定された`rg`によるUTF-8テキスト検索
- UTF-8テキストの読み書きと完全一致置換
- サイズを制限したbase64ファイル転送
- ディレクトリ作成
- 内蔵パーサーまたは固定された`git apply`によるパッチ適用<br>
再帰一覧では`.git`内部を常に除外し、パッチでは`.git`内部を対象にできません。許可ルート外、シンボリックリンクによる脱出、高確度で資格情報らしい内容なども拒否します。<br>一般シェル、PowerShell、任意コマンド実行ツールは含みません。
### safe-images
`safe-images`は読み取り専用です。PNG、JPEG、WebPの拡張子とマジックバイトを照合し、初期状態では8 MiB、50メガピクセルまでに制限します。<br>
SVG、HEIC、空ファイル、許可ルート外、シンボリックリンク、UNCパス、NTFS代替データストリームを拒否します。<br>
### safe-download
`safe-download`は読み取り専用で、単一ファイルまたはディレクトリを常にZIPとして返します。`safe-files`とは別の`cwd`と許可リストを設定し、ChatGPTへ渡してよいソースだけを公開します。<br>
ディレクトリは固定された`rg --files --hidden`で列挙し、`.git`内部、ROM、Save、State、秘密鍵形式、資格情報らしい内容、許可範囲外、シンボリックリンクを拒否します。<br>
### gitmcp
`gitmcp`は、許可されたディレクトリ内のGitリポジトリに対して、固定されたGitサブコマンドとオプションだけを実行します。一般シェルや任意Git引数は受け取らず、`.git`の直接編集、フック追加、force push、任意refspecには対応しません。<br>
`status`、追跡ファイル一覧、ブランチ・remote・履歴の確認、作業ツリーまたはstaged差分、ブランチ切り替え、`git add --all -- .`、commitを利用できます。`push`、`pull`、cloneは起動引数で個別に無効化でき、設定例では`pull`とcloneを無効にしています。cloneでは固定の`--recurse-submodules`を選択できます。<br>
`repositoryPath`へサブモジュールや入れ子のGitリポジトリを直接指定すると、そのリポジトリ自身のstatus、diff、logなどを取得できます。親リポジトリ配下を再帰探索して、すべての入れ子リポジトリを自動列挙するツールは含みません。<br>
## 任意のstdio MCPを追加する
接続するMCPの起動コマンドや引数は、Gateway本体ではなく`config/gateway.toml`の`[mcp_servers.<name>]`へ記述します。<br>
```toml
private_use_only = true
[mcp_servers.example]
command = "py"
args = ['C:\path\to\server.py']
cwd = 'C:\path\to'
enabled = true
prefix = "example"
startup_timeout_sec = 30
tool_timeout_sec = 1800
allowed_directories = ['C:\work\project']
allowed_files = ['C:\Users\owner\Downloads\one-upload-file.png']
[mcp_servers.example.env]
EXAMPLE_CONFIG = 'C:\path\to\config.json'
```
有効なstdio MCPだけが子プロセスとして起動し、元のツール名`tool_name`はChatGPT側で`example__tool_name`として公開されます。`enabled = false`のエントリは起動しません。<br>
Codex設定からコピーした`tool_output_token_limit`、ツール別の承認設定、Gatewayが認識しない項目は無視されます。このGateway上では効果を持ちません。<br>
## Gateway設定
### ユーザーの決定は尊重されます
Gatewayの動作は、利用者が`config/gateway.toml`へ明示した設定によって決まります。<br>
MCPを自動検出して勝手に登録することや、設定ファイルを自動的に書き換えることはありません。<br>
接続するMCP、その起動コマンド、引数、作業ディレクトリ、環境変数、有効・無効、公開しないツール、パスの許可・拒否範囲、直列実行、遅延起動は、すべて利用者が選択します。<br>Gatewayはその設定を読み取り、検証して適用しますが、利用者の代わりに安全性や用途を推測して設定を追加したり、許可範囲を広げたりしません。<br>
`config/gateway.example.toml`は設定例であり、そのまま適用される「魔法のスクリプト」ではありません。<br>必要な項目だけを確認して`config/gateway.toml`へ記述し、実際に起動するプログラムと公開する機能を利用者自身が把握できる構成にしています。<br>
### パス許可
`allowed_directories`は指定したディレクトリとその配下を許可し、`allowed_files`は指定したファイルだけを完全一致で許可します。<br>
Gatewayはすべての子MCPのツール引数を再帰的に検査し、`path`、`filePath`、`files`、`directory`などのキーや絶対パスらしい文字列を許可リストへ照合します。相対パスは対象MCPの`cwd`から解決します。<br>
```toml
allowed_directories = ['C:\work\project']
allowed_files = ['C:\Users\owner\Downloads\upload.png']
```
この検査はChatGPTから子MCPへ渡るツール引数のガードです。接続したMCP自身が内部で勝手にファイルへアクセスすることを、OSレベルで防ぐ機能ではありません。<br>
### 公開ツールの除外
ツール名の完全一致は`blocked_tools`、大文字小文字を区別しない部分一致は`blocked_tool_substrings`で非公開にできます。
```toml
blocked_tools = ["dangerous_tool"]
blocked_tool_substrings = ["script", "shell", "execute"]
```
`blocked_tool_substrings`はglobや正規表現ではありません。たとえば`"script"`は`evaluate_script`、`runScript`、`SCRIPT_debug`をすべて対象にします。<br>
### 直列実行と遅延起動
同じ資源を同時操作させたくないMCPは、同じ`serial_group`へ所属させられます。
`deferred = true`にしたMCPは初期化時に起動せず、別MCPの指定ツールが成功した後に`start_after`で起動できます。`stop_after`では同様に停止できます。<br>
```toml
[mcp_servers.browser]
command = "node"
args = ["browser-server.mjs"]
cwd = ".."
enabled = true
prefix = "browser"
deferred = true
serial_group = "browser"
[mcp_servers.browser.start_after]
server = "controller"
tool = "prepare_browser"
[mcp_servers.browser.stop_after]
server = "controller"
tool = "stop_browser"
```
## セキュリティ上の前提
> [!WARNING]
> `gateway.toml`の`command`はローカルプログラムを実行します。信頼できるMCPだけを登録してください。<br>
> コマンドによっては、インターネット上のMCPプログラムを直接取得して実行するものもあります。<br>
> `gateway.toml`で指定したコマンドは、サンドボックス内ではなく、実際のPC上でWindowsユーザーの権限を使って実行されます。<br>
> 信頼できないMCPを指定しないでください。<br>

Gatewayは管理者権限での起動を拒否し、子MCPへ親プロセスの秘密情報らしい環境変数をそのまま継承しません。ただし、同じWindowsユーザーが読めるファイルをOSレベルで隔離するものではありません。<br>
Tunnelは自分のPlatform Organizationと自分のChatGPT Workspaceだけへ関連付け、runtime API keyには`Tunnels Read + Use`以外の権限を与えない構成を推奨します。詳細は[SECURITY.md](./SECURITY.md)と[INSTALL.md](./INSTALL.md)を確認してください。<br>
## 診断とテスト
必要なコマンドの検出とバージョン確認を行います。インストールや設定変更は行いません。<br>
```powershell
node app\doctor.mjs
```
リポジトリのテストは次で実行できます。<br>
```powershell
npm test
```
外部npm依存はありません。<br>
## ライセンス
このリポジトリ本体は[MIT License](./LICENSE)です。<br>公式`tunnel-client.exe`など第三者コンポーネントについては[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)を確認してください。<br>
