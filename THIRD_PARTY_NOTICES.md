# Third-Party Notices
- `mcp/dq9-test`はユーザー提供の`dq9-test` ZIPを基に、Windows Headless Chrome起動と単一実行制御を維持しています。元プロジェクトのライセンス条件を確認して維持してください。
- `mcp/ghidra/bridge_mcp_ghidra.py`はユーザー提供ファイルを基に、任意Ghidraスクリプト実行ツールを公開しない変更を加えています。元プロジェクトのライセンス条件を確認して維持してください。
- `chrome-devtools-mcp`はnpmから`1.6.0`を固定取得します。ライセンスは同パッケージに従います。
- `tunnel-client`はOpenAI公式GitHub Releaseからユーザーが手動取得し、公開された`SHA256SUMS.txt`で検証します。このリポジトリはダウンロードやZIP展開を自動化せず、バイナリもコミットしません。
- `local-mcp`の設計は参照しましたが、任意コマンド実行機能を避けるためRust実装は同梱せず、UTF-8限定の`safe-files` MCPへ置き換えています。