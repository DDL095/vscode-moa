"""
Clean up package.json:
  1. Replace displayName / description with NLS placeholders (%-wrapped keys)
  2. Strip leading version prefixes from all description fields
     (e.g. "v0.17.0: ..." -> "...", "v0.14.5 [DEPRECATED ..." -> "[DEPRECATED ...")
     BUT preserve version references mid-sentence (e.g. "redesigned in v0.17-v0.18")
  3. Bump version 0.18.3 -> 0.18.4
  4. Remove leading version prefixes in chatParticipants / commands / languageModelTools / configuration

This script is idempotent: running it twice produces the same output.
"""
import json
import re
from pathlib import Path

PKG_PATH = Path(__file__).parent.parent / "package.json"

# --- Leading version prefix pattern ---
# Matches: optional-whitespace + v0.X.Y[:\s]  OR  (v0.X.Y)  at start of string
# Captures the rest after the prefix.
LEADING_VERSION_RE = re.compile(
    r'^\s*v\d+\.\d+(?:\.\d+)?\s*[:：]?\s*'
)

def clean_desc(s):
    """Strip leading version prefix, preserve everything else."""
    if not isinstance(s, str):
        return s
    cleaned = LEADING_VERSION_RE.sub('', s)
    return cleaned

def clean_nested(obj):
    """Recursively clean all 'description' / 'modelDescription' / 'userDescription' fields."""
    if isinstance(obj, dict):
        for k, v in list(obj.items()):
            if k in ('description', 'modelDescription', 'userDescription') and isinstance(v, str):
                obj[k] = clean_desc(v)
            elif isinstance(v, (dict, list)):
                clean_nested(v)
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            if isinstance(item, (dict, list)):
                clean_nested(item)

def main():
    pkg = json.loads(PKG_PATH.read_text(encoding='utf-8'))

    # 1. NLS placeholders
    pkg['displayName'] = '%extension.displayName%'
    pkg['description'] = '%extension.description%'

    # 2. Bump version
    old_ver = pkg.get('version', '')
    if old_ver == '0.18.3':
        pkg['version'] = '0.18.4'
        print(f'[version] {old_ver} -> 0.18.4')
    else:
        print(f'[version] keeping {old_ver} (expected 0.18.3)')

    # 3. Clean all description fields recursively
    clean_nested(pkg.get('contributes', {}))

    # 4. Write back with 2-space indent (matches existing style)
    PKG_PATH.write_text(
        json.dumps(pkg, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8'
    )
    print(f'[done] wrote {PKG_PATH}')

if __name__ == '__main__':
    main()
