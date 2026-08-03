# Security Policy
## 想定用途
このリポジトリは一人の所有者が自分のWindows開発環境へ接続するためのprivate MCPです。公開Plugin、第三者配布、共同利用、インターネット公開を想定しません。
## 本当のOS境界
Node.jsのパス検査はChatGPTへ公開するファイルツールを制限しますが、同じWindowsユーザーで実行されるMCPプログラム全体を隔離しません。ownerアカウントで起動すれば、そのユーザーが読めるSSH鍵やアプリデータへ、欠陥または悪意のある依存関係が到達できる可能性があります。強い分離が必要な場合は、専用の標準Windowsユーザーを使い、ownerプロファイルへのACLを与えないでください。管理者権限では実行しません。
## Tunnelの公開範囲
Secure MCP Tunnelは外向きHTTPSでOpenAIへ接続し、ローカルMCPの受信ポートを公開しません。Tunnelの関連付けは自分のPlatform Organizationと自分のChatGPT Workspaceだけに限定します。他人のOrganizationや共有Workspaceを関連付けず、Pluginの公開申請や配布を行いません。
## Runtime API key
runtime主体は`Tunnels Read + Use`だけにします。Tunnel管理用の`Read + Manage`、モデル要求、Organization管理などを与えません。Node.js起動スクリプトはキーをマスク入力で一時的に受け取り、ディスクへ保存しません。gatewayは本体コードを読み込む前に秘密情報らしい環境変数を削除し、子MCPには許可した環境変数だけを渡します。
## ファイル操作
許可範囲は`config\gateway.json`の`workspaceRoots`です。各ルート直下に`.chatgpt-local-mcp-root`が必要です。ユーザープロファイル全体、その上位、ルート外、シンボリックリンクによる脱出を拒否します。`.ssh`、`.git`、`.codex`、`.env`、秘密鍵、資格情報らしい名前と高確度の秘密文字列は返しません。
`search_text`は固定の`rg`実行です。利用者は検索式、許可ルート内の対象、globだけを指定でき、実行ファイルや追加コマンドを指定できません。`apply_patch`は専用パーサーまたは固定の`git apply`だけです。一般シェル、PowerShell、任意コマンドAPIはありません。
DQ9の`run_cases`は任意のローカルパスを読みません。ファイルMCPと同じ明示許可Workspace内、通常ファイル、`.json`、UTF-8、2MiB以下という条件を満たすbattle suiteだけを受け付けます。
## ファイル転送
`read_file_chunk`と`write_file`は既定16MiB以下です。ROM、State、鍵、証明書秘密鍵、実行ファイル、DLL、MSI、PowerShell、バッチ、ショートカットを拒否します。テキストはUTF-8だけを正式対応し、UTF-16LE、UTF-16BE、UTF-32、不正UTF-8を拒否します。
## ChromeとGhidra
Chrome CDPとGhidra HTTPは`127.0.0.1`だけで待受させます。通常の閲覧用Chromeプロファイルは使用しません。Ghidraの`run_ghidra_script`と`run_script_inline`はbridgeとgatewayの両方で遮断します。
## 漏えい時
runtime keyが漏れた場合はOpenAI Platformで直ちに失効します。GitHub、Discord、SSH、ChatGPT、Codexなど別サービスの資格情報が漏れた可能性がある場合は、各サービス側で個別に失効または再生成します。
