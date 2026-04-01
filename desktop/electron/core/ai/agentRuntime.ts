import { assembleRuntimeSystemPrompt } from './contextAssembler';
import { getRoleSpec } from './roleRegistry';
import { runSubagentOrchestration } from './subagentRuntime';
import { getTaskGraphRuntime } from './taskGraphRuntime';
import type {
  IntentName,
  IntentRoute,
  PreparedRuntimeExecution,
  RuntimeContext,
  RuntimeMode,
  RoleId,
  ThinkingBudget,
} from './types';

const MULTI_AGENT_TRIGGER_PARTS = [
  '多角色',
  '多智能体',
  '多 agent',
  '多agent',
  'multiagent',
  'multi-agent',
  'subagent',
  '子agent',
  '分角色',
  '协作执行',
  '多人协作',
];

const REDCLAW_MULTI_AGENT_PARTS = [
  '开始创作',
  '完整文案',
  '完整的小红书文案',
  '文案包',
  '标题包',
  '封面文案',
  '配图',
  '封面',
  '生成图片',
  '选题',
  '策划',
  '调研',
  '研究',
  '创作',
  '复盘',
  '项目',
  '方案',
];

const LONG_RUNNING_TRIGGER_PARTS = [
  '长期',
  '持续',
  '自动化',
  '定时',
  '周期',
  '每天',
  '每周',
  '30天',
  '7天',
  '项目推进',
  '后台',
  '跟进',
  '计划',
  '路线图',
];

const DANGEROUS_ACTION_PARTS = ['删除', '覆盖', '批量', '清空', '重置'];

const DEFAULT_INTENT_BY_MODE: Record<RuntimeMode, IntentRoute['intent']> = {
  redclaw: 'manuscript_creation',
  knowledge: 'knowledge_retrieval',
  chatroom: 'discussion',
  'advisor-discussion': 'discussion',
  'background-maintenance': 'automation',
};

const DEFAULT_ROLE_BY_MODE: Record<RuntimeMode, RoleId> = {
  redclaw: 'copywriter',
  knowledge: 'researcher',
  chatroom: 'planner',
  'advisor-discussion': 'planner',
  'background-maintenance': 'ops-coordinator',
};

const DEFAULT_CAPABILITIES_BY_MODE: Record<RuntimeMode, string[]> = {
  redclaw: ['planning', 'writing', 'artifact-save'],
  knowledge: ['knowledge-retrieval', 'evidence-synthesis'],
  chatroom: ['multi-agent-discussion'],
  'advisor-discussion': ['multi-agent-discussion'],
  'background-maintenance': ['task-graph', 'background-runner', 'artifact-save'],
};

const containsAny = (text: string, parts: string[]): boolean => parts.some((part) => text.includes(part));

const normalizeIntentHint = (value: unknown): IntentName | null => {
  const normalized = String(value || '').trim() as IntentName;
  if (!normalized) return null;
  if (
    normalized === 'direct_answer'
    || normalized === 'file_operation'
    || normalized === 'manuscript_creation'
    || normalized === 'image_creation'
    || normalized === 'cover_generation'
    || normalized === 'knowledge_retrieval'
    || normalized === 'long_running_task'
    || normalized === 'discussion'
    || normalized === 'memory_maintenance'
    || normalized === 'automation'
    || normalized === 'advisor_persona'
  ) {
    return normalized;
  }
  return null;
};

const extractHints = (context: RuntimeContext) => {
  const metadata = (context.metadata && typeof context.metadata === 'object')
    ? context.metadata as Record<string, unknown>
    : {};
  return {
    metadata,
    forcedIntent: normalizeIntentHint(metadata.intent),
    forceMultiAgent: Boolean(metadata.forceMultiAgent),
    forceLongRunningTask: Boolean(metadata.forceLongRunningTask),
  };
};

const inferIntent = (runtimeMode: RuntimeMode, normalizedInput: string, hints: ReturnType<typeof extractHints>): IntentName => {
  if (hints.forcedIntent) return hints.forcedIntent;
  if (runtimeMode === 'background-maintenance') return 'automation';
  if (runtimeMode === 'knowledge') return 'knowledge_retrieval';
  if (runtimeMode === 'chatroom' || runtimeMode === 'advisor-discussion') return 'discussion';
  if (runtimeMode !== 'redclaw') return DEFAULT_INTENT_BY_MODE[runtimeMode];

  if (containsAny(normalizedInput, ['角色生成', '角色文档', 'persona', '人设', '角色设定'])) {
    return 'advisor_persona';
  }
  if (containsAny(normalizedInput, ['封面'])) {
    return 'cover_generation';
  }
  if (containsAny(normalizedInput, ['配图', '生图', '图片', '海报', '视觉方案'])) {
    return 'image_creation';
  }
  if (containsAny(normalizedInput, ['自动化', '定时', '后台运行', '周期'])) {
    return 'automation';
  }
  if (containsAny(normalizedInput, ['长期', '持续推进', '路线图', '项目推进'])) {
    return 'long_running_task';
  }
  if (containsAny(normalizedInput, ['知识库', '读取素材', '阅读素材', '调研', '研究', '检索'])) {
    return 'knowledge_retrieval';
  }
  return 'manuscript_creation';
};

