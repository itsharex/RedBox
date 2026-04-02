import { getSettings } from '../db';
import { createGeneratedMediaAsset, type MediaAsset } from './mediaLibraryStore';
import { normalizeApiBaseUrl } from './urlUtils';

export interface GenerateVideosInput {
    prompt: string;
    projectId?: string;
    title?: string;
    model?: string;
    endpoint?: string;
    apiKey?: string;
    aspectRatio?: string;
    count?: number;
    durationSeconds?: number;
    resolution?: '720p' | '1080p';
    generateAudio?: boolean;
    generationMode?: 'text-to-video' | 'reference-guided' | 'first-last-frame';
    referenceImages?: string[];
}

export interface GenerateVideosResult {
    model: string;
    endpoint: string;
    provider: string;
    aspectRatio: '16:9' | '9:16';
    resolution: '720p' | '1080p';
    durationSeconds: number;
    generateAudio: boolean;
    assets: MediaAsset[];
}

const GEMINI_DEFAULT_VIDEO_MODEL = 'veo-2.0-generate-001';
const OPENAI_DEFAULT_VIDEO_MODEL = 'sora-2';
const DEFAULT_VIDEO_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_POLL_MAX_ROUNDS = 120;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOfficialGeminiEndpoint(endpoint: string): boolean {
    const normalized = normalizeApiBaseUrl(endpoint).toLowerCase();
    return normalized.includes('generativelanguage.googleapis.com')
        || normalized.includes('.googleapis.com');
}

function detectGeminiApiVersionFromEndpoint(endpoint: string): 'v1' | 'v1beta' {
    const normalized = normalizeApiBaseUrl(endpoint).toLowerCase();
    return normalized.includes('/v1') && !normalized.includes('/v1beta') ? 'v1' : 'v1beta';
}

function isOfficialOpenAiEndpoint(endpoint: string): boolean {
    const normalized = normalizeApiBaseUrl(endpoint);
    if (!normalized) return false;
    try {
        const parsed = new URL(normalized);
        return String(parsed.hostname || '').trim().toLowerCase() === 'api.openai.com';
    } catch {
        return false;
    }
}

function createOpenAiSdkClient(endpoint: string, apiKey: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OpenAI = require('openai').default;
    return new OpenAI({
        apiKey: String(apiKey || '').trim(),
        baseURL: normalizeApiBaseUrl(endpoint),
        timeout: 600000,
        maxRetries: 0,
    });
}

function normalizeVideoAspectRatio(value: string): '16:9' | '9:16' {
    return String(value || '').trim() === '9:16' ? '9:16' : '16:9';
}

function normalizeVideoResolution(value: string): '720p' | '1080p' {
    return String(value || '').trim() === '1080p' ? '1080p' : '720p';
}

function normalizeVideoDuration(value: unknown): number {
    const parsed = Math.floor(Number(value) || 8);
    return Math.max(5, Math.min(12, parsed));
}

function mapOpenAiVideoSize(
    aspectRatio: '16:9' | '9:16',
    resolution: '720p' | '1080p'
): '720x1280' | '1280x720' | '1024x1792' | '1792x1024' {
    if (aspectRatio === '9:16') {
        return resolution === '1080p' ? '1024x1792' : '720x1280';
    }
    return resolution === '1080p' ? '1792x1024' : '1280x720';
}

function mapOpenAiVideoSeconds(durationSeconds: number): '4' | '8' | '12' {
    if (durationSeconds <= 6) return '4';
    if (durationSeconds <= 10) return '8';
    return '12';
}

async function fetchGeneratedVideoBuffer(videoUrl: string, apiKey: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const attempts: Array<Record<string, string>> = [
        {},
        { 'x-goog-api-key': apiKey },
        { Authorization: `Bearer ${apiKey}` },
    ];
    let lastError = 'Failed to download generated video.';

    for (const headers of attempts) {
        try {
            const response = await fetch(videoUrl, { headers });
            if (!response.ok) {
                lastError = `下载生成视频失败 (${response.status} ${response.statusText})`;
                continue;
            }
            const mimeType = String(response.headers.get('content-type') || 'video/mp4').trim().toLowerCase() || 'video/mp4';
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length === 0) {
                lastError = '下载到的生视频内容为空。';
                continue;
            }
            return { buffer, mimeType };
        } catch (error) {
            lastError = String(error || '下载生成视频失败。');
        }
    }

    throw new Error(lastError);
}

