import { Check, FolderOpen, Pencil, Plus, RefreshCw } from 'lucide-react';
import clsx from 'clsx';

export interface WorkspaceSpace {
    id: string;
    name: string;
}

interface ProjectSettingsSectionProps {
    spaces: WorkspaceSpace[];
    activeSpaceId: string;
    workspaceRoot: string;
    isLoading: boolean;
    isSwitching: boolean;
    onRefresh: () => void;
    onCreate: () => void;
    onRename: (space: WorkspaceSpace) => void;
    onSwitch: (spaceId: string) => void;
}

export function ProjectSettingsSection({
    spaces,
    activeSpaceId,
    workspaceRoot,
    isLoading,
    isSwitching,
    onRefresh,
    onCreate,
    onRename,
    onSwitch,
}: ProjectSettingsSectionProps) {
    const activeSpace = spaces.find((space) => space.id === activeSpaceId) || null;

    return (
        <section className="space-y-6">
            <div className="space-y-2">
                <h2 className="text-lg font-medium text-text-primary">项目与空间</h2>
                <p className="text-sm leading-6 text-text-secondary">
                    每个项目对应一个独立工作空间。微信、飞书等后台机器人会按空间隔离运行，不会跨项目串用资产、记忆和任务。
                </p>
            </div>

            <div className="rounded-2xl border border-border bg-surface-secondary/20 p-5">
                <div className="text-[11px] uppercase tracking-[0.18em] text-text-tertiary">当前项目</div>
                <div className="mt-3 flex items-center gap-3">
                    <div className="h-11 w-11 rounded-2xl bg-surface-primary text-accent-primary inline-flex items-center justify-center shadow-sm">
                        <FolderOpen className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                        <div className="text-base font-semibold text-text-primary truncate">
                            {activeSpace?.name || '未选择项目'}
                        </div>
                        <div className="mt-1 text-xs text-text-tertiary truncate">
                            {workspaceRoot || '当前工作区路径由应用管理'}
                        </div>
                    </div>
                </div>
                <div className="mt-4 rounded-xl border border-border bg-surface-primary/70 px-4 py-3 text-xs leading-6 text-text-secondary">
                    切换项目后应用会刷新，新的知识库、草稿、任务和机器人上下文会全部切到对应空间。
                </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <div className="text-sm font-medium text-text-primary">项目列表</div>
                    <div className="mt-1 text-xs text-text-tertiary">创建、重命名或切换当前使用的项目空间。</div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={onRefresh}
                        disabled={isLoading || isSwitching}
                        className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-text-secondary hover:bg-surface-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                    >
                        <RefreshCw className={clsx('w-3.5 h-3.5', isLoading && 'animate-spin')} />
                        刷新
                    </button>
                    <button
                        type="button"
                        onClick={onCreate}
                        disabled={isSwitching}
                        className="inline-flex items-center gap-2 rounded-lg bg-accent-primary px-3 py-2 text-xs font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        新建项目
                    </button>
                </div>
            </div>

            <div className="space-y-3">
                {spaces.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-border px-4 py-6 text-sm text-text-tertiary">
                        还没有可用项目，先创建一个新的空间。
                    </div>
                ) : (
                    spaces.map((space) => {
                        const isActive = space.id === activeSpaceId;
                        return (
                            <div
                                key={space.id}
                                className={clsx(
                                    'rounded-2xl border px-4 py-4 transition-colors',
                                    isActive
                                        ? 'border-accent-primary/30 bg-accent-primary/5'
                                        : 'border-border bg-surface-secondary/15'
                                )}
                            >
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <div className="text-sm font-medium text-text-primary truncate">{space.name}</div>
                                            {isActive && (
                                                <span className="inline-flex items-center gap-1 rounded-full border border-accent-primary/20 bg-accent-primary/10 px-2 py-0.5 text-[10px] font-medium text-accent-primary">
                                                    <Check className="w-3 h-3" />
                                                    当前项目
                                                </span>
                                            )}
                                        </div>
                                        <div className="mt-1 text-[11px] text-text-tertiary font-mono">{space.id}</div>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {!isActive && (
                                            <button
                                                type="button"
                                                onClick={() => onSwitch(space.id)}
                                                disabled={isSwitching}
                                                className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-primary hover:text-text-primary transition-colors disabled:opacity-50"
                                            >
                                                切换到这里
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => onRename(space)}
                                            disabled={isSwitching}
                                            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-primary hover:text-text-primary transition-colors disabled:opacity-50"
                                        >
                                            <Pencil className="w-3.5 h-3.5" />
                                            重命名
                                        </button>
                                    </div>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>
        </section>
    );
}
