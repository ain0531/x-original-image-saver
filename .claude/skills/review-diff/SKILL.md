---
name: review-diff
description: 実装後の最終確認として、計画書と差分をもとに変更内容を評価する。コミットやpushの前に使う。
model: opus
context: fork
allowed-tools: Read, Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(npm test:*)
---

# 入力（これだけを見る）

- 計画書（.claude/plans/current.md）
- git diff の結果
- テスト結果（渡されなければ npm test を自分で実行する）
リポジトリ全体は読まない。判断に必要な場合のみ、該当箇所を最小限で読む。

# 確認の観点

1. 計画書の内容がすべて実装されているか、計画外の変更がないか
2. 境界条件、エラー処理、既存挙動への影響
3. セキュリティ（入力検証、秘密情報の混入）
4. テストの十分さ
5. AGENTS.md のバージョン管理方針
   - package.json と manifest.json の version が一致し、変更の種類（修正=c / 新機能=b / 互換性なし=a）に合った上げ方になっているか
   - CHANGELOG.md に該当バージョンの記載があるか
6. src/ を変更したのに dist/ が更新されていない、といった食い違いがないか

# 出力

- 判定: 承認 / 要修正
- 要修正の場合: 問題点を重要度順に、該当箇所つきで列挙する
