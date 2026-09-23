// @ares/tools — one file per tool.
// Each exports a Tool<I, O> built with buildTool() from _shared.ts.

export * from "./_shared.js";

export { ReadTool } from "./Read.js";
export { WriteTool } from "./Write.js";
export { EditTool, nearMissHint, looksLineNumberPrefixed, weakestLayer, type EditLayer, type EditOutput } from "./Edit.js";
export { ApplyPatchTool, type ApplyPatchOutput } from "./ApplyPatch.js";
export { safeOverwrite, assessShrink, type SafeOverwriteOptions, type SafeOverwriteResult, type ShrinkVerdict } from "./safeWrite.js";
export { GlobTool } from "./Glob.js";
export { GrepTool, regexInputProblem } from "./Grep.js";
export { BashTool, runShell, type BashOutput } from "./Bash.js";
export { PowerShellTool } from "./PowerShell.js";
export { classifyShellFailure, shellFlavorOf, powerShellDialect, type ShellFlavor } from "./shellHints.js";
export { LspTool, type LspOutput, type LspLocation, type LspSymbol } from "./LSP.js";
export { TodoStore, makeTodoWriteTool, type TodoWriteOutput } from "./TodoWrite.js";
export {
  makeTaskTool,
  makeTaskOutputTool,
  makeKillTaskTool,
  type SubagentRunner,
  type TaskOutput,
  type TaskBackgroundOutput,
  type BackgroundTaskSnapshot,
  type BackgroundTaskStatus,
} from "./Task.js";
export {
  makeCodingBackendTool,
  buildAresHarnessPrompt,
  detectBackend,
  BACKENDS,
  type BackendName,
  type BackendSpec,
  type CodingBackendDeps,
  type CodingBackendOutput,
} from "./CodingBackend.js";
export {
  makeConductorTool,
  exampleValidator,
  exampleHinter,
  type ConductorToolDeps,
} from "./Conductor.js";
export {
  makeWebFetchTool,
  htmlToText,
  assertPublicHost,
  type WebFetchOutput,
  type Summarizer,
} from "./WebFetch.js";
export {
  looksJsGated,
  discoverCdpEndpoint,
  renderOverCdp,
  cdpRenderer,
  CdpClient,
  type JsRenderer,
  type CdpRenderOptions,
} from "./cdpRender.js";
export {
  makeAgentComputerTools,
  getAgentComputer,
  guiInputRefusal,
  vmPlatformBlocked,
  chooseDistroDir,
  driveFreeBytes,
  formatGb,
  WslSandbox,
  SANDBOX_DISTRO,
  machineCardPromptBlock,
  appendJournal,
  journalTail,
  updateFacts,
  type JournalEntry,
  type MachineFacts,
  type WslRunner,
  type SandboxExecResult,
  type SandboxStatus,
  type DisplayLease,
  type AgentComputerToolsOptions,
} from "./AgentComputer.js";
export {
  makeWebSearchTool,
  duckDuckGoLite,
  parseDuckDuckGoLite,
  defaultSearchChain,
  braveSearch,
  tavilySearch,
  searxngSearch,
  withFallback,
  type WebSearchResult,
  type WebSearchOutput,
  type SearchBackend,
} from "./WebSearch.js";
export {
  makeImageSearchTool,
  duckDuckGoImages,
  braveImages,
  type ImageResult,
  type ImageSearchOutput,
} from "./ImageSearch.js";
export {
  CodebaseSearchTool,
  setCodebaseSearchEmbedder,
  resetCodebaseSearchSidecars,
  codebaseSearchSidecarIdle,
  chunkVectorSidecarPath,
  embedBudgetMs,
  type CodebaseSearchHit,
  type CodebaseSearchOutput,
  type CodebaseSearchSymbolHit,
  type CodebaseSearchEmbeddingStats,
} from "./CodebaseSearch.js";
export {
  ollamaEmbedClient,
  cosineSimilarity,
  embedModelName,
  embedBaseUrl,
  DEFAULT_EMBED_MODEL,
  type Embedder,
  type OllamaEmbedClientOptions,
} from "./embedClient.js";
export {
  ShellRegistry,
  type ShellSnapshot,
  type ShellLaunchOptions,
} from "./ShellRegistry.js";
export { makeBashOutputTool, type BashOutputResult } from "./BashOutput.js";
export { makeKillShellTool, type KillShellOutput } from "./KillShell.js";
export { makeBackgroundTasksTool, type BackgroundTasksOutput } from "./BackgroundTasks.js";
export { McpListToolsTool, McpCallTool, HttpMcpClient, SseMcpClient, McpAuthError, listMcpServerTools, listMcpServerToolsFull, listMcpServers, callMcpTool, remoteHeaders, loadMcpConfig, type McpListOutput, type McpCallOutput, type McpToolDescriptor, type McpServerConfig, type RemoteServerConfig } from "./Mcp.js";
export { SkillsListTool, SkillReadTool, type SkillsListOutput, type SkillReadOutput, type SkillSummary } from "./Skills.js";
export {
  MemoryTool,
  makeMemoryTool,
  memoryContentVersion,
  MemoryConflictError,
  MemoryLockTimeoutError,
  type MemoryOutput,
  type MemoryItem,
  type MemoryCommitContext,
  type MemoryToolOptions,
} from "./Memory.js";
export {
  ComputerUseTool,
  makeComputerUseTool,
  mapImageToVirtual,
  shotScale,
  normalizeActionCoords,
  type ComputerActionRunner,
  type ComputerUseOutput,
  type RunnerInput,
  type ShotMeta,
} from "./ComputerUse.js";
export { DeployTool, type DeployOutput } from "./Deploy.js";
export { StripeTool, type StripeOutput } from "./Stripe.js";
export { EmailTool, type EmailOutput } from "./Email.js";
export { RequestUserActionTool, type RequestUserActionOutput } from "./RequestUserAction.js";
export { SetUiEffectTool, type SetUiEffectOutput } from "./SetUiEffect.js";
export {
  makeEnterPlanModeTool,
  makeUpdatePlanDraftTool,
  makeExitPlanModeTool,
  type PlanModeState,
  type PlanModeStateSource,
} from "./PlanMode.js";
export { WeatherTool, getWeatherText, type WeatherOutput, type WeatherCondition, type WeatherForecast } from "./Weather.js";
export { RemindTool, setRemindScheduler, type RemindOutput, type SchedulerLike } from "./Remind.js";
export { TelegramTool, setTelegramChannel, getTelegramChannel, resolveTargets as resolveTelegramTargets, type TelegramOutput, type TelegramChannelLike } from "./Telegram.js";
export { RemotePCTool, setRemoteAgentServer, getRemoteAgentServer, type RemotePCInput, type RemotePCOutput, type RemoteAgentServerLike } from "./RemotePC.js";
export { ConnectTool, CONNECT_WAIT_MS, type ConnectOutput } from "./Connect.js";
export {
  CheckoutTool,
  recordCheckoutApproval,
  approvedCheckout,
  spendCheckoutApproval,
  parseAmount,
  pageShowsAmount,
  looksLikeOrderSubmission,
  type CheckoutOutput,
  type ApprovedCheckout,
} from "./Checkout.js";
export { DeviceTool, type DeviceOutput } from "./Device.js";
export { PhoneTool, twilioMonthlyPrice, type PhoneOutput } from "./Phone.js";
export { GoogleCalendarTool, type GoogleCalendarOutput } from "./GoogleCalendar.js";
export { GmailTool, buildRfc2822, planUnsubscribe, gmailBodyText, findCodeInputProblem, CODE_HANDLE_TTL_MS, type GmailOutput } from "./Gmail.js";
export * as oneTimeCode from "./oneTimeCode.js";
export { GoogleDriveTool, driveSearchQuery, driveMultipart, DRIVE_EXPORTS, type GoogleDriveOutput } from "./GoogleDrive.js";
export { GoogleDocsTool, docText, type GoogleDocsOutput } from "./GoogleDocs.js";
export { GoogleSheetsTool, type GoogleSheetsOutput } from "./GoogleSheets.js";
export { GoogleSlidesTool, addSlideRequests, slideTexts, type GoogleSlidesOutput } from "./GoogleSlides.js";
export { GoogleFormsTool, formQuestion, addQuestionRequests, type GoogleFormsOutput } from "./GoogleForms.js";
export { GoogleTasksTool, tasksDue, type GoogleTasksOutput } from "./GoogleTasks.js";
export { GoogleContactsTool, type GoogleContactsOutput } from "./GoogleContacts.js";
export { OutlookTool, odata, graphTime, eventBody as outlookEventBody, recipients as outlookRecipients, type OutlookOutput } from "./Outlook.js";
export { CONNECTOR_TOOLS } from "./connectorTools.js";
export { SpotifyTool, type SpotifyOutput } from "./Spotify.js";
// Life surfaces (the phone's Today tab): commitments, places, media.
export { TrackTool, type TrackOutput } from "./Track.js";
export { TrackingStore, trackingPath, overdueTrackingBlock, normalizeDueAt, TRACKING_KINDS, TRACKING_CLOSED_WINDOW_MS, type TrackingItem, type TrackingKind, type TrackingStatus } from "./tracking.js";
export { PlacesTool, makeThrottle, clearPlacesCache, nominatimSearchUrl, nominatimReverseUrl, overpassQuery, googleTextSearchBody, mapsLink, geocode, reverseGeocode, searchPlaces, PLACES_USER_AGENT, type Place, type PlacesOutput } from "./Places.js";
export { ImagineTool, setImagineSpeech, findImageData, parsePodcastScript, stripId3, chunkText, veoSeconds, mediaSlug, type ImagineOutput, type ImagineSpeech } from "./Imagine.js";
export { HueTool, discoverHueBridges, pairHueBridge, hueCall, hexToXy, hueStateBody, type HueOutput, type HueBridgeRef, type HuePairing } from "./Hue.js";
export { TeslaTool, TESLA_ASK_ACTIONS, type TeslaOutput } from "./Tesla.js";
export { TicketsTool, ticketmasterSearchUrl, type TicketsOutput } from "./Tickets.js";
export { FlightStatusTool, relevantFlight, summarizeFlight, type FlightStatusOutput } from "./FlightStatus.js";
export { FlightBookingTool, duffelMode, offerRequestBody, summarizeOffer, type FlightBookingOutput } from "./FlightBooking.js";
export { WithingsTool, decodeMeasureGroups, type WithingsOutput } from "./Withings.js";
export { TailscaleTool, TAILSCALE_ASK_ACTIONS, type TailscaleOutput } from "./Tailscale.js";
export { BankTool, claimSimplefinToken, simplefinAccounts, simplefinClaimUrl, type BankOutput } from "./Bank.js";
export {
  makeToolSearchTool,
  DeferredToolRegistry,
  TOOL_SEARCH_DESCRIPTION,
  type DeferredToolDescriptor,
  type ToolSearchOutput,
  type ToolSearchOptions,
} from "./ToolSearch.js";

