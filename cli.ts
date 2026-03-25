export interface ParsedCommandLineArgs {
  allowedDirectories: string[];
  ignoreFiles: string[];
  respectGitignore: boolean;
}

export function parseCommandLineArgs(argv: string[]): ParsedCommandLineArgs {
  const allowedDirectories: string[] = [];
  const ignoreFiles: string[] = [];
  let respectGitignore = false;
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (!positionalOnly && arg === "--") {
      positionalOnly = true;
      continue;
    }

    if (!positionalOnly && arg === "--respect-gitignore") {
      respectGitignore = true;
      continue;
    }

    if (!positionalOnly && arg === "--ignore-file") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--ignore-file requires a value");
      }
      ignoreFiles.push(value);
      index++;
      continue;
    }

    if (!positionalOnly && arg.startsWith("--ignore-file=")) {
      ignoreFiles.push(arg.slice("--ignore-file=".length));
      continue;
    }

    allowedDirectories.push(arg);
  }

  return {
    allowedDirectories,
    ignoreFiles,
    respectGitignore,
  };
}
