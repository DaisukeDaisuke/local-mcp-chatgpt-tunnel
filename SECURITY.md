# Security Policy
## 想定用途
このリポジトリは一人の所有者が自分のWindows開発環境へ接続するprivate MCP Gatewayです。公開Plugin、第三者配布、共同利用、インターネット公開を想定しません。
## 任意MCPの危険性
`gateway.toml`の`command`はローカルプログラムを実行します。登録したMCP自体が悪意を持つか侵害されていれば、safe-filesのパス制限とは無関係に、そのWindowsユーザーが読めるファイルへアクセスできます。信頼できるMCPだけを登録し、不要なものは`enabled = false`にします。
## OS境界
Gatewayは管理者権限での起動を拒否し、子MCPへ親プロセスの秘密情報らしい環境変数をそのまま継承しません。ただし、同じWindowsユーザーのファイルACLまでは隔離できません。SSH鍵、GitHub、Discord、Codex、ChatGPT関連ファイルから強く分離する場合は、専用の標準Windowsユーザーを使います。
## Tunnelの公開範囲
Secure MCP Tunnelは外向きHTTPSでOpenAIへ接続し、ローカルMCPの受信ポートを公開しません。Tunnelの関連付けは自分のPlatform Organizationと自分のChatGPT Workspaceだけに限定します。他人のOrganization、共有Workspace、公開Pluginへ関連付けません。
## Runtime API key
runtime主体には`Tunnels Read + Use`だけを与えます。INSTALL.mdはruntime API keyを`tunnel-client`の引数で渡す例を示します。このリポジトリはキーを保存しませんが、コマンドライン引数はシェル履歴や同一PC上のプロセス情報から見える場合があります。必要なら公式helpにある環境変数またはファイル参照方式を使います。
## ファイル操作
safe-filesの許可範囲は`--root`で渡したディレクトリだけです。マーカーファイルは使いません。ユーザープロファイル全体、その上位、許可ルート外、シンボリックリンクによる脱出を拒否します。`.ssh`、`.git`、`.codex`、`.env`、秘密鍵、資格情報らしい名前と高確度の秘密文字列は返しません。
`search_text`は固定の`rg`実行です。一般シェル、PowerShell、任意コマンドAPIはありません。`apply_patch`は専用パーサーまたは固定の`git apply`だけを使います。
## ファイル転送
`read_file_chunk`と`write_file`は既定16MiB以下です。ROM、State、鍵、証明書秘密鍵、実行ファイル、DLL、MSI、PowerShell、バッチ、ショートカットを拒否します。テキストはUTF-8だけを正式対応し、UTF-16LE、UTF-16BE、UTF-32、不正UTF-8を拒否します。
## 漏えい時
runtime keyが漏れた場合はOpenAI Platformで直ちに失効します。GitHub、Discord、SSH、ChatGPT、Codexなど別サービスの資格情報が漏れた可能性がある場合は、各サービス側で個別に失効または再生成します。