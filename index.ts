#!/usr/bin/env node

import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  RootsListChangedNotificationSchema,
  type Root,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { parseCommandLineArgs } from "./cli.js";
import { IgnoreManager } from "./ignore-manager.js";
import { normalizePath, expandHome } from "./path-utils.js";
import { getValidRootDirectories } from "./roots-utils.js";
import {
  applyFileEdits,
  buildDirectoryTree,
  formatSize,
  getFileStats,
  headFile,
  listDirectoryEntries,
  listDirectoryEntriesWithSizes,
  readFileContent,
  searchFilesWithValidation,
  setAllowedDirectories,
  tailFile,
  validatePath,
  writeFileContent,
  getAllowedDirectories,
} from "./lib.js";

function printUsage(): void {
  console.error("Usage: mcp-server-filesystem-ignore [options] [allowed-directory] [additional-directories...]");
  console.error("Options:");
  console.error("  --ignore-file <path-or-name>   Load a gitignore-style ignore file");
  console.error("  --ignore-file=<path-or-name>   Same as above");
  console.error("  --respect-gitignore            Convenience flag for --ignore-file .gitignore");
  console.error("  --                             Treat remaining arguments as directories");
  console.error("Allowed directories can also come from the MCP roots protocol.");
}

const parsedArgs = parseCommandLineArgs(process.argv.slice(2));
if (process.argv.slice(2).length === 0) {
  printUsage();
}

let allowedDirectories = (
  await Promise.all(
    parsedArgs.allowedDirectories.map(async (dir) => {
      const expanded = expandHome(dir);
      const absolute = path.resolve(expanded);
      const normalizedOriginal = normalizePath(absolute);

      try {
        const resolved = await fs.realpath(absolute);
        const normalizedResolved = normalizePath(resolved);
        if (normalizedOriginal !== normalizedResolved) {
          return [normalizedOriginal, normalizedResolved];
        }

        return [normalizedResolved];
      } catch {
        return [normalizedOriginal];
      }
    }),
  )
).flat();

const accessibleDirectories: string[] = [];
for (const dir of allowedDirectories) {
  try {
    const stats = await fs.stat(dir);
    if (stats.isDirectory()) {
      accessibleDirectories.push(dir);
    } else {
      console.error(`Warning: ${dir} is not a directory, skipping`);
    }
  } catch {
    console.error(`Warning: Cannot access directory ${dir}, skipping`);
  }
}

if (accessibleDirectories.length === 0 && allowedDirectories.length > 0) {
  console.error("Error: None of the specified directories are accessible");
  process.exit(1);
}

allowedDirectories = accessibleDirectories;
setAllowedDirectories(allowedDirectories);

const ignoreManager = await IgnoreManager.create({
  ignoreFiles: parsedArgs.ignoreFiles,
  respectGitignore: parsedArgs.respectGitignore,
  allowedRoots: allowedDirectories,
});

const ReadTextFileArgsSchema = z.object({
  path: z.string(),
  tail: z.number().optional().describe("If provided, returns only the last N lines of the file"),
  head: z.number().optional().describe("If provided, returns only the first N lines of the file"),
});

const ReadMediaFileArgsSchema = z.object({
  path: z.string(),
});

const ReadMultipleFilesArgsSchema = z.object({
  paths: z
    .array(z.string())
    .min(1, "At least one file path must be provided")
    .describe("Array of file paths to read. Each path must be a string pointing to a valid file within allowed directories."),
});

const WriteFileArgsSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const EditOperation = z.object({
  oldText: z.string().describe("Text to search for - must match exactly"),
  newText: z.string().describe("Text to replace with"),
});

