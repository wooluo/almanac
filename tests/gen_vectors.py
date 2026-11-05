# -*- coding: utf-8 -*-
"""生成 Python↔JS 引擎一致性向量（vectors.json，不入库）。

覆盖：2025-2027 每周抽样 + 全部节气交节日±1 + 锚点邻域 + 整月网格 + 择吉结果，
供 test_engine.js 逐字段比对 JS 引擎输出。
运行：python3 tests/gen_vectors.py && node tests/test_engine.js
"""
import json
import os
import sys
from datetime import date, timedelta

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)
import almanac as A

TZ = 8.0


def ymd_range(d0, d1, step=1):
    d = d0
    while d <= d1:
        yield d
        d += timedelta(days=step)


def build_vectors():
    dates = []
    seen = set()

    def add(d):
        if d not in seen:
            seen.add(d)
            dates.append(d)

    # 1) 每周抽样（2025-2027 三年）
    for d in ymd_range(date(2025, 1, 1), date(2027, 12, 31), 7):
        add(d)
    # 2) 2025-12 ~ 2027-02 所有节气交节日 ±1
    for year in (2025, 2026, 2027):
        for t in A.year_terms(year, TZ):
            td = date(*t["date"])
            if date(2025, 12, 1) <= td <= date(2027, 2, 28):
                for off in (-1, 0, 1):
                    add(td + timedelta(days=off))
    # 3) 锚点与年柱切换邻域
    for d in ymd_range(date(2026, 11, 1), date(2026, 11, 15)):
        add(d)
    for d in ymd_range(date(2026, 1, 30), date(2026, 2, 8)):
        add(d)
    dates.sort()

    days = []
    for d in dates:
        day = A.build_day(d.year, d.month, d.day, TZ)
        days.append({"ymd": [d.year, d.month, d.day], "day": day,
                     "text": A.almanac_text(day)})

    # 4) 整月网格（跨闰年 2 月/大小月/年界）
    grids = {}
    for (y, m) in [(2027, 2), (2026, 12), (2026, 1), (2028, 2)]:
        grids["%04d-%02d" % (y, m)] = [
            {"ymd": [d["y"], d["m"], d["d"]], "grade": A.day_grade(d)}
            for d in A.month_grid(y, m, TZ)
        ]

    # 5) 择吉（含生肖过滤与黄道约束）
    picks = {
        "marry_zodiac_wu": A.pick_days((2026, 11, 5), 90, "marry", "午", TZ),
        "travel_zodiac_zi": A.pick_days((2026, 11, 5), 90, "travel", "子", TZ),
        "csection": A.pick_days((2026, 11, 5), 90, "csection", None, TZ),
    }

    return {"tz": TZ, "days": days, "grids": grids, "picks": picks}


if __name__ == "__main__":
    vec = build_vectors()
    out = os.path.join(BASE, "tests", "vectors.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(vec, f, ensure_ascii=False, indent=0)
    print("已生成 %s：%d 天向量，%d 个月网格，%d 组择吉"
          % (out, len(vec["days"]), len(vec["grids"]), len(vec["picks"])))