import { ReadTool } from "./Read.js";
import { WriteTool } from "./Write.js";
import { EditTool } from "./Edit.js";
import { ApplyPatchTool } from "./ApplyPatch.js";
import { GlobTool } from "./Glob.js";
import { GrepTool } from "./Grep.js";
import { BashTool } from "./Bash.js";
import { PowerShellTool } from "./PowerShell.js";
import { LspTool } from "./LSP.js";
import { CodebaseSearchTool } from "./CodebaseSearch.js";
import { McpListToolsTool, McpCallTool } from "./Mcp.js";
import { SkillsListTool, SkillReadTool } from "./Skills.js";
import { MemoryTool } from "./Memory.js";
import { ComputerUseTool } from "./ComputerUse.js";
import { DeployTool } from "./Deploy.js";
import { StripeTool } from "./Stripe.js";
import { EmailTool } from "./Email.js";
import { RequestUserActionTool } from "./RequestUserAction.js";
import { SetUiEffectTool } from "./SetUiEffect.js";
import { WeatherTool } from "./Weather.js";
import { RemindTool } from "./Remind.js";
import { TelegramTool } from "./Telegram.js";
import { RemotePCTool } from "./RemotePC.js";
import { ConnectTool } from "./Connect.js";
import { CheckoutTool } from "./Checkout.js";
import { PhoneTool } from "./Phone.js";
import { DeviceTool } from "./Device.js";
import { GoogleCalendarTool } from "./GoogleCalendar.js";
import { GmailTool } from "./Gmail.js";
import { SpotifyTool } from "./Spotify.js";
import { CONNECTOR_TOOLS } from "./connectorTools.js";
import { TrackTool } from "./Track.js";
import { PlacesTool } from "./Places.js";
import { ImagineTool } from "./Imagine.js";
import { HueTool } from "./Hue.js";
import { TeslaTool } from "./Tesla.js";
import { TicketsTool } from "./Tickets.js";
import { FlightStatusTool } from "./FlightStatus.js";
import { FlightBookingTool } from "./FlightBooking.js";
import { WithingsTool } from "./Withings.js";
import { TailscaleTool } from "./Tailscale.js";
import { BankTool } from "./Bank.js";

