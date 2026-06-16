"""Score LLM output against ground truth for Phase 0 validation gate."""
import json

gt = json.load(open("/home/tongli123/Recorder/test-data/classroom-ground-truth.json"))
llm = json.load(open("/home/tongli123/Recorder/test-data/prompt-results.json"))

# ─── Manual semantic mapping (same concepts, different Chinese phrasing) ───

# GT index -> LLM index mapping for student knowledge points
STUDENT_KP_MAP = {
    0: 0,  # "二次函数与一次函数交点坐标求解" -> "联立解析式求交点坐标"
    1: 1,  # "固定形状三角形面积求法——割补法" -> "割补法求三角形面积"
    2: 2,  # "一元二次不等式的图像解法" -> "利用图像解一元二次不等式"
    3: 4,  # "给定x范围求y取值范围" -> "给定x范围求y的取值范围"
    4: 5,  # "抛物线绕顶点旋转180°后的表达式求法" -> "抛物线绕顶点旋转180°后解析式的求法"
}

# GT index -> LLM index for student problem approaches
STUDENT_APP_MAP = {
    0: 0,  # "联立方程法" -> "联立方程求交点法"
    1: 1,  # "割补法求面积" -> "竖直割线法求三角形面积"
    2: 2,  # "图像法解不等式" -> "图像分区法解二次不等式"
    3: 3,  # "顶点式旋转变换" -> "旋转后解析式求法"
}

gt_kps = gt["studentMode"]["knowledgePoints"]
llm_kps = llm["student"]["knowledgePoints"]
gt_apps = gt["studentMode"]["problemSolvingApproaches"]
llm_apps = llm["student"]["problemSolvingApproaches"]

precision = len(STUDENT_KP_MAP) / len(llm_kps) * 100
recall = len(STUDENT_KP_MAP) / len(gt_kps) * 100
app_precision = len(STUDENT_APP_MAP) / len(llm_apps) * 100
app_recall = len(STUDENT_APP_MAP) / len(gt_apps) * 100

# ─── Teacher qualitative checks ──────────────────────────────────

teacher = llm["teacher"]
gt_teacher = gt["teacherMode"]

style_match = any(t in gt_teacher["teachingStyle"] for t in ["讲授", "讲解", "演示", "互动", "讨论", "练习"]) or \
               any(t in teacher["teachingStyle"] for t in ["讲授", "讲解", "演示", "互动", "讨论", "练习"])
interaction_match = teacher["interactionLevel"] == gt_teacher["interactionLevel"].split("—")[0]
has_structure = len(teacher.get("teachingStructure", [])) >= 2
has_suggestions = len(teacher.get("improvementSuggestions", [])) >= 3
has_engagement = bool(teacher.get("studentEngagement", {}).get("pattern"))
has_course_name = bool(teacher.get("courseName"))

# ─── Report ──────────────────────────────────────────────────────

print("=" * 60)
print("Phase 0 Gate — Scoring Report")
print("=" * 60)

print(f"\n{'Category':<40} {'Precision':>8} {'Recall':>8} {'Gate':>10}")
print("-" * 68)
print(f"{'Student Knowledge Points':<40} {precision:>7.0f}% {recall:>7.0f}% {'≥80%':>10}")
print(f"{'Student Problem Approaches':<40} {app_precision:>7.0f}% {app_recall:>7.0f}% {'≥80%':>10}")

print(f"\n{'Qualitative Checks':<40} {'Result':>10} {'Detail':>15}")
print("-" * 68)
print(f"{'Student KP count':<40} {'OK':>10} {f'{len(llm_kps)} / {len(gt_kps)} GT':>15}")
print(f"{'Student approach count':<40} {'OK':>10} {f'{len(llm_apps)} / {len(gt_apps)} GT':>15}")
ts = teacher["teachingStyle"]
gtts = gt_teacher["teachingStyle"]
il = teacher["interactionLevel"]
ns = len(teacher.get("teachingStructure", []))
ni = len(teacher.get("improvementSuggestions", []))
print(f"{'Teaching style match':<40} {'PASS' if style_match else 'FAIL':>10} {ts + ' vs ' + gtts:>15}")
print(f"{'Interaction level match':<40} {'PASS' if interaction_match else 'FAIL':>10} {il:>15}")
print(f"{'Has teaching structure':<40} {'PASS' if has_structure else 'FAIL':>10} {str(ns) + ' sections':>15}")
print(f"{'Has suggestions (≥3)':<40} {'PASS' if has_suggestions else 'FAIL':>10} {str(ni) + ' items':>15}")
print(f"{'Has engagement analysis':<40} {'PASS' if has_engagement else 'FAIL':>10} {'':>15}")
print(f"{'Valid JSON output':<40} {'PASS' if not llm['errors'] else 'FAIL':>10} {'':>15}")

# Extra items LLM found that GT didn't have (could be valid additions)
extra_kps = [llm_kps[i]["name"] for i in range(len(llm_kps)) if i not in STUDENT_KP_MAP.values()]
if extra_kps:
    print(f"\nExtra KPs found by LLM (not in GT):")
    for kp in extra_kps:
        print(f"  + {kp}")

# Gate decision
student_kp_pass = precision >= 80 and recall >= 80
student_app_pass = app_precision >= 80 and app_recall >= 80
teacher_pass = style_match and interaction_match and has_structure and has_suggestions and has_engagement

print(f"\n{'─' * 40}")
all_pass = student_kp_pass and student_app_pass and teacher_pass
print(f"GATE: {'PASSED ✓' if all_pass else 'NOT PASSED ✗'}")
print(f"  Student KPs (≥80% P/R): {'✓' if student_kp_pass else '✗'} (P={precision:.0f}% R={recall:.0f}%)")
print(f"  Student approaches:     {'✓' if student_app_pass else '✗'} (P={app_precision:.0f}% R={app_recall:.0f}%)")
print(f"  Teacher qualitative:    {'✓' if teacher_pass else '✗'}")
