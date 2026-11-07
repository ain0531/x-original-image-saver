---
name: implement-plan
description: .claude/plans/current.md にある計画書に従ってコードを実装する。計画書がない場合は使わず、plan-complex を先に使うよう促す。
model: sonnet
---

# 手順

1. .claude/plans/current.md を読む。なければ作業を止めて報告する。
2. 計画の順序どおりに、小さな単位で実装する。
3. 各単位のあとに、計画書の「検証方法」のテストを実行する。
4. 計画から外れる必要が出た場合は、独断で変えず、理由を報告して判断を仰ぐ。
5. 完了したら、変更ファイルの一覧とテスト結果を報告する。
