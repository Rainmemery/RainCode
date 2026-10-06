---
name: plugin-demo
description: 演示随插件分发的技能（T6.1 第三源）：引导使用 hello 插件工具完成问候与字数统计
argumentHint: "<名字>"
---
这是随 marketplace 示例插件 hello 分发的技能（安装副本 `<插件目录>/skills/` 第三源，source=plugin）。

请按以下步骤完成演示任务：
1. 调用 `plugin__hello__greet` 工具向 $ARGUMENTS 问候，原样回传问候语。
2. 对问候语调用 `plugin__hello__word_count` 统计字数，报告字符数与词数。
