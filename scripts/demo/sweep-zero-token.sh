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
#     FAIL(3x)  = 连跑三次都失败 → 可信失败
#   单次结果不足以判定；这样广扫的结论才可信，也不会把抖动误报成回归。
#
# ⚠ 机器负载高时的失败签名：`Runtime.callFunctionOn timed out`（CDP 协议级超时）。
#   它**不是**产品失败——实测 load average 20 时连 build 都要 47s（平时 8s），
#   renderer 忙不过来 → CDP 调用超时。看到这个签名先看 `uptime`，别急着查代码。
#
# 用法: npm run build && bash scripts/demo/sweep-zero-token.sh
# 排除在外的（**别往里加**，加了就是花真 token）：
#   · attach 型：dsh-credentials / dsh-multiturn（连接运行中的 app，默认 CDP 9222）；
#   · 真模型型：pi-smoke / dsh-smoke / ask-question / ask-resume / fork-cross-kernel /
#     *-thinking / session-single-source。**判定方法（别凭感觉）**：
#       ① 看头注释有没有"花真实 token / 真实回合"；
#       ② `grep -c createServer <file>`：**没有本地 mock 又真的会发消息**（键盘输入或点发送）
#          ⇒ 一定会调真模型 ⇒ 不该进这个清单。
#     教训（两次踩到）：`session-single-source`（头注释写着"一次 pi ping"）与
#     `fork-cross-kernel`（末尾打印"真 token"）都是我"看着像冒烟"就加进来的。
#   · 已知抖动：session-single-source 的 ⑤（刷新重开→点行重开）偶发失败，已给它加了
#     失败现场诊断（侧栏行/时间线消息数/body 头），下次失败能自证。
#
# ⚠ **两边的错都要防**（本轮各踩一次）：
#   · **漏**：kernel-dispatch（25 断言、纯派发不花 token）一直没进清单 —— 手跑过却没写进来；
#   · **多**：fork-cross-kernel / ask-question / ask-resume 一度被加进来，它们**会调真模型**。
#   加新 e2e 时按上面的"判定方法"两条核一遍，别凭"像不像冒烟"。
cd "$(dirname "$0")/../.." || exit 1

LIST="
kernel-dispatch dsh-model-reasoning pi-model-reasoning pi-devrole
multi-kernel-round dsh-round minimal-model thinking-block session-list-orphan-kernel
kernel-plugin-uninstall composer-model-pin minimal-smoke minimal-settings minimal-fork
minimal-tool session-search rename message-actions bookmark-snapshot bookmark-fork
composer-draft cwd-session-restore sidebar-panel sidepanel-resize sticker-picker
goal-command fork
"

pass=0; flaky=0; fail=0
run_once() { node "$1" >/tmp/sweep-last.log 2>&1; echo $?; }

# 先报一下负载：这台机器负载高时，一批里会冒出若干**DOM 时序型**失败
# （`Runtime.callFunctionOn timed out` / "等不到某个元素"），单跑又全绿。
# 看到高负载就别把失败当回归——所以直接印在最前面，省得回头翻。
echo "== 机器负载: $(uptime | sed 's/.*load averages*: //') =="

for n in $LIST; do
  f="scripts/demo/$n.e2e.mjs"
  [ -f "$f" ] || { echo "== $n :: MISSING"; fail=$((fail+1)); continue; }
  code=$(run_once "$f")
  if [ "$code" -eq 0 ]; then
    echo "== $n :: PASS :: $(grep -oE '✅ PASS: [0-9]+ 项断言' /tmp/sweep-last.log | head -1)"
    pass=$((pass+1)); continue
  fi
  cp /tmp/sweep-last.log "/tmp/sweep-first-$n.log"
  # 复跑**两次**：负载高时"两次都撞上"并不罕见（实测 load≈12 时曾有三条连挂两次、
  # 单跑又全绿）。判 FAIL 的门槛抬高，才不会把环境抖动当回归。
  ok2=1
  for _ in 1 2; do
    sleep 3
    [ "$(run_once "$f")" -eq 0 ] && { ok2=0; break; }
  done
  if [ "$ok2" -eq 0 ]; then
    echo "== $n :: FLAKY(首跑失败/复跑通过) :: $(grep -E '❌|Error' "/tmp/sweep-first-$n.log" | head -1 | cut -c1-70)"
    flaky=$((flaky+1))
  else
    echo "== $n :: FAIL(3x) :: $(grep -E '❌ FAIL|Error' /tmp/sweep-last.log | head -1 | cut -c1-90)"
    fail=$((fail+1))
  fi
done

echo "SWEEP DONE: PASS=$pass FLAKY=$flaky FAIL=$fail"
[ "$fail" -eq 0 ]
