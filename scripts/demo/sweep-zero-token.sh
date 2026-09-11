#!/bin/bash
# 零 token e2e 广扫 —— 跑库里全部"种子态/无真模型"的 e2e，收集通过/失败。
#
# 为什么要有这个脚本（而不是手敲一串）：改动面相关的 e2e 是底线不是上限，
# 而**全量广扫**才是揪出"平时没人走的路径"上真 bug 的手段（本轮就靠它抓到
# 分叉会话丢回复、dsh 面板恒空两个真缺陷）。广扫要进仓库、能被反复跑，才有意义。
#
# ⚠ 连跑 N 个 app 会互相挤资源：实测一批里会冒出若干"DOM 还没渲染出来就超时"的失败，
#   逐个单跑又全绿。所以对失败**自动复跑一次**（间隔 3s），并把结果分开报：
#     PASS      = 一次过
#     FLAKY     = 首跑失败、复跑通过 → 抖动（要深挖就单独深挖，别当回归）
#     FAIL(2x)  = 复跑也失败 → 可信失败
#   单次结果不足以判定；这样广扫的结论才可信，也不会把抖动误报成回归。
#
# 用法: npm run build && bash scripts/demo/sweep-zero-token.sh
# 排除在外的：attach 型 e2e（连接运行中的 app，默认 CDP 9222）——
#   dsh-credentials / dsh-multiturn / pi-smoke / dsh-smoke / ask-* / *-thinking 等需要真模型或真凭证。
cd "$(dirname "$0")/../.." || exit 1

LIST="
multi-kernel-round dsh-round minimal-model thinking-block session-list-orphan-kernel
kernel-plugin-uninstall composer-model-pin minimal-smoke minimal-settings minimal-fork
minimal-tool session-search rename message-actions bookmark-snapshot bookmark-fork
composer-draft cwd-session-restore sidebar-panel sidepanel-resize sticker-picker
goal-command session-single-source fork
"

pass=0; flaky=0; fail=0
run_once() { node "$1" >/tmp/sweep-last.log 2>&1; echo $?; }

for n in $LIST; do
  f="scripts/demo/$n.e2e.mjs"
  [ -f "$f" ] || { echo "== $n :: MISSING"; fail=$((fail+1)); continue; }
  code=$(run_once "$f")
  if [ "$code" -eq 0 ]; then
    echo "== $n :: PASS :: $(grep -oE '✅ PASS: [0-9]+ 项断言' /tmp/sweep-last.log | head -1)"
    pass=$((pass+1)); continue
  fi
  cp /tmp/sweep-last.log "/tmp/sweep-first-$n.log"
  sleep 3
  code2=$(run_once "$f")
  if [ "$code2" -eq 0 ]; then
    echo "== $n :: FLAKY(首跑失败/复跑通过) :: $(grep -E '❌|Error' "/tmp/sweep-first-$n.log" | head -1 | cut -c1-70)"
    flaky=$((flaky+1))
  else
    echo "== $n :: FAIL(2x) :: $(grep -E '❌ FAIL|Error' /tmp/sweep-last.log | head -1 | cut -c1-90)"
    fail=$((fail+1))
  fi
done

echo "SWEEP DONE: PASS=$pass FLAKY=$flaky FAIL=$fail"
[ "$fail" -eq 0 ]