const EditFileArgsSchema = z.object({
  path: z.string(),
  edits: z.array(EditOperation),
  dryRun: z.boolean().default(false).describe("Preview changes using git-style diff format"),
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryArgsSchema = z.object({
  path: z.string(),
});

const ListDirectoryWithSizesArgsSchema = z.object({
  path: z.string(),
  sortBy: z.enum(["name", "size"]).optional().default("name").describe("Sort entries by name or size"),
});

const DirectoryTreeArgsSchema = z.object({
  path: z.string(),
  excludePatterns: z.array(z.string()).optional().default([]),
});

const MoveFileArgsSchema = z.object({
  source: z.string(),
  destination: z.string(),
});

const SearchFilesArgsSchema = z.object({
  path: z.string(),
  pattern: z.string(),
  excludePatterns: z.array(z.string()).optional().default([]),
});

const GetFileInfoArgsSchema = z.object({
  path: z.string(),
});

const server = new McpServer({
  name: "mcp-server-filesystem-ignore",
  version: "0.1.0",
});

async function readFileAsBase64Stream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    const chunks: Buffer[] = [];

    stream.on("data", (chunk) => {
      chunks.push(chunk as Buffer);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
    stream.on("error", reject);
  });
}

const readTextFileHandler = async (args: z.infer<typeof ReadTextFileArgsSchema>) => {
  const validPath = await validatePath(args.path);

  if (args.head && args.tail) {
    throw new Error("Cannot specify both head and tail parameters simultaneously");
  }

  let content = "";
  if (args.tail) {
    content = await tailFile(validPath, args.tail);
  } else if (args.head) {
    content = await headFile(validPath, args.head);
  } else {
    content = await readFileContent(validPath);
  }

  return {
    content: [{ type: "text" as const, text: content }],
    structuredContent: { content },
  };
};

server.registerTool(
  "read_file",
  {
    title: "Read File (Deprecated)",
    description: "Read the complete contents of a file as text. DEPRECATED: Use read_text_file instead.",
    inputSchema: ReadTextFileArgsSchema.shape,
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  readTextFileHandler,
);

server.registerTool(
  "read_text_file",
  {
    title: "Read Text File",
    description:
      "Read the complete contents of a file from the file system as text. " +
      "Use head or tail to read only part of the file. Only works within allowed directories.",
    inputSchema: ReadTextFileArgsSchema.shape,
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  readTextFileHandler,
);

server.registerTool(
  "read_media_file",
  {
    title: "Read Media File",
    description: "Read an image or audio file and return base64 data plus MIME type.",
    inputSchema: ReadMediaFileArgsSchema.shape,
    outputSchema: {
      content: z.array(
        z.object({
          type: z.enum(["image", "audio", "blob"]),
          data: z.string(),
          mimeType: z.string(),
        }),
      ),
    },
    annotations: { readOnlyHint: true },
  },
  async (args: z.infer<typeof ReadMediaFileArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const extension = path.extname(validPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".ogg": "audio/ogg",
      ".flac": "audio/flac",
    };

    const mimeType = mimeTypes[extension] ?? "application/octet-stream";
    const data = await readFileAsBase64Stream(validPath);
    const type = mimeType.startsWith("image/")
      ? "image"
      : mimeType.startsWith("audio/")
        ? "audio"
        : "blob";

    const contentItem = { type: type as "image" | "audio" | "blob", data, mimeType };
    return {
      content: [contentItem],
      structuredContent: { content: [contentItem] },
    } as unknown as CallToolResult;
  },
);

server.registerTool(
  "read_multiple_files",
  {
    title: "Read Multiple Files",
    description:
      "Read multiple files in one operation. Individual failures do not stop the whole request.",
    inputSchema: ReadMultipleFilesArgsSchema.shape,
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args: z.infer<typeof ReadMultipleFilesArgsSchema>) => {
    const results = await Promise.all(
      args.paths.map(async (filePath) => {
        try {
          const validPath = await validatePath(filePath);
          const content = await readFileContent(validPath);
          return `${filePath}:\n${content}\n`;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return `${filePath}: Error - ${errorMessage}`;
        }
      }),
    );

    const text = results.join("\n---\n");
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text },
    };
  },
);

server.registerTool(
  "write_file",
  {
    title: "Write File",
    description: "Create a new file or overwrite an existing file.",
    inputSchema: WriteFileArgsSchema.shape,
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
  },
  async (args: z.infer<typeof WriteFileArgsSchema>) => {
    const validPath = await validatePath(args.path);
    await writeFileContent(validPath, args.content);
    const text = `Successfully wrote to ${args.path}`;
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text },
    };
  },
);