async function downloadOpenAiVideoBuffer(client: any, videoId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const response = await client.videos.downloadContent(videoId, { variant: 'video' });
    if (!response?.ok) {
        throw new Error(`下载生成视频失败 (${response?.status || 500} ${response?.statusText || 'Unknown Error'})`);
    }
    const mimeType = String(response.headers.get('content-type') || 'video/mp4').trim().toLowerCase() || 'video/mp4';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) {
        throw new Error('下载到的生视频内容为空。');
    }
    return { buffer, mimeType };
}

async function waitForOpenAiVideo(client: any, videoId: string): Promise<any> {
    for (let round = 0; round < VIDEO_POLL_MAX_ROUNDS; round += 1) {
        const video = await client.videos.retrieve(videoId);
        if (video?.status === 'completed') {
            return video;
        }
        if (video?.status === 'failed') {
            const reason = String(video?.error?.message || video?.error?.code || 'Unknown error');
            throw new Error(`生视频任务失败：${reason}`);
        }
        await delay(VIDEO_POLL_INTERVAL_MS);
    }
    throw new Error('生视频任务超时，请稍后重试。');
}

function buildCompatibleVideoGenerationUrl(endpoint: string): string {
    const normalized = normalizeApiBaseUrl(endpoint);
    try {
        const parsed = new URL(normalized);
        const pathname = parsed.pathname.replace(/\/+$/, '');
        if (pathname.toLowerCase().endsWith('/videos/generations')) {
            return parsed.toString();
        }
        parsed.pathname = `${pathname}/videos/generations`.replace(/\/{2,}/g, '/');
        return parsed.toString();
    } catch {
        return `${normalized.replace(/\/+$/, '')}/videos/generations`;
    }
}

function extractCompatibleVideoUrls(payload: any): string[] {
    const urls: string[] = [];
    const pushUrl = (value: unknown) => {
        const text = String(value || '').trim();
        if (text && /^https?:\/\//i.test(text) && !urls.includes(text)) {
            urls.push(text);
        }
    };
    const output = payload && typeof payload === 'object' ? payload : {};
    pushUrl(output.video_url);
    pushUrl(output.video);
    pushUrl(output.url);
    const dataRows = Array.isArray(output.data) ? output.data : [];
    for (const item of dataRows) {
        if (typeof item === 'string') {
            pushUrl(item);
            continue;
        }
        if (!item || typeof item !== 'object') continue;
        pushUrl((item as Record<string, unknown>).video_url);
        pushUrl((item as Record<string, unknown>).video);
        pushUrl((item as Record<string, unknown>).url);
    }
    return urls;
}

async function generateViaOfficialOpenAiSdk(input: {
    prompt: string;
    endpoint: string;
    apiKey: string;
    model: string;
    count: number;
    aspectRatio: '16:9' | '9:16';
    resolution: '720p' | '1080p';
    durationSeconds: number;
    title?: string;
    projectId?: string;
    referenceImages?: string[];
}): Promise<GenerateVideosResult> {
    const client = createOpenAiSdkClient(input.endpoint, input.apiKey);
    const size = mapOpenAiVideoSize(input.aspectRatio, input.resolution);
    const seconds = mapOpenAiVideoSeconds(input.durationSeconds);
    const assets: MediaAsset[] = [];
    const referenceImage = Array.isArray(input.referenceImages) ? input.referenceImages[0] : undefined;
    const createBody: Record<string, unknown> = {
        model: input.model,
        prompt: input.prompt,
        size,
        seconds,
    };

    if (referenceImage) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { toFile } = require('openai');
        const base64Match = String(referenceImage).match(/^data:([^;,]+)?;base64,(.+)$/);
        if (base64Match) {
            createBody.input_reference = await toFile(
                Buffer.from(base64Match[2], 'base64'),
                'reference-image.png',
                { type: base64Match[1] || 'image/png' }
            );
        }
    }

    for (let index = 0; index < input.count; index += 1) {
        const job = await client.videos.create(createBody);
        const video = await waitForOpenAiVideo(client, job.id);
        const downloaded = await downloadOpenAiVideoBuffer(client, video.id);
        const asset = await createGeneratedMediaAsset({
            prompt: input.prompt,
            dataBuffer: downloaded.buffer,
            mimeType: downloaded.mimeType,
            projectId: input.projectId?.trim() || undefined,
            provider: input.endpoint.toLowerCase().includes('/redbox/') ? 'redbox' : 'openai-compatible',
            model: input.model,
            aspectRatio: input.aspectRatio,
            size: input.resolution,
            quality: `${input.durationSeconds}s`,
            title: input.title?.trim() || undefined,
        });
        assets.push(asset);
    }

    if (!assets.length) {
        throw new Error('生视频任务已完成，但没有可保存的视频文件。');
    }

    return {
        model: input.model,
        endpoint: input.endpoint,
        provider: 'openai',
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        durationSeconds: input.durationSeconds,
        generateAudio: false,
        assets,
    };
}

