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
各MCPの`allowed_directories`と`allowed_files`が、ChatGPTから子MCPへ渡せるファイルパスを決めます。ディレクトリは配下を含み、ファイルは絶対パスの完全一致です。相対パスはMCPの`cwd`から解決し、Windows区切り文字、JSONの二重エスケープ、既存パスのシンボリックリンクを正規化してから比較します。許可リストが空のMCPでパスらしい引数を使うと拒否します。
safe-filesは`cwd`だけをWorkspaceルートとして使い、その外側とシンボリックリンクによる脱出を拒否します。危険そうなフォルダ名の一般ブラックリストは使いません。高確度の秘密文字列は内容検査で拒否し、`.git`内部へのpatchは操作固有の制約として拒否します。
safe-imagesは読み取り専用で、公開するツールは`read_image`だけです。PNG、JPEG、WebPの拡張子とマジックバイトを照合し、ファイルサイズと総画素数を制限します。SVG、HEIC、シンボリックリンク、UNC、NTFS代替データストリーム、許可ルート外の画像は拒否します。画像base64は`content`の画像ブロックだけへ置き、`structuredContent`へ重複させません。
`search_text`は固定の`rg`実行です。一般シェル、PowerShell、任意コマンドAPIはありません。`apply_patch`は専用パーサーまたは固定の`git apply`だけを使います。
## ファイル転送
`read_file_chunk`と`write_file`は既定16MiB以下です。ROM、State、鍵、証明書秘密鍵、実行ファイル、DLL、MSI、PowerShell、バッチ、ショートカットを拒否します。テキストはUTF-8だけを正式対応し、UTF-16LE、UTF-16BE、UTF-32、不正UTF-8を拒否します。
## 漏えい時
runtime keyが漏れた場合はOpenAI Platformで直ちに失効します。GitHub、Discord、SSH、ChatGPT、Codexなど別サービスの資格情報が漏れた可能性がある場合は、各サービス側で個別に失効または再生成します。