# gh-issue
GitHub CLIのIssue作成・閲覧・一覧・コメント投稿・クローズだけを公開する独立stdio MCPです。既存のgh-workflow、git-capabilityとは別のサーバーです。Node.js 22以上、GitHub CLI、Codex CLIが必要で、npmパッケージの追加は不要です。MCPプロセス自体をGatewayのオンラインサンドボックスで起動します。
## 起動引数
```bash
node mcp/gh-issue/server.mjs --token=YOUR_GITHUB_TOKEN --gh-executable=/absolute/path/to/gh
```
このコマンドはサンドボックス内部の起動引数を示しています。通常のターミナルから直接起動すると、オンラインサンドボックスの起動マーカーがないため拒否します。Gateway設定は後述の設定例を使います。環境変数の手動設定はOSのサンドボックスを作成しません。
トークンはMCPの起動引数で指定します。`--token YOUR_GITHUB_TOKEN`形式も利用できます。ツール呼び出し時の引数へトークンを渡す必要はありません。ローカルに保存済みの認証や親環境のトークンへフォールバックせず、指定されたトークンを子プロセスの`GH_TOKEN`へ設定します。
公開されたgithub.comのリポジトリは所有者を問わず対象にできます。GitHub側の権限によって操作が拒否される場合は、そのエラーを返します。MCP側で公開する操作の制限はトークン自体のGitHub権限を変更するものではありません。
起動引数はOSのプロセス一覧やMCP設定ファイルで見える場合があります。実トークンを含む設定を共有しないでください。サーバー応答・ghの出力・実行エラーに同じトークン文字列が含まれる場合は`[REDACTED]`へ置き換えます。
## 任意のリポジトリ制限
```bash
node mcp/gh-issue/server.mjs --token=YOUR_GITHUB_TOKEN --gh-executable=/absolute/path/to/gh --repository=OWNER/REPO --repository=OTHER/REPO
```
`--repository`を指定した場合はその許可リスト内だけを利用できます。1件だけならツールの`repository`を省略できます。指定しない場合や複数指定した場合は、ツールの`repository`が必須です。
`--gh-executable`は必須で、起動時にGitHub CLIの絶対パスを固定します。Windowsでは`--gh-executable=C:\Program Files\GitHub CLI\gh.exe`のように指定します。名前は`gh`または`gh.exe`（Windowsは`gh.exe`のみ）、通常ファイルであることが必要です。実体が書き込み可能なworkspace内にある場合は拒否し、PATHや現在のディレクトリから別の実行ファイルを探索しません。
## 公開ツール
| ツール | 必須引数 | 任意引数 | 実行する操作 |
| --- | --- | --- | --- |
| `create_issue` | `repository`, `title`, `body` | なし | `gh issue create` |
| `view_issue` | `repository`, `issueNumber` | `comments`（既定false） | `gh issue view` |
| `list_issues` | `repository` | `state`（open/closed/all、既定open）, `limit`（1〜100、既定30） | `gh issue list` |
| `comment_issue` | `repository`, `issueNumber`, `body` | なし | `gh issue comment` |
| `close_issue` | `repository`, `issueNumber` | `reason`（completed/not planned、既定completed） | `gh issue close` |
許可リストが1件だけの場合の`repository`省略は全ツール共通です。`issueNumber`は正の整数で、Issue URLやPR番号への操作は受け付けません。作成時の`body`は空文字も指定できます。コメント本文は空白だけでは指定できません。
閲覧と一覧はJSONを解析して`result.issue`、`result.issues`へ返します。書き込みは`result.stdout`、`result.stderr`、`result.exitCode`を返します。すべてのツールは`ok`と成功時の`result`、失敗時の`error`を含む構造化結果を返します。
## Gatewayへの追加
`config/gateway.gh-issue.example.toml`の`[mcp_servers.gh_issue]`を既存設定へ追加し、Node.js・Codex CLI・GitHub CLI・workspaceのパスとトークンを置き換えて`enabled = true`にします。`sandbox = 'onlineworkspace'`が必須で、未指定・never・elevated・unelevatedはGatewayの設定読み込み時に拒否します。オンラインサンドボックスはMCP起動時に1回作成され、ghはその子プロセスとして動作します。
Node.js、Codex CLI、GitHub CLIは`allowed_directories`の外へ置きます。Gatewayは固定のgh実行ファイルをサンドボックスのread-only trust inputへ追加します。`command`はNode.jsの絶対パス、`codex_executable`はCodex CLIの絶対パスを指定します。Gateway経由では`gh_issue__create_issue`などの名前で公開され、`isolatedId`と署名付きworkspaceを利用します。`app/server-config.mjs`への同梱登録は適用済みです。許可rootやworkspaceをツール引数で上書きできません。
## 実行制限
各呼び出しで内部の`gh repo view`により公開状態・github.com上のリポジトリ名を再確認します。移転・改名で別のリポジトリへ転送された場合は拒否します。コメント・クローズ前には内部の`gh issue view`でURLが対象リポジトリの`/issues/番号`であることを確認します。内部確認コマンドを任意に呼び出すツールは公開しません。
シェルは使わず固定サブコマンドと検証済み引数で`gh`を起動します。本文は`--body-file -`へ標準入力で渡すため、改行を保持し、本文中の記号をコマンドとして解釈しません。実行は1プロセスあたり30秒、合計stdout/stderrは8MiB、JSON入力は1MiBまでです。タイムアウトや通信失敗後には書き込みが完了している可能性があるため、自動再送しません。
Issue編集・削除・再オープン、既存コメント編集・削除、PR操作、Actions操作、任意のghコマンドは公開しません。
## 検証
```bash
node --test tests/gh-issue.test.mjs
```
テストはgh実行をモック化し、外部リポジトリへ投稿しません。オンラインサンドボックスの必須設定・起動時の拒否・固定ghのread-only登録を検査します。stdioテストでは起動マーカーを模擬します。実機のCodexオンラインサンドボックス起動と実トークンを使ったGitHubへの操作は、このパッケージ作成時の検証には含まれません。
GitHub CLI仕様: https://cli.github.com/manual/gh_issue_create / https://cli.github.com/manual/gh_issue_view / https://cli.github.com/manual/gh_issue_list / https://cli.github.com/manual/gh_issue_comment / https://cli.github.com/manual/gh_issue_close / https://cli.github.com/manual/gh_help_environment