server.registerTool(
  "edit_file",
  {
    title: "Edit File",
    description: "Apply exact text replacements to a file and return a unified diff.",
    inputSchema: EditFileArgsSchema.shape,
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  },
  async (args: z.infer<typeof EditFileArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const result = await applyFileEdits(validPath, args.edits, args.dryRun);
    return {
      content: [{ type: "text" as const, text: result }],
      structuredContent: { content: result },
    };
  },
);

server.registerTool(
  "create_directory",
  {
    title: "Create Directory",
    description: "Create a directory, including any missing parents.",
    inputSchema: CreateDirectoryArgsSchema.shape,
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false },
  },
  async (args: z.infer<typeof CreateDirectoryArgsSchema>) => {
    const validPath = await validatePath(args.path);
    await fs.mkdir(validPath, { recursive: true });
    const text = `Successfully created directory ${args.path}`;
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text },
    };
  },
);

server.registerTool(
  "list_directory",
  {
    title: "List Directory",
    description: "List files and directories within a path. Ignore-file filtering is opt-in at startup.",
    inputSchema: ListDirectoryArgsSchema.shape,
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args: z.infer<typeof ListDirectoryArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const entries = await listDirectoryEntries(validPath, { ignoreManager });
    const formatted = entries
      .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
      .join("\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
      structuredContent: { content: formatted },
    };
  },
);

server.registerTool(
  "list_directory_with_sizes",
  {
    title: "List Directory with Sizes",
    description: "List files and directories within a path, including file sizes.",
    inputSchema: ListDirectoryWithSizesArgsSchema.shape,
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args: z.infer<typeof ListDirectoryWithSizesArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const detailedEntries = await listDirectoryEntriesWithSizes(validPath, { ignoreManager });

    const sortedEntries = [...detailedEntries].sort((left, right) => {
      if (args.sortBy === "size") {
        return right.size - left.size;
      }
      return left.name.localeCompare(right.name);
    });

    const formattedEntries = sortedEntries.map((entry) => {
      return `${entry.isDirectory ? "[DIR]" : "[FILE]"} ${entry.name.padEnd(30)} ${
        entry.isDirectory ? "" : formatSize(entry.size).padStart(10)
      }`;
    });

    const totalFiles = detailedEntries.filter((entry) => !entry.isDirectory).length;
    const totalDirs = detailedEntries.filter((entry) => entry.isDirectory).length;
    const totalSize = detailedEntries.reduce((sum, entry) => {
      return sum + (entry.isDirectory ? 0 : entry.size);
    }, 0);

    const summary = [
      "",
      `Total: ${totalFiles} files, ${totalDirs} directories`,
      `Combined size: ${formatSize(totalSize)}`,
    ];
    const text = [...formattedEntries, ...summary].join("\n");

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text },
    };
  },
);

server.registerTool(
  "directory_tree",
  {
    title: "Directory Tree",
    description:
      "Return a recursive JSON tree of files and directories. Ignore-file filtering is opt-in at startup.",
    inputSchema: DirectoryTreeArgsSchema.shape,
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args: z.infer<typeof DirectoryTreeArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const treeData = await buildDirectoryTree(validPath, validPath, {
      excludePatterns: args.excludePatterns,
      ignoreManager,
    });
    const text = JSON.stringify(treeData, null, 2);

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text },
    };
  },
);

