# 红楼梦 20-event Coverage Benchmark Report

> Generated: 2026-07-24
> Status: Pre-run (actual coverage requires running the pipeline with LLM Pass 2)

## Per-Event Checklist Overview

| Event | Title | Total Items | Required Items | Covered Items |
|-------|-------|:-----------:|:--------------:|:-------------:|
| E01 | 甄士隐梦幻识通灵 贾雨村风尘怀闺秀 | 3 | 2 | N/A |
| E02 | 葫芦庙门子献护官符 雨村徇私断薛蟠案 | 3 | 2 | N/A |
| E03 | 林黛玉抛父进京都 | 3 | 2 | N/A |
| E04 | 张太医论病细穷源 贾敬寿排家宴见熙凤 | 3 | 2 | N/A |
| E05 | 凤姐协理宁国府 | 3 | 2 | N/A |
| E06 | 刘姥姥一进荣国府 | 3 | 2 | N/A |
| E07 | 耗子精故事与李嬷嬷骂袭人 | 3 | 2 | N/A |
| E08 | 贾宝玉大醉绛芸轩 薛宝钗巧合认通灵 | 3 | 2 | N/A |
| E09 | 通灵除邪 | 3 | 2 | N/A |
| E10 | 金寡妇贪利权受辱 秦可卿病笃延名医 | 3 | 2 | N/A |
| E11 | 清虚观打醮惹烦扰 宝黛诉衷肠怒砸玉 | 3 | 2 | N/A |
| E12 | 湘云劝学惹风波，宝玉剖心定知己 | 3 | 2 | N/A |
| E13 | 宝玉挨打之后 袭人进言搬出园 | 3 | 2 | N/A |
| E14 | 林如海捐馆扬州城 贾宝玉路谒北静王 | 3 | 2 | N/A |
| E15 | 王凤姐弄权铁槛寺 秦鲸卿得趣馒头庵 | 3 | 2 | N/A |
| E16 | 刘姥姥醉闹贾府宴 | 3 | 2 | N/A |
| E17 | 闲取乐偶攒金庆寿 不了情暂撮土为香 | 3 | 2 | N/A |
| E18 | 鸳鸯抗婚诉姐妹 宝玉藏山听密语 | 3 | 2 | N/A |
| E19 | 情切切良宵花解语 意绵绵静日玉生香 | 3 | 2 | N/A |
| E20 | 王熙凤正言弹妒意 林黛玉俏语谑娇音 | 3 | 2 | N/A |

**Aggregate**: 20 events, 60 total checklist items, 40 required items.

## Per-Dimension Summary

| Dimension | Event Count | Required Count |
|-----------|:-----------:|:--------------:|
| 对话个性 | 18 | 17 |
| 心理描写 | 11 | 8 |
| 环境渲染 | 10 | 5 |
| 反讽距离 | 7 | 3 |
| 草蛇灰线 | 7 | 2 |
| 礼教规制 | 6 | 4 |
| 诗词 | 1 | 1 |
| 梦境预兆 | 0 | 0 |

## Notes

- **对话个性** appears in 18 of 20 events (17 required) — the most ubiquitous dimension.
- **诗词** and **梦境预兆** are under-represented (1 event and 0 events respectively) because the 20 events focus primarily on narrative action, not the poetry gatherings or dream sequences that are central to other chapters.
- Actual coverage metrics (covered items vs. required items) require running the S1 pipeline with an LLM Pass 2 evaluator and ChecklistValidator. Update this report after running:
  ```bash
  npx tsx packages/core/src/ai/tools/checklist-coverage.ts
  ```
  Then merge the coverage data from pipeline output into the "Covered Items" column.

## Recommendations for Coverage Improvement

1. Add dimension coverage for **诗词** by including events from the Crab Flower Club poetry society scenes.
2. Add **梦境预兆** to events dealing with supernatural or dream sequences.
3. Consider distributing **心理描写** more evenly — currently clustered in events with heavy emotional content.
