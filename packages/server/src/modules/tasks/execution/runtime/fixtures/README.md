`claude-2.1.317-named-empty.txt`: Claude Code 2.1.317、RC の確認のペインの capture。入力済み等の派生ケースはテスト内で加工している。Codex の名前入り枠の実画面は未取得。

`claude-2.1.319-tmux-ghost.ansi` と `claude-2.1.319-tmux-same-draft-start.ansi`: Linux の Claude Code 2.1.319 を専用 tmux ソケット、一時 HOME・設定・作業ディレクトリ、`--strict-mcp-config` で起動し、二つの短い応答後に `capture-pane -p -e` で取得した未加工の 80 列画面。前者は実際の次の入力候補 `give another tip`、後者は同じ文を手入力して Home でカーソルを文頭に戻した画面。別々に取得した画面全体がバイト単位で同一で、先頭の `g` だけが反転表示される。両画面には個人情報や一時ディレクトリのパスは含まれない。候補の生成は `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=1` を指定した。tmux の色付きテキストだけではこの二つを区別できない例であり、misao や他のバージョンについての観察ではない。
