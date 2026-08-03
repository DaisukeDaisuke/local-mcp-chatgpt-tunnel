# Security Policy
## 公開面
この構成は受信HTTP、公開MCP、公開CDPポートを持ちません。`docker compose config`に`ports`が現れた場合は意図しない変更として扱ってください。
## 秘密情報
APIキー、SSH秘密鍵、CA秘密鍵、mTLSクライアント秘密鍵をGitへコミットしないでください。漏えいした場合は、APIキーを失効し、SSH鍵を`authorized_keys`から削除し、mTLS証明書をOpenAI側で無効化して再発行してください。
## Ghidra
Ghidra HTTPサーバーはWindowsの`127.0.0.1`だけで待受させます。DockerからはEd25519認証済みSSHローカルフォワードだけを使用します。`run_ghidra_script`と`run_script_inline`を再追加しないでください。
## Chrome
Chrome CDPはコンテナ内`127.0.0.1:9222`だけで待受します。Composeへ`9222:9222`を追加しないでください。Chromeは非rootユーザーで起動し、`--no-sandbox`を追加しません。
## OpenAI
通常TLSでNode.jsはOpenAIのサーバー証明書を検証します。mTLSを有効にするとOpenAI側もクライアント証明書を検証しますが、APIキーは引き続き必要です。課金なしの有効なモデルAPIキーはありません。
## 報告
秘密情報がログに出た場合、まず該当資格情報を失効してから、再現に秘密値を含めずに修正してください。
