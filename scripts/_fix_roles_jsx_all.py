"""Fix ALL <...> schema tokens in roles.ts (TS treats them as JSX).

The previous run revealed 6 more <...> tokens across other schemas
(Ref output, Actor output, etc.). All of them need the same 「...」
swap so TS no longer interprets the schema as JSX.
"""
from pathlib import Path
import re

ROLES = Path(r"D:\BaiduYunDrive\OneDrive\github仓库\vscode-moa\src\moaCore\roles.ts")
text = ROLES.read_text(encoding="utf-8")

# Use regex to swap every <...> token that follows `"<field_name>":`.
# Pattern: optional leading whitespace + quoted key + ": " + <...> + optional
# trailing chars (comma, comment, etc.)
# We match "<...>" where ... contains no '<' or '>'.
pattern = re.compile(r'("[a-zA-Z_]+":\s*)<([^<>]+)>([,]?)')

def swap(m):
    key = m.group(1)
    inner = m.group(2)
    tail = m.group(3)
    return f"{key}「{inner}」{tail}"

new_text, count = pattern.subn(swap, text)
print(f"Replaced {count} occurrences")

# Verify
remaining = re.findall(r'"[a-zA-Z_]+":\s*<[^<>]+>', new_text)
print(f"Remaining schema <...> tokens: {len(remaining)}")
for r in remaining:
    print(f"  {r}")

ROLES.write_bytes(new_text.encode("utf-8"))
print(f"\nWrote {ROLES}")
