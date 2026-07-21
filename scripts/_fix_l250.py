"""Fix L250 — I accidentally turned its trailing '",' into '\','.

Original L250 was correctly:
  '  "task_type": "research | ... | hybrid",'

I broke it into:
  '  "task_type": "research | ... | hybrid\','   <-- wrong: stray \',

Just fix L250 in place.
"""
from pathlib import Path

ROLES = Path(r"D:\BaiduYunDrive\OneDrive\github仓库\vscode-moa\src\moaCore\roles.ts")
text = ROLES.read_text(encoding="utf-8")

bad_l250 = (
    "    '  \"task_type\": \"research | coding | documentation | analysis | hybrid\\',"
    + chr(10)
)
good_l250 = (
    "    '  \"task_type\": \"research | coding | documentation | analysis | hybrid\",'"
    + chr(10)
)

print("bad in text?", bad_l250 in text)

if bad_l250 in text:
    text = text.replace(bad_l250, good_l250, 1)
    ROLES.write_bytes(text.encode("utf-8"))
    print("L250 fixed.")
else:
    print("L250 already correct or different.")

lines = ROLES.read_text(encoding="utf-8").splitlines()
for k, ln in enumerate(lines[248:258], start=249):
    print(f"L{k}: {ln!r}")
