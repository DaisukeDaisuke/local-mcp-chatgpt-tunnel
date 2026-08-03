# Security Policy
## 公開面
この構成はWindowsネイティブで動作し、MCP gatewayはstdioのみです。公開MCP URL、Docker公開ポート、ルーターのポート転送は使用しません。tunnel-clientがOpenAIへ外向きHTTPS接続します。tunnel-client自身のヘルスUIがWindowsのloopbackへ待受する場合がありますが、LANやインターネットには公開しません。
## Tunnel runtime key
runtime keyの主体には`Tunnels: Read + Use`だけを許可してください。`Model capabilities: Request`を含むTunnels以外のAPI権限と、Tunnel管理用のAdmin keyは付与しません。キーは`%USERPROFILE%\.dq9-mcp\tunnel-runtime-key`に保存し、Git、設定JSON、PowerShell履歴、ログ、ブラウザーへ貼り付けないでください。
## ファイル操作
ファイルMCPの許可範囲は`config\gateway.json`の`workspaceRoots`です。UTF-8だけを読み書きし、UTF-16、UTF-32、不正UTF-8、ルート外、シンボリックリンク経由の書込みを拒否します。`set_working_directory`は許可ルート内の既存ディレクトリに限定されます。`apply_patch`は専用パーサーまたは固定の`git apply`だけを使用し、シェルと任意コマンドを公開しません。
## Ghidra
Ghidra HTTPサーバーは`127.0.0.1`だけで待受させてください。`run_ghidra_script`と`run_script_inline`は再公開しないでください。Windowsホスト外からアクセス可能なbindへ変更しないでください。
## Chrome
Chrome CDPは`127.0.0.1:9222`だけで待受します。ChromeはDQ9 MCPが専用プロファイルで起動し、Chrome DevTools MCPは同じCDPへ接続します。通常の閲覧用Chromeプロファイルを指定しないでください。
## 資格情報漏えい
runtime keyが漏えいした場合はOpenAI Platformで直ちに失効し、新しいTunnel専用キーを作成してください。ROM、State、秘密鍵、トークンを含むログをIssueやチャットへ添付しないでください。