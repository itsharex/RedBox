# IPC Inventory

## Frontend referenced channels

| Channel | References |
| --- | ---: |
| `advisors:changed` | 1 |
| `advisors:create` | 1 |
| `advisors:delete` | 1 |
| `advisors:delete-knowledge` | 1 |
| `advisors:download-progress` | 1 |
| `advisors:generate-persona` | 1 |
| `advisors:list` | 4 |
| `advisors:optimize-prompt` | 1 |
| `advisors:optimize-prompt-deep` | 1 |
| `advisors:select-avatar` | 1 |
| `advisors:update` | 2 |
| `advisors:upload-knowledge` | 1 |
| `app:open-release-page` | 1 |
| `app:update-available` | 1 |
| `archives:create` | 1 |
| `archives:delete` | 1 |
| `archives:list` | 1 |
| `archives:sample-created` | 1 |
| `archives:samples:create` | 1 |
| `archives:samples:delete` | 1 |
| `archives:samples:list` | 1 |
| `archives:samples:update` | 2 |
| `archives:update` | 1 |
| `assistant:daemon-log` | 1 |
| `assistant:daemon-status` | 1 |
| `background:task-updated` | 1 |
| `chat:error` | 1 |
| `chat:getOrCreateFileSession` | 2 |
| `chat:phase-start` | 1 |
| `chat:plan-updated` | 1 |
| `chat:response-chunk` | 1 |
| `chat:response-end` | 1 |
| `chat:session-title-updated` | 1 |
| `chat:skill-activated` | 1 |
| `chat:thinking` | 1 |
| `chat:thought-delta` | 1 |
| `chat:thought-end` | 1 |
| `chat:thought-start` | 1 |
| `chat:tool-confirm-request` | 1 |
| `chat:tool-end` | 1 |
| `chat:tool-start` | 1 |
| `chat:tool-update` | 1 |
| `chatrooms:clear` | 1 |
| `chatrooms:create` | 1 |
| `chatrooms:delete` | 1 |
| `chatrooms:list` | 2 |
| `chatrooms:messages` | 1 |
| `chatrooms:send` | 2 |
| `chatrooms:update` | 1 |
| `clipboard:read-text` | 1 |
| `clipboard:write-html` | 1 |
| `cover:generate` | 1 |
| `cover:list` | 1 |
| `cover:open` | 2 |
| `cover:open-root` | 1 |
| `cover:save-template-image` | 1 |
| `creative-chat:advisor-start` | 1 |
| `creative-chat:done` | 1 |
| `creative-chat:rag` | 1 |
| `creative-chat:stream` | 1 |
| `creative-chat:thinking` | 1 |
| `creative-chat:tool` | 1 |
| `creative-chat:user-message` | 1 |
| `embedding:compute` | 1 |
| `embedding:get-manuscript-cache` | 1 |
| `embedding:get-sorted-sources` | 1 |
| `embedding:save-manuscript-cache` | 1 |
| `file:copy-image` | 1 |
| `file:show-in-folder` | 2 |
| `image-gen:generate` | 2 |
| `indexing:clear-queue` | 1 |
| `indexing:get-stats` | 3 |
| `indexing:rebuild-advisor` | 1 |
| `indexing:rebuild-all` | 1 |
| `indexing:remove-item` | 1 |
| `indexing:status` | 2 |
| `knowledge:delete` | 1 |
| `knowledge:delete-youtube` | 1 |
| `knowledge:docs-updated` | 1 |
| `knowledge:docs:add-files` | 1 |
| `knowledge:docs:add-folder` | 1 |
| `knowledge:docs:add-obsidian-vault` | 1 |
| `knowledge:docs:delete-source` | 1 |
| `knowledge:docs:list` | 2 |
| `knowledge:list` | 3 |
| `knowledge:list-youtube` | 2 |
| `knowledge:new-youtube-video` | 1 |
| `knowledge:note-updated` | 1 |
| `knowledge:retry-youtube-subtitle` | 1 |
| `knowledge:transcribe` | 1 |
| `knowledge:youtube-regenerate-summaries` | 1 |
| `knowledge:youtube-video-updated` | 1 |
| `manuscripts:create-file` | 3 |
| `manuscripts:create-folder` | 1 |
| `manuscripts:delete` | 1 |
| `manuscripts:format-wechat` | 1 |
| `manuscripts:get-layout` | 4 |
| `manuscripts:list` | 2 |
| `manuscripts:read` | 2 |
| `manuscripts:rename` | 2 |
| `manuscripts:save` | 3 |
| `manuscripts:save-layout` | 3 |
| `media:bind` | 1 |
| `media:delete` | 1 |
| `media:list` | 1 |
| `media:open` | 4 |
| `media:open-root` | 2 |
| `media:update` | 1 |
| `memory:add` | 1 |
| `memory:archived` | 1 |
| `memory:delete` | 1 |
| `memory:history` | 1 |
| `memory:list` | 1 |
| `memory:maintenance-run` | 1 |
| `memory:maintenance-status` | 1 |
| `memory:search` | 1 |
| `New Chat` | 1 |
| `redclaw:list-projects` | 1 |
| `redclaw:runner-message` | 1 |
| `redclaw:runner-status` | 1 |
| `settings:updated` | 1 |
| `similarity:get-cache` | 1 |
| `similarity:get-knowledge-version` | 1 |
| `similarity:save-cache` | 1 |
| `skills:create` | 1 |
| `skills:market-install` | 1 |
| `skills:save` | 1 |
| `space:changed` | 3 |
| `spaces:create` | 1 |
| `spaces:list` | 2 |
| `spaces:rename` | 1 |
| `spaces:switch` | 1 |
| `video-gen:generate` | 1 |
| `wander:brainstorm` | 1 |
| `wander:delete-history` | 1 |
| `wander:get-random` | 1 |
| `wander:list-history` | 1 |
| `wander:progress` | 1 |
| `youtube:fetch-info-progress` | 1 |
| `youtube:install-progress` | 1 |
| `youtube:save-note` | 1 |

