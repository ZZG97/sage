---
name: health-manager
description: >
  Health record management: add medical visit records from images/text, query history, track medications and lab results.
  Use when: user provides medical images (病历, 处方, 检查报告, 化验单), says "添加看病记录", "记录一下",
  "看病", "开药", "检查结果", "查看病历", "用药记录", "健康记录", "medical record",
  or sends photos of prescriptions/lab results/medical documents.
user_invocable: true
---

# Health Manager Skill

管理个人健康档案：解析病历/处方/检查报告图片，结构化存储，支持查询和追踪。

**数据库位置：** `~/workspace/sage/data/health.db`（SQLite）
**服务层：** `~/workspace/sage/src/apps/health/service.ts`（HealthService 类，完整 CRUD）
**API 路由：** `~/workspace/sage/src/apps/health/routes.ts`（挂载在 `/apps/health/`）
**Skill 操作方式：** 通过 `sqlite3` CLI 直接读写数据库（与 service 层共享同一 SQLite 文件）

## 核心表结构

### medical_records — 看病记录主表
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增ID |
| visit_date | TEXT | 就诊日期 YYYY-MM-DD |
| hospital | TEXT | 医院 |
| department | TEXT | 科室 |
| doctor | TEXT | 医生 |
| chief_complaint | TEXT | 主诉/症状 |
| diagnosis | TEXT | 诊断 JSON array |
| medications | TEXT | 用药 JSON array: [{name, dosage, frequency, duration, notes}] |
| examinations | TEXT | 检查 JSON array: [{item, result, reference, is_abnormal}] |
| treatment | TEXT | 治疗方案 |
| doctor_advice | TEXT | 医嘱 |
| follow_up_date | TEXT | 复诊日期 |
| cost | REAL | 费用 |
| tags | TEXT | 标签 JSON array |
| attachments | TEXT | 图片路径 JSON array |
| raw_analysis | TEXT | AI原始分析 |
| summary | TEXT | 一句话摘要 |
| created_at/updated_at | TEXT | 时间戳 |

### health_metrics — 检查指标（血常规/生化等数值）
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增ID |
| record_id | INTEGER FK | 关联 medical_records |
| category | TEXT | 分类：血常规/生化/尿常规/影像 |
| metric_name | TEXT | 指标名 |
| value | TEXT | 值（含非数值如"阳性"） |
| numeric_value | REAL | 数值型值（趋势分析用） |
| unit | TEXT | 单位 |
| reference_range | TEXT | 参考范围 |
| is_abnormal | INTEGER | 0=正常 1=偏高 -1=偏低 2=异常 |
| measured_at | TEXT | 检测日期 |

### medication_history — 用药记录
| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增ID |
| record_id | INTEGER FK | 关联看病记录（可空） |
| medication_name | TEXT | 药品名 |
| generic_name | TEXT | 通用名/成分 |
| dosage | TEXT | 剂量 |
| frequency | TEXT | 频次 |
| route | TEXT | 给药途径 |
| start_date/end_date | TEXT | 用药周期 |
| is_active | INTEGER | 是否在用 |
| notes | TEXT | 备注 |

## 工作流

### 流程一：添加看病记录（从图片/文本）

**Step 1: 分析输入**
用户会发送以下内容：
- 病历照片（门诊病历本、电子病历截图）
- 处方/开药单照片
- 检查报告（血常规、生化、CT/MRI报告等）
- 文字描述

仔细阅读图片，提取所有可识别的信息。如果图片模糊或部分信息无法识别，标注"无法识别"而非猜测。

**Step 2: 结构化提取**
从图片/文本中提取：
- 基本信息：日期、医院、科室、医生
- 症状和诊断
- 用药信息：药名、剂量、用法、疗程
- 检查结果：指标名、值、参考范围、是否异常
- 医嘱和复诊安排

**Step 3: 确认并存储**
向用户展示提取结果，确认后写入数据库。

```bash
# 插入主记录
sqlite3 ~/workspace/sage/data/health.db << 'SQL'
INSERT INTO medical_records (visit_date, hospital, department, doctor, chief_complaint, diagnosis, medications, examinations, treatment, doctor_advice, follow_up_date, cost, tags, attachments, raw_analysis, summary)
VALUES ('2026-04-01', '北京大学第三医院', '呼吸内科', '张医生',
  '咳嗽一周', '["急性上呼吸道感染"]',
  '[{"name":"阿莫西林","dosage":"0.5g","frequency":"每日3次","duration":"5天"}]',
  NULL, '药物治疗', '多喝水多休息', '2026-04-08', 156.5,
  '["感冒","呼吸内科"]',
  '["/path/to/image.jpg"]',
  'AI分析原文...', '急性上呼吸道感染，开阿莫西林5天');
SQL
```

