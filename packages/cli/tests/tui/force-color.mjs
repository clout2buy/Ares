// Set truecolor BEFORE ink/chalk load so rendered frames carry 24-bit color
// codes (chalk reads support at import time). Imported first by helpers.mjs.
process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? "3";
