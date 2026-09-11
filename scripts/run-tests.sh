#!/usr/bin/env bash
# 跑单测并**永远保留完整输出**。
#
# 为什么需要它:本会话出现过两次"1 failed | 11xx passed"的瞬态,两次都没留下**是哪一条**——
# 第一次是命令里只 grep 了汇总行(Tests ...),第二次同样。教训写在笔记里没有用,
# **必须变成工具**:任何一次失败的身份都不该因为"我当时的 grep 写窄了"而消失。
#
# 用法: bash scripts/run-tests.sh [vitest 的额外参数...]
# 输出: 终端实时可见(tee),同时完整落在 /tmp/mhd-vitest-<时间戳>.log;失败时打印该路径与失败清单。
set -o pipefail

LOG="/tmp/mhd-vitest-$(date +%Y%m%d-%H%M%S).log"
npx vitest run "$@" 2>&1 | tee "$LOG"
CODE=${PIPESTATUS[0]}

if [ "$CODE" -ne 0 ]; then
  echo ""
  echo "──────── 失败详情(完整输出在 $LOG) ────────"
  # 失败清单:vitest 的 FAIL 行 + 汇总行,一起打出来,免得再丢身份
  grep -E "FAIL|Tests +[0-9]+ (failed|passed)|^ *×" "$LOG" | head -30
fi
exit "$CODE"