```bash
# 插入检查指标（如有）
sqlite3 ~/workspace/sage/data/health.db << 'SQL'
INSERT INTO health_metrics (record_id, category, metric_name, value, numeric_value, unit, reference_range, is_abnormal, measured_at)
VALUES (1, '血常规', '白细胞计数', '11.2', 11.2, '×10⁹/L', '3.5-9.5', 1, '2026-04-01');
SQL
```

```bash
# 插入用药记录
sqlite3 ~/workspace/sage/data/health.db << 'SQL'
INSERT INTO medication_history (record_id, medication_name, generic_name, dosage, frequency, route, start_date, end_date, is_active, notes)
VALUES (1, '阿莫西林胶囊', '阿莫西林', '0.5g', '每日3次', '口服', '2026-04-01', '2026-04-06', 1, '饭后服用');
SQL
```

**Step 4: 反馈**
告知用户记录已保存，并给出简要的健康提醒（如复诊时间、用药注意事项）。

### 流程二：查询记录

```bash
# 最近 N 条记录
sqlite3 -header -column ~/workspace/sage/data/health.db \
  "SELECT id, visit_date, hospital, department, summary FROM medical_records ORDER BY visit_date DESC LIMIT 10;"

# 按科室查
sqlite3 -header -column ~/workspace/sage/data/health.db \
  "SELECT id, visit_date, hospital, summary FROM medical_records WHERE department='呼吸内科' ORDER BY visit_date DESC;"

# 按诊断查
sqlite3 -header -column ~/workspace/sage/data/health.db \
  "SELECT id, visit_date, hospital, department, summary FROM medical_records WHERE diagnosis LIKE '%高血压%' ORDER BY visit_date DESC;"

# 按日期范围查
sqlite3 -header -column ~/workspace/sage/data/health.db \
  "SELECT id, visit_date, hospital, department, summary FROM medical_records WHERE visit_date BETWEEN '2026-01-01' AND '2026-06-30' ORDER BY visit_date DESC;"

# 查看某条记录详情
sqlite3 -json ~/workspace/sage/data/health.db \
  "SELECT * FROM medical_records WHERE id=1;"

# 查看某条记录的检查指标
sqlite3 -header -column ~/workspace/sage/data/health.db \
  "SELECT metric_name, value, unit, reference_range, CASE is_abnormal WHEN 1 THEN '↑偏高' WHEN -1 THEN '↓偏低' WHEN 2 THEN '⚠异常' ELSE '正常' END as status FROM health_metrics WHERE record_id=1;"
```

### 流程三：用药追踪

```bash
# 当前在用药物
sqlite3 -header -column ~/workspace/sage/data/health.db \
  "SELECT medication_name, dosage, frequency, route, start_date, end_date, notes FROM medication_history WHERE is_active=1;"

# 某药物用药历史
sqlite3 -header -column ~/workspace/sage/data/health.db \
  "SELECT medication_name, dosage, frequency, start_date, end_date, notes FROM medication_history WHERE medication_name LIKE '%阿莫西林%' ORDER BY start_date DESC;"

# 停用药物（疗程结束）
sqlite3 ~/workspace/sage/data/health.db \
  "UPDATE medication_history SET is_active=0 WHERE id=1;"
```

### 流程四：指标趋势

```bash
# 某指标历史变化（如血糖）
sqlite3 -header -column ~/workspace/sage/data/health.db \
  "SELECT m.measured_at, m.value, m.unit, m.reference_range, CASE m.is_abnormal WHEN 1 THEN '↑' WHEN -1 THEN '↓' WHEN 2 THEN '⚠' ELSE '✓' END as status FROM health_metrics m JOIN medical_records r ON m.record_id=r.id WHERE m.metric_name LIKE '%血糖%' ORDER BY m.measured_at;"
```

## 输出格式

查询结果用清晰的中文表格或列表展示。示例：

```
📋 最近看病记录

| 日期 | 医院 | 科室 | 摘要 |
|---|---|---|---|
| 2026-04-01 | 北医三院 | 呼吸内科 | 急性上呼吸道感染，开阿莫西林5天 |
| 2026-03-15 | 协和医院 | 皮肤科 | 湿疹，开炉甘石洗剂 |
```

## 注意事项

1. **隐私**：健康数据敏感，仅存本地 SQLite，不上传任何外部服务
2. **准确性**：图片识别结果必须让用户确认后再存储，不确定的信息标注"待确认"
3. **不做医疗建议**：只做记录整理和信息提取，不替代医生诊断
4. **用药提醒**：如果发现疗程即将结束或已结束，主动提醒用户更新用药状态
5. **JSON 字段**：diagnosis、medications、examinations、tags、attachments 都用 JSON 格式存储，查询时用 json_extract() 或 LIKE
6. **图片保存**：用户上传的医疗图片已由 Sage 自动下载到 `agent_home/workspace/uploads/images/`，直接引用该路径存入 attachments
7. **updated_at**：更新记录时手动设置 `updated_at=datetime('now','localtime')`