/** Home, car, travel, health and money connectors (all deferred). */
export const LIFE_TOOLS = [HueTool, TeslaTool, TicketsTool, FlightStatusTool, FlightBookingTool, WithingsTool, TailscaleTool, BankTool] as const;

/** The default tool set wired into a fresh Session. */
export const DEFAULT_TOOLS = process.platform === "win32"
  ? [
      ReadTool,
      WriteTool,
      EditTool,
      ApplyPatchTool,
      GlobTool,
      GrepTool,
      CodebaseSearchTool,
      LspTool,
      PowerShellTool,
      BashTool,
      McpListToolsTool,
      McpCallTool,
      SkillsListTool,
      SkillReadTool,
      MemoryTool,
      ComputerUseTool,
      DeployTool,
      StripeTool,
      EmailTool,
      RequestUserActionTool,
      SetUiEffectTool,
      WeatherTool,
      RemindTool,
      TelegramTool,
      RemotePCTool,
      ConnectTool,
      CheckoutTool,
      PhoneTool,
      DeviceTool,
      GoogleCalendarTool,
      GmailTool,
      SpotifyTool,
      ...CONNECTOR_TOOLS,
      TrackTool,
      PlacesTool,
      ImagineTool,
      ...LIFE_TOOLS,
    ] as const
  : [
      ReadTool,
      WriteTool,
      EditTool,
      ApplyPatchTool,
      GlobTool,
      GrepTool,
      CodebaseSearchTool,
      LspTool,
      BashTool,
      PowerShellTool,
      McpListToolsTool,
      McpCallTool,
      SkillsListTool,
      SkillReadTool,
      MemoryTool,
      DeployTool,
      StripeTool,
      EmailTool,
      RequestUserActionTool,
      SetUiEffectTool,
      WeatherTool,
      RemindTool,
      TelegramTool,
      RemotePCTool,
      ConnectTool,
      CheckoutTool,
      PhoneTool,
      DeviceTool,
      GoogleCalendarTool,
      GmailTool,
      SpotifyTool,
      ...CONNECTOR_TOOLS,
      TrackTool,
      PlacesTool,
      ImagineTool,
      ...LIFE_TOOLS,
    ] as const;
