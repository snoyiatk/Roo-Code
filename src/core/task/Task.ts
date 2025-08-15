import * as path from "path"
import * as vscode from "vscode"
import os from "os"
import crypto from "crypto"
import EventEmitter from "events"

import { Anthropic } from "@anthropic-ai/sdk"
import delay from "delay"
import pWaitFor from "p-wait-for"
import { serializeError } from "serialize-error"

import {
	type TaskLike,
	type TaskMetadata,
	type TaskEvents,
	type ProviderSettings,
	type TokenUsage,
	type ToolUsage,
	type ToolName,
	type ContextCondense,
	type ClineMessage,
	type ClineSay,
	type ClineAsk,
	type BlockingAsk,
	type ToolProgressStatus,
	type HistoryItem,
	RooCodeEventName,
	TelemetryEventName,
	TodoItem,
	getApiProtocol,
	getModelId,
	DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
	isBlockingAsk,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import { CloudService, ExtensionBridgeService } from "@roo-code/cloud"

// api
import { ApiHandler, ApiHandlerCreateMessageMetadata, buildApiHandler } from "../../api"
import { ApiStream } from "../../api/transform/stream"

// shared
import { findLastIndex } from "../../shared/array"
import { combineApiRequests } from "../../shared/combineApiRequests"
import { combineCommandSequences } from "../../shared/combineCommandSequences"
import { t } from "../../i18n"
import { ClineApiReqCancelReason, ClineApiReqInfo } from "../../shared/ExtensionMessage"
import { getApiMetrics } from "../../shared/getApiMetrics"
import { ClineAskResponse } from "../../shared/WebviewMessage"
import { defaultModeSlug } from "../../shared/modes"
import { DiffStrategy } from "../../shared/tools"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { getModelMaxOutputTokens } from "../../shared/api"

// services
import { UrlContentFetcher } from "../../services/browser/UrlContentFetcher"
import { BrowserSession } from "../../services/browser/BrowserSession"
import { McpHub } from "../../services/mcp/McpHub"
import { McpServerManager } from "../../services/mcp/McpServerManager"
import { RepoPerTaskCheckpointService } from "../../services/checkpoints"

// integrations
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider"
import { findToolName, formatContentBlockToMarkdown } from "../../integrations/misc/export-markdown"
import { RooTerminalProcess } from "../../integrations/terminal/types"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"

// utils
import { calculateApiCostAnthropic } from "../../shared/cost"
import { getWorkspacePath } from "../../utils/path"

// prompts
import { formatResponse } from "../prompts/responses"
import { SYSTEM_PROMPT } from "../prompts/system"

// core modules
import { ToolRepetitionDetector } from "../tools/ToolRepetitionDetector"
import { FileContextTracker } from "../context-tracking/FileContextTracker"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { RooProtectedController } from "../protect/RooProtectedController"
import { type AssistantMessageContent, presentAssistantMessage, parseAssistantMessage } from "../assistant-message"
import { AssistantMessageParser } from "../assistant-message/AssistantMessageParser"
import { truncateConversationIfNeeded } from "../sliding-window"
import { ClineProvider } from "../webview/ClineProvider"
import { MultiSearchReplaceDiffStrategy } from "../diff/strategies/multi-search-replace"
import { MultiFileSearchReplaceDiffStrategy } from "../diff/strategies/multi-file-search-replace"
import { readApiMessages, saveApiMessages, readTaskMessages, saveTaskMessages, taskMetadata } from "../task-persistence"
import { getEnvironmentDetails } from "../environment/getEnvironmentDetails"
import {
	type CheckpointDiffOptions,
	type CheckpointRestoreOptions,
	getCheckpointService,
	checkpointSave,
	checkpointRestore,
	checkpointDiff,
} from "../checkpoints"
import { processUserContentMentions } from "../mentions/processUserContentMentions"
import { ApiMessage } from "../task-persistence/apiMessages"
import { getMessagesSinceLastSummary, summarizeConversation } from "../condense"
import { maybeRemoveImageBlocks } from "../../api/transform/image-cleaning"
import { restoreTodoListForTask } from "../tools/updateTodoListTool"
import { AutoApprovalHandler } from "./AutoApprovalHandler"

const MAX_EXPONENTIAL_BACKOFF_SECONDS = 600 // 10 minutes

export type TaskOptions = {
	provider: ClineProvider
	apiConfiguration: ProviderSettings
	enableDiff?: boolean
	enableCheckpoints?: boolean
	enableTaskBridge?: boolean
	fuzzyMatchThreshold?: number
	consecutiveMistakeLimit?: number
	task?: string
	images?: string[]
	historyItem?: HistoryItem
	experiments?: Record<string, boolean>
	startTask?: boolean
	rootTask?: Task
	parentTask?: Task
	taskNumber?: number
	onCreated?: (task: Task) => void
}

export class Task extends EventEmitter<TaskEvents> implements TaskLike {
	readonly taskId: string
	readonly instanceId: string
	readonly metadata: TaskMetadata

	todoList?: TodoItem[]

	readonly rootTask: Task | undefined = undefined
	readonly parentTask: Task | undefined = undefined
	readonly taskNumber: number
	readonly workspacePath: string

	/**
	 * The mode associated with this task. Persisted across sessions
	 * to maintain user context when reopening tasks from history.
	 *
	 * ## Lifecycle
	 *
	 * ### For new tasks:
	 * 1. Initially `undefined` during construction
	 * 2. Asynchronously initialized from provider state via `initializeTaskMode()`
	 * 3. Falls back to `defaultModeSlug` if provider state is unavailable
	 *
	 * ### For history items:
	 * 1. Immediately set from `historyItem.mode` during construction
	 * 2. Falls back to `defaultModeSlug` if mode is not stored in history
	 *
	 * ## Important
	 * This property should NOT be accessed directly until `taskModeReady` promise resolves.
	 * Use `getTaskMode()` for async access or `taskMode` getter for sync access after initialization.
	 *
	 * @private
	 * @see {@link getTaskMode} - For safe async access
	 * @see {@link taskMode} - For sync access after initialization
	 * @see {@link waitForModeInitialization} - To ensure initialization is complete
	 */
	private _taskMode: string | undefined

	/**
	 * Promise that resolves when the task mode has been initialized.
	 * This ensures async mode initialization completes before the task is used.
	 *
	 * ## Purpose
	 * - Prevents race conditions when accessing task mode
	 * - Ensures provider state is properly loaded before mode-dependent operations
	 * - Provides a synchronization point for async initialization
	 *
	 * ## Resolution timing
	 * - For history items: Resolves immediately (sync initialization)
	 * - For new tasks: Resolves after provider state is fetched (async initialization)
	 *
	 * @private
	 * @see {@link waitForModeInitialization} - Public method to await this promise
	 */
	private taskModeReady: Promise<void>

	providerRef: WeakRef<ClineProvider>
	private readonly globalStoragePath: string
	abort: boolean = false
	blockingAsk?: BlockingAsk
	didFinishAbortingStream = false
	abandoned = false
	isInitialized = false
	isPaused: boolean = false
	pausedModeSlug: string = defaultModeSlug
	private pauseInterval: NodeJS.Timeout | undefined

	// API
	readonly apiConfiguration: ProviderSettings
	api: ApiHandler
	private static lastGlobalApiRequestTime?: number
	private autoApprovalHandler: AutoApprovalHandler

	/**
	 * Reset the global API request timestamp. This should only be used for testing.
	 * @internal
	 */
	static resetGlobalApiRequestTime(): void {
		Task.lastGlobalApiRequestTime = undefined
	}

	toolRepetitionDetector: ToolRepetitionDetector
	rooIgnoreController?: RooIgnoreController
	rooProtectedController?: RooProtectedController
	fileContextTracker: FileContextTracker
	urlContentFetcher: UrlContentFetcher
	terminalProcess?: RooTerminalProcess

	// Computer User
	browserSession: BrowserSession

	// Editing
	diffViewProvider: DiffViewProvider
	diffStrategy?: DiffStrategy
	diffEnabled: boolean = false
	fuzzyMatchThreshold: number
	didEditFile: boolean = false

	// LLM Messages & Chat Messages
	apiConversationHistory: ApiMessage[] = []
	clineMessages: ClineMessage[] = []

	// Ask
	private askResponse?: ClineAskResponse
	private askResponseText?: string
	private askResponseImages?: string[]
	public lastMessageTs?: number

	// Tool Use
	consecutiveMistakeCount: number = 0
	consecutiveMistakeLimit: number
	consecutiveMistakeCountForApplyDiff: Map<string, number> = new Map()
	toolUsage: ToolUsage = {}

	// Checkpoints
	enableCheckpoints: boolean
	checkpointService?: RepoPerTaskCheckpointService
	checkpointServiceInitializing = false

	// Task Bridge
	enableTaskBridge: boolean
	bridgeService: ExtensionBridgeService | null = null

	// Streaming
	isWaitingForFirstChunk = false
	isStreaming = false
	currentStreamingContentIndex = 0
	currentStreamingDidCheckpoint = false
	assistantMessageContent: AssistantMessageContent[] = []
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = []
	userMessageContentReady = false
	didRejectTool = false
	didAlreadyUseTool = false
	didCompleteReadingStream = false
	assistantMessageParser?: AssistantMessageParser
	isAssistantMessageParserEnabled = false
	private lastUsedInstructions?: string
	private skipPrevResponseIdOnce: boolean = false

	constructor({
		provider,
		apiConfiguration,
		enableDiff = false,
		enableCheckpoints = true,
		enableTaskBridge = false,
		fuzzyMatchThreshold = 1.0,
		consecutiveMistakeLimit = DEFAULT_CONSECUTIVE_MISTAKE_LIMIT,
		task,
		images,
		historyItem,
		startTask = true,
		rootTask,
		parentTask,
		taskNumber = -1,
		onCreated,
	}: TaskOptions) {
		super()

		if (startTask && !task && !images && !historyItem) {
			throw new Error("Either historyItem or task/images must be provided")
		}

		this.taskId = historyItem ? historyItem.id : crypto.randomUUID()

		this.metadata = {
			taskId: this.taskId,
			task: historyItem ? historyItem.task : task,
			images: historyItem ? [] : images,
		}

		// Normal use-case is usually retry similar history task with new workspace.
		this.workspacePath = parentTask
			? parentTask.workspacePath
			: getWorkspacePath(path.join(os.homedir(), "Desktop"))

		this.instanceId = crypto.randomUUID().slice(0, 8)
		this.taskNumber = -1

		this.rooIgnoreController = new RooIgnoreController(this.cwd)
		this.rooProtectedController = new RooProtectedController(this.cwd)
		this.fileContextTracker = new FileContextTracker(provider, this.taskId)

		this.rooIgnoreController.initialize().catch((error) => {
			console.error("Failed to initialize RooIgnoreController:", error)
		})

		this.apiConfiguration = apiConfiguration
		this.api = buildApiHandler(apiConfiguration)
		this.autoApprovalHandler = new AutoApprovalHandler()

		this.urlContentFetcher = new UrlContentFetcher(provider.context)
		this.browserSession = new BrowserSession(provider.context)
		this.diffEnabled = enableDiff
		this.fuzzyMatchThreshold = fuzzyMatchThreshold
		this.consecutiveMistakeLimit = consecutiveMistakeLimit ?? DEFAULT_CONSECUTIVE_MISTAKE_LIMIT
		this.providerRef = new WeakRef(provider)
		this.globalStoragePath = provider.context.globalStorageUri.fsPath
		this.diffViewProvider = new DiffViewProvider(this.cwd, this)
		this.enableCheckpoints = enableCheckpoints
		this.enableTaskBridge = enableTaskBridge

		this.rootTask = rootTask
		this.parentTask = parentTask
		this.taskNumber = taskNumber

		// Store the task's mode when it's created.
		// For history items, use the stored mode; for new tasks, we'll set it
		// after getting state.
		if (historyItem) {
			this._taskMode = historyItem.mode || defaultModeSlug
			this.taskModeReady = Promise.resolve()
			TelemetryService.instance.captureTaskRestarted(this.taskId)
		} else {
			// For new tasks, don't set the mode yet - wait for async initialization.
			this._taskMode = undefined
			this.taskModeReady = this.initializeTaskMode(provider)
			TelemetryService.instance.captureTaskCreated(this.taskId)
		}

		// Only set up diff strategy if diff is enabled.
		if (this.diffEnabled) {
			// Default to old strategy, will be updated if experiment is enabled.
			this.diffStrategy = new MultiSearchReplaceDiffStrategy(this.fuzzyMatchThreshold)

			// Check experiment asynchronously and update strategy if needed.
			provider.getState().then((state) => {
				const isMultiFileApplyDiffEnabled = experiments.isEnabled(
					state.experiments ?? {},
					EXPERIMENT_IDS.MULTI_FILE_APPLY_DIFF,
				)

				if (isMultiFileApplyDiffEnabled) {
					this.diffStrategy = new MultiFileSearchReplaceDiffStrategy(this.fuzzyMatchThreshold)
				}
			})
		}

		this.toolRepetitionDetector = new ToolRepetitionDetector(this.consecutiveMistakeLimit)

		onCreated?.(this)

		if (startTask) {
			if (task || images) {
				this.startTask(task, images)
			} else if (historyItem) {
				this.resumeTaskFromHistory()
			} else {
				throw new Error("Either historyItem or task/images must be provided")
			}
		}
	}

	/**
	 * Initialize the task mode from the provider state.
	 * This method handles async initialization with proper error handling.
	 *
	 * ## Flow
	 * 1. Attempts to fetch the current mode from provider state
	 * 2. Sets `_taskMode` to the fetched mode or `defaultModeSlug` if unavailable
	 * 3. Handles errors gracefully by falling back to default mode
	 * 4. Logs any initialization errors for debugging
	 *
	 * ## Error handling
	 * - Network failures when fetching provider state
	 * - Provider not yet initialized
	 * - Invalid state structure
	 *
	 * All errors result in fallback to `defaultModeSlug` to ensure task can proceed.
	 *
	 * @private
	 * @param provider - The ClineProvider instance to fetch state from
	 * @returns Promise that resolves when initialization is complete
	 */
	private async initializeTaskMode(provider: ClineProvider): Promise<void> {
		try {
			const state = await provider.getState()
			this._taskMode = state?.mode || defaultModeSlug
		} catch (error) {
			// If there's an error getting state, use the default mode
			this._taskMode = defaultModeSlug
			// Use the provider's log method for better error visibility
			const errorMessage = `Failed to initialize task mode: ${error instanceof Error ? error.message : String(error)}`
			provider.log(errorMessage)
		}
	}

	/**
	 * Wait for the task mode to be initialized before proceeding.
	 * This method ensures that any operations depending on the task mode
	 * will have access to the correct mode value.
	 *
	 * ## When to use
	 * - Before accessing mode-specific configurations
	 * - When switching between tasks with different modes
	 * - Before operations that depend on mode-based permissions
	 *
	 * ## Example usage
	 * ```typescript
	 * // Wait for mode initialization before mode-dependent operations
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Now safe to access synchronously
	 *
	 * // Or use with getTaskMode() for a one-liner
	 * const mode = await task.getTaskMode(); // Internally waits for initialization
	 * ```
	 *
	 * @returns Promise that resolves when the task mode is initialized
	 * @public
	 */
	public async waitForModeInitialization(): Promise<void> {
		return this.taskModeReady
	}

	/**
	 * Get the task mode asynchronously, ensuring it's properly initialized.
	 * This is the recommended way to access the task mode as it guarantees
	 * the mode is available before returning.
	 *
	 * ## Async behavior
	 * - Internally waits for `taskModeReady` promise to resolve
	 * - Returns the initialized mode or `defaultModeSlug` as fallback
	 * - Safe to call multiple times - subsequent calls return immediately if already initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // Safe async access
	 * const mode = await task.getTaskMode();
	 * console.log(`Task is running in ${mode} mode`);
	 *
	 * // Use in conditional logic
	 * if (await task.getTaskMode() === 'architect') {
	 *   // Perform architect-specific operations
	 * }
	 * ```
	 *
	 * @returns Promise resolving to the task mode string
	 * @public
	 */
	public async getTaskMode(): Promise<string> {
		await this.taskModeReady
		return this._taskMode || defaultModeSlug
	}

	/**
	 * Get the task mode synchronously. This should only be used when you're certain
	 * that the mode has already been initialized (e.g., after waitForModeInitialization).
	 *
	 * ## When to use
	 * - In synchronous contexts where async/await is not available
	 * - After explicitly waiting for initialization via `waitForModeInitialization()`
	 * - In event handlers or callbacks where mode is guaranteed to be initialized
	 *
	 * ## Example usage
	 * ```typescript
	 * // After ensuring initialization
	 * await task.waitForModeInitialization();
	 * const mode = task.taskMode; // Safe synchronous access
	 *
	 * // In an event handler after task is started
	 * task.on('taskStarted', () => {
	 *   console.log(`Task started in ${task.taskMode} mode`); // Safe here
	 * });
	 * ```
	 *
	 * @throws {Error} If the mode hasn't been initialized yet
	 * @returns The task mode string
	 * @public
	 */
	public get taskMode(): string {
		if (this._taskMode === undefined) {
			throw new Error("Task mode accessed before initialization. Use getTaskMode() or wait for taskModeReady.")
		}
		return this._taskMode
	}

	static create(options: TaskOptions): [Task, Promise<void>] {
		const instance = new Task({ ...options, startTask: false })
		const { images, task, historyItem } = options
		let promise

		if (images || task) {
			promise = instance.startTask(task, images)
		} else if (historyItem) {
			promise = instance.resumeTaskFromHistory()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		return [instance, promise]
	}

	// API Messages

	private async getSavedApiConversationHistory(): Promise<ApiMessage[]> {
		return readApiMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToApiConversationHistory(message: Anthropic.MessageParam) {
		const messageWithTs = { ...message, ts: Date.now() }
		this.apiConversationHistory.push(messageWithTs)
		await this.saveApiConversationHistory()
	}

	async overwriteApiConversationHistory(newHistory: ApiMessage[]) {
		this.apiConversationHistory = newHistory
		await this.saveApiConversationHistory()
	}

	private async saveApiConversationHistory() {
		try {
			await saveApiMessages({
				messages: this.apiConversationHistory,
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})
		} catch (error) {
			// In the off chance this fails, we don't want to stop the task.
			console.error("Failed to save API conversation history:", error)
		}
	}

	// Cline Messages

	private async getSavedClineMessages(): Promise<ClineMessage[]> {
		return readTaskMessages({ taskId: this.taskId, globalStoragePath: this.globalStoragePath })
	}

	private async addToClineMessages(message: ClineMessage) {
		this.clineMessages.push(message)
		const provider = this.providerRef.deref()
		await provider?.postStateToWebview()
		this.emit(RooCodeEventName.Message, { action: "created", message })
		await this.saveClineMessages()

		const shouldCaptureMessage = message.partial !== true && CloudService.isEnabled()

		if (shouldCaptureMessage) {
			CloudService.instance.captureEvent({
				event: TelemetryEventName.TASK_MESSAGE,
				properties: { taskId: this.taskId, message },
			})
		}
	}

	public async overwriteClineMessages(newMessages: ClineMessage[]) {
		this.clineMessages = newMessages
		restoreTodoListForTask(this)
		await this.saveClineMessages()
	}

	private async updateClineMessage(message: ClineMessage) {
		const provider = this.providerRef.deref()
		await provider?.postMessageToWebview({ type: "messageUpdated", clineMessage: message })
		this.emit(RooCodeEventName.Message, { action: "updated", message })

		const shouldCaptureMessage = message.partial !== true && CloudService.isEnabled()

		if (shouldCaptureMessage) {
			CloudService.instance.captureEvent({
				event: TelemetryEventName.TASK_MESSAGE,
				properties: { taskId: this.taskId, message },
			})
		}
	}

	private async saveClineMessages() {
		try {
			await saveTaskMessages({
				messages: this.clineMessages,
				taskId: this.taskId,
				globalStoragePath: this.globalStoragePath,
			})

			const { historyItem, tokenUsage } = await taskMetadata({
				messages: this.clineMessages,
				taskId: this.taskId,
				taskNumber: this.taskNumber,
				globalStoragePath: this.globalStoragePath,
				workspace: this.cwd,
				mode: this._taskMode || defaultModeSlug, // Use the task's own mode, not the current provider mode
			})

			this.emit(RooCodeEventName.TaskTokenUsageUpdated, this.taskId, tokenUsage)

			await this.providerRef.deref()?.updateTaskHistory(historyItem)
		} catch (error) {
			console.error("Failed to save Roo messages:", error)
		}
	}

	// Note that `partial` has three valid states true (partial message),
	// false (completion of partial message), undefined (individual complete
	// message).
	async ask(
		type: ClineAsk,
		text?: string,
		partial?: boolean,
		progressStatus?: ToolProgressStatus,
		isProtected?: boolean,
	): Promise<{ response: ClineAskResponse; text?: string; images?: string[] }> {
		// If this Cline instance was aborted by the provider, then the only
		// thing keeping us alive is a promise still running in the background,
		// in which case we don't want to send its result to the webview as it
		// is attached to a new instance of Cline now. So we can safely ignore
		// the result of any active promises, and this class will be
		// deallocated. (Although we set Cline = undefined in provider, that
		// simply removes the reference to this instance, but the instance is
		// still alive until this promise resolves or rejects.)
		if (this.abort) {
			throw new Error(`[RooCode#ask] task ${this.taskId}.${this.instanceId} aborted`)
		}

		let askTs: number

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "ask" && lastMessage.ask === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					// TODO: Be more efficient about saving and posting only new
					// data or one whole message at a time so ignore partial for
					// saves, and only post parts of partial message instead of
					// whole array in new listener.
					this.updateClineMessage(lastMessage)
					throw new Error("Current ask promise was ignored (#1)")
				} else {
					// This is a new partial message, so add it with partial
					// state.
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, partial, isProtected })
					throw new Error("Current ask promise was ignored (#2)")
				}
			} else {
				if (isUpdatingPreviousPartial) {
					// This is the complete version of a previously partial
					// message, so replace the partial with the complete version.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined

					// Bug for the history books:
					// In the webview we use the ts as the chatrow key for the
					// virtuoso list. Since we would update this ts right at the
					// end of streaming, it would cause the view to flicker. The
					// key prop has to be stable otherwise react has trouble
					// reconciling items between renders, causing unmounting and
					// remounting of components (flickering).
					// The lesson here is if you see flickering when rendering
					// lists, it's likely because the key prop is not stable.
					// So in this case we must make sure that the message ts is
					// never altered after first setting it.
					askTs = lastMessage.ts
					this.lastMessageTs = askTs
					lastMessage.text = text
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					lastMessage.isProtected = isProtected
					await this.saveClineMessages()
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					this.askResponse = undefined
					this.askResponseText = undefined
					this.askResponseImages = undefined
					askTs = Date.now()
					this.lastMessageTs = askTs
					await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			this.askResponse = undefined
			this.askResponseText = undefined
			this.askResponseImages = undefined
			askTs = Date.now()
			this.lastMessageTs = askTs
			await this.addToClineMessages({ ts: askTs, type: "ask", ask: type, text, isProtected })
		}

		// Detect if the task will enter an idle state.
		const isReady = this.askResponse !== undefined || this.lastMessageTs !== askTs

		if (!partial && !isReady && isBlockingAsk(type)) {
			this.blockingAsk = type
			this.emit(RooCodeEventName.TaskIdle, this.taskId)
		}

		console.log(`[Task#${this.taskId}] pWaitFor askResponse(${type}) -> blocking`)
		await pWaitFor(() => this.askResponse !== undefined || this.lastMessageTs !== askTs, { interval: 100 })
		console.log(`[Task#${this.taskId}] pWaitFor askResponse(${type}) -> unblocked (${this.askResponse})`)

		if (this.lastMessageTs !== askTs) {
			// Could happen if we send multiple asks in a row i.e. with
			// command_output. It's important that when we know an ask could
			// fail, it is handled gracefully.
			throw new Error("Current ask promise was ignored")
		}

		const result = { response: this.askResponse!, text: this.askResponseText, images: this.askResponseImages }
		this.askResponse = undefined
		this.askResponseText = undefined
		this.askResponseImages = undefined

		// Switch back to an active state.
		if (this.blockingAsk) {
			this.blockingAsk = undefined
			this.emit(RooCodeEventName.TaskActive, this.taskId)
		}

		this.emit(RooCodeEventName.TaskAskResponded)
		return result
	}

	public setMessageResponse(text: string, images?: string[]) {
		this.handleWebviewAskResponse("messageResponse", text, images)
	}

	handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) {
		this.askResponse = askResponse
		this.askResponseText = text
		this.askResponseImages = images
	}

	public submitUserMessage(text: string, images?: string[]): void {
		try {
			const trimmed = (text ?? "").trim()
			const imgs = images ?? []

			if (!trimmed && imgs.length === 0) {
				return
			}

			const provider = this.providerRef.deref()
			if (!provider) {
				console.error("[Task#submitUserMessage] Provider reference lost")
				return
			}

			void provider.postMessageToWebview({
				type: "invoke",
				invoke: "sendMessage",
				text: trimmed,
				images: imgs,
			})
		} catch (error) {
			console.error("[Task#submitUserMessage] Failed to submit user message:", error)
		}
	}

	async handleTerminalOperation(terminalOperation: "continue" | "abort") {
		if (terminalOperation === "continue") {
			this.terminalProcess?.continue()
		} else if (terminalOperation === "abort") {
			this.terminalProcess?.abort()
		}
	}

	public async condenseContext(): Promise<void> {
		const systemPrompt = await this.getSystemPrompt()

		// Get condensing configuration
		// Using type assertion to handle the case where Phase 1 hasn't been implemented yet
		const state = await this.providerRef.deref()?.getState()
		const customCondensingPrompt = state ? (state as any).customCondensingPrompt : undefined
		const condensingApiConfigId = state ? (state as any).condensingApiConfigId : undefined
		const listApiConfigMeta = state ? (state as any).listApiConfigMeta : undefined

		// Determine API handler to use
		let condensingApiHandler: ApiHandler | undefined
		if (condensingApiConfigId && listApiConfigMeta && Array.isArray(listApiConfigMeta)) {
			// Using type assertion for the id property to avoid implicit any
			const matchingConfig = listApiConfigMeta.find((config: any) => config.id === condensingApiConfigId)
			if (matchingConfig) {
				const profile = await this.providerRef.deref()?.providerSettingsManager.getProfile({
					id: condensingApiConfigId,
				})
				// Ensure profile and apiProvider exist before trying to build handler
				if (profile && profile.apiProvider) {
					condensingApiHandler = buildApiHandler(profile)
				}
			}
		}

		const { contextTokens: prevContextTokens } = this.getTokenUsage()
		const {
			messages,
			summary,
			cost,
			newContextTokens = 0,
			error,
		} = await summarizeConversation(
			this.apiConversationHistory,
			this.api, // Main API handler (fallback)
			systemPrompt, // Default summarization prompt (fallback)
			this.taskId,
			prevContextTokens,
			false, // manual trigger
			customCondensingPrompt, // User's custom prompt
			condensingApiHandler, // Specific handler for condensing
		)
		if (error) {
			this.say(
				"condense_context_error",
				error,
				undefined /* images */,
				false /* partial */,
				undefined /* checkpoint */,
				undefined /* progressStatus */,
				{ isNonInteractive: true } /* options */,
			)
			return
		}
		await this.overwriteApiConversationHistory(messages)
		const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
		await this.say(
			"condense_context",
			undefined /* text */,
			undefined /* images */,
			false /* partial */,
			undefined /* checkpoint */,
			undefined /* progressStatus */,
			{ isNonInteractive: true } /* options */,
			contextCondense,
		)
	}

	async say(
		type: ClineSay,
		text?: string,
		images?: string[],
		partial?: boolean,
		checkpoint?: Record<string, unknown>,
		progressStatus?: ToolProgressStatus,
		options: {
			isNonInteractive?: boolean
			metadata?: Record<string, unknown>
		} = {},
		contextCondense?: ContextCondense,
	): Promise<undefined> {
		if (this.abort) {
			throw new Error(`[RooCode#say] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (partial !== undefined) {
			const lastMessage = this.clineMessages.at(-1)

			const isUpdatingPreviousPartial =
				lastMessage && lastMessage.partial && lastMessage.type === "say" && lastMessage.say === type

			if (partial) {
				if (isUpdatingPreviousPartial) {
					// Existing partial message, so update it.
					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = partial
					lastMessage.progressStatus = progressStatus
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new partial message, so add it with partial state.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						partial,
						contextCondense,
						metadata: options.metadata,
					})
				}
			} else {
				// New now have a complete version of a previously partial message.
				// This is the complete version of a previously partial
				// message, so replace the partial with the complete version.
				if (isUpdatingPreviousPartial) {
					if (!options.isNonInteractive) {
						this.lastMessageTs = lastMessage.ts
					}

					lastMessage.text = text
					lastMessage.images = images
					lastMessage.partial = false
					lastMessage.progressStatus = progressStatus
					if (options.metadata) {
						;(lastMessage as any).metadata = options.metadata
					}

					// Instead of streaming partialMessage events, we do a save
					// and post like normal to persist to disk.
					await this.saveClineMessages()

					// More performant than an entire `postStateToWebview`.
					this.updateClineMessage(lastMessage)
				} else {
					// This is a new and complete message, so add it like normal.
					const sayTs = Date.now()

					if (!options.isNonInteractive) {
						this.lastMessageTs = sayTs
					}

					await this.addToClineMessages({
						ts: sayTs,
						type: "say",
						say: type,
						text,
						images,
						contextCondense,
						metadata: options.metadata,
					})
				}
			}
		} else {
			// This is a new non-partial message, so add it like normal.
			const sayTs = Date.now()

			// A "non-interactive" message is a message is one that the user
			// does not need to respond to. We don't want these message types
			// to trigger an update to `lastMessageTs` since they can be created
			// asynchronously and could interrupt a pending ask.
			if (!options.isNonInteractive) {
				this.lastMessageTs = sayTs
			}

			await this.addToClineMessages({
				ts: sayTs,
				type: "say",
				say: type,
				text,
				images,
				checkpoint,
				contextCondense,
			})
		}
	}

	async sayAndCreateMissingParamError(toolName: ToolName, paramName: string, relPath?: string) {
		await this.say(
			"error",
			`Roo tried to use ${toolName}${
				relPath ? ` for '${relPath.toPosix()}'` : ""
			} without value for required parameter '${paramName}'. Retrying...`,
		)
		return formatResponse.toolError(formatResponse.missingToolParameterError(paramName))
	}

	// Start / Abort / Resume

	private async startTask(task?: string, images?: string[]): Promise<void> {
		if (this.enableTaskBridge) {
			try {
				this.bridgeService = this.bridgeService || ExtensionBridgeService.getInstance()

				if (this.bridgeService) {
					await this.bridgeService.subscribeToTask(this)
				}
			} catch (error) {
				console.error(
					`[Task#startTask] subscribeToTask failed - ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		// `conversationHistory` (for API) and `clineMessages` (for webview)
		// need to be in sync.
		// If the extension process were killed, then on restart the
		// `clineMessages` might not be empty, so we need to set it to [] when
		// we create a new Cline client (otherwise webview would show stale
		// messages from previous session).
		this.clineMessages = []
		this.apiConversationHistory = []
		await this.providerRef.deref()?.postStateToWebview()

		await this.say("text", task, images)
		this.isInitialized = true

		let imageBlocks: Anthropic.ImageBlockParam[] = formatResponse.imageBlocks(images)

		console.log(`[subtasks] task ${this.taskId}.${this.instanceId} starting`)

		await this.initiateTaskLoop([
			{
				type: "text",
				text: `<task>\n${task}\n</task>`,
			},
			...imageBlocks,
		])
	}

	public async resumePausedTask(lastMessage: string) {
		// Release this Cline instance from paused state.
		this.isPaused = false
		this.emit(RooCodeEventName.TaskUnpaused)

		// Fake an answer from the subtask that it has completed running and
		// this is the result of what it has done  add the message to the chat
		// history and to the webview ui.
		try {
			await this.say("subtask_result", lastMessage)

			await this.addToApiConversationHistory({
				role: "user",
				content: [{ type: "text", text: `[new_task completed] Result: ${lastMessage}` }],
			})
		} catch (error) {
			this.providerRef
				.deref()
				?.log(`Error failed to add reply from subtask into conversation of parent task, error: ${error}`)

			throw error
		}
	}

	private async resumeTaskFromHistory() {
		if (this.enableTaskBridge) {
			try {
				this.bridgeService = this.bridgeService || ExtensionBridgeService.getInstance()

				if (this.bridgeService) {
					await this.bridgeService.subscribeToTask(this)
				}
			} catch (error) {
				console.error(
					`[Task#resumeTaskFromHistory] subscribeToTask failed - ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		const modifiedClineMessages = await this.getSavedClineMessages()

		// Remove any resume messages that may have been added before
		const lastRelevantMessageIndex = findLastIndex(
			modifiedClineMessages,
			(m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"),
		)

		if (lastRelevantMessageIndex !== -1) {
			modifiedClineMessages.splice(lastRelevantMessageIndex + 1)
		}

		// Since we don't use `api_req_finished` anymore, we need to check if the
		// last `api_req_started` has a cost value, if it doesn't and no
		// cancellation reason to present, then we remove it since it indicates
		// an api request without any partial content streamed.
		const lastApiReqStartedIndex = findLastIndex(
			modifiedClineMessages,
			(m) => m.type === "say" && m.say === "api_req_started",
		)

		if (lastApiReqStartedIndex !== -1) {
			const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex]
			const { cost, cancelReason }: ClineApiReqInfo = JSON.parse(lastApiReqStarted.text || "{}")

			if (cost === undefined && cancelReason === undefined) {
				modifiedClineMessages.splice(lastApiReqStartedIndex, 1)
			}
		}

		await this.overwriteClineMessages(modifiedClineMessages)
		this.clineMessages = await this.getSavedClineMessages()

		// Now present the cline messages to the user and ask if they want to
		// resume (NOTE: we ran into a bug before where the
		// apiConversationHistory wouldn't be initialized when opening a old
		// task, and it was because we were waiting for resume).
		// This is important in case the user deletes messages without resuming
		// the task first.
		this.apiConversationHistory = await this.getSavedApiConversationHistory()

		const lastClineMessage = this.clineMessages
			.slice()
			.reverse()
			.find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")) // Could be multiple resume tasks.

		let askType: ClineAsk
		if (lastClineMessage?.ask === "completion_result") {
			askType = "resume_completed_task"
		} else {
			askType = "resume_task"
		}

		this.isInitialized = true

		const { response, text, images } = await this.ask(askType) // Calls `postStateToWebview`.

		let responseText: string | undefined
		let responseImages: string[] | undefined

		if (response === "messageResponse") {
			await this.say("user_feedback", text, images)
			responseText = text
			responseImages = images
		}

		// Make sure that the api conversation history can be resumed by the API,
		// even if it goes out of sync with cline messages.
		let existingApiConversationHistory: ApiMessage[] = await this.getSavedApiConversationHistory()

		// v2.0 xml tags refactor caveat: since we don't use tools anymore, we need to replace all tool use blocks with a text block since the API disallows conversations with tool uses and no tool schema
		const conversationWithoutToolBlocks = existingApiConversationHistory.map((message) => {
			if (Array.isArray(message.content)) {
				const newContent = message.content.map((block) => {
					if (block.type === "tool_use") {
						// It's important we convert to the new tool schema
						// format so the model doesn't get confused about how to
						// invoke tools.
						const inputAsXml = Object.entries(block.input as Record<string, string>)
							.map(([key, value]) => `<${key}>\n${value}\n</${key}>`)
							.join("\n")
						return {
							type: "text",
							text: `<${block.name}>\n${inputAsXml}\n</${block.name}>`,
						} as Anthropic.Messages.TextBlockParam
					} else if (block.type === "tool_result") {
						// Convert block.content to text block array, removing images
						const contentAsTextBlocks = Array.isArray(block.content)
							? block.content.filter((item) => item.type === "text")
							: [{ type: "text", text: block.content }]
						const textContent = contentAsTextBlocks.map((item) => item.text).join("\n\n")
						const toolName = findToolName(block.tool_use_id, existingApiConversationHistory)
						return {
							type: "text",
							text: `[${toolName} Result]\n\n${textContent}`,
						} as Anthropic.Messages.TextBlockParam
					}
					return block
				})
				return { ...message, content: newContent }
			}
			return message
		})
		existingApiConversationHistory = conversationWithoutToolBlocks

		// FIXME: remove tool use blocks altogether

		// if the last message is an assistant message, we need to check if there's tool use since every tool use has to have a tool response
		// if there's no tool use and only a text block, then we can just add a user message
		// (note this isn't relevant anymore since we use custom tool prompts instead of tool use blocks, but this is here for legacy purposes in case users resume old tasks)

		// if the last message is a user message, we can need to get the assistant message before it to see if it made tool calls, and if so, fill in the remaining tool responses with 'interrupted'

		let modifiedOldUserContent: Anthropic.Messages.ContentBlockParam[] // either the last message if its user message, or the user message before the last (assistant) message
		let modifiedApiConversationHistory: ApiMessage[] // need to remove the last user message to replace with new modified user message
		if (existingApiConversationHistory.length > 0) {
			const lastMessage = existingApiConversationHistory[existingApiConversationHistory.length - 1]

			if (lastMessage.role === "assistant") {
				const content = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				const hasToolUse = content.some((block) => block.type === "tool_use")

				if (hasToolUse) {
					const toolUseBlocks = content.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]
					const toolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => ({
						type: "tool_result",
						tool_use_id: block.id,
						content: "Task was interrupted before this tool call could be completed.",
					}))
					modifiedApiConversationHistory = [...existingApiConversationHistory] // no changes
					modifiedOldUserContent = [...toolResponses]
				} else {
					modifiedApiConversationHistory = [...existingApiConversationHistory]
					modifiedOldUserContent = []
				}
			} else if (lastMessage.role === "user") {
				const previousAssistantMessage: ApiMessage | undefined =
					existingApiConversationHistory[existingApiConversationHistory.length - 2]

				const existingUserContent: Anthropic.Messages.ContentBlockParam[] = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text", text: lastMessage.content }]
				if (previousAssistantMessage && previousAssistantMessage.role === "assistant") {
					const assistantContent = Array.isArray(previousAssistantMessage.content)
						? previousAssistantMessage.content
						: [{ type: "text", text: previousAssistantMessage.content }]

					const toolUseBlocks = assistantContent.filter(
						(block) => block.type === "tool_use",
					) as Anthropic.Messages.ToolUseBlock[]

					if (toolUseBlocks.length > 0) {
						const existingToolResults = existingUserContent.filter(
							(block) => block.type === "tool_result",
						) as Anthropic.ToolResultBlockParam[]

						const missingToolResponses: Anthropic.ToolResultBlockParam[] = toolUseBlocks
							.filter(
								(toolUse) => !existingToolResults.some((result) => result.tool_use_id === toolUse.id),
							)
							.map((toolUse) => ({
								type: "tool_result",
								tool_use_id: toolUse.id,
								content: "Task was interrupted before this tool call could be completed.",
							}))

						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1) // removes the last user message
						modifiedOldUserContent = [...existingUserContent, ...missingToolResponses]
					} else {
						modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
						modifiedOldUserContent = [...existingUserContent]
					}
				} else {
					modifiedApiConversationHistory = existingApiConversationHistory.slice(0, -1)
					modifiedOldUserContent = [...existingUserContent]
				}
			} else {
				throw new Error("Unexpected: Last message is not a user or assistant message")
			}
		} else {
			throw new Error("Unexpected: No existing API conversation history")
		}

		let newUserContent: Anthropic.Messages.ContentBlockParam[] = [...modifiedOldUserContent]

		const agoText = ((): string => {
			const timestamp = lastClineMessage?.ts ?? Date.now()
			const now = Date.now()
			const diff = now - timestamp
			const minutes = Math.floor(diff / 60000)
			const hours = Math.floor(minutes / 60)
			const days = Math.floor(hours / 24)

			if (days > 0) {
				return `${days} day${days > 1 ? "s" : ""} ago`
			}
			if (hours > 0) {
				return `${hours} hour${hours > 1 ? "s" : ""} ago`
			}
			if (minutes > 0) {
				return `${minutes} minute${minutes > 1 ? "s" : ""} ago`
			}
			return "just now"
		})()

		if (responseText) {
			newUserContent.push({
				type: "text",
				text: `\n\nNew instructions for task continuation:\n<user_message>\n${responseText}\n</user_message>`,
			})
		}

		if (responseImages && responseImages.length > 0) {
			newUserContent.push(...formatResponse.imageBlocks(responseImages))
		}

		// Ensure we have at least some content to send to the API
		// If newUserContent is empty, add a minimal resumption message
		if (newUserContent.length === 0) {
			newUserContent.push({
				type: "text",
				text: "[TASK RESUMPTION] Resuming task...",
			})
		}

		await this.overwriteApiConversationHistory(modifiedApiConversationHistory)

		console.log(`[subtasks] task ${this.taskId}.${this.instanceId} resuming from history item`)

		await this.initiateTaskLoop(newUserContent)
	}

	public dispose(): void {
		console.log(`[Task] disposing task ${this.taskId}.${this.instanceId}`)

		// Stop waiting for child task completion.
		if (this.pauseInterval) {
			clearInterval(this.pauseInterval)
			this.pauseInterval = undefined
		}

		// Unsubscribe from TaskBridge service.
		if (this.bridgeService) {
			this.bridgeService
				.unsubscribeFromTask(this.taskId)
				.catch((error) => console.error("Error unsubscribing from task bridge:", error))
			this.bridgeService = null
		}

		// Release any terminals associated with this task.
		try {
			// Release any terminals associated with this task.
			TerminalRegistry.releaseTerminalsForTask(this.taskId)
		} catch (error) {
			console.error("Error releasing terminals:", error)
		}

		try {
			this.urlContentFetcher.closeBrowser()
		} catch (error) {
			console.error("Error closing URL content fetcher browser:", error)
		}

		try {
			this.browserSession.closeBrowser()
		} catch (error) {
			console.error("Error closing browser session:", error)
		}

		try {
			if (this.rooIgnoreController) {
				this.rooIgnoreController.dispose()
				this.rooIgnoreController = undefined
			}
		} catch (error) {
			console.error("Error disposing RooIgnoreController:", error)
			// This is the critical one for the leak fix.
		}

		try {
			this.fileContextTracker.dispose()
		} catch (error) {
			console.error("Error disposing file context tracker:", error)
		}

		try {
			// If we're not streaming then `abortStream` won't be called.
			if (this.isStreaming && this.diffViewProvider.isEditing) {
				this.diffViewProvider.revertChanges().catch(console.error)
			}
		} catch (error) {
			console.error("Error reverting diff changes:", error)
		}
	}

	public async abortTask(isAbandoned = false) {
		console.log(`[subtasks] aborting task ${this.taskId}.${this.instanceId}`)

		// Will stop any autonomously running promises.
		if (isAbandoned) {
			this.abandoned = true
		}

		this.abort = true
		this.emit(RooCodeEventName.TaskAborted)

		try {
			this.dispose() // Call the centralized dispose method
		} catch (error) {
			console.error(`Error during task ${this.taskId}.${this.instanceId} disposal:`, error)
			// Don't rethrow - we want abort to always succeed
		}
		// Save the countdown message in the automatic retry or other content.
		try {
			// Save the countdown message in the automatic retry or other content.
			await this.saveClineMessages()
		} catch (error) {
			console.error(`Error saving messages during abort for task ${this.taskId}.${this.instanceId}:`, error)
		}
	}

	// Used when a sub-task is launched and the parent task is waiting for it to
	// finish.
	// TBD: The 1s should be added to the settings, also should add a timeout to
	// prevent infinite waiting.
	public async waitForResume() {
		await new Promise<void>((resolve) => {
			this.pauseInterval = setInterval(() => {
				if (!this.isPaused) {
					clearInterval(this.pauseInterval)
					this.pauseInterval = undefined
					resolve()
				}
			}, 1000)
		})
	}

	// Task Loop

	private async initiateTaskLoop(userContent: Anthropic.Messages.ContentBlockParam[]): Promise<void> {
		// Kicks off the checkpoints initialization process in the background.
		getCheckpointService(this)

		let nextUserContent = userContent
		let includeFileDetails = true

		this.emit(RooCodeEventName.TaskStarted)

		while (!this.abort) {
			const didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails)
			includeFileDetails = false // We only need file details the first time.

			// The way this agentic loop works is that cline will be given a
			// task that he then calls tools to complete. Unless there's an
			// attempt_completion call, we keep responding back to him with his
			// tool's responses until he either attempt_completion or does not
			// use anymore tools. If he does not use anymore tools, we ask him
			// to consider if he's completed the task and then call
			// attempt_completion, otherwise proceed with completing the task.
			// There is a MAX_REQUESTS_PER_TASK limit to prevent infinite
			// requests, but Cline is prompted to finish the task as efficiently
			// as he can.

			if (didEndLoop) {
				// For now a task never 'completes'. This will only happen if
				// the user hits max requests and denies resetting the count.
				break
			} else {
				nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }]
				this.consecutiveMistakeCount++
			}
		}
	}

	public async recursivelyMakeClineRequests(
		userContent: Anthropic.Messages.ContentBlockParam[],
		includeFileDetails: boolean = false,
	): Promise<boolean> {
		if (this.abort) {
			throw new Error(`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`)
		}

		if (this.consecutiveMistakeLimit > 0 && this.consecutiveMistakeCount >= this.consecutiveMistakeLimit) {
			const { response, text, images } = await this.ask(
				"mistake_limit_reached",
				t("common:errors.mistake_limit_guidance"),
			)

			if (response === "messageResponse") {
				userContent.push(
					...[
						{ type: "text" as const, text: formatResponse.tooManyMistakes(text) },
						...formatResponse.imageBlocks(images),
					],
				)

				await this.say("user_feedback", text, images)

				// Track consecutive mistake errors in telemetry.
				TelemetryService.instance.captureConsecutiveMistakeError(this.taskId)
			}

			this.consecutiveMistakeCount = 0
		}

		// In this Cline request loop, we need to check if this task instance
		// has been asked to wait for a subtask to finish before continuing.
		const provider = this.providerRef.deref()

		if (this.isPaused && provider) {
			provider.log(`[subtasks] paused ${this.taskId}.${this.instanceId}`)
			await this.waitForResume()
			provider.log(`[subtasks] resumed ${this.taskId}.${this.instanceId}`)
			const currentMode = (await provider.getState())?.mode ?? defaultModeSlug

			if (currentMode !== this.pausedModeSlug) {
				// The mode has changed, we need to switch back to the paused mode.
				await provider.handleModeSwitch(this.pausedModeSlug)

				// Delay to allow mode change to take effect before next tool is executed.
				await delay(500)

				provider.log(
					`[subtasks] task ${this.taskId}.${this.instanceId} has switched back to '${this.pausedModeSlug}' from '${currentMode}'`,
				)
			}
		}

		// Getting verbose details is an expensive operation, it uses ripgrep to
		// top-down build file structure of project which for large projects can
		// take a few seconds. For the best UX we show a placeholder api_req_started
		// message with a loading spinner as this happens.

		// Determine API protocol based on provider and model
		const modelId = getModelId(this.apiConfiguration)
		const apiProtocol = getApiProtocol(this.apiConfiguration.apiProvider, modelId)

		await this.say(
			"api_req_started",
			JSON.stringify({
				request:
					userContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n") + "\n\nLoading...",
				apiProtocol,
			}),
		)

		const {
			showRooIgnoredFiles = true,
			includeDiagnosticMessages = true,
			maxDiagnosticMessages = 50,
			maxReadFileLine = -1,
		} = (await this.providerRef.deref()?.getState()) ?? {}

		const parsedUserContent = await processUserContentMentions({
			userContent,
			cwd: this.cwd,
			urlContentFetcher: this.urlContentFetcher,
			fileContextTracker: this.fileContextTracker,
			rooIgnoreController: this.rooIgnoreController,
			showRooIgnoredFiles,
			includeDiagnosticMessages,
			maxDiagnosticMessages,
			maxReadFileLine,
		})

		const environmentDetails = await getEnvironmentDetails(this, includeFileDetails)

		// Add environment details as its own text block, separate from tool
		// results.
		const finalUserContent = [...parsedUserContent, { type: "text" as const, text: environmentDetails }]

		await this.addToApiConversationHistory({ role: "user", content: finalUserContent })
		TelemetryService.instance.captureConversationMessage(this.taskId, "user")

		// Since we sent off a placeholder api_req_started message to update the
		// webview while waiting to actually start the API request (to load
		// potential details for example), we need to update the text of that
		// message.
		const lastApiReqIndex = findLastIndex(this.clineMessages, (m) => m.say === "api_req_started")

		this.clineMessages[lastApiReqIndex].text = JSON.stringify({
			request: finalUserContent.map((block) => formatContentBlockToMarkdown(block)).join("\n\n"),
			apiProtocol,
		} satisfies ClineApiReqInfo)

		await this.saveClineMessages()
		await provider?.postStateToWebview()

		try {
			let cacheWriteTokens = 0
			let cacheReadTokens = 0
			let inputTokens = 0
			let outputTokens = 0
			let totalCost: number | undefined

			// We can't use `api_req_finished` anymore since it's a unique case
			// where it could come after a streaming message (i.e. in the middle
			// of being updated or executed).
			// Fortunately `api_req_finished` was always parsed out for the GUI
			// anyways, so it remains solely for legacy purposes to keep track
			// of prices in tasks from history (it's worth removing a few months
			// from now).
			const updateApiReqMsg = (cancelReason?: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
				const existingData = JSON.parse(this.clineMessages[lastApiReqIndex].text || "{}")
				this.clineMessages[lastApiReqIndex].text = JSON.stringify({
					...existingData,
					tokensIn: inputTokens,
					tokensOut: outputTokens,
					cacheWrites: cacheWriteTokens,
					cacheReads: cacheReadTokens,
					cost:
						totalCost ??
						calculateApiCostAnthropic(
							this.api.getModel().info,
							inputTokens,
							outputTokens,
							cacheWriteTokens,
							cacheReadTokens,
						),
					cancelReason,
					streamingFailedMessage,
				} satisfies ClineApiReqInfo)
			}

			const abortStream = async (cancelReason: ClineApiReqCancelReason, streamingFailedMessage?: string) => {
				if (this.diffViewProvider.isEditing) {
					await this.diffViewProvider.revertChanges() // closes diff view
				}

				// if last message is a partial we need to update and save it
				const lastMessage = this.clineMessages.at(-1)

				if (lastMessage && lastMessage.partial) {
					// lastMessage.ts = Date.now() DO NOT update ts since it is used as a key for virtuoso list
					lastMessage.partial = false
					// instead of streaming partialMessage events, we do a save and post like normal to persist to disk
					console.log("updating partial message", lastMessage)
					// await this.saveClineMessages()
				}

				// Let assistant know their response was interrupted for when task is resumed
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text:
								assistantMessage +
								`\n\n[${
									cancelReason === "streaming_failed"
										? "Response interrupted by API Error"
										: "Response interrupted by user"
								}]`,
						},
					],
				})

				// Update `api_req_started` to have cancelled and cost, so that
				// we can display the cost of the partial stream.
				updateApiReqMsg(cancelReason, streamingFailedMessage)
				await this.saveClineMessages()

				// Signals to provider that it can retrieve the saved messages
				// from disk, as abortTask can not be awaited on in nature.
				this.didFinishAbortingStream = true
			}

			// Reset streaming state.
			this.currentStreamingContentIndex = 0
			this.currentStreamingDidCheckpoint = false
			this.assistantMessageContent = []
			this.didCompleteReadingStream = false
			this.userMessageContent = []
			this.userMessageContentReady = false
			this.didRejectTool = false
			this.didAlreadyUseTool = false
			this.presentAssistantMessageLocked = false
			this.presentAssistantMessageHasPendingUpdates = false
			if (this.assistantMessageParser) {
				this.assistantMessageParser.reset()
			}

			await this.diffViewProvider.reset()

			// Yields only if the first chunk is successful, otherwise will
			// allow the user to retry the request (most likely due to rate
			// limit error, which gets thrown on the first chunk).
			const stream = this.attemptApiRequest()
			let assistantMessage = ""
			let reasoningMessage = ""
			this.isStreaming = true

			try {
				for await (const chunk of stream) {
					if (!chunk) {
						// Sometimes chunk is undefined, no idea that can cause
						// it, but this workaround seems to fix it.
						continue
					}

					switch (chunk.type) {
						case "reasoning":
							reasoningMessage += chunk.text
							await this.say("reasoning", reasoningMessage, undefined, true)
							break
						case "usage":
							inputTokens += chunk.inputTokens
							outputTokens += chunk.outputTokens
							cacheWriteTokens += chunk.cacheWriteTokens ?? 0
							cacheReadTokens += chunk.cacheReadTokens ?? 0
							totalCost = chunk.totalCost
							break
						case "text": {
							assistantMessage += chunk.text

							// Parse raw assistant message chunk into content blocks.
							const prevLength = this.assistantMessageContent.length
							if (this.isAssistantMessageParserEnabled && this.assistantMessageParser) {
								this.assistantMessageContent = this.assistantMessageParser.processChunk(chunk.text)
							} else {
								// Use the old parsing method when experiment is disabled
								this.assistantMessageContent = parseAssistantMessage(assistantMessage)
							}

							if (this.assistantMessageContent.length > prevLength) {
								// New content we need to present, reset to
								// false in case previous content set this to true.
								this.userMessageContentReady = false
							}

							// Present content to user.
							presentAssistantMessage(this)
							break
						}
					}

					if (this.abort) {
						console.log(`aborting stream, this.abandoned = ${this.abandoned}`)

						if (!this.abandoned) {
							// Only need to gracefully abort if this instance
							// isn't abandoned (sometimes OpenRouter stream
							// hangs, in which case this would affect future
							// instances of Cline).
							await abortStream("user_cancelled")
						}

						break // Aborts the stream.
					}

					if (this.didRejectTool) {
						// `userContent` has a tool rejection, so interrupt the
						// assistant's response to present the user's feedback.
						assistantMessage += "\n\n[Response interrupted by user feedback]"
						// Instead of setting this preemptively, we allow the
						// present iterator to finish and set
						// userMessageContentReady when its ready.
						// this.userMessageContentReady = true
						break
					}

					// PREV: We need to let the request finish for openrouter to
					// get generation details.
					// UPDATE: It's better UX to interrupt the request at the
					// cost of the API cost not being retrieved.
					if (this.didAlreadyUseTool) {
						assistantMessage +=
							"\n\n[Response interrupted by a tool use result. Only one tool may be used at a time and should be placed at the end of the message.]"
						break
					}
				}
			} catch (error) {
				// Abandoned happens when extension is no longer waiting for the
				// Cline instance to finish aborting (error is thrown here when
				// any function in the for loop throws due to this.abort).
				if (!this.abandoned) {
					// If the stream failed, there's various states the task
					// could be in (i.e. could have streamed some tools the user
					// may have executed), so we just resort to replicating a
					// cancel task.

					// Check if this was a user-initiated cancellation BEFORE calling abortTask
					// If this.abort is already true, it means the user clicked cancel, so we should
					// treat this as "user_cancelled" rather than "streaming_failed"
					const cancelReason = this.abort ? "user_cancelled" : "streaming_failed"

					const streamingFailedMessage = this.abort
						? undefined
						: (error.message ?? JSON.stringify(serializeError(error), null, 2))

					// Now call abortTask after determining the cancel reason.
					await this.abortTask()
					await abortStream(cancelReason, streamingFailedMessage)

					const history = await provider?.getTaskWithId(this.taskId)

					if (history) {
						await provider?.initClineWithHistoryItem(history.historyItem)
					}
				}
			} finally {
				this.isStreaming = false
			}

			if (inputTokens > 0 || outputTokens > 0 || cacheWriteTokens > 0 || cacheReadTokens > 0) {
				TelemetryService.instance.captureLlmCompletion(this.taskId, {
					inputTokens,
					outputTokens,
					cacheWriteTokens,
					cacheReadTokens,
					cost:
						totalCost ??
						calculateApiCostAnthropic(
							this.api.getModel().info,
							inputTokens,
							outputTokens,
							cacheWriteTokens,
							cacheReadTokens,
						),
				})
			}

			// Need to call here in case the stream was aborted.
			if (this.abort || this.abandoned) {
				throw new Error(`[RooCode#recursivelyMakeRooRequests] task ${this.taskId}.${this.instanceId} aborted`)
			}

			this.didCompleteReadingStream = true

			// Set any blocks to be complete to allow `presentAssistantMessage`
			// to finish and set `userMessageContentReady` to true.
			// (Could be a text block that had no subsequent tool uses, or a
			// text block at the very end, or an invalid tool use, etc. Whatever
			// the case, `presentAssistantMessage` relies on these blocks either
			// to be completed or the user to reject a block in order to proceed
			// and eventually set userMessageContentReady to true.)
			const partialBlocks = this.assistantMessageContent.filter((block) => block.partial)
			partialBlocks.forEach((block) => (block.partial = false))

			// Can't just do this b/c a tool could be in the middle of executing.
			// this.assistantMessageContent.forEach((e) => (e.partial = false))

			// Now that the stream is complete, finalize any remaining partial content blocks
			if (this.isAssistantMessageParserEnabled && this.assistantMessageParser) {
				this.assistantMessageParser.finalizeContentBlocks()
				this.assistantMessageContent = this.assistantMessageParser.getContentBlocks()
			}
			// When using old parser, no finalization needed - parsing already happened during streaming

			if (partialBlocks.length > 0) {
				// If there is content to update then it will complete and
				// update `this.userMessageContentReady` to true, which we
				// `pWaitFor` before making the next request. All this is really
				// doing is presenting the last partial message that we just set
				// to complete.
				presentAssistantMessage(this)
			}

			await this.persistGpt5Metadata(reasoningMessage)

			updateApiReqMsg()
			await this.saveClineMessages()
			await this.providerRef.deref()?.postStateToWebview()

			// Reset parser after each complete conversation round
			if (this.assistantMessageParser) {
				this.assistantMessageParser.reset()
			}

			// Now add to apiConversationHistory.
			// Need to save assistant responses to file before proceeding to
			// tool use since user can exit at any moment and we wouldn't be
			// able to save the assistant's response.
			let didEndLoop = false

			if (assistantMessage.length > 0) {
				await this.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: assistantMessage }],
				})

				TelemetryService.instance.captureConversationMessage(this.taskId, "assistant")

				// NOTE: This comment is here for future reference - this was a
				// workaround for `userMessageContent` not getting set to true.
				// It was due to it not recursively calling for partial blocks
				// when `didRejectTool`, so it would get stuck waiting for a
				// partial block to complete before it could continue.
				// In case the content blocks finished it may be the api stream
				// finished after the last parsed content block was executed, so
				// we are able to detect out of bounds and set
				// `userMessageContentReady` to true (note you should not call
				// `presentAssistantMessage` since if the last block i
				//  completed it will be presented again).
				// const completeBlocks = this.assistantMessageContent.filter((block) => !block.partial) // If there are any partial blocks after the stream ended we can consider them invalid.
				// if (this.currentStreamingContentIndex >= completeBlocks.length) {
				// 	this.userMessageContentReady = true
				// }

				await pWaitFor(() => this.userMessageContentReady)

				// If the model did not tool use, then we need to tell it to
				// either use a tool or attempt_completion.
				const didToolUse = this.assistantMessageContent.some((block) => block.type === "tool_use")

				if (!didToolUse) {
					this.userMessageContent.push({ type: "text", text: formatResponse.noToolsUsed() })
					this.consecutiveMistakeCount++
				}

				const recDidEndLoop = await this.recursivelyMakeClineRequests(this.userMessageContent)
				didEndLoop = recDidEndLoop
			} else {
				// If there's no assistant_responses, that means we got no text
				// or tool_use content blocks from API which we should assume is
				// an error.
				await this.say(
					"error",
					"Unexpected API Response: The language model did not provide any assistant messages. This may indicate an issue with the API or the model's output.",
				)

				await this.addToApiConversationHistory({
					role: "assistant",
					content: [{ type: "text", text: "Failure: I did not provide a response." }],
				})
			}

			return didEndLoop // Will always be false for now.
		} catch (error) {
			// This should never happen since the only thing that can throw an
			// error is the attemptApiRequest, which is wrapped in a try catch
			// that sends an ask where if noButtonClicked, will clear current
			// task and destroy this instance. However to avoid unhandled
			// promise rejection, we will end this loop which will end execution
			// of this instance (see `startTask`).
			return true // Needs to be true so parent loop knows to end task.
		}
	}

	private async getSystemPrompt(): Promise<string> {
		const { mcpEnabled } = (await this.providerRef.deref()?.getState()) ?? {}
		let mcpHub: McpHub | undefined
		if (mcpEnabled ?? true) {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider reference lost during view transition")
			}

			// Wait for MCP hub initialization through McpServerManager
			mcpHub = await McpServerManager.getInstance(provider.context, provider)

			if (!mcpHub) {
				throw new Error("Failed to get MCP hub from server manager")
			}

			// Wait for MCP servers to be connected before generating system prompt
			await pWaitFor(() => !mcpHub!.isConnecting, { timeout: 10_000 }).catch(() => {
				console.error("MCP servers failed to connect in time")
			})
		}

		const rooIgnoreInstructions = this.rooIgnoreController?.getInstructions()

		const state = await this.providerRef.deref()?.getState()

		const {
			browserViewportSize,
			mode,
			customModes,
			customModePrompts,
			customInstructions,
			experiments,
			enableMcpServerCreation,
			browserToolEnabled,
			language,
			maxConcurrentFileReads,
			maxReadFileLine,
			apiConfiguration,
		} = state ?? {}

		return await (async () => {
			const provider = this.providerRef.deref()

			if (!provider) {
				throw new Error("Provider not available")
			}

			return SYSTEM_PROMPT(
				provider.context,
				this.cwd,
				(this.api.getModel().info.supportsComputerUse ?? false) && (browserToolEnabled ?? true),
				mcpHub,
				this.diffStrategy,
				browserViewportSize,
				mode,
				customModePrompts,
				customModes,
				customInstructions,
				this.diffEnabled,
				experiments,
				enableMcpServerCreation,
				language,
				rooIgnoreInstructions,
				maxReadFileLine !== -1,
				{
					maxConcurrentFileReads: maxConcurrentFileReads ?? 5,
					todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
					useAgentRules: vscode.workspace.getConfiguration("roo-cline").get<boolean>("useAgentRules") ?? true,
				},
			)
		})()
	}

	public async *attemptApiRequest(retryAttempt: number = 0): ApiStream {
		const state = await this.providerRef.deref()?.getState()

		const {
			apiConfiguration,
			autoApprovalEnabled,
			alwaysApproveResubmit,
			requestDelaySeconds,
			mode,
			autoCondenseContext = true,
			autoCondenseContextPercent = 100,
			profileThresholds = {},
		} = state ?? {}

		// Get condensing configuration for automatic triggers.
		const customCondensingPrompt = state?.customCondensingPrompt
		const condensingApiConfigId = state?.condensingApiConfigId
		const listApiConfigMeta = state?.listApiConfigMeta

		// Determine API handler to use for condensing.
		let condensingApiHandler: ApiHandler | undefined

		if (condensingApiConfigId && listApiConfigMeta && Array.isArray(listApiConfigMeta)) {
			// Using type assertion for the id property to avoid implicit any.
			const matchingConfig = listApiConfigMeta.find((config: any) => config.id === condensingApiConfigId)

			if (matchingConfig) {
				const profile = await this.providerRef.deref()?.providerSettingsManager.getProfile({
					id: condensingApiConfigId,
				})

				// Ensure profile and apiProvider exist before trying to build handler.
				if (profile && profile.apiProvider) {
					condensingApiHandler = buildApiHandler(profile)
				}
			}
		}

		let rateLimitDelay = 0

		// Use the shared timestamp so that subtasks respect the same rate-limit
		// window as their parent tasks.
		if (Task.lastGlobalApiRequestTime) {
			const now = Date.now()
			const timeSinceLastRequest = now - Task.lastGlobalApiRequestTime
			const rateLimit = apiConfiguration?.rateLimitSeconds || 0
			rateLimitDelay = Math.ceil(Math.max(0, rateLimit * 1000 - timeSinceLastRequest) / 1000)
		}

		// Only show rate limiting message if we're not retrying. If retrying, we'll include the delay there.
		if (rateLimitDelay > 0 && retryAttempt === 0) {
			// Show countdown timer
			for (let i = rateLimitDelay; i > 0; i--) {
				const delayMessage = `Rate limiting for ${i} seconds...`
				await this.say("api_req_retry_delayed", delayMessage, undefined, true)
				await delay(1000)
			}
		}

		// Update last request time before making the request so that subsequent
		// requests — even from new subtasks — will honour the provider's rate-limit.
		Task.lastGlobalApiRequestTime = Date.now()

		const systemPrompt = await this.getSystemPrompt()
		this.lastUsedInstructions = systemPrompt
		const { contextTokens } = this.getTokenUsage()

		if (contextTokens) {
			const modelInfo = this.api.getModel().info

			const maxTokens = getModelMaxOutputTokens({
				modelId: this.api.getModel().id,
				model: modelInfo,
				settings: this.apiConfiguration,
			})

			const contextWindow = modelInfo.contextWindow

			const currentProfileId =
				state?.listApiConfigMeta.find((profile) => profile.name === state?.currentApiConfigName)?.id ??
				"default"

			const truncateResult = await truncateConversationIfNeeded({
				messages: this.apiConversationHistory,
				totalTokens: contextTokens,
				maxTokens,
				contextWindow,
				apiHandler: this.api,
				autoCondenseContext,
				autoCondenseContextPercent,
				systemPrompt,
				taskId: this.taskId,
				customCondensingPrompt,
				condensingApiHandler,
				profileThresholds,
				currentProfileId,
			})
			if (truncateResult.messages !== this.apiConversationHistory) {
				await this.overwriteApiConversationHistory(truncateResult.messages)
			}
			if (truncateResult.error) {
				await this.say("condense_context_error", truncateResult.error)
			} else if (truncateResult.summary) {
				// A condense operation occurred; for the next GPT‑5 API call we should NOT
				// send previous_response_id so the request reflects the fresh condensed context.
				this.skipPrevResponseIdOnce = true

				const { summary, cost, prevContextTokens, newContextTokens = 0 } = truncateResult
				const contextCondense: ContextCondense = { summary, cost, newContextTokens, prevContextTokens }
				await this.say(
					"condense_context",
					undefined /* text */,
					undefined /* images */,
					false /* partial */,
					undefined /* checkpoint */,
					undefined /* progressStatus */,
					{ isNonInteractive: true } /* options */,
					contextCondense,
				)
			}
		}

		const messagesSinceLastSummary = getMessagesSinceLastSummary(this.apiConversationHistory)
		let cleanConversationHistory = maybeRemoveImageBlocks(messagesSinceLastSummary, this.api).map(
			({ role, content }) => ({ role, content }),
		)

		// Check auto-approval limits
		const approvalResult = await this.autoApprovalHandler.checkAutoApprovalLimits(
			state,
			this.combineMessages(this.clineMessages.slice(1)),
			async (type, data) => this.ask(type, data),
		)

		if (!approvalResult.shouldProceed) {
			// User did not approve, task should be aborted
			throw new Error("Auto-approval limit reached and user did not approve continuation")
		}

		// Determine GPT‑5 previous_response_id from last persisted assistant turn (if available),
		// unless a condense just occurred (skip once after condense).
		let previousResponseId: string | undefined = undefined
		try {
			const modelId = this.api.getModel().id
			if (modelId && modelId.startsWith("gpt-5") && !this.skipPrevResponseIdOnce) {
				// Find the last assistant message that has a previous_response_id stored
				const idx = findLastIndex(
					this.clineMessages,
					(m) =>
						m.type === "say" &&
						(m as any).say === "text" &&
						(m as any).metadata?.gpt5?.previous_response_id,
				)
				if (idx !== -1) {
					// Use the previous_response_id from the last assistant message for this request
					previousResponseId = ((this.clineMessages[idx] as any).metadata.gpt5.previous_response_id ||
						undefined) as string | undefined
				}
			}
		} catch {
			// non-fatal
		}

		const metadata: ApiHandlerCreateMessageMetadata = {
			mode: mode,
			taskId: this.taskId,
			...(previousResponseId ? { previousResponseId } : {}),
			// If a condense just occurred, explicitly suppress continuity fallback for the next call
			...(this.skipPrevResponseIdOnce ? { suppressPreviousResponseId: true } : {}),
		}

		// Reset skip flag after applying (it only affects the immediate next call)
		if (this.skipPrevResponseIdOnce) {
			this.skipPrevResponseIdOnce = false
		}

		const stream = this.api.createMessage(systemPrompt, cleanConversationHistory, metadata)
		const iterator = stream[Symbol.asyncIterator]()

		try {
			// Awaiting first chunk to see if it will throw an error.
			this.isWaitingForFirstChunk = true
			const firstChunk = await iterator.next()
			yield firstChunk.value
			this.isWaitingForFirstChunk = false
		} catch (error) {
			this.isWaitingForFirstChunk = false
			// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.
			if (autoApprovalEnabled && alwaysApproveResubmit) {
				let errorMsg

				if (error.error?.metadata?.raw) {
					errorMsg = JSON.stringify(error.error.metadata.raw, null, 2)
				} else if (error.message) {
					errorMsg = error.message
				} else {
					errorMsg = "Unknown error"
				}

				const baseDelay = requestDelaySeconds || 5
				let exponentialDelay = Math.min(
					Math.ceil(baseDelay * Math.pow(2, retryAttempt)),
					MAX_EXPONENTIAL_BACKOFF_SECONDS,
				)

				// If the error is a 429, and the error details contain a retry delay, use that delay instead of exponential backoff
				if (error.status === 429) {
					const geminiRetryDetails = error.errorDetails?.find(
						(detail: any) => detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
					)
					if (geminiRetryDetails) {
						const match = geminiRetryDetails?.retryDelay?.match(/^(\d+)s$/)
						if (match) {
							exponentialDelay = Number(match[1]) + 1
						}
					}
				}

				// Wait for the greater of the exponential delay or the rate limit delay
				const finalDelay = Math.max(exponentialDelay, rateLimitDelay)

				// Show countdown timer with exponential backoff
				for (let i = finalDelay; i > 0; i--) {
					await this.say(
						"api_req_retry_delayed",
						`${errorMsg}\n\nRetry attempt ${retryAttempt + 1}\nRetrying in ${i} seconds...`,
						undefined,
						true,
					)
					await delay(1000)
				}

				await this.say(
					"api_req_retry_delayed",
					`${errorMsg}\n\nRetry attempt ${retryAttempt + 1}\nRetrying now...`,
					undefined,
					false,
				)

				// Delegate generator output from the recursive call with
				// incremented retry count.
				yield* this.attemptApiRequest(retryAttempt + 1)

				return
			} else {
				const { response } = await this.ask(
					"api_req_failed",
					error.message ?? JSON.stringify(serializeError(error), null, 2),
				)

				if (response !== "yesButtonClicked") {
					// This will never happen since if noButtonClicked, we will
					// clear current task, aborting this instance.
					throw new Error("API request failed")
				}

				await this.say("api_req_retried")

				// Delegate generator output from the recursive call.
				yield* this.attemptApiRequest()
				return
			}
		}

		// No error, so we can continue to yield all remaining chunks.
		// (Needs to be placed outside of try/catch since it we want caller to
		// handle errors not with api_req_failed as that is reserved for first
		// chunk failures only.)
		// This delegates to another generator or iterable object. In this case,
		// it's saying "yield all remaining values from this iterator". This
		// effectively passes along all subsequent chunks from the original
		// stream.
		yield* iterator
	}

	// Checkpoints

	public async checkpointSave(force: boolean = false) {
		return checkpointSave(this, force)
	}

	public async checkpointRestore(options: CheckpointRestoreOptions) {
		return checkpointRestore(this, options)
	}

	public async checkpointDiff(options: CheckpointDiffOptions) {
		return checkpointDiff(this, options)
	}

	// Metrics

	public combineMessages(messages: ClineMessage[]) {
		return combineApiRequests(combineCommandSequences(messages))
	}

	public getTokenUsage(): TokenUsage {
		return getApiMetrics(this.combineMessages(this.clineMessages.slice(1)))
	}

	public recordToolUsage(toolName: ToolName) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].attempts++
	}

	public recordToolError(toolName: ToolName, error?: string) {
		if (!this.toolUsage[toolName]) {
			this.toolUsage[toolName] = { attempts: 0, failures: 0 }
		}

		this.toolUsage[toolName].failures++

		if (error) {
			this.emit(RooCodeEventName.TaskToolFailed, this.taskId, toolName, error)
		}
	}

	/**
	 * Persist GPT-5 per-turn metadata (previous_response_id, instructions, reasoning_summary)
	 * onto the last complete assistant say("text") message.
	 */
	private async persistGpt5Metadata(reasoningMessage?: string): Promise<void> {
		try {
			const modelId = this.api.getModel().id
			if (!modelId || !modelId.startsWith("gpt-5")) return

			const lastResponseId: string | undefined = (this.api as any)?.getLastResponseId?.()
			const idx = findLastIndex(
				this.clineMessages,
				(m) => m.type === "say" && (m as any).say === "text" && m.partial !== true,
			)
			if (idx !== -1) {
				const msg = this.clineMessages[idx] as any
				msg.metadata = msg.metadata ?? {}
				msg.metadata.gpt5 = {
					...(msg.metadata.gpt5 ?? {}),
					previous_response_id: lastResponseId,
					instructions: this.lastUsedInstructions,
					reasoning_summary: (reasoningMessage ?? "").trim() || undefined,
				}
			}
		} catch {
			// Non-fatal error in metadata persistence
		}
	}

	// Getters

	public get cwd() {
		return this.workspacePath
	}
}
