---
name: plan-complex
description: 複数ファイルにまたがる変更、設計判断を伴う実装、大規模リファクタリングの計画を立てる。単一ファイルの小さな修正には使わない。
model: opus
context: fork
allowed-tools: Read, Grep, Glob, Write
---

# 目的

実装担当（Sonnet）が迷わず実行できる計画書を作る。コードは書かない。

# 手順

1. 要件と、関係するコードを読んで把握する。既存の挙動は SPECIFICATION.md の該当箇所で確認する。
2. 設計上の選択肢を比較し、採用案と理由を決める。
3. .claude/plans/current.md に次の構成で書き出す（既存の内容は上書きしてよい）。
   - 目的と完了条件
   - 変更するファイルと、各ファイルの変更内容
   - 実装の順序（小さな単位に分ける）
   - 注意点（境界条件、既存挙動への影響）
   - 検証方法（実行するテスト。基本は npm test）
   - バージョンと文書の更新（AGENTS.md に従い a/b/c のどれを上げるかとその理由、package.json・manifest.json・CHANGELOG.md・SPECIFICATION.md の更新内容）
4. 呼び出し元には、計画書のパスと3行以内の要約だけを返す。