server.registerTool(
  "move_file",
  {
    title: "Move File",
    description: "Move or rename a file or directory within the allowed directories.",
    inputSchema: MoveFileArgsSchema.shape,
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true },
  },
  async (args: z.infer<typeof MoveFileArgsSchema>) => {
    const validSourcePath = await validatePath(args.source);
    const validDestPath = await validatePath(args.destination);
    await fs.rename(validSourcePath, validDestPath);
    const text = `Successfully moved ${args.source} to ${args.destination}`;
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text },
    };
  },
);

server.registerTool(
  "search_files",
  {
    title: "Search Files",
    description:
      "Recursively search for files and directories matching a glob-style pattern relative to the starting path.",
    inputSchema: SearchFilesArgsSchema.shape,
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args: z.infer<typeof SearchFilesArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const results = await searchFilesWithValidation(validPath, args.pattern, getAllowedDirectories(), {
      excludePatterns: args.excludePatterns,
      ignoreManager,
    });
    const text = results.length > 0 ? results.join("\n") : "No matches found";
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text },
    };
  },
);

server.registerTool(
  "get_file_info",
  {
    title: "Get File Info",
    description: "Return size, timestamps, permissions, and type info for a file or directory.",
    inputSchema: GetFileInfoArgsSchema.shape,
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args: z.infer<typeof GetFileInfoArgsSchema>) => {
    const validPath = await validatePath(args.path);
    const info = await getFileStats(validPath);
    const text = Object.entries(info)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text },
    };
  },
);

server.registerTool(
  "list_allowed_directories",
  {
    title: "List Allowed Directories",
    description: "Return the directories that the server is allowed to access.",
    inputSchema: {},
    outputSchema: { content: z.string() },
    annotations: { readOnlyHint: true },
  },
  async () => {
    const text = `Allowed directories:\n${getAllowedDirectories().join("\n")}`;
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: { content: text },
    };
  },
);

async function updateAllowedDirectoriesFromRoots(requestedRoots: Root[]) {
  const validatedRootDirs = await getValidRootDirectories(requestedRoots);
  if (validatedRootDirs.length === 0) {
    console.error("No valid root directories provided by client");
    return;
  }

  allowedDirectories = [...validatedRootDirs];
  setAllowedDirectories(allowedDirectories);
  ignoreManager?.setAllowedRoots(allowedDirectories);
  console.error(`Updated allowed directories from MCP roots: ${validatedRootDirs.length} valid directories`);
}

server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
  try {
    const response = await server.server.listRoots();
    if (response && "roots" in response) {
      await updateAllowedDirectoriesFromRoots(response.roots);
    }
  } catch (error) {
    console.error(
      "Failed to request roots from client:",
      error instanceof Error ? error.message : String(error),
    );
  }
});

server.server.oninitialized = async () => {
  const clientCapabilities = server.server.getClientCapabilities();
  if (clientCapabilities?.roots) {
    try {
      const response = await server.server.listRoots();
      if (response && "roots" in response) {
        await updateAllowedDirectoriesFromRoots(response.roots);
      } else {
        console.error("Client returned no roots set, keeping current settings");
      }
    } catch (error) {
      console.error(
        "Failed to request initial roots from client:",
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }

  if (allowedDirectories.length > 0) {
    console.error("Client does not support MCP Roots, using allowed directories set from server args:", allowedDirectories);
    return;
  }

  throw new Error(
    "Server cannot operate: No allowed directories available. Start the server with directory arguments or use a client that provides MCP roots.",
  );
};

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Filesystem ignore-aware MCP server running on stdio");
  if (allowedDirectories.length === 0) {
    console.error("Started without allowed directories - waiting for client to provide roots via MCP protocol");
  } else if (ignoreManager?.isEnabled()) {
    console.error(`Ignore filtering enabled with ${ignoreManager.getSpecValues().length} configured source(s)`);
  }
}

await runServer();
