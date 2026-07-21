"""Surgical fix for L250-L252 in roles.ts.

The previous attempts broke the line structure. This time we rebuild
L250, L251, L252 cleanly from scratch.

Target structure (after fix):
  L250:     '  "task_type": "research | coding | documentation | analysis | hybrid",',
  L251:     '  "needs_iteration": \u300ctrue \u8868\u793a\u9700\u8981 MoA \u591a\u8f6e; false \u8868\u793a\u5355\u6b21\u5b8c\u6210\u300d,',
  L252:     '',

We replace a wider window: from L250's "task_type" through L252's empty
'' line.
"""
from pathlib import Path

ROLES = Path(r"D:\BaiduYunDrive\OneDrive\github仓库\vscode-moa\src\moaCore\roles.ts")
text = ROLES.read_text(encoding="utf-8")

# Build a precise broken-region signature: from "task_type" through
# the first occurrence of the empty '    \'\','  AFTER it.
LF = chr(10)
ANCHOR_START = "    '  \"task_type\":"
ANCHOR_END = "    ''," + LF  # empty line marker

i = text.find(ANCHOR_START)
assert i >= 0, "Cannot find task_type anchor"

# Find the first ''  line after task_type
j = text.find(ANCHOR_END, i)
assert j >= 0, "Cannot find ''  line after task_type"

# The broken region runs from start to end_marker (inclusive of LF after marker).
region_end = j + len(ANCHOR_END)

broken = text[i:region_end]
print("BROKEN REGION (repr):")
print(repr(broken))

# Build clean replacement.
clean = (
    "    '  \"task_type\": \"research | coding | documentation | analysis | hybrid\","
    + LF
    + "    '  \"needs_iteration\": \u300ctrue \u8868\u793a\u9700\u8981 MoA \u591a\u8f6e; "
    + "false \u8868\u793a\u5355\u6b21\u5b8c\u6210\u300d,"
    + LF
    + "    '',"
    + LF
)
print("\nCLEAN REPLACEMENT (repr):")
print(repr(clean))

new_text = text[:i] + clean + text[region_end:]
ROLES.write_bytes(new_text.encode("utf-8"))
print(f"\nWrote {ROLES} (was {len(text)}, now {len(new_text)})")

# Show result around the area
lines = ROLES.read_text(encoding="utf-8").splitlines()
for k, ln in enumerate(lines[248:258], start=249):
    print(f"L{k}: {ln!r}")