## Electron main handlers

```text
1635:ipcMain.handle('db:save-settings', async (_, settings) => {
1644:ipcMain.handle('db:get-settings', () => {
1648:ipcMain.handle('debug:get-status', () => {
1656:ipcMain.handle('debug:get-recent', (_event, payload?: { limit?: number }) => {
1663:ipcMain.handle('debug:open-log-dir', async () => {
1667:ipcMain.handle('tools:diagnostics:list', () => {
1671:ipcMain.handle('tools:diagnostics:run-direct', async (_event, payload?: { toolName?: string }) => {
1679:ipcMain.handle('tools:diagnostics:run-ai', async (_event, payload?: { toolName?: string }) => {
1687:ipcMain.handle('tools:hooks:list', () => {
1691:ipcMain.handle('tools:hooks:register', (_event, payload?: Record<string, unknown>) => {
1715:ipcMain.handle('tools:hooks:remove', (_event, payload?: { id?: string }) => {
1724:ipcMain.handle('sessions:list', () => {
1731:ipcMain.handle('sessions:get', (_event, payload?: { sessionId?: string }) => {
1742:ipcMain.handle('sessions:resume', (_event, payload?: { sessionId?: string }) => {
1752:ipcMain.handle('sessions:fork', (_event, payload?: { sessionId?: string; title?: string }) => {
1764:ipcMain.handle('sessions:get-transcript', (_event, payload?: { sessionId?: string; limit?: number }) => {
1771:ipcMain.handle('sessions:get-tool-results', (_event, payload?: { sessionId?: string; limit?: number }) => {
1778:ipcMain.handle('runtime:get-trace', (_event, payload?: { sessionId?: string; limit?: number }) => {
1785:ipcMain.handle('runtime:get-checkpoints', (_event, payload?: { sessionId?: string; limit?: number }) => {
1792:ipcMain.handle('runtime:get-tool-results', (_event, payload?: { sessionId?: string; limit?: number }) => {
1799:ipcMain.handle('runtime:resume', (_event, payload?: { sessionId?: string }) => {
1809:ipcMain.handle('runtime:fork-session', (_event, payload?: { sessionId?: string; title?: string }) => {
1820:ipcMain.handle('runtime:query', async (event, payload?: { sessionId?: string; message?: string }) => {
1845:ipcMain.handle('tasks:create', async (_event, payload?: {
1873:ipcMain.handle('tasks:list', async (_event, payload?: { status?: string; ownerSessionId?: string; limit?: number }) => {
1881:ipcMain.handle('tasks:get', async (_event, payload?: { taskId?: string }) => {
1887:ipcMain.handle('work:list', async (_event, payload?: { status?: string; type?: string; limit?: number; tag?: string }) => {
1896:ipcMain.handle('work:get', async (_event, payload?: { id?: string }) => {
1902:ipcMain.handle('work:ready', async (_event, payload?: { limit?: number }) => {
1906:ipcMain.handle('work:update', async (_event, payload?: {
1927:ipcMain.handle('tasks:resume', async (_event, payload?: { taskId?: string }) => {
1937:ipcMain.handle('tasks:cancel', async (_event, payload?: { taskId?: string }) => {
1943:ipcMain.handle('tasks:trace', async (_event, payload?: { taskId?: string; limit?: number }) => {
1949:ipcMain.handle('tasks:resume-from-session', async (_event, payload?: { sessionId?: string }) => {
1959:ipcMain.handle('ai:roles:list', async () => {
1963:ipcMain.handle('app:get-version', () => app.getVersion());
1964:ipcMain.handle('plugin:browser-extension-status', async () => {
1981:ipcMain.handle('plugin:prepare-browser-extension', async () => {
1990:ipcMain.handle('plugin:open-browser-extension-dir', async () => {
2004:ipcMain.handle('app:check-update', async (_, payload?: { force?: boolean }) => {
2009:ipcMain.handle('app:open-release-page', async (_, payload?: { url?: string }) => {
2025:ipcMain.handle('clipboard:read-text', () => {
2034:ipcMain.handle('clipboard:write-html', async (_, payload?: { html?: string; text?: string }) => {
2052:ipcMain.handle('wechat-official:get-status', async () => {
2067:ipcMain.handle('wechat-official:bind', async (_, payload?: {
2089:ipcMain.handle('wechat-official:unbind', async (_, payload?: { bindingId?: string }) => {
2101:ipcMain.handle('file:copy-image', async (_, payload?: { source?: string }) => {
2124:ipcMain.handle('file:show-in-folder', async (_, payload?: { source?: string }) => {
2143:ipcMain.handle('spaces:list', async () => {
2150:ipcMain.handle('spaces:create', async (_, name: string) => {
2156:ipcMain.handle('spaces:rename', async (_, { id, name }: { id: string; name: string }) => {
2164:ipcMain.handle('spaces:switch', async (_, spaceId: string) => {
2172:ipcMain.handle('memory:list', async () => {
2176:ipcMain.handle('memory:archived', async () => {
2180:ipcMain.handle('memory:history', async (_, originId?: string) => {
2184:ipcMain.handle('memory:search', async (_, payload?: { query?: string; includeArchived?: boolean; limit?: number }) => {
2191:ipcMain.handle('memory:maintenance-status', async () => {
2195:ipcMain.handle('memory:maintenance-run', async () => {
2199:ipcMain.handle('background-tasks:list', async () => {
2203:ipcMain.handle('background-tasks:get', async (_, payload?: { taskId?: string }) => {
2207:ipcMain.handle('background-tasks:cancel', async (_, payload?: { taskId?: string }) => {
2211:ipcMain.handle('background-workers:get-pool-state', async () => {
2215:ipcMain.handle('assistant:daemon-status', async () => {
2219:ipcMain.handle('assistant:daemon-start', async (_, payload: {
2259:ipcMain.handle('assistant:daemon-stop', async () => {
2267:ipcMain.handle('assistant:daemon-set-config', async (_, payload: {
2308:ipcMain.handle('assistant:daemon-weixin-login-start', async (_, payload: {
2323:ipcMain.handle('assistant:daemon-weixin-login-wait', async (_, payload: {
2338:ipcMain.handle('session-bridge:status', async () => {
2343:ipcMain.handle('session-bridge:list-sessions', async () => {
2348:ipcMain.handle('session-bridge:get-session', async (_, payload?: { sessionId?: string }) => {
2355:ipcMain.handle('session-bridge:create-session', async (_, payload?: {
2365:ipcMain.handle('session-bridge:send-message', async (_, payload?: {
2378:ipcMain.handle('session-bridge:list-permissions', async (_, payload?: { sessionId?: string }) => {
2384:ipcMain.handle('session-bridge:resolve-permission', async (_, payload?: {
2405:ipcMain.handle('memory:add', async (_, { content, type, tags }) => {
2409:ipcMain.handle('memory:delete', async (_, id) => {
2413:ipcMain.handle('memory:update', async (_, { id, updates }) => {
2418:ipcMain.handle('mcp:list', async () => {
2422:ipcMain.handle('mcp:save', async (_, payload: { servers?: McpServerConfig[] }) => {
2432:ipcMain.handle('mcp:test', async (_, payload: { server?: McpServerConfig }) => {
2444:ipcMain.handle('mcp:discover-local', async () => {
2461:ipcMain.handle('mcp:import-local', async () => {
2471:ipcMain.handle('mcp:oauth-status', async (_, payload: { serverId?: string }) => {
2486:ipcMain.handle('ai:detect-protocol', async (_, payload: {
2507:ipcMain.handle('ai:test-connection', async (_, payload: {
2537:ipcMain.handle('ai:fetch-models', async (_, payload: {
2606:ipcMain.handle('chat:create-session', async (_, title?: string) => {
2615:ipcMain.handle('chat:getOrCreateFileSession', async (_, { filePath, fileId }: { filePath: string; fileId?: string }) => {
2672:ipcMain.handle('chat:getOrCreateContextSession', async (_, { contextId, contextType, title, initialContext }: { contextId: string; contextType: string; title: string; initialContext: string }) => {
2706:ipcMain.handle('redclaw:list-projects', async (_, { limit }: { limit?: number } = {}) => {
2715:ipcMain.handle('redclaw:get-project', async (_, { projectId }: { projectId: string }) => {
2728:ipcMain.handle('redclaw:open-project', async (_, { projectDir }: { projectDir: string }) => {
2744:ipcMain.handle('redclaw:runner-status', async () => {
2748:ipcMain.handle('redclaw:runner-start', async (_, payload: {
2763:ipcMain.handle('redclaw:runner-stop', async () => {
2771:ipcMain.handle('redclaw:runner-run-now', async (_, payload: { projectId?: string } = {}) => {
2779:ipcMain.handle('redclaw:runner-set-project', async (_, payload: {
2791:ipcMain.handle('redclaw:runner-set-config', async (_, payload: {
2809:ipcMain.handle('redclaw:runner-list-scheduled', async () => {
2818:ipcMain.handle('redclaw:runner-add-scheduled', async (_, payload: {
2837:ipcMain.handle('redclaw:runner-remove-scheduled', async (_, payload: { taskId: string }) => {
2846:ipcMain.handle('redclaw:runner-set-scheduled-enabled', async (_, payload: { taskId: string; enabled: boolean }) => {
2855:ipcMain.handle('redclaw:runner-run-scheduled-now', async (_, payload: { taskId: string }) => {
2864:ipcMain.handle('redclaw:runner-list-long-cycle', async () => {
2873:ipcMain.handle('redclaw:runner-add-long-cycle', async (_, payload: {
2890:ipcMain.handle('redclaw:runner-remove-long-cycle', async (_, payload: { taskId: string }) => {
2899:ipcMain.handle('redclaw:runner-set-long-cycle-enabled', async (_, payload: { taskId: string; enabled: boolean }) => {
2908:ipcMain.handle('redclaw:runner-run-long-cycle-now', async (_, payload: { taskId: string }) => {
2917:ipcMain.handle('media:list', async (_, { limit }: { limit?: number } = {}) => {
2928:ipcMain.handle('media:update', async (_, payload: { assetId: string; projectId?: string; title?: string; prompt?: string }) => {
2941:ipcMain.handle('media:delete', async (_, { assetId }: { assetId: string }) => {
2954:ipcMain.handle('media:bind', async (_, { assetId, manuscriptPath }: { assetId: string; manuscriptPath: string }) => {
2973:ipcMain.handle('media:open', async (_, { assetId }: { assetId: string }) => {
2998:ipcMain.handle('media:open-root', async () => {
3011:ipcMain.handle('subjects:list', async (_, { limit }: { limit?: number } = {}) => {
3021:ipcMain.handle('subjects:get', async (_, { id }: { id: string }) => {
3034:ipcMain.handle('subjects:create', async (_, payload: {
3052:ipcMain.handle('subjects:update', async (_, payload: {
3074:ipcMain.handle('subjects:delete', async (_, { id }: { id: string }) => {
3087:ipcMain.handle('subjects:search', async (_, { query, categoryId, limit }: { query?: string; categoryId?: string; limit?: number } = {}) => {
3097:ipcMain.handle('subjects:categories:list', async () => {
3107:ipcMain.handle('subjects:categories:create', async (_, { name }: { name: string }) => {
3117:ipcMain.handle('subjects:categories:update', async (_, payload: { id: string; name: string }) => {
3127:ipcMain.handle('subjects:categories:delete', async (_, { id }: { id: string }) => {
3137:ipcMain.handle('cover:list', async (_, { limit }: { limit?: number } = {}) => {
3148:ipcMain.handle('cover:open', async (_, { assetId }: { assetId: string }) => {
3173:ipcMain.handle('cover:open-root', async () => {
3186:ipcMain.handle('cover:save-template-image', async (_, {
3216:ipcMain.handle('cover:generate', async (_, {
3275:ipcMain.handle('image-gen:generate', async (_, {
3326:ipcMain.handle('video-gen:generate', async (_, {
3388:ipcMain.handle('chat:get-sessions', async () => {
3393:ipcMain.handle('chat:delete-session', async (_, sessionId: string) => {
3400:ipcMain.handle('chat:get-messages', async (_, sessionId: string) => {
3405:ipcMain.handle('chat:clear-messages', async (_, sessionId: string) => {
3427:ipcMain.handle('chat:compact-context', async (event, sessionId: string) => {
3441:ipcMain.handle('chat:get-context-usage', async (_, sessionId: string) => {
3497:ipcMain.handle('chat:get-runtime-state', async (event, sessionId: string) => {
3543:ipcMain.handle('chat:generate-title', async (_, { sessionId, message }) => {
3548:ipcMain.handle('chat:pick-attachment', async (_, payload?: { sessionId?: string }) => {
3621:ipcMain.handle('chat:transcribe-audio', async (_event, payload?: {
3668:ipcMain.on('chat:send-message', async (event, { sessionId, message, displayContent, attachment, modelConfig, taskHints }) => {
3900:ipcMain.on('chat:cancel', (_, payload?: { sessionId?: string } | string) => {
3921:ipcMain.on('ai:start-chat', async (event, message, modelConfig) => {
3985:ipcMain.on('ai:confirm-tool', (_, callId: string, confirmed: boolean) => {
3996:ipcMain.on('ai:cancel', () => {
4003:ipcMain.handle('skills:list', async () => {
4165:ipcMain.handle('skills:enable', async (_, { name }: { name: string }) => {
4177:ipcMain.handle('skills:disable', async (_, { name }: { name: string }) => {
4189:ipcMain.handle('skills:market-search', async (_, { query }: { query?: string }) => {
4213:ipcMain.handle('skills:market-install', async (_, { slug, tag }: { slug: string; tag?: string }) => {
4223:ipcMain.handle('skills:install-from-github', async (_, { repoFullName, skillPath }: { repoFullName: string; skillPath?: string }) => {
4237:ipcMain.handle('skills:save', async (_, { location, content }: { location: string; content: string }) => {
4247:ipcMain.handle('skills:create', async (_, { name }: { name: string }) => {
4377:ipcMain.handle('advisors:list', async () => {
4467:ipcMain.handle('advisors:create', async (_, data: { name: string; avatar: string; personality: string; systemPrompt: string; knowledgeLanguage?: string; youtubeChannel?: { url: string; channelId: string } }) => {
4507:ipcMain.handle('advisors:update', async (_, data: { id: string; name: string; avatar: string; personality: string; systemPrompt: string; knowledgeLanguage?: string }) => {
4544:ipcMain.handle('advisors:select-avatar', async () => {
4569:ipcMain.handle('advisors:delete', async (_, advisorId: string) => {
4583:ipcMain.handle('advisors:upload-knowledge', async (_, advisorId: string) => {
4622:ipcMain.handle('advisors:delete-knowledge', async (_, { advisorId, fileName }: { advisorId: string; fileName: string }) => {
4635:ipcMain.handle('advisors:optimize-prompt', async (_, { info }: { info: string }) => {
4669:ipcMain.handle('advisors:optimize-prompt-deep', async (_, {
4762:ipcMain.handle('advisors:generate-persona', async (_, {
4821:ipcMain.handle('youtube:check-ytdlp', async () => {
4947:ipcMain.handle('advisors:fetch-youtube-info', async (event, { channelUrl }: { channelUrl: string }) => {
4966:ipcMain.handle('advisors:update-youtube-settings', async (_event, payload: {
4999:ipcMain.handle('advisors:youtube-runner-status', async () => {
5007:ipcMain.handle('advisors:youtube-runner-run-now', async (_event, payload: { advisorId?: string } = {}) => {
5015:ipcMain.handle('advisors:download-youtube-subtitles', async (event, { channelUrl, videoCount, advisorId }: { channelUrl: string; videoCount: number; advisorId: string }) => {
5123:ipcMain.handle('youtube:install', async (event) => {
5137:ipcMain.handle('youtube:update', async () => {
5149:ipcMain.handle('advisors:refresh-videos', async (event, { advisorId, limit = 50 }: { advisorId: string; limit?: number }) => {
5193:ipcMain.handle('advisors:get-videos', async (_, { advisorId }: { advisorId: string }) => {
5211:ipcMain.handle('advisors:download-video', async (_event, { advisorId, videoId }: { advisorId: string; videoId: string }) => {
5267:ipcMain.handle('advisors:retry-failed', async (event, { advisorId }: { advisorId: string }) => {
5444:ipcMain.handle('chatrooms:list', async () => {
5503:ipcMain.handle('chatrooms:create', async (_, { name, advisorIds }: { name: string; advisorIds: string[] }) => {
5529:ipcMain.handle('chatrooms:messages', async (_, roomId: string) => {
5543:ipcMain.handle('chatrooms:update', async (_, { roomId, name, advisorIds }: { roomId: string; name?: string; advisorIds?: string[] }) => {
5566:ipcMain.handle('chatrooms:delete', async (_, roomId: string) => {
5609:ipcMain.handle('chatrooms:clear', async (_, roomId: string) => {
5625:ipcMain.handle('chatrooms:send', async (_, { roomId, message, context, clientMessageId }: { roomId: string; message: string; context?: { filePath: string; fileContent: string }; clientMessageId?: string }) => {
5839:ipcMain.handle('manuscripts:list', async () => {
5854:ipcMain.handle('manuscripts:read', async (_, filePath: string) => {
5892:ipcMain.handle('manuscripts:save', async (_, { path: filePath, content, metadata }: { path: string; content: string; metadata?: any }) => {
5930:ipcMain.handle('manuscripts:format-wechat', async (_, payload?: {
5961:ipcMain.handle('wechat-official:create-draft', async (_, payload?: {
5992:ipcMain.handle('manuscripts:get-layout', async () => {
6006:ipcMain.handle('manuscripts:save-layout', async (_, layout: any) => {
6021:ipcMain.handle('manuscripts:create-folder', async (_, { parentPath, name }: { parentPath: string; name: string }) => {
6035:ipcMain.handle('manuscripts:create-file', async (_, { parentPath, name, content }: { parentPath: string; name: string; content?: string }) => {
6060:ipcMain.handle('manuscripts:delete', async (_, filePath: string) => {
6074:ipcMain.handle('manuscripts:rename', async (_, { oldPath, newName }: { oldPath: string; newName: string }) => {
6090:ipcMain.handle('manuscripts:move', async (_, { sourcePath, targetDir }: { sourcePath: string; targetDir: string }) => {
6297:ipcMain.handle('knowledge:docs:list', async () => {
6308:ipcMain.handle('knowledge:docs:add-files', async () => {
6359:ipcMain.handle('knowledge:docs:add-folder', async () => {
6420:ipcMain.handle('knowledge:docs:add-obsidian-vault', async () => {
6474:ipcMain.handle('knowledge:docs:delete-source', async (_, sourceId: string) => {
6504:ipcMain.handle('knowledge:list', async () => {
6583:ipcMain.handle('knowledge:delete', async (_, noteId: string) => {
6596:ipcMain.handle('knowledge:transcribe', async (_event, noteId: string) => {
6644:ipcMain.handle('knowledge:list-youtube', async () => {
6696:ipcMain.handle('knowledge:delete-youtube', async (_, videoId: string) => {
6709:ipcMain.handle('knowledge:read-youtube-subtitle', async (_, videoId: string) => {
6735:ipcMain.handle('knowledge:retry-youtube-subtitle', async (_, videoId: string) => {
6821:ipcMain.handle('knowledge:youtube-regenerate-summaries', async (_event, payload?: { videoIds?: string[] }) => {
6866:ipcMain.handle('wander:get-random', async () => {
7446:ipcMain.handle('wander:brainstorm', async (event, items: any[], options?: { multiChoice?: boolean; deepThink?: boolean; requestId?: string }) => {
7522:ipcMain.handle('embedding:compute', async (_, text: string) => {
7532:ipcMain.handle('embedding:get-sorted-sources', async (_, embedding: number[]) => {
7544:ipcMain.handle('embedding:rebuild-all', async () => {
7575:ipcMain.handle('embedding:get-status', async () => {
7580:ipcMain.handle('embedding:get-manuscript-cache', async (_, filePath: string) => {
7592:ipcMain.handle('embedding:save-manuscript-cache', async (_, { filePath, contentHash, embedding }: { filePath: string; contentHash: string; embedding: number[] }) => {
7604:ipcMain.handle('similarity:get-cache', async (_, manuscriptId: string) => {
7617:ipcMain.handle('similarity:save-cache', async (_, cache: { manuscriptId: string; contentHash: string; knowledgeVersion: number; sortedIds: string[] }) => {
7629:ipcMain.handle('similarity:get-knowledge-version', async () => {
7635:ipcMain.handle('wander:list-history', async () => {
7640:ipcMain.handle('wander:get-history', async (_, id: string) => {
7645:ipcMain.handle('wander:delete-history', async (_, id: string) => {
8425:ipcMain.handle('archives:list', async () => {
8429:ipcMain.handle('archives:create', async (_, data: {
8449:ipcMain.handle('archives:update', async (_, data: {
8469:ipcMain.handle('archives:delete', async (_, profileId: string) => {
8474:ipcMain.handle('archives:samples:list', async (_, profileId: string) => {
8478:ipcMain.handle('archives:samples:create', async (_, data: {
8527:ipcMain.handle('archives:samples:update', async (_, data: {
8577:ipcMain.handle('archives:samples:delete', async (_, sampleId: string) => {
8590:ipcMain.handle('indexing:get-stats', async () => {
8594:ipcMain.handle('indexing:remove-item', async (_, itemId: string) => {
8599:ipcMain.handle('indexing:clear-queue', async () => {
8604:ipcMain.handle('indexing:rebuild-all', async () => {
8726:ipcMain.handle('indexing:rebuild-advisor', async (_, advisorId: string) => {
9613:ipcMain.handle('xhs:save-note', async (_event, note: any) => {
9617:ipcMain.handle('youtube:save-note', async (_event, payload: {
```
