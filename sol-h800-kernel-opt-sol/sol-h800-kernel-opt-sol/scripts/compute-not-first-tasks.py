#!/usr/bin/env python3
"""Emit the subset of local kernel-opt-test task dirs where we (lichangye) are NOT
ranked #1 on the SoL-Contest-InfiniAI leaderboard.

Join key: manifest `source_dir` == leaderboard `task_id`.
Output: a comma-separated list of task_dir values for SOL_H800_TASK_BATCH, plus a
readable table on stderr.
"""
import json
import sys
from collections import defaultdict

MANIFEST = "/mnt/public/lichangye/kernel-opt-test/tasks.json"
LB = "/mnt/public/lichangye/SoL-Contest-InfiniAI/data/leaderboard/experiments.json"
USER = "lichangye"

man = json.load(open(MANIFEST))
tasks = man if isinstance(man, list) else man.get("tasks", [])

exp = json.load(open(LB))
best = defaultdict(lambda: (None, -1.0))  # task_id -> (user, geomean_speedup)
ours = defaultdict(lambda: -1.0)
for e in exp:
    s = e.get("geomean_speedup")
    if not isinstance(s, (int, float)) or s <= 0:
        continue
    tid = e["task_id"]
    if s > best[tid][1]:
        best[tid] = (e["user"], s)
    if e["user"] == USER and s > ours[tid]:
        ours[tid] = s

not_first = []
rows = []
for t in tasks:
    src = t.get("source_dir", "")
    tdir = t.get("task_dir", "")
    bu, bs = best.get(src, (None, -1.0))
    is_first = bu == USER
    if not is_first:
        not_first.append(tdir)
    rows.append((t.get("order"), src, tdir, is_first, bu, bs, ours.get(src, -1.0)))

# stderr: readable table
print(f"{'ord':>3}  {'source_dir':44} {'#1?':4} {'best_user':14} {'best':>9} {'ours':>9}", file=sys.stderr)
for o, src, tdir, isf, bu, bs, os_ in sorted(rows, key=lambda r: r[0] or 0):
    flag = "YES" if isf else "no"
    print(f"{o:>3}  {src[:44]:44} {flag:4} {str(bu)[:14]:14} {bs:9.3f} {(os_ if os_>0 else 0):9.3f}", file=sys.stderr)
print(f"\nTotal local tasks: {len(tasks)}  |  NOT #1: {len(not_first)}", file=sys.stderr)

# stdout: comma-separated task_dir list for SOL_H800_TASK_BATCH
print(",".join(not_first))
