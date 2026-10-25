export interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
  positionals: string[];
}

/** Lightweight argument parsing shared by the entrypoint and command modules. */
export function parseArgs(argv: string[]): ParsedArgs {
  let command = "launcher";
  let rest = argv;
  // `--help` and `--version` are commands in flag clothing. Any other leading
  // `--flag` used to leave the command at "launcher" — so `ares --version`
  // mounted the Ink deck and, without a TTY, died in a React stack trace
  // (issue #14).
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "--version") {
    command = argv[0];
    rest = argv.slice(1);
  } else if (argv[0] && !argv[0].startsWith("--")) {
    command = argv[0];
    rest = argv.slice(1);
  }
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, flags, positionals };
}