const inferRoleForIntent = (runtimeMode: RuntimeMode, intent: IntentName): RoleId => {
  if (runtimeMode !== 'redclaw') return DEFAULT_ROLE_BY_MODE[runtimeMode];
  switch (intent) {
    case 'cover_generation':
    case 'image_creation':
      return 'image-director';
    case 'knowledge_retrieval':
      return 'researcher';
    case 'long_running_task':
    case 'automation':
      return 'ops-coordinator';
    case 'advisor_persona':
      return 'planner';
    default:
      return 'copywriter';
  }
};

const buildDirectRoute = (context: RuntimeContext): IntentRoute => {
  const normalizedInput = String(context.userInput || '').toLowerCase();
  const runtimeMode = context.runtimeMode;
  const hints = extractHints(context);
  const intent = inferIntent(runtimeMode, normalizedInput, hints);
  const recommendedRole = inferRoleForIntent(runtimeMode, intent);
  const requiresMultiAgent = hints.forceMultiAgent
    || runtimeMode === 'advisor-discussion'
    || containsAny(normalizedInput, MULTI_AGENT_TRIGGER_PARTS)
    || (runtimeMode === 'redclaw' && containsAny(normalizedInput, REDCLAW_MULTI_AGENT_PARTS));
  const requiresLongRunningTask = hints.forceLongRunningTask
    || runtimeMode === 'background-maintenance'
    || intent === 'long_running_task'
    || intent === 'automation'
    || containsAny(normalizedInput, LONG_RUNNING_TRIGGER_PARTS);

  return {
    intent,
    secondaryIntents: [],
    goal: String(context.userInput || '').trim() || '处理当前用户请求',
    deliverables: [],
    requiredCapabilities: DEFAULT_CAPABILITIES_BY_MODE[runtimeMode],
    recommendedRole,
    requiresLongRunningTask,
    requiresMultiAgent,
    requiresHumanApproval: containsAny(normalizedInput, DANGEROUS_ACTION_PARTS),
    confidence: 1,
    reasoning: `runtime-mode-default:${runtimeMode}; intent=${intent}; role=${recommendedRole}`,
    source: 'rule',
  };
};

const resolveThinkingBudget = (runtimeMode: RuntimeMode, route: IntentRoute): ThinkingBudget => {
  if (route.requiresLongRunningTask) return 'high';
  if (route.requiresMultiAgent) return 'medium';
  if (runtimeMode === 'redclaw') return 'medium';
  if (runtimeMode === 'knowledge') return 'medium';
  if (runtimeMode === 'advisor-discussion') return 'medium';
  return 'low';
};

const shouldRunSubagentOrchestration = (params: {
  runtimeMode: RuntimeMode;
  userInput: string;
  route: IntentRoute;
}): boolean => {
  if (params.runtimeMode === 'advisor-discussion') {
    return true;
  }
  if (params.route.requiresMultiAgent || params.route.requiresLongRunningTask) {
    return true;
  }
  const normalized = String(params.userInput || '').toLowerCase();
  return containsAny(normalized, MULTI_AGENT_TRIGGER_PARTS);
};

export class AgentRuntime {
  analyzeRuntimeContext(params: { runtimeContext: RuntimeContext }) {
    const route = buildDirectRoute(params.runtimeContext);
    const role = getRoleSpec(route.recommendedRole);
    const thinkingBudget = resolveThinkingBudget(params.runtimeContext.runtimeMode, route);
    const orchestrationEnabled = shouldRunSubagentOrchestration({
      runtimeMode: params.runtimeContext.runtimeMode,
      userInput: params.runtimeContext.userInput,
      route,
    });
    return {
      route,
      role,
      thinkingBudget,
      orchestrationEnabled,
      shouldUseCoordinator: Boolean(route.requiresLongRunningTask || route.requiresMultiAgent),
    };
  }

