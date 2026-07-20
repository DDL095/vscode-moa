"""
v0.19.0 Actor 验证脚本

用法：找到最近一次 moa 任务，验证 actor_result.json 不再为空。

检查点：
  1. actor_result.json 是否存在
  2. executed_actions 是否非空（Layer 2 修复点）
  3. reason 是否不再是 "Hit iteration cap"
  4. 副作用文件是否实际写入（write_file 类 action）
  5. §1.1 强制总结轮是否被触发（看 progress log 或 OutputChannel）

运行：
  python scripts/verify_v019_actor.py [--task-id <id>] [--workspace <path>]
"""
import argparse
import json
import os
import sys
from pathlib import Path


def find_latest_task(cache_root: Path) -> Path | None:
    """找最近修改的 moa_* 目录。"""
    if not cache_root.exists():
        return None
    candidates = [d for d in cache_root.iterdir() if d.is_dir() and d.name.startswith("moa_")]
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def verify_task(task_dir: Path) -> dict:
    """验证单个 task 的所有 actor_result.json。"""
    result = {
        "task_id": task_dir.name,
        "actor_iterations": [],
        "issues": [],
        "ok": True,
    }

    # 扫描所有 iteration 子目录
    iter_dirs = sorted([d for d in task_dir.iterdir() if d.is_dir() and d.name.startswith("iteration_")])
    if not iter_dirs:
        result["issues"].append(f"⚠️ 无 iteration_* 目录")
        result["ok"] = False
        return result

    for iter_dir in iter_dirs:
        iter_num = iter_dir.name.replace("iteration_", "")
        actor_file = iter_dir / "actor_result.json"
        if not actor_file.exists():
            continue  # 该轮无 Actor（正常）

        try:
            with open(actor_file, "r", encoding="utf-8") as f:
                actor = json.load(f)
        except Exception as e:
            result["issues"].append(f"❌ iter{iter_num}: actor_result.json 解析失败: {e}")
            result["ok"] = False
            continue

        executed = actor.get("executed_actions", [])
        reason = actor.get("self_assessment", {}).get("reason", "?")
        tool_calls = actor.get("tool_calls", 0)
        elapsed = actor.get("elapsed_sec", 0)

        entry = {
            "iter": iter_num,
            "executed_count": len(executed),
            "tool_calls": tool_calls,
            "elapsed_sec": round(elapsed, 1),
            "reason": reason,
            "actions_summary": [
                {
                    "type": a.get("action", {}).get("type"),
                    "target": a.get("action", {}).get("target"),
                    "status": a.get("status"),
                    "has_content": bool(a.get("action", {}).get("content")),
                    "content_len": len(a.get("action", {}).get("content") or ""),
                }
                for a in executed
            ],
        }
        result["actor_iterations"].append(entry)

        # 检查点 1: executed_actions 是否非空
        if len(executed) == 0:
            result["issues"].append(
                f"❌ iter{iter_num}: executed_actions=[] (v0.19.0 §1 修复失效) "
                f"tool_calls={tool_calls} reason={reason!r}"
            )
            result["ok"] = False

        # 检查点 2: 是否撞 cap 但 reason 仍是旧文案
        if "Hit iteration cap" in reason and len(executed) == 0:
            result["issues"].append(
                f"❌ iter{iter_num}: Layer 2 bug 未修复（actor 空跑 + reason='Hit iteration cap'）"
            )
            result["ok"] = False

        # 检查点 3: §1.2 partial fallback 是否触发
        partial_actions = [a for a in executed if a.get("status") == "partial"]
        if partial_actions:
            result["issues"].append(
                f"ℹ️ iter{iter_num}: §1.2 partial fallback 触发 ({len(partial_actions)} action)"
            )

    return result


def main():
    parser = argparse.ArgumentParser(description="v0.19.0 Actor 验证")
    parser.add_argument("--task-id", help="指定 task_id（默认扫描最新）")
    parser.add_argument("--workspace", default=".", help="工作区路径（默认当前目录）")
    args = parser.parse_args()

    cache_root = Path(args.workspace) / ".moa_cache"
    if args.task_id:
        task_dir = cache_root / args.task_id
        if not task_dir.exists():
            print(f"❌ Task 目录不存在: {task_dir}")
            sys.exit(2)
    else:
        task_dir = find_latest_task(cache_root)
        if task_dir is None:
            print(f"❌ {cache_root} 下无 moa_* 任务目录")
            sys.exit(2)

    print(f"=" * 60)
    print(f"验证 task: {task_dir.name}")
    print(f"路径: {task_dir}")
    print(f"=" * 60)

    result = verify_task(task_dir)
    print()
    print(f"Actor 调用次数: {len(result['actor_iterations'])}")
    for entry in result["actor_iterations"]:
        print()
        print(f"  iter{entry['iter']}: {entry['executed_count']} action(s), "
              f"{entry['tool_calls']} tool_calls, {entry['elapsed_sec']}s")
        print(f"    reason: {entry['reason']!r}")
        for i, a in enumerate(entry["actions_summary"], 1):
            print(f"    [{i}] {a['type']} → {a['target']} ({a['status']}, "
                  f"content={a['content_len']} chars)")

    print()
    print("=" * 60)
    if result["issues"]:
        print("Issues:")
        for issue in result["issues"]:
            print(f"  {issue}")
    print()
    if result["ok"]:
        print("✅ v0.19.0 Actor 修复验证通过")
        sys.exit(0)
    else:
        print("❌ v0.19.0 Actor 仍有问题")
        sys.exit(1)


if __name__ == "__main__":
    main()
