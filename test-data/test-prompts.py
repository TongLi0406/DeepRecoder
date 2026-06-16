"""Phase 0: Test LLM prompts against ground truth transcript."""
import json, os, requests, time

TRANSCRIPT = open("/home/tongli123/Recorder/test-data/classroom-transcript.txt").read()

API_URL = "https://api.deepseek.com/anthropic/v1/messages"
HEADERS = {
    "Authorization": f"Bearer {os.environ['ANTHROPIC_AUTH_TOKEN']}",
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01"
}

def call_llm(system_prompt, user_content, max_tokens=4096):
    body = {
        "model": "deepseek-v4-pro",
        "max_tokens": max_tokens,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_content}]
    }
    r = requests.post(API_URL, headers=HEADERS, json=body, timeout=120)
    r.raise_for_status()
    data = r.json()
    for block in data["content"]:
        if block["type"] == "text":
            return block["text"]
    raise ValueError(f"No text block in response: {data}")

# ─── Prompt Templates ─────────────────────────────────────────────

STUDENT_SYSTEM = """你是学习分析助手。分析课堂录音转写，输出结构化 JSON。

输出格式（严格输出以下 JSON，不要其他内容）：
{
  "courseName": "课程名称",
  "topic": "本节课主题",
  "knowledgePoints": [
    {"name": "知识点名称", "description": "详细解释", "category": "分类", "masteryHint": "掌握建议"}
  ],
  "problemSolvingApproaches": [
    {"approach": "方法名", "usedFor": ["适用场景"], "procedure": "具体步骤"}
  ],
  "interLessonConnections": [
    {"connection": "关联名", "description": "关联说明", "relatedTopic": "关联主题"}
  ]
}

规则：
- knowledgePoints 覆盖每一个独立的知识点
- problemSolvingApproaches 覆盖解题思路和方法，procedure 要具体可操作
- interLessonConnections 指出本节课与前置/后续课程的联系
- 所有字段用中文"""

TEACHER_SYSTEM = """你是课堂教学分析助手。分析课堂录音转写，从教师视角输出结构化 JSON。

输出格式（严格输出以下 JSON，不要其他内容）：
{
  "courseName": "课程名称",
  "topic": "本节课主题",
  "teachingStyle": "讲授型/互动型/讨论型/练习型",
  "interactionLevel": "高/中/低",
  "teachingStructure": [
    {"section": "环节名称", "description": "内容描述", "durationHint": "时长估计"}
  ],
  "questionTypes": [
    {"type": "问题类型", "count": 数字, "examples": ["示例问题"], "quality": "评价"}
  ],
  "studentEngagement": {
    "pattern": "参与模式描述",
    "highlights": ["亮点"],
    "concerns": ["需要关注的问题"]
  },
  "knowledgePoints": [
    {"name": "知识点名称", "description": "详细解释", "category": "分类", "teachingApproach": "教法说明"}
  ],
  "improvementSuggestions": ["改进建议1", "改进建议2"]
}

规则：
- teachingStyle 从学生参与度、教师语言密度、是否有互动环节判断
- questionTypes 分析教师提问的层次（事实回忆/应用/综合/开放）
- studentEngagement 从转写中推断学生参与情况
- knowledgePoints 覆盖课堂中的每个知识点，含教法说明
- improvementSuggestions 给教师可操作的教学改进建议"""

# ─── Run Tests ────────────────────────────────────────────────────

print("=" * 60)
print("Phase 0 — Prompt Validation: Classroom")
print("=" * 60)

# Test 1: Student Mode
print("\n[1/2] Testing Student Mode prompt...")
t0 = time.time()
student_raw = call_llm(STUDENT_SYSTEM, f"请分析以下课堂录音转写，输出结构化分析：\n\n{TRANSCRIPT}")
student_time = time.time() - t0
print(f"  Done in {student_time:.1f}s")

# Test 2: Teacher Mode
print("\n[2/2] Testing Teacher Mode prompt...")
t0 = time.time()
teacher_raw = call_llm(TEACHER_SYSTEM, f"请分析以下课堂录音转写，从教师视角输出结构化分析：\n\n{TRANSCRIPT}")
teacher_time = time.time() - t0
print(f"  Done in {teacher_time:.1f}s")

# ─── Parse & Save ─────────────────────────────────────────────────

results = {"student": None, "teacher": None, "errors": []}

for mode, raw in [("student", student_raw), ("teacher", teacher_raw)]:
    # Strip markdown code fences if present
    clean = raw.strip()
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[1]
        if clean.endswith("```"):
            clean = clean[:-3]
    try:
        results[mode] = json.loads(clean)
    except json.JSONDecodeError:
        # Try to extract JSON between { }
        import re
        m = re.search(r'\{[\s\S]*\}', clean)
        if m:
            try:
                results[mode] = json.loads(m.group())
            except json.JSONDecodeError as e:
                results["errors"].append(f"{mode}: {e}")
                results[mode] = {"raw": raw}
        else:
            results["errors"].append(f"{mode}: no JSON found")
            results[mode] = {"raw": raw}

with open("/home/tongli123/Recorder/test-data/prompt-results.json", "w") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)

# ─── Quick Summary ────────────────────────────────────────────────

print("\n" + "=" * 60)
print("Results Summary")
print("=" * 60)

for mode in ["student", "teacher"]:
    r = results[mode]
    if "raw" in r:
        print(f"\n{mode}: PARSE FAILED — raw output saved")
        print(f"  Raw preview: {r['raw'][:200]}...")
    else:
        print(f"\n{mode} mode:")
        if "knowledgePoints" in r:
            kps = r["knowledgePoints"]
            print(f"  Knowledge points: {len(kps)}")
            for kp in kps:
                print(f"    - {kp.get('name', '?')}")
        if "problemSolvingApproaches" in r:
            print(f"  Problem approaches: {len(r['problemSolvingApproaches'])}")
        if "teachingStyle" in r:
            print(f"  Teaching style: {r['teachingStyle']}")
        if "improvementSuggestions" in r:
            print(f"  Improvement suggestions: {len(r['improvementSuggestions'])}")

print(f"\nTiming: student={student_time:.1f}s, teacher={teacher_time:.1f}s")
print(f"Results saved to test-data/prompt-results.json")