  async prepareExecution(params: {
    runtimeContext: RuntimeContext;
    baseSystemPrompt: string;
    llm?: {
      apiKey: string;
      baseURL: string;
      model: string;
      timeoutMs?: number;
    };
  }): Promise<PreparedRuntimeExecution> {
    const analysis = this.analyzeRuntimeContext({ runtimeContext: params.runtimeContext });
    const { route, role, thinkingBudget, orchestrationEnabled } = analysis;
    const runtime = getTaskGraphRuntime();
    const task = runtime.createInteractiveTask({
      runtimeMode: params.runtimeContext.runtimeMode,
      ownerSessionId: params.runtimeContext.sessionId,
      userInput: params.runtimeContext.userInput,
      route,
      roleId: role.roleId,
      metadata: params.runtimeContext.metadata,
    });

    runtime.startNode(task.id, 'route', route.reasoning);
    runtime.completeNode(task.id, 'route', route.reasoning);
    runtime.startNode(task.id, 'plan', `role=${role.roleId}`);
    runtime.completeNode(task.id, 'plan', `role=${role.roleId}; confidence=${route.confidence}`);

    let orchestration: PreparedRuntimeExecution['orchestration'] = null;
    let orchestrationSection = '';
    console.log('[AgentRuntime] prepared-route', {
      sessionId: params.runtimeContext.sessionId,
      runtimeMode: params.runtimeContext.runtimeMode,
      intent: route.intent,
      routeSource: route.source || 'rule',
      roleId: role.roleId,
      requiresMultiAgent: route.requiresMultiAgent,
      requiresLongRunningTask: route.requiresLongRunningTask,
      orchestrationEnabled,
    });

    if (orchestrationEnabled && params.llm?.apiKey && params.llm?.baseURL && params.llm?.model) {
      try {
        runtime.addTrace(task.id, 'runtime.orchestration_start', {
          intent: route.intent,
          roleId: role.roleId,
        }, 'spawn_agents');
        const orchestrationResult = await runSubagentOrchestration({
          llm: params.llm,
          route,
          runtimeMode: params.runtimeContext.runtimeMode,
          taskId: task.id,
          userInput: params.runtimeContext.userInput,
        });
        if (orchestrationResult) {
          orchestrationSection = orchestrationResult.promptSection;
          orchestration = {
            outputs: orchestrationResult.outputs,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runtime.addTrace(task.id, 'runtime.orchestration_failed', { error: message }, 'spawn_agents');
      }
    } else if (task.graph.some((node) => node.type === 'spawn_agents')) {
      runtime.skipNode(
        task.id,
        'spawn_agents',
        orchestrationEnabled
          ? '当前未配置可用的协作 LLM，上游 orchestration 跳过'
          : '当前请求未启用 subagent orchestration',
      );
      if (task.graph.some((node) => node.type === 'handoff')) {
        runtime.skipNode(
          task.id,
          'handoff',
          orchestrationEnabled ? '未生成子角色 handoff' : '当前请求未启用 subagent handoff',
        );
      }
    }

    if (runtime.getTask(task.id)?.graph.some((node) => node.type === 'execute_tools')) {
      runtime.startNode(task.id, 'execute_tools', '准备执行主代理');
    }

    const systemPrompt = assembleRuntimeSystemPrompt({
      baseSystemPrompt: params.baseSystemPrompt,
      runtimeMode: params.runtimeContext.runtimeMode,
      route,
      role,
      task,
    });

    const systemPromptWithOrchestration = orchestrationSection
      ? `${systemPrompt}\n\n${orchestrationSection}`
      : systemPrompt;
    runtime.addTrace(task.id, 'runtime.prepared', {
      route,
      roleId: role.roleId,
      thinkingBudget,
      runtimeMode: params.runtimeContext.runtimeMode,
      orchestrationRoles: orchestration?.outputs.map((item) => item.roleId) || [],
    });

    return {
      task,
      route,
      role,
      systemPrompt: systemPromptWithOrchestration,
      thinkingBudget,
      orchestration,
    };
  }

  completeExecution(taskId: string, payload?: unknown) {
    const runtime = getTaskGraphRuntime();
    runtime.completeNode(taskId, 'execute_tools', '主代理执行完成');
    if (payload !== undefined) {
      runtime.addArtifact(taskId, {
        type: 'runtime-result',
        label: '主代理执行结果',
        metadata: payload,
      });
    }
    if (runtime.getTask(taskId)?.graph.some((node) => node.type === 'review')) {
      runtime.skipNode(taskId, 'review', '当前路径未执行独立 reviewer，默认跳过');
    }
    if (runtime.getTask(taskId)?.graph.some((node) => node.type === 'save_artifact')) {
      runtime.completeNode(taskId, 'save_artifact', '执行结果已归档');
    }
    runtime.completeTask(taskId, '运行完成');
  }

  failExecution(taskId: string, error: string) {
    getTaskGraphRuntime().failTask(taskId, error, 'execute_tools');
  }
}

let runtime: AgentRuntime | null = null;

export const getAgentRuntime = (): AgentRuntime => {
  if (!runtime) {
    runtime = new AgentRuntime();
  }
  return runtime;
};
