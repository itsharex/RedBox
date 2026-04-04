import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Timeline } from '@xzdarcy/react-timeline-editor';
import './editable-track-timeline.css';

type TimelineClipSummary = {
    assetId?: unknown;
    name?: unknown;
    track?: unknown;
    order?: unknown;
    durationMs?: unknown;
    trimInMs?: unknown;
    trimOutMs?: unknown;
    enabled?: unknown;
    assetKind?: unknown;
};

type TimelineActionShape = {
    id: string;
    start: number;
    end: number;
    effectId: string;
    selected?: boolean;
    flexible?: boolean;
    movable?: boolean;
    disable?: boolean;
};

type TimelineRowShape = {
    id: string;
    actions: TimelineActionShape[];
    rowHeight?: number;
};

type EditableTrackTimelineProps = {
    filePath: string;
    clips: Array<Record<string, unknown>>;
    fallbackTracks: string[];
    accent?: 'cyan' | 'emerald';
    emptyLabel?: string;
    onPackageStateChange?: (state: Record<string, unknown>) => void;
};

const DEFAULT_CLIP_MS = 4000;
const MIN_CLIP_MS = 1000;

const TIMELINE_EFFECTS = {
    video: { id: 'video', name: 'Video' },
    audio: { id: 'audio', name: 'Audio' },
    image: { id: 'image', name: 'Image' },
    default: { id: 'default', name: 'Clip' },
} as const;

function normalizeNumber(input: unknown, fallback = 0): number {
    const value = typeof input === 'number' ? input : Number(input);
    return Number.isFinite(value) ? value : fallback;
}

function normalizeTrackNames(clips: TimelineClipSummary[], fallbackTracks: string[]): string[] {
    const ordered = new Set<string>();
    fallbackTracks.filter(Boolean).forEach((item) => ordered.add(item));
    clips.forEach((clip) => {
        const track = String(clip.track || '').trim();
        if (track) ordered.add(track);
    });
    return ordered.size > 0 ? Array.from(ordered) : ['V1'];
}

function clipVisibleDurationMs(clip: TimelineClipSummary): number {
    const durationMs = normalizeNumber(clip.durationMs, 0);
    if (durationMs > 0) return Math.max(MIN_CLIP_MS, durationMs);
    return DEFAULT_CLIP_MS;
}

function getEffectId(assetKind: unknown): string {
    const normalized = String(assetKind || '').trim().toLowerCase();
    if (normalized === 'video') return 'video';
    if (normalized === 'audio') return 'audio';
    if (normalized === 'image') return 'image';
    return 'default';
}

function buildTimelineRows(clips: TimelineClipSummary[], fallbackTracks: string[]): TimelineRowShape[] {
    const trackNames = normalizeTrackNames(clips, fallbackTracks);
    return trackNames.map((trackName) => {
        const trackClips = clips
            .filter((item) => String(item.track || '').trim() === trackName)
            .sort((a, b) => normalizeNumber(a.order, 0) - normalizeNumber(b.order, 0));

        let cursorSeconds = 0;
        const actions = trackClips.map((clip, index) => {
            const durationSeconds = clipVisibleDurationMs(clip) / 1000;
            const id = String(clip.assetId || `${trackName}-${index}`).trim();
            const action: TimelineActionShape = {
                id,
                start: cursorSeconds,
                end: cursorSeconds + durationSeconds,
                effectId: getEffectId(clip.assetKind),
                movable: true,
                flexible: true,
                disable: clip.enabled === false,
            };
            cursorSeconds = action.end;
            return action;
        });

        return {
            id: trackName,
            rowHeight: 64,
            actions,
        };
    });
}

function serializeRows(rows: TimelineRowShape[]): string {
    return JSON.stringify(rows.map((row) => ({
        id: row.id,
        actions: row.actions.map((action) => ({
            id: action.id,
            start: Number(action.start.toFixed(3)),
            end: Number(action.end.toFixed(3)),
            disable: !!action.disable,
            effectId: action.effectId,
        })),
    })));
}

