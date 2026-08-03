# Third-Party Notices
- 任意の外部MCPはユーザーが`gateway.toml`へ登録し、各MCPの配布元とライセンス条件に従って個別に導入します。このリポジトリはGhidra、DQ9、Chrome DevToolsなどの第三者MCPを再配布せず、外部MCPのnpm依存も固定しません。
- `tunnel-client`はOpenAI公式GitHub Releaseからユーザーが手動取得し、公開された`SHA256SUMS.txt`で検証します。このリポジトリはダウンロードやZIP展開を自動化せず、バイナリもコミットしません。
- `local-mcp`の設計は参照しましたが、任意コマンド実行機能を避けるためRust実装は同梱せず、UTF-8限定の`safe-files` MCPへ置き換えています。