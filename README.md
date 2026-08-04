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
- 必要に応じて、公開済みツールをフル識別子またはprefixで検索する内蔵ディレクトリを公開する
## このリポジトリが行わないこと
- OpenAI Responses APIやChat Completions APIの呼び出し
- 独自AIエージェント、独自ハーネス、モデル課金処理の実装
- 公開MCP URLやローカル受信ポートの提供
- Node.js、Git、ripgrep、Python、tunnel-clientの自動インストール
- Ghidra MCP、Chrome DevTools MCP、DQ9 MCPなど第三者MCPの再配布

<br>

Secure MCP Tunnelへの接続は公式`tunnel-client.exe`が担当します。<br>このリポジトリは、その標準入出力へ接続するローカルMCP Gatewayと同梱MCPを提供します。
## 対応環境
現在の導入手順はWindows 11向けです。<br>実行にはNode.js LTSとOpenAI公式`tunnel-client.exe`を使います。<br>同梱のファイル検索機能にはripgrepを使い、GitHub Actions確認にはGitHub CLIを使います。診断スクリプトは`node`、`npm`、`git`、`gh`、`rg`、`py`を確認します。
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
| `safe-files` | `list_files`、`search_text`、`file_info`、`read_text`、`write_text_file`、`replace_text`、`apply_patch` | 許可したWorkspace内の一覧、UTF-8検索、複数ファイル・行範囲読み取り、ファイル情報、読み書き、限定されたパッチ適用 |
| `safe-images` | `read_image` | PNG、JPEG、WebPをChatGPTの画像コンテンツとして読み取る |
| `safe-download` | `download_zip` | 許可したソースを単一ファイルでもZIPとしてChatGPTへ渡す |
| `gitmcp` | `status`、`diff`、`log`、`branches`、`switch_branch`、`add_all`、`commit`、`push`、`pull`、`clone_repository` | 許可したリポジトリに対する限定されたGit操作 |
| `gh-workflow` | `list_runs`、`watch_run`、`view_run`、`view_run_jobs`、`view_failed_logs`、`list_workflows`、`view_workflow_yaml` | 明示的に許可したGitHubリポジトリのActions実行状況を読み取り専用で確認 |
同梱MCPは外部npm依存を持ちません。すべてのツールが`outputSchema`を宣言します。<br>
### safe-files
`safe-files`で外向きに「MCP root」と呼ぶものは、`gateway.toml`で指定された`cwd`を初期値とする現在の作業ディレクトリです。相対パスはこのMCP rootから解決され、`set_working_directory`で許可ディレクトリ内の別の既存ディレクトリへ変更できます。<br>
`read_text`はMCP rootからの相対パスと絶対パスの両方を受け付けますが、正規化後および実在パス解決後の対象が設定された許可ディレクトリ内に残る場合だけ読み取ります。<br>
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
ディレクトリは固定された`rg --files --hidden`で列挙し、`.git`内部、ROM、Save、State、秘密鍵形式、資格情報らしい内容、許可範囲外、シンボリックリンクを拒否します。`disallowed_path_globs`が設定されている場合は、利用者指定の`globs`や`excludePaths`を適用する前に対象ディレクトリ全体を確認し、拒否パターンへ一致するファイルまたはフォルダが1件でもあればZIP作成全体を拒否します。エラーには一致した設定パターンと対象パスを含めます。<br>
### gitmcp
`gitmcp`は、許可されたディレクトリ内のGitリポジトリに対して、固定されたGitサブコマンドとオプションだけを実行します。一般シェルや任意Git引数は受け取らず、`.git`の直接編集、フック追加、force push、任意refspecには対応しません。<br>
`status`、追跡ファイル一覧、ブランチ・remote・履歴の確認、作業ツリーまたはstaged差分、ブランチ切り替え、`git add --all -- .`、commitを利用できます。`push`、`pull`、cloneは起動引数で個別に無効化でき、設定例では`pull`とcloneを無効にしています。cloneでは固定の`--recurse-submodules`を選択できます。<br>
`repositoryPath`へサブモジュールや入れ子のGitリポジトリを直接指定すると、そのリポジトリ自身のstatus、diff、logなどを取得できます。親リポジトリ配下を再帰探索して、すべての入れ子リポジトリを自動列挙するツールは含みません。<br>
### gh-workflow
`gh-workflow`は、起動引数`--repository=OWNER/REPO`で明示的に許可したGitHubリポジトリについて、GitHub Actionsの実行状況だけを読み取ります。`--repository=`は複数回指定でき、指定されていないリポジトリは選択できません。許可リポジトリが1件なら各ツールで省略でき、複数なら対象リポジトリの指定が必須です。設定例では`DaisukeDaisuke/desmume_webassembly`を指定し、MCP自体はデフォルト無効です。<br>
`gh run list --branch main --limit 3`、`gh run watch RUN_ID --exit-status`、`gh run view RUN_ID`に相当するツールに加え、job一覧、全ログ、失敗ログ、workflow一覧、workflow概要、workflow YAMLを取得できます。workflow dispatch、rerun、cancel、delete、artifact download、`gh api`は公開しません。<br>
`gh`は`spawn`から`shell=false`で直接起動し、サブコマンドとオプションを固定しています。run ID、branch、workflow識別子は個別に検証し、標準入力を閉じ、出力サイズを制限します。子プロセスの`cwd`は必ず`gateway.toml`で明示してください。認証にはローカルの`gh auth login`で保存されたGitHub CLI設定を利用できます。<br>
## 任意のstdio MCPを追加する
接続するMCPの起動コマンドや引数は、Gateway本体ではなく`config/gateway.toml`の`[mcp_servers.<name>]`へ記述します。<br>
```toml
private_use_only = true
publish_tool_directory = false
[mcp_servers.example]
command = "py"
args = ['C:\path\to\server.py']
cwd = 'C:\path\to'
enabled = true
prefix = "example"
annotation_config = true
startup_timeout_sec = 30
tool_timeout_sec = 1800
allowed_directories = ['C:\work\project']
allowed_files = ['C:\Users\owner\Downloads\one-upload-file.png']
[mcp_servers.example.env]
EXAMPLE_CONFIG = 'C:\path\to\config.json'
```
有効なstdio MCPだけが子プロセスとして起動し、元のツール名`tool_name`はChatGPT側で`example__tool_name`として公開されます。`enabled = false`のエントリは起動しません。<br>
Codex設定からコピーした`tool_output_token_limit`、ツール別の承認設定、Gatewayが認識しない項目は無視されます。このGateway上では効果を持ちません。<br>
### 外部MCPのツールannotations
外部MCPは、子MCPが返した`annotations`を基準にしつつ、欠けている`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`を明示値へ補完して公開します。子MCPが`readOnlyHint = true`だけを返した場合は、明示指定がない限り`destructiveHint = false`、`idempotentHint = true`として補完します。<br>
Gateway起動時、`tool_annotations_path`で指定したTOMLがなければ作成し、有効な外部MCPのprefixに対応する`[tool_annotations.<prefix>]`が存在しない場合は末尾へ追加します。子MCPから取得したツール識別名も`[tool_annotations.<prefix>.tools]`へ`UNCLASSIFIED`として追記します。既存のprefix設定やツール割り当ては上書きせず、消えたツールも自動削除しません。<br>
同梱MCPは各`server.mjs`でannotationsを定義しているため、`gateway.toml`で`annotation_config = false`にします。外部MCPは省略時に`true`として扱います。<br>
自動生成されるTOML内には、次の省略名と4つのhintの意味がコメントで記載されます。`open_world_hint`はprefix全体、`open_world_tools`は個別ツールの`openWorldHint`を上書きします。<br>
```toml
[tool_annotations.chrome-devtools]
default = "LOCAL_STATE_ANNOTATIONS"
open_world_hint = true
[tool_annotations.chrome-devtools.tools]
take_snapshot = "READ_ONLY_ANNOTATIONS"
click = "UNCLASSIFIED"
[tool_annotations.chrome-devtools.open_world_tools]
take_snapshot = false
click = true
```
`UNCLASSIFIED`は子MCPが返したannotationsの既存値を保持し、欠けているhintだけを補完する未分類マーカーです。分類時は各ツール識別名の値を`READ_ONLY_ANNOTATIONS`、`LOCAL_STATE_ANNOTATIONS`、`LOCAL_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS`、`LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS`、`LOCAL_ADDITIVE_IDEMPOTENT_ANNOTATIONS`のいずれかへ変更します。<br>
## Gateway設定
### ユーザーの決定は尊重されます
Gatewayの動作は、利用者が`config/gateway.toml`へ明示した設定によって決まります。MCPを自動検出して勝手に登録することや、設定ファイルを自動的に書き換えることはありません。<br>
例外として、外部MCPのツールannotationsだけは、`tool_annotations_path`で指定された独立TOMLへ未登録prefixと新しく発見したツール識別名を追記します。新規ツールは`UNCLASSIFIED`になり、`gateway.toml`、既存prefix、既存ツール設定は変更しません。<br>
接続するMCP、その起動コマンド、引数、作業ディレクトリ、環境変数、有効・無効、公開しないツール、パスの許可・拒否範囲、直列実行、遅延起動は、すべて利用者が選択します。<br>
Gatewayはその設定を読み取り、検証して適用しますが、利用者の代わりに安全性や用途を推測して設定を追加したり、許可範囲を広げたりしません。<br>
`config/gateway.example.toml`は設定例であり、そのまま適用される「魔法のスクリプト」ではありません。必要な項目だけを確認して`config/gateway.toml`へ記述し、実際に起動するプログラムと公開する機能を利用者自身が把握できる構成にしています。<br>
### 任意コード実行はこのリポジトリでは提供しません。
このリポジトリは、一般シェル、PowerShell、コマンドプロンプト、任意スクリプト、任意プロセス起動など、ChatGPTからWindows PC上で任意コードを実行するための同梱ツールを提供しません。今後も実装しません。<br>
任意コード実行を公開すると、Tunnel IDやruntime API keyなどの接続情報が意図せず流出し、不正利用された場合、攻撃者は許可されたパスの読み書きにとどまらず、Windowsユーザー権限で任意の操作を実行できる可能性があります。<br>
パス許可やツール名の除外だけでは、任意コードの内部動作を安全に制限できません。<br>
コードの生成、変換、ビルド確認、単体テストなどは、まずChatGPTのサンドボックス内で行ってください。<br>
ローカルのソースが必要な場合は、`safe-download`で許可したファイルだけをZIP化し、ChatGPTにサンドボックスへダウンロードさせてください。<br>
利用者が外部の任意コード実行MCPを`gateway.toml`へ追加すること自体はGatewayの仕様上可能ですが、それはこのリポジトリが提供、推奨、保護する機能ではありません。<br>
接続したMCPは実際のPC上でWindowsユーザーの権限を使って動作します。<br>
### パス許可
`allowed_directories`は指定したディレクトリとその配下を許可し、`allowed_files`は指定したファイルだけを完全一致で許可します。<br>
Gatewayはすべての子MCPのツール引数を再帰的に検査し、`path`、`filePath`、`files`、`directory`などのキーや絶対パスらしい文字列を許可リストへ照合します。相対パスは対象MCPの`cwd`から解決します。<br>
```toml
allowed_directories = ['C:\work\project']
allowed_files = ['C:\Users\owner\Downloads\upload.png']
disallowed_directories = ['C:\work\project\private']
disallowed_files = ['C:\work\project\.env']
disallowed_path_globs = ['**.ssh**']
```
`disallowed_path_globs`は、ファイルとフォルダの両方を対象に、正規化されたパス全体へ適用する拒否globです。<br>
`*`はパス区切りをまたがない任意文字列、`**`はパス区切りを含む任意文字列、`?`はパス区切り以外の任意の1文字に一致します。<br>
たとえば`'**.ssh**'`は、パスのどこかに`.ssh`を含む場合に一律拒否します。Windowsでは`\`と`/`を同じ区切りとして扱い、大文字小文字を区別しません。<br>
macOSとLinuxでは`/`を区切りとして扱い、大文字小文字を区別します。<br>
拒否時のエラーには、`disallowed_path_globs`で拒否されたこと、一致したglob、正規化された対象パスが表示されます。<br>
Gateway側の検査は、ChatGPTから子MCPへ渡るツール引数のガードです。<br>
同梱の`safe-files`、`safe-images`、`safe-download`、`gitmcp`は同じ設定を子プロセス内でも検査しますが、任意に接続した第三者MCPの内部アクセスをOSレベルで防ぐ機能ではありません。<br>
### MCPサーバー設定の形式
Gatewayは、CodexのMCP設定と同じように、MCPごとの設定を`[mcp_servers.<name>]`テーブルへまとめる形式を採用しています。<br>
Codexの設定ファイルをそのまま読み込む互換機能ではなく、Gatewayが実装している項目だけを認識します。<br>
`config/gateway.toml`へMCPを追加する場合は、コメント用の`#`を付けず、次のように記述します。以下はGatewayが認識する全オプションを載せたテンプレートです。。<br>
```toml
private_use_only = true
publish_tool_directory = false
tool_annotations_path = "tool-annotations.toml"

[mcp_servers.my_server]
command = "node"
args = ['C:\path\to\server.mjs', '--example=value']
cwd = 'C:\path\to'
enabled = true
prefix = "my_server"
annotation_config = true
startup_timeout_sec = 30
tool_timeout_sec = 1800
serial_group = "my_server"
deferred = true
blocked_tools = ["dangerous_tool"]
blocked_tool_substrings = ["script", "shell", "execute"]
allowed_directories = ['C:\work\project']
allowed_files = ['C:\Users\owner\Downloads\upload.png']
disallowed_directories = ['C:\work\project\private']
disallowed_files = ['C:\work\project\.env']
disallowed_path_globs = ['**.ssh**']

[mcp_servers.my_server.start_after]
server = "controller"
tool = "prepare_my_server"

[mcp_servers.my_server.stop_after]
server = "controller"
tool = "stop_my_server"

[mcp_servers.my_server.env]
EXAMPLE_CONFIG = 'C:\path\to\config.json'
```
| 項目 | 説明 |
| --- | --- |
| `private_use_only` | Gateway全体の必須設定です。安全確認のため、必ず`true`にする必要があります。 |
| `publish_tool_directory` | `true`にすると内蔵ツール`gateway__list_available_tools`を公開します。省略時と`false`では公開しません。 |
| `tool_annotations_path` | 外部MCPのannotations設定TOMLです。相対パスは`gateway.toml`のあるディレクトリを基準にし、省略時は同じディレクトリの`tool-annotations.toml`です。 |
| `[mcp_servers.<name>]` | 1つのstdio MCPを定義します。`<name>`はGateway内で一意にします。 |
| `command` | 子MCPを起動する実行ファイルまたはコマンドです。`enabled = false`でない場合は必須です。 |
| `args` | `command`へ渡す引数を文字列配列で指定します。省略時は引数なしで起動します。 |
| `cwd` | 子MCPの作業ディレクトリです。相対パスは`gateway.toml`があるディレクトリを基準に解決され、省略時はそのディレクトリを使います。 |
| `enabled` | `false`にすると設定を残したまま、そのMCPを起動対象から除外します。省略時は有効です。 |
| `prefix` | ChatGPTへ公開するツール名の接頭辞です。元の`tool_name`は`<prefix>__<tool_name>`として公開されます。省略時は`[mcp_servers.<name>]`の`<name>`を使います。 |
| `annotation_config` | 外部annotations設定を適用するかを指定します。省略時は`true`です。同梱MCPのように自身で完全なannotationsを持つ場合は`false`にします。 |
| `startup_timeout_sec` | 子MCPの起動と初期化を待つ秒数です。正の数で指定し、省略時は30秒です。 |
| `tool_timeout_sec` | 子MCPのツール呼び出しを待つ秒数です。正の数で指定し、省略時は1800秒です。 |
| `request_timeout_sec` | `tool_timeout_sec`の互換用別名です。両方ある場合は`tool_timeout_sec`が優先されるため、新しい設定では`tool_timeout_sec`を使用します。 |
| `serial_group` | 同じ値を持つMCPのツール呼び出しを直列化します。同じブラウザーやリポジトリなど、同時操作させたくない資源に使用します。 |
| `deferred` | `true`にするとGateway初期化時には起動せず、`start_after`で指定したツールが成功するまで遅延します。省略時は`false`です。 |
| `blocked_tools` | ChatGPTへ公開しないツール名を完全一致の文字列配列で指定します。 |
| `blocked_tool_substrings` | ChatGPTへ公開しないツール名の部分文字列を指定します。大文字小文字は区別せず、globや正規表現としては扱いません。 |
| `allowed_directories` | 指定した絶対パスのディレクトリと、その配下へのアクセスを許可します。 |
| `allowed_files` | 指定した絶対パスのファイルだけを完全一致で許可します。 |
| `disallowed_directories` | 許可範囲内であっても拒否するディレクトリと、その配下を絶対パスで指定します。 |
| `disallowed_files` | 許可範囲内であっても拒否するファイルを絶対パスで指定します。 |
| `disallowed_path_globs` | 正規化されたパス全体へ適用する拒否globを指定します。ファイルとフォルダの両方が対象です。 |
| `[mcp_servers.<name>.start_after]` | `server`と`tool`で指定した別MCPのツールが成功した後、このMCPを起動します。通常は`deferred = true`と組み合わせます。 |
| `[mcp_servers.<name>.stop_after]` | `server`と`tool`で指定した別MCPのツールが成功した後、このMCPを停止します。 |
| `[mcp_servers.<name>.env]` | 子MCPへ追加で渡す環境変数です。値には文字列、数値、真偽値を指定できます。Gatewayのパスポリシー用に予約された環境変数は上書きできません。 |
通常のMCPは`deferred = false`または省略で起動します。その場合、`start_after`は不要です。<br>
`url`によるリモートMCP設定は拒否されます。Codex固有の`tool_output_token_limit`は読み取られても使用されず、このGateway上では効果を持ちません。<br>
### 内蔵ツールディレクトリ
トップレベルで`publish_tool_directory = true`を指定すると、`gateway__list_available_tools`を公開します。<br>
このツールはGatewayが既に保持している公開ツールレジストリだけを参照し、設定ファイル、ファイルシステム、子MCPの追加情報を読みません。`enabled = false`のMCPは起動せず、名前だけを`disabledProxyNames`へ返します。<br>
入力を省略すると現在利用可能なツールをすべて返し、`prefix`を指定すると大文字小文字を区別せずフル識別子の先頭一致で絞り込みます。該当が0件の場合はエラーにせず、全件を返します。<br>
返却するツール情報は`chrome-devtools__click`のような省略しない公開名と説明だけです。入力スキーマ、出力スキーマ、起動コマンド、引数、パス、環境変数、拒否されたツール名は返しません。`enabledProxyCount`は設定上有効なMCP数、`rejectedToolCount`は起動済みMCPから公開を拒否したツール数です。<br>
### 公開ツールの除外
ツール名の完全一致は`blocked_tools`、大文字小文字を区別しない部分一致は`blocked_tool_substrings`で非公開にできます。。<br>
```toml
blocked_tools = ["dangerous_tool"]
blocked_tool_substrings = ["script", "shell", "execute"]
```
`blocked_tool_substrings`はglobや正規表現ではありません。<br>
たとえば`"script"`は`evaluate_script`、`runScript`、`SCRIPT_debug`をすべて対象にします。<br>
### 直列実行と遅延起動
同じ資源を同時操作させたくないMCPは、同じ`serial_group`へ所属させられます。<br>
`deferred = true`にしたMCPは初期化時に起動せず、別MCPの指定ツールが成功した後に`start_after`で起動できます。<br>
`stop_after`では同様に停止できます。<br>
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
## SDK
[mainブランチのZIP](https://github.com/DaisukeDaisuke/local-mcp-chatgpt-tunnel/archive/refs/heads/main.zip)をダウンロードしてChatGPTへ添付し、次のプロンプトを送信すると、このリポジトリをSDK兼参照実装として使った、単一の`.mjs`ファイルで完結する独立のstdio MCPを作成させられます。<br>
`<Describe the MCP tools you need here.>`は、作成したいツールと操作対象の具体的な説明へ置き換えてください。<br>
```text
The attached local-mcp-chatgpt-tunnel-main.zip is the SDK and reference implementation. Inspect it before writing code.
Create an independent stdio MCP implemented as one self-contained Node.js ESM .mjs file for the following purpose:

<Describe the MCP tools you need here.>

Requirements:
- Return the complete .mjs file and the minimal config/gateway.toml entry needed to run it through local-mcp-chatgpt-tunnel.
- Do not modify the attached repository. The generated stdio MCP must not depend on files inside the repository at runtime and must use only Node.js built-in modules unless I explicitly permit an external dependency.
- Follow the repository's MCP protocol handling, JSON Schema conventions, outputSchema declarations, tool annotations, error handling, stdout/stderr separation, timeouts, and bounded-output design.
- Write only JSON-RPC protocol messages to stdout. Write diagnostics and logs to stderr.
- Shell injection must be impossible under all circumstances. Treat every MCP argument, path, filename, identifier, option, and environment-derived value as untrusted input.
- Never pass a constructed or user-controlled command string to a shell. Do not use child_process.exec, execSync, spawn with shell: true, cmd.exe /c, powershell -Command, bash -c, or sh -c.
- When a native program is genuinely required, invoke a fixed executable directly with spawn or execFile, shell: false, a fixed subcommand, and individually validated arguments. Use an explicit allowlist and a -- separator where the target program supports it.
- Do not expose a general-purpose command runner, arbitrary script execution, arbitrary executable selection, arbitrary environment-variable injection, or unrestricted native-program arguments.
- If the stdio MCP performs any filesystem operation, it must implement all of the following tools: `get_current_root`, `get_working_directory`, and `set_working_directory`. These tools are mandatory, not optional.
- `get_current_root` must return the canonical absolute path of the allowed workspace root currently in use. It must not enumerate arbitrary filesystem roots or expose unrelated paths.
- `get_working_directory` must return the canonical absolute path of the current working directory, matching the behavior of `mcp/safe-files/server.mjs`. It must not return a path relative to `get_current_root`.
- `set_working_directory` must accept a path relative to `get_current_root`, resolve it to an existing directory inside that root, apply the complete path policy, then store and return its canonical absolute path. The relative-only input rule is an intentional restriction for generated MCPs; the returned working directory remains absolute.
- Any stdio MCP that performs filesystem operations must support and enforce these exact configuration arrays:
  `allowed_directories = []`
  `allowed_files = []`
  `disallowed_directories = []`
  `disallowed_files = []`
  `disallowed_path_globs = []`
- Apply the allowlist and denylist to every filesystem operation, including working-directory changes. Deny rules must take precedence over allow rules.
- Every filesystem tool must accept paths relative to `get_current_root` by default. Absolute paths are forbidden unless the stated operation genuinely requires them and the tool documents and validates that exception explicitly.
- Reject `..`, parent traversal, root-relative paths, drive-relative paths, UNC paths, NTFS alternate data streams, and any other syntax that could escape or reinterpret the current root. Normalize and validate the relative path before resolving it, then verify the resolved real path remains inside the current root and passes every allowlist and denylist check.
- Do not require callers to provide redundant absolute paths when the same target can be identified safely by a path relative to `get_current_root`.
- A tool that accepts input files must accept multiple files as an array unless the underlying operation can inherently and safely operate on exactly one file. Validate every file independently and enforce bounded file counts, sizes, and output sizes.
- For build-related tools, require the caller to select a narrow project, target, package, configuration, or input-file set. Do not default to building an entire workspace or repository when a narrower target is possible. Keep the executable, subcommand, and build options fixed or allowlisted.
- This stdio MCP is not executed inside the ChatGPT sandbox. It runs on the user's real Windows PC with the permissions of the current Windows user. Remove unsafe capabilities by design instead of relying on the model to ask for confirmation.
- Do not download, install, update, or access the network unless I explicitly require that behavior. If network access is required, restrict destinations and operations to an explicit allowlist.
- Close child-process stdin, impose timeouts and output limits, handle cancellation and termination, and return structured MCP errors without crashing the process.
- Include clear tool descriptions, strict input schemas, strict output schemas, accurate annotations, and a short security explanation for every capability.
- Prefer a small, auditable implementation. Do not add convenience features that expand the security boundary beyond the stated purpose.
```
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
