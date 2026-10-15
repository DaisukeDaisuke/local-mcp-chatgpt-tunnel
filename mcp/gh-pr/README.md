# gh-pr bundled stdio MCP
添付SDKの`mcp/gh-workflow/server.mjs`のstdio・固定サブコマンド・分離方式を基準にしたPR専用MCP。Node.js組み込みモジュールとSDK内の既存ヘルパーだけを使用する。GitHub APIをNodeから直接呼ばず、固定した`gh`実行ファイルを`shell: false`で起動する。
## 配置と設定
`mcp/gh-pr/server.mjs`を配置し、同梱の`app/server-config.mjs.patch`をSDKのルートで適用する。`config/gateway.gh-pr.example.toml`のテーブルを既存の`config/gateway.toml`へ追加し、例示パスとリポジトリを実環境に置き換える。設定パッチはbundled登録、`onlineworkspace`強制、固定トークンファイル・実行ファイルのsandbox読み取り許可を含む。元のZIPを更新する必要はない。
起動時の`--repository=OWNER/REPO`は必須で、複数指定できる。1件の場合だけ公開ツールの`repository`を省略できる。宛先の比較はOWNER/REPO全体の大文字小文字を無視する完全一致であり、URL・前方一致・任意ホストは許可しない。全ツールで許可外宛先をトークン読み取り・`gh`起動より前に拒否する。作成前の固定`gh repo view`では改名・移転された宛先への意図しない作成も拒否する。
トークンはUTF-8のファイルへ格納する。起動引数には`--token-file=絶対パス`だけを渡し、`--token=...`や継承トークンを使用しない。ファイルと固定`gh.exe`は書き込み可能workspaceの外に配置する。この2個はSDKのgh-issueと同じ固定read-only trust inputとして自動で読み取り許可されるため、`allowed_files = []`のままでよい。Gatewayのsandbox用read-only登録とMCP内の固定パス許可の両方が対応する。明示的なdenyは自動許可より優先する。内容は8192バイト以下、トークン部分は4096文字以下のASCIIで、末尾改行は許可する。UTF-16LE・不正UTF-8・シンボリックリンク・workspace内のトークンは拒否する。トークンを渡す先は子プロセスの`GH_TOKEN`環境変数だけで、コマンドライン・ログ・応答へは出力しない。
`--max-body`はPR本文とコメント本文の両方へ適用する。既定値は`10K`、設定可能範囲は1〜1048576 UTF-8バイト。`100B`は100バイト、`10K`は10240バイト、`1M`は1048576バイト。`KB`/`KiB`、`MB`/`MiB`も1024単位で扱う。公開引数からこの上限を増やすことはできない。超過は切り詰めず、実行前に拒否する。GitHub側の上限や権限による拒否は別途`gh`のエラーとして返る。
## ツールとコマンド
| ツール | 固定操作 | 安全境界 |
|---|---|---|
| `create_pr` | `gh pr create --repo github.com/OWNER/REPO --base BASE --head HEAD --title=TITLE --body-file -`、必要時のみ`--draft` | base/head/title/bodyを明示し、ローカルのブランチ推測・push・fork・editorを使用しない |
| `edit_pr_body` | `gh pr edit NUMBER --repo github.com/OWNER/REPO --body-file -` | 指定PRの本文だけを置換し、先に`gh pr view`で宛先と番号を確認する |
| `convert_to_draft` | `gh pr ready NUMBER --repo github.com/OWNER/REPO --undo` | draft状態だけを変更する |
| `mark_ready_for_review` | `gh pr ready NUMBER --repo github.com/OWNER/REPO` | レビュー待ちへの変更であり、承認済みの宣言ではない |
| `view_pr` | `gh pr view NUMBER --repo github.com/OWNER/REPO --json 固定フィールド` | oversized既存本文は`body=null, bodyOmitted=true`として返す |
| `check_review_status` | `gh pr view`の`reviewDecision,reviewRequests`等 | 読み取り専用で、レビュー投稿・承認・mergeを実行しない |
| `comment_pr` | `gh pr comment NUMBER --repo github.com/OWNER/REPO --body-file -` | PR確認後に新しいタイムラインコメントを追加する |
| `list_pr_comments` | `gh pr view`の`comments`等 | コメントURLから数値IDを取得し、PRへの所属を検証する |
| `edit_pr_comment` | 固定`gh api --hostname github.com --method PATCH repos/OWNER/REPO/issues/comments/COMMENT_ID --input -` | `gh pr view`で当該PRのコメント一覧に所属が確認できたIDだけを編集する |
`create_pr`の`base`は宛先ブランチ、`head`は元ブランチ。`head`は`feature`または`user:feature`形式。両ブランチは`gh`の対応範囲で選択できる。ユーザーが提示したCLIヘルプのとおり、組織名を`user`として指定するfork元はCLI側で未対応。モデルの引数から任意フラグや別の実行ファイルを追加することはできない。
コメントは通常のPRタイムラインコメントを対象とし、レビュー中の行コメントは対象外。GitHubではPRタイムラインコメントも`/issues/comments/ID`という共通RESTエンドポイントを使うが、Issue本文を編集する`/issues/NUMBER`は一切使用しない。IssueかどうかをAPIで調べる処理も追加していない。PR番号と宛先を`gh pr view`で確認したうえで、同じPRの`#issuecomment-ID`に一致するものだけを編集する。未掲載ID・別PR・Issue URL・レビュー行コメントはAPI実行前に拒否する。本文は`--input -`へ`{"body":"..."}`のJSONで渡し、IDは独立して数値検証する。
`gh pr view`の取得件数はCLIの仕様に依存する。コメントを100件以上取得した場合は`mayBeTruncated=true`を返す。取得できないIDは推測して編集しない。作成・編集後に同じPRを再取得し、指定した本文または状態が反映されたことを確認する。上限の影響等で確認できなければ、書き込み済みの可能性を返して自動再試行しない。
レビューの`reviewComplete=true`は、`OPEN`かつ非draft、`reviewDecision=APPROVED`、未処理レビュー依頼0件のときだけ返す。判断状態がnull/空またはレビュー依頼が100件以上の場合は`reviewComplete=null`とする。`headSha`と`checkedAt`を返すため、そのコミット時点の確認として扱える。CIの成功・全議論の解決・マージ許可は判定対象に含まない。
## 分離・パス・プロセス
全`tools/call`は最初に`createBundledIsolation().run(arguments, operation)`を通る。鍵が存在する場合、空文字・短すぎる鍵も起動時に拒否し、署名なしへフォールバックしない。署名検証・定数時間比較・絶対root/baseの検証はSDKの`bundled-isolation.mjs`を使用する。SDKは指定された`JSON.stringify({ base, roots })`形式のほか、現在のGatewayが送る`isolatedId`も含む署名形式を扱う。公開`root`/`roots`/`workspace`/`workspaces`およびその入れ子変形はヘルパーと厳格な入力スキーマで拒否する。
Gateway呼出しの実行cwdはその呼出しの署名済み`base`だけを使用する。`process.cwd()`や前回のcwdに置き換えない。standalone動作でも`onlineworkspace`マーカーと全パス設定が必要で、cwdは設定許可ディレクトリ内に限る。コードには利用者向けのローカルリポジトリ操作・入力本文ファイル・出力ディレクトリの概念がないため、`roots`/`get_working_directory`/`set_working_directory`は公開しない。認証ファイルは本来1個の固定trust inputなので、配列の任意ファイル読取りツールにはしていない。
`allowed_directories`・`allowed_files`・`disallowed_directories`・`disallowed_files`・`disallowed_path_globs`の5配列をGatewayの既存環境変数から読み、すべてのMCP側パス操作へ適用する。denyがallowより優先する。公開操作のcwdは署名root内に限り、実体パスでも再確認する。固定read-only trust inputのトークン・実行ファイルはSDKのgh系MCPと同じくworkspace外で、起動時の2個の完全一致パスだけを内部のread-only許可へ追加する。通常のcwdや公開パスの許可範囲を広げず、Gatewayの`allowed_files`設定も変更しない。これらを公開引数で変更することはできない。
UNC、root-relative、drive-relative、Windows namespace、NTFS ADS、Windowsの予約デバイス名、パス変数展開、signed root外へのsymlinkを拒否する。トークンはsymlinkを許可せず、開いたファイルの種別・サイズ・inodeも確認する。trusted executableもworkspace外の既存通常ファイルに限る。
子プロセスには`environmentWithoutBundledIsolationKey()`とSDKの環境allowlistを適用し、Gateway秘密鍵・継承認証・GH debug/host/socket/proxy等の上書き変数を渡さない。`GH_HOST=github.com`と`--repo github.com/OWNER/REPO`、APIの固定`--hostname github.com`によってGitHub宛先を固定する。ネットワーク操作は列挙したPR操作と固定のリポジトリidentity確認・確認済みコメント編集だけ。更新通知・拡張更新通知を無効にし、install/download/任意APIを公開しない。
全実行は固定`gh`パス、固定サブコマンド、分割した検証済み引数で行い、shellを介さない。本文はstdinへ渡して閉じる。stdoutへ出すのはJSON-RPCだけで、ヘルプや起動診断はstderr。1コールの実行時間は60秒、子プロセスのstdout+stderrは合計8MiB、待機中コールは最大8件、JSONフレームは本文上限に応じた有限値、返信も最大16MiB+64KiBに制限する。stdinの巨大フレームを破棄して次のフレームへ復帰し、stdoutのbackpressureで入力を一時停止する。キャンセル通知・EOF・SIGINT・SIGTERMで処理を中断し、子プロセスを終了させる。
## 検証
追加の`tests/gh-pr.test.mjs`は、宛先拒否の順序、本文サイズ、署名エラー、root上書き、UTF-16拒否、ファイルポリシー、プロセス引数と環境、キャンセル、timeout、出力上限、誤ったIssue/PRコメントIDの拒否、反映確認と不確定書込みを検証する。実際のGitHub投稿や実WindowsのOS sandboxはこのテストでは起動しない。設定・分離・gh-workflow・path-policy・sandbox関連の既存SDKテストも確認する。
```bash
node --test tests/gh-pr.test.mjs tests/bundled-isolation.test.mjs tests/path-policy.test.mjs tests/gh-workflow.test.mjs tests/toml-config.test.mjs tests/codex-app-server.test.mjs
```
