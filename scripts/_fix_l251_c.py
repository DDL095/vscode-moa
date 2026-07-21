"""Surgical fix L250-L252 in roles.ts — correct quote handling.

Each schema line in roles.ts is a single-quoted JS string like:
  '  "field": value,'

To insert a L251 that follows the same pattern in Python (using "..."):
  Python double-quoted string containing literal single quotes
  + escape any internal double-quote with \"
  + escape any internal single-quote with \' (but schema lines have NO
    internal single quotes, so we don't need this)
  + closing single quote + trailing comma + LF
"""
from pathlib import Path

ROLES = Path(r"D:\BaiduYunDrive\OneDrive\github仓库\vscode-moa\src\moaCore\roles.ts")
text = ROLES.read_text(encoding="utf-8")

LF = chr(10)

ANCHOR_START = "    '  \"task_type\":"
i = text.find(ANCHOR_START)
assert i >= 0

ANCHOR_END = "    ''," + LF
j = text.find(ANCHOR_END, i)
assert j >= 0

region_end = j + len(ANCHOR_END)

# Clean replacement — exactly the JS schema lines:
clean = (
    "    '  \"task_type\": \"research | coding | documentation | analysis | hybrid\',"
    + LF
    + "    '  \"needs_iteration\": \u300ctrue \u8868\u793a\u9700\u8981 MoA \u591a\u8f6e; false \u8868\u793a\u5355\u6b21\u5b8c\u6210\u300d\',"
    + LF
    + "    '',"
    + LF
)

print("CLEAN (repr):")
print(repr(clean))

new_text = text[:i] + clean + text[region_end:]
ROLES.write_bytes(new_text.encode("utf-8"))

lines = ROLES.read_text(encoding="utf-8").splitlines()
for k, ln in enumerate(lines[248:258], start=249):
    print(f"L{k}: {ln!r}")
