# DQ9 OpenAI MCP Docker Suite
Windows 11とDocker Desktop上で、コンテナ内Headless Chrome、Chrome DevTools MCP、DQ9 Test MCP、Ghidra MCPブリッジ、UTF-8限定ファイル編集MCPを一つのNode.js CLIから利用する構成です。外部公開ポートはありません。Node.jsからOpenAIへ外向きHTTPS通信を行うため、ルーターのポート開放は不要です。
## 安全上の境界
- Node.jsアプリはHTTPサーバーを起動せず、CLIとしてのみ動作します。
- Docker Composeには`ports`がなく、Chrome CDP、Ghidraブリッジ、MCPは外部公開されません。
- ファイルMCPは指定ルート内のUTF-8読込、一覧、原子的書込、完全一致置換、ディレクトリ作成だけを提供します。シェル、コマンド実行、削除APIはありません。
- Ghidraの`run_ghidra_script`と`run_script_inline`はブリッジ登録時に削除され、Agents SDK側でも二重に遮断されます。
- Ghidraへの接続はWindows OpenSSHのEd25519公開鍵認証と、`PermitOpen`で制限されたローカルフォワードを使用します。Ghidra HTTPポートをLANへ公開しません。
- OpenAI APIキー、SSH秘密鍵、mTLS秘密鍵はGit管理せず、Windows上のファイルを読取専用でマウントします。
- OpenAI API呼出しは`OPENAI_BILLING_ACK=I_UNDERSTAND_API_USAGE_IS_BILLED`がない限り拒否されます。
## 重要な課金仕様
課金を完全に無効化したままモデルを呼べるOpenAI APIキーはありません。APIキーを作らずに使えるのは`doctor`とローカルMCPの検証だけです。APIキーをマウントして上記確認文字列を設定した場合のみ、課金対象のモデル呼出しが有効になります。プロジェクト予算は通知用であり、厳密なハード上限として扱わないでください。
API課金を発生させずChatGPT側の契約内でMCPを呼ぶ別経路は、対応プランからSecure MCP Tunnelへ接続する構成です。ただし、書込みを含む完全なMCPは現在Business、Enterprise、Edu向けで、Plusからこのローカル開発環境を直接使う代替にはなりません。本リポジトリはPlusでも技術的に実行できるOpenAI API方式を実装し、既定では課金呼出しを無効化しています。
## 1. 初期配置
```powershell
Copy-Item .env.example .env
Copy-Item config\dq9-runtime.example.json config\dq9-runtime.json
New-Item -ItemType Directory -Force workspace
```
`.env`の`WORKSPACE_PATH`、`DQ9_CONFIG_PATH`と、`config/dq9-runtime.json`内のROM、State、永続スクリプトのパスをコンテナ内パス`/workspace/...`として設定します。ROMやStateをGitへ追加しないでください。
## 2. Ghidra用Ed25519トンネル
管理者PowerShellで実行します。
```powershell
.\scripts\windows\Initialize-GhidraTunnel.ps1 -RestrictSshFirewallToDockerInterfaces
```
このスクリプトは専用標準ユーザー`mcp-tunnel`、Ed25519クライアント鍵、制限付き`authorized_keys`、`Match User`設定、Windows SSHホスト鍵から生成した固定`known_hosts`を作成します。秘密鍵は既定で`%USERPROFILE%\.dq9-mcp`に作られ、リポジトリには入りません。GhidraプラグインはWindows側`127.0.0.1:8089`で待受させます。デバッガーを使う場合は`127.0.0.1:8099`です。
## 3. ビルドと無課金検証
```powershell
docker compose build
docker compose run --rm app node app/doctor.mjs
docker compose run --rm app npm test
```
`doctor`はAPIキーを必要とせず、OpenAIへのモデル呼出しを行いません。
## 4. OpenAI APIを使う場合
OpenAI Platformで専用Projectを作り、そのProject専用のRestricted API keyを作成します。必要なResponses API権限だけを許可し、ブラウザーやソースコードへ入れず、`%USERPROFILE%\.dq9-mcp\openai_api_key`の一行ファイルとして保存します。`.env`の`OPENAI_API_KEY_PATH`をそのファイルへ向けます。APIキーをGit、Dockerfile、Composeの平文環境値へ入れないでください。
課金を理解して明示的に有効化する場合だけ、`.env`へ次を設定します。
```dotenv
OPENAI_BILLING_ACK=I_UNDERSTAND_API_USAGE_IS_BILLED
```
実行例です。
```powershell
.\scripts\windows\Invoke-Assistant.ps1 "DQ9テストランタイムを準備し、現在の画面状態を確認して"
```
## 5. OpenAI mTLS
OpenAI mTLSはAPIキーを置き換えず、APIキーとクライアント証明書の両方を要求します。OpenAIの公開要件はクライアント証明書に`Digital Signature`と`Key Encipherment`を要求するため、この構成はEd25519ではなくRSA 3072のX.509証明書を生成します。
```powershell
docker compose --profile tools run --rm certgen
```
生成先は`.env`の`SECRETS_DIR`です。OpenAIへアップロードするのは`openai_mtls_ca_cert.pem`だけです。`openai_mtls_ca_key.pem`と`openai_mtls_client_key.pem`は絶対にアップロード、共有、Git追加しないでください。OpenAIでCA証明書を有効化した後、`.env`へ次を設定します。
```dotenv
OPENAI_MTLS_ENABLED=true
OPENAI_MTLS_CERT_PATH=C:/Users/owner/.dq9-mcp/openai_mtls_client_cert.pem
OPENAI_MTLS_KEY_PATH=C:/Users/owner/.dq9-mcp/openai_mtls_client_key.pem
```
## 6. Git管理
秘密情報、ROM、State、実行生成物は`.gitignore`で除外されています。初回取得後は次を確認してください。
```powershell
.\scripts\windows\Enable-GitHooks.ps1
git status --short
git ls-files | Select-String -Pattern "key|pem|\.nds$|\.dst$"
```
## 構成
```text
Node.js CLI
├─ OpenAI Responses API（外向き443、任意でmTLS）
├─ stdio: safe-files MCP
├─ stdio: dq9-test MCP
├─ stdio: chrome-devtools-mcp
└─ stdio: Ghidra MCP bridge
   └─ 127.0.0.1:8089
      └─ SSH Ed25519 local forward
         └─ Windows Ghidra 127.0.0.1:8089
```
