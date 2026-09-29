"""Package the extension source into a distributable ZIP (no audit scripts).

版本号自动取 manifest.json，所以升版本只需要改 manifest.json 一处，
不用再来改这个脚本。
"""
import json
import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
top = f"TransMate-v{version}-源码"
out = root / f"TransMate-v{version}-源码.zip"

include = [
    "manifest.json",
    "background.js",
    "content.js",
    "providers.js",
    "options.html",
    "options.js",
    "options.css",
    "popup.html",
    "popup.js",
    "popup.css",
    "timezone.js",
    "timezone.css",
    "安装说明.txt",
    # MIT 要求许可声明随副本一起分发；第三方声明同理（timezone.js 里打包了两个库）。
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
]

files = []
for name in include:
    path = root / name
    if not path.is_file():
        raise SystemExit(f"missing file: {path}")
    files.append(path)
files.extend(sorted(root.glob("icons/*.png")))

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in files:
        archive.write(path, f"{top}/{path.relative_to(root).as_posix()}")

with zipfile.ZipFile(out) as archive:
    total = 0
    for info in archive.infolist():
        total += info.file_size
        print(f"{info.file_size:>9}  {info.filename}")
print(f"\n{len(files)} files, {total} bytes raw -> {out.name} ({out.stat().st_size} bytes)")
