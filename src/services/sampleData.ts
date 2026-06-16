import type { SessionMode, StudentSummary, TeacherSummary, MeetingSummary } from "../types";

const SAMPLE_STUDENT: StudentSummary = {
  courseName: "初中数学 · 二次函数压轴题",
  topic: "二次函数与一次函数综合基础",
  knowledgePoints: [
    {
      id: "1",
      name: "联立解析式求交点坐标",
      description: "将二次函数与一次函数解析式联立，解方程组求交点",
      category: "函数图像交点",
      masteryHint: "熟练解二元二次方程组，注意代入检验",
    },
    {
      id: "2",
      name: "割补法求三角形面积",
      description: "当三角形顶点坐标已知时，通过竖直线段分割为两个小三角形分别求面积",
      category: "面积问题",
      masteryHint: "优先选择使计算简单的分割方式，注意高要取绝对值",
    },
    {
      id: "3",
      name: "利用图像解一元二次不等式",
      description: "将不等式两边看作两个函数，找出交点后分区比较图像高低",
      category: "不等式",
      masteryHint: "分清不等式表示的是上方还是下方，注意端点是否取等",
    },
    {
      id: "4",
      name: "抛物线绕顶点旋转180°后的表达式求法",
      description: "绕顶点旋转180°后顶点不变，开口方向相反，a变为原来的相反数",
      category: "几何变换",
      masteryHint: "用顶点式 y=a(x-h)²+k 写出新表达式，a 变号即可",
    },
  ],
  problemSolvingApproaches: [
    {
      id: "1",
      approach: "联立方程求交点",
      usedFor: ["求两个函数图像的交点坐标"],
      procedure: "1. 写出两个函数解析式 2. 联立消去y 3. 解方程求x 4. 代回求y 5. 写出交点坐标",
    },
    {
      id: "2",
      approach: "竖直割线法求面积",
      usedFor: ["顶点坐标已知的三角形面积"],
      procedure: "1. 过中间顶点作y轴平行线 2. 计算交点和底长 3. 分别求两个小三角形面积 4. 求和",
    },
    {
      id: "3",
      approach: "图像分区法解不等式",
      usedFor: ["一元二次不等式"],
      procedure: "1. 找交点横坐标 2. 过交点作竖直线分区域 3. 判断各区域是否满足不等关系 4. 写出x范围",
    },
  ],
  interLessonConnections: [
    {
      id: "1",
      connection: "一次函数到二次函数的综合应用",
      description: "本课大量使用一次函数知识，是七八年级内容的综合提升",
      relatedTopic: "一次函数与二次函数综合",
    },
    {
      id: "2",
      connection: "从解方程到解不等式的图像化思维",
      description: "联立方程求交点 → 图像法解不等式，建立函数图像的直观理解",
      relatedTopic: "方程与不等式",
    },
  ],
};

const SAMPLE_TEACHER: TeacherSummary = {
  ...SAMPLE_STUDENT,
  teachingStyle: "讲授型 · 例题演示",
  interactionLevel: "低",
  teachingStructure: [
    { section: "导入", description: "强调压轴题重要性，建立学习动机", durationHint: "~1分钟" },
    { section: "例题1 交点+面积", description: "联立求交点 → 割补法求面积 → 图像法解不等式", durationHint: "~4分钟" },
    { section: "例题2 参数+旋转", description: "待定系数求参数 → 给定x求y范围 → 绕顶点旋转180°", durationHint: "~4分钟" },
  ],
  questionTypes: [
    {
      type: "引导式自问自答",
      count: 8,
      examples: ["那怎麼結合圖像呢", "請問你能不能把表達式給寫出來"],
      quality: "以自问自答引导解题思路，但未激发深层思考",
    },
  ],
  studentEngagement: {
    pattern: "教师全程讲授，无学生应答或互动，属单向输入模式",
    highlights: [],
    concerns: ["缺乏学生思维过程检查", "长时间单向讲解易分散注意力", "无法判断学生是否真正理解"],
  },
  improvementSuggestions: [
    "在关键步骤后插入停顿，让学生尝试计算",
    "增加递进式提问，如'为什么选择这条线分割'",
    "补充即时变式练习，检验知识迁移",
    "对知识点总结可引导学生自行归纳",
  ],
};

const SAMPLE_MEETING: MeetingSummary = {
  title: "Q2 产品评审会",
  date: new Date().toISOString().slice(0, 10),
  attendees: ["张三", "李四", "王五"],
  decisions: [
    { id: "1", content: "Q2 上线日期推迟到 7 月 15 日", context: "移动端适配工作量超出预期，需要额外两周" },
    { id: "2", content: "采用渐进式上线策略", context: "先在内部灰度一周，再全量发布" },
  ],
  actionItems: [
    { id: "1", content: "完成 iOS 端测试", assignee: "张三", deadline: "7月8日" },
    { id: "2", content: "更新上线文档", assignee: "李四", deadline: "7月10日" },
    { id: "3", content: "准备回滚方案", assignee: "王五", deadline: "7月12日" },
  ],
  problems: ["移动端 ScrollView 性能问题", "第三方登录 SDK 兼容性"],
  goals: ["确定 Q2 上线时间线", "明确风险预案"],
  keyPoints: ["移动端需额外两周适配", "灰度发布降低风险", "每个阶段都要有回滚方案"],
};

export function getSampleSummary(mode: SessionMode): StudentSummary | TeacherSummary | MeetingSummary {
  switch (mode) {
    case "classroom-student":
      return SAMPLE_STUDENT;
    case "classroom-teacher":
      return SAMPLE_TEACHER;
    case "meeting-organizer":
    case "meeting-attendee":
      return SAMPLE_MEETING;
  }
}
