// @ares/channels — chat surfaces as pure Garrison gateway clients.
// A channel holds zero entity state: it renders TurnEvents, forwards intents,
// and never imports from the daemon. First channel: Telegram.

export { TelegramApi, TelegramApiError } from "./telegram/api.js";
export type {
  TelegramApiOptions,
  FetchLike,
  FetchInit,
  FetchResponseLike,
  TgUpdate,
  TgMessage,
  TgChat,
  TgUser,
  TgCallbackQuery,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  SendMessageOptions,
} from "./telegram/api.js";

export { TelegramBridge, chunkMessage } from "./telegram/bridge.js";
export type { TelegramBridgeOptions, TelegramApiLike, BridgeTimers } from "./telegram/bridge.js";

export {
  OperatorTelegramReporter,
  formatOperatorReport,
  formatWarMapBriefing,
  redactForTelegram,
} from "./telegram/operatorReport.js";
export type {
  OperatorEventLike,
  OperatorReportOptions,
  OperatorReporterOptions,
  WarMapBriefing,
} from "./telegram/operatorReport.js";

export type {
  ClientFrame,
  ServerFrame,
  GatewaySessionInfo,
  GarrisonStatus,
  StagedApprovalFrame,
  ApprovalVerb,
  WebSocketLike,
  WebSocketCtor,
} from "./types.js";
