"""一次性变异脚本：确认"译文出口必须带 warnings"这条断言真的会失败。

用法：python temp/mutate-verify-exit.py
改坏 -> 跑回归 -> 还原，每步都打印结果。换行符必须保持 LF。
"""
import io
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, "background.js")

MUTATIONS = [
    (
        "出口丢掉 warnings（只留 targetLanguage）",
        "return { text: output, targetLanguage: target.code, warnings: TLP_VERIFY.verifyTranslation(text, output) };",
        "return { text: output, targetLanguage: target.code };",
        "background.js:",
    ),
    (
        "批量出口绕过 withWarnings，自己拼对象",
        ".map((item) => withWarnings(item, byId.get(item.id) || \"\"))",
        ".map((item) => ({ id: item.clientId, text: byId.get(item.id) || \"\" }))",
        "withWarnings",
    ),
]


def read(path):
    with io.open(path, "r", encoding="utf-8", newline="") as handle:
        return handle.read()


def write(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def run_regression():
    result = subprocess.run(
        ["node", "temp/regression-checks.cjs"],
        cwd=ROOT, capture_output=True, text=True
    )
    return result.returncode, (result.stdout + result.stderr)


def main():
    original = read(TARGET)
    # 项目统一用 CRLF；只要不是"混着来"，读写时用 newline='' 就能原样还原。
    lf_only = original.count("\n") - original.count("\r\n")
    assert lf_only == 0, f"background.js 换行符不统一：{lf_only} 行是裸 LF"

    failures = 0
    for title, old, new, expect in MUTATIONS:
        if original.count(old) != 1:
            print(f"[跳过] {title}：锚点出现 {original.count(old)} 次，需要恰好 1 次")
            failures += 1
            continue

        write(TARGET, original.replace(old, new))
        code, output = run_regression()
        write(TARGET, original)

        caught = code != 0 and expect in output
        print(f"[{'抓住' if caught else '漏掉'}] {title}")
        if not caught:
            failures += 1
            print("      退出码", code)
            print("      " + output.strip().replace("\n", "\n      ")[:800])

    print()
    print("全部变异都被抓住" if failures == 0 else f"{failures} 处没被抓住")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
