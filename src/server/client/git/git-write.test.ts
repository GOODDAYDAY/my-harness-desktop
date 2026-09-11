// git-write 的行为守卫 —— 用**真实临时仓库**(git init 在 mkdtemp 里,不碰本仓 ✓)。
//
// 第 236/237 轮的判定过程留在这里,因为结论直接决定了断言怎么写:
//   · 用**不存在的 cwd** 测前置校验 → `simpleGit` 先失败 → `{ok:false}` **由它满足** ✗(假通过)
//   · 换成**真实 cwd** 后才看得出是谁拦下的:
//       `../../etc/passwd` → "**路径逃逸: …**"            ← **我们的校验** ✓✓
//       `/etc/passwd`      → "fatal: … is outside repository" ← **git 自己** ✗✗(我们的校验放行)
//   故:③ 断言"由**我们的校验**拦下"(钉原因 ✓);② 断言"当前被拦下,但拦它的是 git"
//   —— ② 是在**钉住那个缺口** ✓:谁哪天给 assertRelativePaths 补上 isAbsolute,② 会红并提醒他更新 ✓
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { commitFiles, pushCurrent } from "./git-write";

let repo = "";
const git = (cmd: string): string => execSync(cmd, { cwd: repo, encoding: "utf-8" });

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "gw-test-"));
  git("git init -q && git config user.email t@t && git config user.name t");
  writeFileSync(join(repo, "ok.txt"), "x");
  git("git add ok.txt && git commit -qm init");
});

describe("git-write:commitFiles(真实临时仓库)", () => {
  it("① 空 message → { ok:false },且由**我们的校验**拦下(错误指明 message)", async () => {
    const r = await commitFiles(repo, "   ", ["ok.txt"]);
    expect(r.ok, "空 message 竟然被接受了").toBe(false);
    expect(r.error ?? "", "不是被 message 那条挡下的").toMatch(/message/i);
  });

  it("★ ② 绝对路径 → 当前被拦下,但**拦它的是 git 而不是我们**(缺口,如实钉住)", async () => {
    const r = await commitFiles(repo, "msg", ["/etc/passwd"]);
    expect(r.ok).toBe(false);
    // ⚠ 这条断言是**故意的**:它记录"我们的路径校验放行了绝对路径,靠 git 兜住"。
    //   若哪天 assertRelativePaths 补上 isAbsolute 判断,这里会红 —— 那时把断言改成
    //   `toMatch(/路径/)` 即可(那才是它本该有的行为)。
    expect(r.error ?? "", "行为变了:绝对路径现在由我们拦下了 —— 请把这条断言改成断言'路径'错误").toMatch(/outside repository/i);
  });

  it("★★ ③ 逃逸路径(../../x)→ 由**我们的校验**拦下(错误是'路径逃逸')", async () => {
    const r = await commitFiles(repo, "msg", ["../../etc/passwd"]);
    expect(r.ok, "逃逸路径被放行了").toBe(false);
    expect(r.error ?? "", "不是我们的路径校验拦下的(git 先失败了?换真实 cwd 可区分)").toMatch(/逃逸/);
  });

  it("④ **永不抛**:无论哪种失败都返回 { ok:false, error }", async () => {
    for (const [msg, files] of [["", ["ok.txt"]], ["msg", ["../../x"]], ["msg", ["/etc/passwd"]]] as const) {
      const r = await commitFiles(repo, msg, [...files]);
      expect(r).toHaveProperty("ok", false);
      expect(typeof r.error).toBe("string");
    }
  });

  it("⑤ 正常路径:提交成功并回一个 hash ✓", async () => {
    writeFileSync(join(repo, "ok.txt"), "y");
    const r = await commitFiles(repo, "正常提交", ["ok.txt"]);
    expect(r.ok, `正常提交失败了: ${r.error}`).toBe(true);
    expect(r.hash ?? "", "没有回 commit hash").toMatch(/^[0-9a-f]{7,}$/);
  });

  it("★★ ⑥ pushCurrent **不自动建 upstream**(无远程时原样报错)", async () => {
    const r = await pushCurrent(repo);
    expect(r.ok, "无 upstream 竟然 push 成功了?").toBe(false);
    expect(typeof r.error).toBe("string");
    // 关键:**没有**因为它失败就顺手 `git push -u origin …` —— 远程列表仍为空 ✓✓
    expect(git("git remote").trim(), "**擅自建了 upstream/远程**(违反'不自动 publish'的契约)").toBe("");
  });
});
