export const LOCALE_NAMESPACE = "dsh-codex-app-provider";

export const zh = {
  childLoading: "正在打开子代理…", childUnavailable: "子代理会话不可用", openMain: "在主区域打开",
  executionStopRequested: "已请求停止，执行终态待确认", executionUnknown: "执行状态未知", reasoningSummary: "推理摘要", executionInterrupted: "已中断",
  execution: "Codex 执行", files: "文件修改", search: "网页搜索", compaction: "上下文压缩",
  executing: "正在执行", executed: "已执行", executionFailed: "执行失败", exitCode: "退出状态",
  childStop: "停止", childPositionSidebar: "右侧栏", childApprovalWaiting: "有原生审批等待处理", childLoadEarlier: "加载更早记录",
  childEmpty: "暂无记录", childPrompt: "向子会话发送", childSend: "发送", childSteer: "插入当前步骤",
  childQueue: "排队下一轮", childReload: "重载", childExecuted: "已执行", childOpen: "打开子会话",
  roleUser: "用户", roleAssistant: "助手", roleTool: "工具", roleApproval: "审批",
  childAllow: "允许一次", childDeny: "拒绝", childOneShot: "一次性子会话：只读", childParentUnavailable: "父会话不可用：只读", childQuestion: "原生提问", childAnswer: "回答", childSendAnswer: "提交回答",
};
export const en: Record<keyof typeof zh, string> = {
  childLoading: "Opening child…", childUnavailable: "Child conversation unavailable", openMain: "Open in main area",
  executionStopRequested: "Stop requested; execution outcome unconfirmed", executionUnknown: "Execution state unknown", reasoningSummary: "Reasoning summary", executionInterrupted: "Interrupted",
  execution: "Codex execution", files: "File changes", search: "Web search", compaction: "Context compaction",
  executing: "Running", executed: "Executed", executionFailed: "Execution failed", exitCode: "Exit code",
  childStop: "Stop", childPositionSidebar: "right sidebar", childApprovalWaiting: "A native approval is waiting", childLoadEarlier: "Load earlier",
  childEmpty: "Nothing here yet", childPrompt: "Prompt the child", childSend: "Send", childSteer: "Steer this step",
  childQueue: "Queue next turn", childReload: "Reload", childExecuted: "Executed", childOpen: "Open child session",
  roleUser: "User", roleAssistant: "Assistant", roleTool: "Tool", roleApproval: "Approval",
  childAllow: "Allow once", childDeny: "Deny", childOneShot: "One-shot child: read-only", childParentUnavailable: "Parent unavailable: read-only", childQuestion: "Native question", childAnswer: "Answer", childSendAnswer: "Send answer",
};
