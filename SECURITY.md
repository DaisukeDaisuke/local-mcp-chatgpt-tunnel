# Security Policy
## 想定用途
このリポジトリは一人の所有者が自分のWindows開発環境へ接続するprivate MCP Gatewayです。公開Plugin、第三者配布、共同利用、インターネット公開を想定しません。
## 任意MCPの危険性
`gateway.toml`の`command`はローカルプログラムを実行します。登録したMCP自体が悪意を持つか侵害されていれば、Gatewayのツール引数検査とは無関係に、そのWindowsユーザーが読めるファイルへ内部からアクセスできます。信頼できるMCPだけを登録し、不要なものは`enabled = false`にします。
## OS境界
Gatewayは管理者権限での起動を拒否し、子MCPへ親プロセスの秘密情報らしい環境変数をそのまま継承しません。ただし、同じWindowsユーザーのファイルACLまでは隔離できません。SSH鍵、GitHub、Discord、Codex、ChatGPT関連ファイルから強く分離する場合は、専用の標準Windowsユーザーを使います。
## Tunnelの公開範囲
Secure MCP Tunnelは外向きHTTPSでOpenAIへ接続し、ローカルMCPの受信ポートを公開しません。Tunnelの関連付けは自分のPlatform Organizationと自分のChatGPT Workspaceだけに限定します。他人のOrganization、共有Workspace、公開Pluginへ関連付けません。
## Runtime API key
runtime主体には`Tunnels Read + Use`だけを与え、モデルAPI、Files、Organization管理、Tunnel Manage権限を与えません。INSTALL.mdではキー名にも`no-model-api`を含め、`CONTROL_PLANE_API_KEY`と`CONTROL_PLANE_TUNNEL_ID`をWindowsのユーザー環境変数へ保存します。`tunnel-client`はこれらを自動で読むため、キーをコマンドライン引数へ載せません。
ユーザー環境変数は同じWindowsユーザーで動く別プロセスから読めます。OSレベルの秘密保管庫ではないため、強く分離する場合はTunnel専用の標準Windowsユーザーを使います。`OPENAI_API_KEY`はfallbackとして読まれますが、モデルAPI権限を持つキーとの取り違えを防ぐため使用しません。
## ファイル操作
各MCPの`allowed_directories`と`allowed_files`が、ChatGPTから子MCPへ渡せるファイルパスを決めます。ディレクトリは配下を含み、ファイルは絶対パスの完全一致です。`disallowed_directories`と`disallowed_files`は完全なパスで上書き拒否し、`disallowed_path_globs`は正規化されたパス全体へファイル・フォルダ共通の拒否globを適用します。`*`は区切りをまたがず、`**`は区切りをまたぎ、`?`は区切り以外の1文字へ一致します。拒否エラーには一致したglobと対象パスを含めます。相対パスはMCPの`cwd`から解決し、OSごとの区切り文字、JSONの二重エスケープ、既存パスのシンボリックリンクを正規化してから比較します。許可リストが空のMCPでパスらしい引数を使うと拒否します。
safe-filesは`cwd`だけをWorkspaceルートとして使い、その外側とシンボリックリンクによる脱出を拒否します。固定の一般ブラックリストは持たず、利用者が`disallowed_path_globs`へ明示した拒否パターンだけを適用します。高確度の秘密文字列は内容検査で拒否し、`.git`内部へのpatchは操作固有の制約として拒否します。
safe-imagesは読み取り専用で、公開するツールは`read_image`だけです。PNG、JPEG、WebPの拡張子とマジックバイトを照合し、ファイルサイズと総画素数を制限します。SVG、HEIC、シンボリックリンク、UNC、NTFS代替データストリーム、許可ルート外の画像は拒否します。画像base64は`content`の画像ブロックだけへ置き、`structuredContent`へ重複させません。
safe-downloadは読み取り専用で、`safe-files`とは独立した`cwd`、`SAFE_DOWNLOAD_ROOTS`、Gateway許可リストを使います。ディレクトリ一覧は`spawn('rg', args, { shell:false })`の固定引数だけで行い、対象パス直前へ`--`を置きます。利用者は任意のrg引数を渡せません。`disallowed_path_globs`がある場合は、利用者指定のglobや除外を処理する前に対象ディレクトリ全体のファイル・フォルダ名を確認し、一致が1件でもあれば一覧結果やZIPを返さず、設定globと対象パスを含むエラーを返します。ダウンロード対象globは相対範囲へ制限し、除外ファイル・フォルダはrg文字列へ展開せず、列挙後の実パス比較で除外します。`.git`はrg指定と後処理の両方で拒否します。ZIPはファイル数、展開前合計、生成後サイズを制限し、ROM、Save、State、秘密鍵形式、資格情報らしい内容、シンボリックリンク、UNC、NTFS代替データストリームを拒否します。ZIP base64はMCP resourceの`blob`だけへ置き、`structuredContent`へ重複させません。
gh-workflowは読み取り専用で、起動時に1件以上の`--repository=OWNER/REPO`を必須とします。複数指定した場合も、その許可リスト内だけを各ツールの`repository`として選択できます。`gh`は明示した`cwd`から`spawn('gh', args, { shell:false })`で直接起動し、標準入力を閉じ、サブコマンドとオプションを固定し、run ID、branch、workflow識別子を個別に検証します。workflow実行、再実行、cancel、delete、artifact download、`gh api`、任意gh引数は公開しません。
`search_text`は固定の`rg`実行です。一般シェル、PowerShell、任意コマンドAPIはありません。`apply_patch`は専用パーサーまたは固定の`git apply`だけを使います。
## ファイル転送
`read_file_chunk`と`write_file`は既定16MiB以下です。ROM、State、鍵、証明書秘密鍵、実行ファイル、DLL、MSI、PowerShell、バッチ、ショートカットを拒否します。テキストはUTF-8だけを正式対応し、UTF-16LE、UTF-16BE、UTF-32、不正UTF-8を拒否します。
## 漏えい時
runtime keyが漏れた場合はOpenAI Platformで直ちに失効します。GitHub、Discord、SSH、ChatGPT、Codexなど別サービスの資格情報が漏れた可能性がある場合は、各サービス側で個別に失効または再生成します。