async function generateViaOpenAiCompatibleVideoRoute(input: {
    prompt: string;
    endpoint: string;
    apiKey: string;
    model: string;
    count: number;
    aspectRatio: '16:9' | '9:16';
    resolution: '720p' | '1080p';
    durationSeconds: number;
    title?: string;
    projectId?: string;
    referenceImages?: string[];
    generationMode?: 'text-to-video' | 'reference-guided' | 'first-last-frame';
}): Promise<GenerateVideosResult> {
    const requestUrl = buildCompatibleVideoGenerationUrl(input.endpoint);
    const size = mapOpenAiVideoSize(input.aspectRatio, input.resolution);
    const seconds = mapOpenAiVideoSeconds(input.durationSeconds);
    const refs = Array.isArray(input.referenceImages) ? input.referenceImages.filter(Boolean) : [];
    const body: Record<string, unknown> = {
        model: input.model,
        prompt: input.prompt,
        size,
        seconds,
        n: input.count,
    };
    if (refs[0]) {
        body.image = refs[0];
        body.image_url = refs[0];
        body.reference_image = refs[0];
        body.img_url = refs[0];
    }
    if (refs.length > 0) {
        body.images = refs.slice(0, 2);
    }
    const response = await fetch(requestUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${input.apiKey}`,
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`生视频请求失败 (${response.status}): ${errorText || response.statusText || 'request failed'}`);
    }

    const payload = await response.json().catch(() => ({}));
    const videoUrls = extractCompatibleVideoUrls(payload);
    if (!videoUrls.length) {
        throw new Error('生视频任务已完成，但接口未返回可下载的视频地址。');
    }

    const assets: MediaAsset[] = [];
    for (const videoUrl of videoUrls.slice(0, input.count)) {
        const downloaded = await fetchGeneratedVideoBuffer(videoUrl, input.apiKey);
        const asset = await createGeneratedMediaAsset({
            prompt: input.prompt,
            dataBuffer: downloaded.buffer,
            mimeType: downloaded.mimeType,
            projectId: input.projectId?.trim() || undefined,
            provider: input.endpoint.toLowerCase().includes('/redbox/') ? 'redbox' : 'openai-compatible',
            model: input.model,
            aspectRatio: input.aspectRatio,
            size: input.resolution,
            quality: `${input.durationSeconds}s`,
            title: input.title?.trim() || undefined,
        });
        assets.push(asset);
    }

    if (!assets.length) {
        throw new Error('生视频任务已完成，但没有可保存的视频文件。');
    }

    return {
        model: input.model,
        endpoint: input.endpoint,
        provider: input.endpoint.toLowerCase().includes('/redbox/') ? 'redbox' : 'openai-compatible',
        aspectRatio: input.aspectRatio,
        resolution: input.resolution,
        durationSeconds: input.durationSeconds,
        generateAudio: false,
        assets,
    };
}

export async function generateVideosToMediaLibrary(input: GenerateVideosInput): Promise<GenerateVideosResult> {
    const prompt = String(input.prompt || '').trim();
    if (!prompt) {
        throw new Error('Prompt is required');
    }

    const settings = (getSettings() || {}) as Record<string, unknown>;
    const endpoint = normalizeApiBaseUrl(
        String(
            input.endpoint ||
            settings.video_endpoint ||
            settings.api_endpoint ||
            DEFAULT_VIDEO_ENDPOINT
        ).trim()
    );
    const apiKey = String(input.apiKey || settings.video_api_key || settings.api_key || '').trim();
    const isGeminiEndpoint = isOfficialGeminiEndpoint(endpoint);
    const model = String(
        input.model ||
        settings.video_model ||
        (isGeminiEndpoint ? GEMINI_DEFAULT_VIDEO_MODEL : OPENAI_DEFAULT_VIDEO_MODEL)
    ).trim();
    const aspectRatio = normalizeVideoAspectRatio(String(input.aspectRatio || '').trim());
    const resolution = normalizeVideoResolution(String(input.resolution || '').trim());
    const durationSeconds = normalizeVideoDuration(input.durationSeconds);
    const count = Math.max(1, Math.min(2, Number(input.count) || 1));
    const generateAudio = Boolean(input.generateAudio);
    const generationMode = String(input.generationMode || '').trim() as 'text-to-video' | 'reference-guided' | 'first-last-frame';
    const referenceImages = Array.isArray(input.referenceImages) ? input.referenceImages.filter(Boolean).slice(0, 2) : [];

    if (!endpoint) {
        throw new Error('生视频 Endpoint 未配置。请先到“设置 → AI 模型”配置生视频模型。');
    }
    if (!apiKey) {
        throw new Error('生视频 API Key 未配置。请先到“设置 → AI 模型”配置生视频模型。');
    }
    if (!model) {
        throw new Error('生视频模型未配置。请先到“设置 → AI 模型”选择生视频模型。');
    }
    if (generationMode === 'reference-guided' && referenceImages.length < 1) {
        throw new Error('参考图视频模式至少需要 1 张参考图。');
    }
    if (generationMode === 'first-last-frame' && referenceImages.length < 2) {
        throw new Error('首尾帧视频模式需要 2 张参考图。');
    }

    if (!isGeminiEndpoint) {
        const commonInput = {
            prompt,
            endpoint,
            apiKey,
            model,
            count,
            aspectRatio,
            resolution,
            durationSeconds,
            title: input.title,
            projectId: input.projectId,
            referenceImages,
            generationMode,
        };
        if (isOfficialOpenAiEndpoint(endpoint)) {
            if (generationMode === 'first-last-frame') {
                throw new Error('当前 OpenAI 官方视频 SDK 仅支持单参考图，不支持首尾帧视频模式。请改用 RedBox/兼容视频路由。');
            }
            return generateViaOfficialOpenAiSdk(commonInput);
        }
        return generateViaOpenAiCompatibleVideoRoute(commonInput);
    }

    if (generationMode !== 'text-to-video') {
        throw new Error('当前 Gemini 官方视频链路仅支持文生视频。参考图视频和首尾帧视频请改用 OpenAI 兼容或 RedBox 官方视频路由。');
    }

    const { GoogleGenAI } = require('@google/genai');
    const client = new GoogleGenAI({
        apiKey,
        apiVersion: detectGeminiApiVersionFromEndpoint(endpoint),
        httpOptions: {
            timeout: 600000,
            retryOptions: {
                attempts: 1,
            },
            baseUrl: `${new URL(endpoint).protocol}//${new URL(endpoint).host}`,
        },
    });

    let operation = await client.models.generateVideos({
        model,
        source: {
            prompt,
        },
        config: {
            numberOfVideos: count,
            aspectRatio,
            resolution,
            durationSeconds,
            generateAudio,
        },
    });

    for (let round = 0; round < VIDEO_POLL_MAX_ROUNDS && !operation?.done; round += 1) {
        await delay(VIDEO_POLL_INTERVAL_MS);
        operation = await client.operations.getVideosOperation({ operation });
    }

    if (!operation?.done) {
        throw new Error('生视频任务超时，请稍后重试。');
    }
    if (operation.error) {
        const reason = typeof operation.error === 'string'
            ? operation.error
            : JSON.stringify(operation.error);
        throw new Error(`生视频任务失败：${reason}`);
    }

    const generatedVideos = Array.isArray(operation.response?.generatedVideos)
        ? operation.response.generatedVideos
        : [];
    if (!generatedVideos.length) {
        throw new Error('生视频任务未返回可用视频。');
    }

    const assets: MediaAsset[] = [];
    for (const item of generatedVideos.slice(0, count)) {
        const videoUrl = String(item?.video?.uri || '').trim();
        if (!videoUrl) continue;
        const downloaded = await fetchGeneratedVideoBuffer(videoUrl, apiKey);
        const asset = await createGeneratedMediaAsset({
            prompt,
            dataBuffer: downloaded.buffer,
            mimeType: downloaded.mimeType,
            projectId: input.projectId?.trim() || undefined,
            provider: 'gemini',
            model,
            aspectRatio,
            size: resolution,
            quality: `${durationSeconds}s${generateAudio ? '·audio' : ''}`,
            title: input.title?.trim() || undefined,
        });
        assets.push(asset);
    }

    if (!assets.length) {
        throw new Error('生视频任务已完成，但没有可保存的视频文件。');
    }

    return {
        model,
        endpoint,
        provider: 'gemini',
        aspectRatio,
        resolution,
        durationSeconds,
        generateAudio,
        assets,
    };
}
