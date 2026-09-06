// The frame budget — every chrome piece has a FIXED height, so the transcript
// viewport is arithmetic and the frame can never exceed the terminal. Ink only
// falls back to clear-the-screen-every-frame (the flicker) when a frame
// overflows; this makes overflow impossible by construction.
//
// Rows (top → bottom):
//   header        2   wordmark · model · workspace · branch, then a hairline
//   activity      0-3 thinking line / fleet tree (bounded)
//   transcript    N   whatever is left (≥ 3)
//   todos         0-1
//   palette       0-P command palette (bounded)
//   permission    0-4 the in-frame ask (contract: buttons row = H-6)
//   status        1
//   input         3   bordered composer
//   toolbar       1   click bar — ALWAYS the last row (tuiChrome.toolbarRow)

export const HEADER_ROWS = 2;
export const STATUS_ROWS = 1;
export const INPUT_ROWS = 3;
export const TOOLBAR_ROWS = 1;
export const PERM_ROWS = 4;
export const MAX_ACTIVITY_ROWS = 3;
export const MAX_PALETTE_ROWS = 10;
export const MIN_TRANSCRIPT_ROWS = 3;

/** Smallest terminal the chat screen will draw into. */
export const MIN_COLUMNS = 50;
export const MIN_ROWS = 14;

export interface LayoutInput {
  columns: number;
  rows: number;
  activityRows: number;
  hasTodos: boolean;
  paletteRows: number;
  hasPerm: boolean;
}

export interface Layout {
  /** Frame width in cells. One less than the terminal so the last column never
   *  triggers pending-wrap scrolling (conhost + Terminal.app both do it). */
  width: number;
  /** Frame height in rows. One less than the terminal so Ink never enters its
   *  overflow path. */
  height: number;
  tooSmall: boolean;
  headerRows: number;
  activityRows: number;
  transcriptRows: number;
  todoRows: number;
  paletteRows: number;
  permRows: number;
  statusRows: number;
  inputRows: number;
  toolbarRows: number;
}

export function computeLayout(input: LayoutInput): Layout {
  const width = Math.max(1, input.columns - 1);
  const height = Math.max(1, input.rows - 1);
  const tooSmall = input.columns < MIN_COLUMNS || input.rows < MIN_ROWS;
  if (tooSmall) {
    // The resize notice owns the whole frame; no chrome is drawn.
    return { width, height, tooSmall, headerRows: 0, activityRows: 0, transcriptRows: height, todoRows: 0, paletteRows: 0, permRows: 0, statusRows: 0, inputRows: 0, toolbarRows: 0 };
  }
  const fixed = HEADER_ROWS + STATUS_ROWS + INPUT_ROWS + TOOLBAR_ROWS;
  const permRows = input.hasPerm ? PERM_ROWS : 0;
  const todoRows = input.hasTodos ? 1 : 0;
  let activityRows = Math.max(0, Math.min(MAX_ACTIVITY_ROWS, input.activityRows));
  let paletteRows = Math.max(0, Math.min(MAX_PALETTE_ROWS, input.paletteRows));
  let transcriptRows = height - fixed - permRows - todoRows - activityRows - paletteRows;
  // Squeeze optional strips before the transcript starves.
  while (transcriptRows < MIN_TRANSCRIPT_ROWS && (activityRows > 0 || paletteRows > 0)) {
    if (paletteRows > 0) paletteRows--;
    else activityRows--;
    transcriptRows++;
  }
  transcriptRows = Math.max(0, transcriptRows);
  return {
    width,
    height,
    tooSmall,
    headerRows: HEADER_ROWS,
    activityRows,
    transcriptRows,
    todoRows,
    paletteRows,
    permRows,
    statusRows: STATUS_ROWS,
    inputRows: INPUT_ROWS,
    toolbarRows: TOOLBAR_ROWS,
  };
}

/** Total rows the layout will draw — must equal `height` exactly. */
export function layoutTotal(l: Layout): number {
  return l.headerRows + l.activityRows + l.transcriptRows + l.todoRows + l.paletteRows + l.permRows + l.statusRows + l.inputRows + l.toolbarRows;
}
