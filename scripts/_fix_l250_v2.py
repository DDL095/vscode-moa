"""Direct string replace L250."""
from pathlib import Path

ROLES = Path(r"D:\BaiduYunDrive\OneDrive\github仓库\vscode-moa\src\moaCore\roles.ts")
text = ROLES.read_text(encoding="utf-8")

# Current broken L250 line:
#     '  "task_type": "research | coding | documentation | analysis | hybrid\',\n
# Missing the closing double-quote inside the schema string.

# Use the literal byte sequence to find it.
LF = chr(10)
broken = '    \'  "task_type": "research | coding | documentation | analysis | hybrid\',' + LF
good = '    \'  "task_type": "research | coding | documentation | analysis | hybrid",\',' + LF

print("broken in text?", broken in text)
print("broken (repr):", repr(broken))
print("good   (repr):", repr(good))

if broken in text:
    text = text.replace(broken, good, 1)
    ROLES.write_bytes(text.encode("utf-8"))
    print("OK fixed")
else:
    # Diagnose: print the actual L250 from file
    lines = text.splitlines()
    print(f"\nActual L250 in file: {lines[249]!r}")

lines = ROLES.read_text(encoding="utf-8").splitlines()
for k, ln in enumerate(lines[248:258], start=249):
    print(f"L{k}: {ln!r}")
