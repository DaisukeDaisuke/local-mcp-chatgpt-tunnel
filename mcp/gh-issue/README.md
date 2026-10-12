# gh-issue
GitHub CLIのIssue作成・閲覧・一覧・コメント投稿・クローズ・本文／タイトル編集に加え、コメントID・本文の取得と、ID指定による既存コメント編集を公開する独立stdio MCPです。既存のgh-workflow、git-capabilityとは別のサーバーです。Node.js 22以上、GitHub CLI、Codex CLIが必要で、npmパッケージの追加は不要です。MCPプロセス自体をGatewayのオンラインサンドボックスで起動します。
## 起動引数
```bash
node mcp/gh-issue/server.mjs --token-file=/absolute/path/to/github-token.txt --gh-executable=/absolute/path/to/gh --edit-comments=ZevyaDev/dqix-decomp-kit
```
このコマンドはサンドボックス内部の起動引数を示しています。通常のターミナルから直接起動すると、オンラインサンドボックスの起動マーカーがないため拒否します。Gateway設定は後述の設定例を使います。環境変数の手動設定はOSのサンドボックスを作成しません。
設定例の認証には既存のgh-workflow・Codespace MCPと同じ`--token-file=<絶対パス>`を使います。UTF-8ファイルにトークンを1行で保存します。末尾の改行は許可します。以前の`--token=TOKEN`と`--token TOKEN`も互換性のため利用できます。両方を指定した場合は`--token-file`を優先します。ツール呼び出し時にはトークンやファイルパスを指定しません。ローカルに保存済みの認証や親環境のトークンへフォールバックせず、選択されたトークンだけを子プロセスの`GH_TOKEN`へ設定します。
公開されたgithub.comのリポジトリは所有者を問わず対象にできます。GitHub側の権限によって操作が拒否される場合は、そのエラーを返します。MCP側で公開する操作の制限はトークン自体のGitHub権限を変更するものではありません。
トークンファイルは書き込み可能なworkspaceの外へ置きます。Gatewayは固定のread-only trust inputとしてサンドボックスへ登録します。シンボリックリンク、空ファイル、8KiB超、UTF-16、不正UTF-8、空白を含むトークンを拒否します。`--token-file`を使う設定例では、起動引数とMCP設定にファイルパスだけが入り、トークン文字列を含めません。サーバー応答・ghの出力・実行エラーに選択されたトークン文字列が含まれる場合は`[REDACTED]`へ置き換えます。
## 任意のリポジトリ制限
```bash
node mcp/gh-issue/server.mjs --token-file=/absolute/path/to/github-token.txt --gh-executable=/absolute/path/to/gh --repository=OWNER/REPO --repository=OTHER/REPO
```
`--repository`を指定した場合はその許可リスト内だけを利用できます。1件だけならツールの`repository`を省略できます。指定しない場合や複数指定した場合は、ツールの`repository`が必須です。
`--gh-executable`は必須で、起動時にGitHub CLIの絶対パスを固定します。Windowsでは`--gh-executable=C:\Program Files\GitHub CLI\gh.exe`のように指定します。名前は`gh`または`gh.exe`（Windowsは`gh.exe`のみ）、通常ファイルであることが必要です。実体が書き込み可能なworkspace内にある場合は拒否し、PATHや現在のディレクトリから別の実行ファイルを探索しません。
## コメント編集のホワイトリスト
```bash
--edit-comments=ZevyaDev/dqix-decomp-kit --edit-comments=OWNER/OTHER_REPO
```
`--edit-comments`は複数指定できます。既存コメントの編集ツール`edit_issue_comment`だけに適用するホワイトリストです。指定がない場合と、対象リポジトリが含まれない場合は、ghを実行する前に編集を拒否して具体的な理由を返します。
指定値をgithub.comの`owner/repo`へ正規化してから、ツールで指定されたリポジトリの正規化結果と完全一致で比較します。大文字小文字、末尾のスラッシュと`.git`、`github.com/OWNER/REPO`、`https://github.com/OWNER/REPO.git`、`git@github.com:OWNER/REPO.git`は同じリポジトリとして扱います。他ホスト、認証情報付きURL、クエリ、フラグメントは受け付けません。重複指定は正規化後にまとめます。前方一致では許可しません。
このホワイトリストは、Issue作成・閲覧・一覧・コメント投稿・クローズ・Issue本文／タイトル編集、コメント一覧・閲覧には適用しません。全操作の対象を別途限定する既存の`--repository`も指定した場合、コメント編集では両方の条件を満たす必要があります。MCPツール引数で編集ホワイトリストを追加・変更することはできません。
## 公開ツール
| ツール | 必須引数 | 任意引数 | 実行する操作 |
| --- | --- | --- | --- |
| `create_issue` | `repository`, `title`, `body` | なし | `gh issue create` |
| `view_issue` | `repository`, `issueNumber` | `comments`（既定false） | `gh issue view` |
| `list_issues` | `repository` | `state`（open/closed/all、既定open）, `limit`（1〜100、既定30） | `gh issue list` |
| `comment_issue` | `repository`, `issueNumber`, `body` | なし | `gh issue comment` |
| `close_issue` | `repository`, `issueNumber` | `reason`（completed/not planned、既定completed） | `gh issue close` |
| `edit_issue` | `repository`, `issueNumber` | `body`, `title`（少なくとも一方が必須） | `gh issue edit` |
| `list_issue_comments` | `repository`, `issueNumber` | `page`（既定1）, `perPage`（1〜100、既定100） | 固定Issueコメント一覧APIのGET |
| `view_issue_comment` | `repository`, `commentId` | なし | 固定コメントAPIのGET |
| `edit_issue_comment` | `repository`, `commentId`, `body` | なし | 固定コメントAPIのPATCH |
許可リストが1件だけの場合の`repository`省略は全ツール共通です。`issueNumber`は正の整数で、Issue URLやPR番号への操作は受け付けません。作成時の`body`は空文字も指定できます。コメント本文は空白だけでは指定できません。
`edit_issue`は既存Issueの本文とタイトルを置き換えます。指定しなかった項目は変更しません。本文は空文字への置き換えも可能で、改行を含むUTF-8文字列を`--body-file -`へ標準入力で渡します。Gatewayでの公開名は`gh_issue__edit_issue`です。
## コメントIDと本文の取得・編集
`list_issue_comments`は対象Issueのコメントをページ単位で取得し、各コメントの`commentId`、`body`、`issueNumber`、`url`、`author`、`createdAt`、`updatedAt`を返します。返却の`nextPage`が数値なら、そのページを取得してください。1ページが`perPage`件で満たされた場合に次ページを示すため、最後の次ページが空になることもあります。途中のページだけを全コメントとして扱いません。
`view_issue_comment`は`commentId`を指定して1件の完全な本文とIDを取得します。`edit_issue_comment`は同じIDのコメントだけを編集し、更新後のコメントIDと本文を返します。Issue番号はコメントの親Issueから確認するため、ID指定の閲覧・編集で`issueNumber`を渡す必要はありません。最後のコメントを推測して編集する処理はありません。
`commentId`にはREST APIの数値IDを指定します。`view_issue`のGraphQLコメントIDと混同しないでください。`list_issue_comments`、`view_issue_comment`、投稿成功時の`comment_issue`から取得できます。32bitを超えるIDにも対応します。
`comment_issue`は元の投稿コマンドに加えて、GitHub CLIが返した`#issuecomment-ID`のURLから`commentId`と投稿した`body`を返します。URL形式を認識できなかった場合も投稿成功を取り消さず、`posted: true`、`lookupRequired: true`を返します。その場合は`list_issue_comments`でIDを取得し、重複投稿しません。
コメント用APIは内部の固定`gh api`コマンドです。一覧は`GET repos/OWNER/REPO/issues/NUMBER/comments`、閲覧は`GET repos/OWNER/REPO/issues/comments/COMMENT_ID`、編集は同じコメントパスへの`PATCH`だけを使います。編集本文は`{"body":"..."}`のJSONとして標準入力で渡します。任意のAPIパス、HTTPメソッド、ghオプション、スクリプトを受け取るツールは公開しません。
Gatewayでは`gh_issue__list_issue_comments`、`gh_issue__view_issue_comment`、`gh_issue__edit_issue_comment`として公開されます。
```json
{"repository":"OWNER/REPO","issueNumber":251}
{"repository":"OWNER/REPO","commentId":3653399145}
{"repository":"OWNER/REPO","commentId":3653399145,"body":"編集後のコメント本文\n次の行"}
```
## 成功・失敗の返却
閲覧と一覧はJSONを解析して`result.issue`、`result.issues`へ返します。書き込みは`result.stdout`、`result.stderr`、`result.exitCode`を返します。すべてのツールは`ok`と成功時の`result`、失敗時の`error`を含む構造化結果を返します。
失敗時は`isError: true`、`ok: false`に加えて、GitHub CLIのエラー文を改行も含めて`content[0].text`と`error`へ返します。プロセス結果がある場合は`result.stdout`、`result.stderr`、`result.exitCode`、`result.signal`、実行した固定コマンドも返します。権限不足、認証失敗、HTTPエラーを`operation fault`や`gh command failed`へ置き換えません。認証トークンのマスクと既存の出力サイズ制限は適用します。エラーに元の具体的な説明がない場合だけ、終了コードなどを説明文へ使います。
## Gatewayへの追加
`config/gateway.gh-issue.example.toml`の`[mcp_servers.gh_issue]`を既存設定へ追加し、Node.js・Codex CLI・GitHub CLI・workspace・トークンファイルのパスを置き換えて`enabled = true`にします。例では`--edit-comments=ZevyaDev/dqix-decomp-kit`を指定しています。コメント編集を許可するリポジトリが複数ある場合は、この引数を追加します。`sandbox = 'onlineworkspace'`が必須で、未指定・never・elevated・unelevatedはGatewayの設定読み込み時に拒否します。オンラインサンドボックスはMCP起動時に1回作成され、ghはその子プロセスとして動作します。
Node.js、Codex CLI、GitHub CLI、トークンファイルは`allowed_directories`の外へ置きます。Gatewayは固定のgh実行ファイルとトークンファイルをサンドボックスのread-only trust inputへ追加します。`command`はNode.jsの絶対パス、`codex_executable`はCodex CLIの絶対パスを指定します。Gateway経由では`gh_issue__create_issue`などの名前で公開され、`isolatedId`と署名付きworkspaceを利用します。`app/server-config.mjs`への同梱登録は適用済みです。許可rootやworkspaceをツール引数で上書きできません。
## 実行制限
各呼び出しで内部の`gh repo view`により公開状態・github.com上のリポジトリ名を再確認します。移転・改名で別のリポジトリへ転送された場合は拒否します。コメント・クローズ・編集前には内部の`gh issue view`でURLが対象リポジトリの`/issues/番号`であることを確認します。既存コメントの閲覧・編集では、コメントIDとAPI URL・親Issue URLを照合し、親がIssueであることも確認します。内部確認コマンドを任意に呼び出すツールは公開しません。
シェルは使わず固定サブコマンドと検証済み引数で`gh`を起動します。本文は`--body-file -`へ標準入力で渡すため、改行を保持し、本文中の記号をコマンドとして解釈しません。実行は1プロセスあたり30秒、合計stdout/stderrは8MiB、JSON入力は1MiBまでです。タイムアウトや通信失敗後には書き込みが完了している可能性があるため、自動再送しません。
Issue削除・再オープン、コメント削除、PR操作、Actions操作、任意のghコマンドは公開しません。
## 検証
```bash
node --test tests/gh-issue.test.mjs
```
テストはgh実行をモック化し、外部リポジトリへ投稿しません。オンラインサンドボックスの必須設定・起動時の拒否・固定ghとトークンファイルのread-only登録・不正なトークンファイルの拒否・以前のtoken引数との互換性に加え、Issue本文／タイトル編集、コメントID・本文の取得と編集、編集ホワイトリストの複数指定・正規化・完全一致・未指定時の拒否・他操作への非適用、ページ送り、投稿時のID返却、権限不足などの元エラーがstdio経由でも保持されることを検査します。stdioテストでは起動マーカーを模擬します。実機のCodexオンラインサンドボックス起動と実トークンを使ったGitHubへの操作は、このパッケージ作成時の検証には含まれません。
GitHub CLI仕様: https://cli.github.com/manual/gh_issue_create / https://cli.github.com/manual/gh_issue_view / https://cli.github.com/manual/gh_issue_list / https://cli.github.com/manual/gh_issue_comment / https://cli.github.com/manual/gh_issue_close / https://cli.github.com/manual/gh_issue_edit / https://cli.github.com/manual/gh_api / https://cli.github.com/manual/gh_help_environment
コメントAPI仕様: https://docs.github.com/en/rest/issues/comments
