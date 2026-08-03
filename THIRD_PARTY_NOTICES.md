# Third-Party Notices
- `mcp/dq9-test`はユーザー提供の`dq9-test` ZIPを基にDocker Headless Chrome対応と単一実行ロックを追加しています。
- `mcp/ghidra/bridge_mcp_ghidra.py`はユーザー提供ファイルを基に、任意Ghidraスクリプト実行ツールを登録しない変更を加えています。元プロジェクトのライセンス条件を確認して維持してください。
- `chrome-devtools-mcp`はDockerビルド時に`1.1.1`をnpmから取得します。
- `@openai/agents`、`openai`、`undici`、`zod`は各ライセンスに従います。
- `local-mcp`の設計は参照しましたが、任意コマンド実行機能を避けるためRust実装は同梱せず、新規のUTF-8限定`safe-files` MCPへ置き換えています。