function formatSeconds(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
    const totalSeconds = Math.round(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainSeconds = totalSeconds % 60;
    return `${minutes}:${String(remainSeconds).padStart(2, '0')}`;
}

function cloneRows(rows: TimelineRowShape[]): TimelineRowShape[] {
    return rows.map((row) => ({
        ...row,
        actions: row.actions.map((action) => ({ ...action })),
    }));
}

export function EditableTrackTimeline({
    filePath,
    clips,
    fallbackTracks,
    accent = 'cyan',
    emptyLabel = '拖入素材到时间轴开始剪辑',
    onPackageStateChange,
}: EditableTrackTimelineProps) {
    const normalizedClips = useMemo(() => clips.map((item) => item as TimelineClipSummary), [clips]);
    const externalRows = useMemo(
        () => buildTimelineRows(normalizedClips, fallbackTracks),
        [fallbackTracks, normalizedClips]
    );
    const externalSignature = useMemo(() => serializeRows(externalRows), [externalRows]);
    const [editorRows, setEditorRows] = useState<TimelineRowShape[]>(externalRows);
    const [isPersisting, setIsPersisting] = useState(false);

    const clipByAssetId = useMemo(() => {
        const entries = normalizedClips
            .map((clip) => [String(clip.assetId || '').trim(), clip] as const)
            .filter(([assetId]) => Boolean(assetId));
        return new Map(entries);
    }, [normalizedClips]);

    useEffect(() => {
        setEditorRows(externalRows);
    }, [externalRows, externalSignature]);

    const persistRows = useCallback(async (rowsToPersist: TimelineRowShape[]) => {
        if (!filePath) return;
        setIsPersisting(true);
        try {
            let latestState: Record<string, unknown> | null = null;
            for (const row of rowsToPersist) {
                const orderedActions = [...row.actions].sort((a, b) => a.start - b.start);
                for (let index = 0; index < orderedActions.length; index += 1) {
                    const action = orderedActions[index];
                    const originalClip = clipByAssetId.get(action.id);
                    if (!originalClip) continue;
                    const nextDurationMs = Math.max(
                        MIN_CLIP_MS,
                        Math.round(Math.max(0.1, action.end - action.start) * 1000)
                    );
                    const result = await window.ipcRenderer.invoke('manuscripts:update-package-clip', {
                        filePath,
                        assetId: action.id,
                        track: row.id,
                        order: index,
                        durationMs: nextDurationMs,
                        trimInMs: normalizeNumber(originalClip.trimInMs, 0),
                        trimOutMs: normalizeNumber(originalClip.trimOutMs, 0),
                        enabled: action.disable !== true,
                    }) as { success?: boolean; state?: Record<string, unknown> };
                    if (result?.success && result.state) {
                        latestState = result.state;
                    }
                }
            }
            if (latestState) {
                onPackageStateChange?.(latestState);
            }
        } catch (error) {
            console.error('Failed to persist timeline rows:', error);
        } finally {
            setIsPersisting(false);
        }
    }, [clipByAssetId, filePath, onPackageStateChange]);

    useEffect(() => {
        const currentSignature = serializeRows(editorRows);
        if (currentSignature === externalSignature) return;
        const timer = window.setTimeout(() => {
            void persistRows(editorRows);
        }, 220);
        return () => window.clearTimeout(timer);
    }, [editorRows, externalSignature, persistRows]);

    return (
        <div className={clsx('redbox-editable-timeline', accent === 'emerald' ? 'redbox-editable-timeline--emerald' : 'redbox-editable-timeline--cyan')}>
            <div className="redbox-editable-timeline__toolbar">
                <div className="redbox-editable-timeline__toolbar-label">时间轴</div>
                <div className="redbox-editable-timeline__toolbar-meta">
                    <span>{normalizedClips.length} 个片段</span>
                    <span>{editorRows.length} 条轨道</span>
                    <span>{isPersisting ? '保存中…' : '已同步'}</span>
                </div>
            </div>
            <div className="redbox-editable-timeline__body">
                <Timeline
                    style={{ width: '100%', height: '100%' }}
                    editorData={editorRows as any}
                    effects={TIMELINE_EFFECTS as any}
                    scale={1}
                    scaleSplitCount={4}
                    scaleWidth={72}
                    startLeft={60}
                    rowHeight={64}
                    gridSnap={true}
                    dragLine={true}
                    enableRowDrag={false}
                    autoScroll={true}
                    onChange={(nextRows) => {
                        setEditorRows(cloneRows(nextRows as TimelineRowShape[]));
                    }}
                    getScaleRender={(scale) => (
                        <div className="redbox-editable-timeline__scale-label">{formatSeconds(Number(scale || 0))}</div>
                    )}
                    getActionRender={(action) => {
                        const clip = clipByAssetId.get(String(action.id || '').trim());
                        const visibleDurationSeconds = Math.max(0.1, Number(action.end || 0) - Number(action.start || 0));
                        const kind = String(clip?.assetKind || '').trim().toLowerCase();
                        const typeLabel = kind === 'audio' ? '音频' : kind === 'image' ? '图片' : kind === 'video' ? '视频' : '片段';
                        return (
                            <div className="redbox-editable-timeline__clip">
                                <div className="redbox-editable-timeline__clip-title">
                                    {String(clip?.name || action.id || '片段')}
                                </div>
                                <div className="redbox-editable-timeline__clip-meta">
                                    <span>{typeLabel}</span>
                                    <span>{formatSeconds(visibleDurationSeconds)}</span>
                                    {action.disable ? <span>禁用</span> : null}
                                </div>
                            </div>
                        );
                    }}
                />
                {normalizedClips.length === 0 ? (
                    <div className="redbox-editable-timeline__empty">
                        <div className="redbox-editable-timeline__empty-title">{emptyLabel}</div>
                        <div className="redbox-editable-timeline__empty-subtitle">先在上方素材区关联视频、音频或关键帧，再开始拖拽排布。</div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
