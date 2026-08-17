import { constants, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Uri, window, workspace, type ExtensionContext, type OutputChannel, type WorkspaceFolder } from "vscode";
import {
  DidChangeConfigurationNotification,
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient;
let shadowServerPath: string | undefined;
let outputChannel: OutputChannel;

export async function activate(context: ExtensionContext): Promise<void> {
  outputChannel = window.createOutputChannel("Pave");
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine("Pave is now active!");

  const rawServerPath = workspace.getConfiguration("pave").get<string>("path", "");
  const serverPath = rawServerPath ? resolveConfigVariables(rawServerPath, workspace.workspaceFolders?.[0]) : "";
  const serverCommand = await prepareServerCommand(context, serverPath || "pavels");
  outputChannel.appendLine(`Using pavels command: ${serverCommand}`);
  const serverOptions: ServerOptions = {
    run: { command: serverCommand, transport: TransportKind.pipe },
    debug: { command: serverCommand, transport: TransportKind.pipe },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "pave" }],
    synchronize: {
      configurationSection: ["pave"],
    },
    middleware: {
      workspace: {
        configuration: async (params, token, next) => {
          const results = await next(params, token);
          if (!Array.isArray(results)) {
            return results;
          }

          for (let i = 0; i < params.items.length; i++) {
            const { section, scopeUri } = params.items[i];
            if (section !== "pave.args") {
              continue;
            }

            const cmakeArgs = await resolveCMakeArgs(scopeUri);
            if (!cmakeArgs) {
              outputChannel.appendLine(`[${section}] from settings (no cmake cache variable found): ${JSON.stringify(results[i])}`);
              continue;
            }

            results[i] = cmakeArgs;
            outputChannel.appendLine(`[${section}] from cmake cache: ${JSON.stringify(results[i])}`);
          }

          return results;
        },
        didChangeConfiguration: async (sections, next) => {
          const cmakeArgs = await resolveCMakeArgs(undefined);
          if (!cmakeArgs) {
            outputChannel.appendLine("didChangeConfiguration: no cmake cache variable found, sending settings as-is");
            return next(sections);
          }

          const paveConfig = workspace.getConfiguration("pave");
          const settings = {
            pave: {
              args: cmakeArgs,
              path: paveConfig.get("path"),
              cmakeArgsVariable: paveConfig.get("cmakeArgsVariable"),
              cmakeBuildDirectory: paveConfig.get("cmakeBuildDirectory"),
            },
          };

          outputChannel.appendLine(`didChangeConfiguration (from cmake cache): ${JSON.stringify(settings.pave)}`);
          await client.sendNotification(DidChangeConfigurationNotification.type, { settings });
        },
      },
    },
  };

  client = new LanguageClient("pave", "Pave", serverOptions, clientOptions);
  try {
    await client.start();
  } catch (error) {
    await removeCurrentShadowCopy();
    throw error;
  }
}

export async function deactivate(): Promise<void> {
  if (!client) {
    return;
  }

  try {
    await client.stop();
  } finally {
    await removeCurrentShadowCopy();
  }
}

function resolveConfigVariables(value: string, workspaceFolder: WorkspaceFolder | undefined): string {
  return value.replace(/\$\{(userHome|workspaceFolder|env:([^}]+))\}/g, (match, token: string, envName: string) => {
    if (token === "userHome") {
      return os.homedir();
    }
    if (token === "workspaceFolder") {
      return workspaceFolder?.uri.fsPath ?? match;
    }
    return process.env[envName] ?? "";
  });
}

async function resolveCMakeArgs(scopeUri: string | undefined): Promise<string[] | undefined> {
  const resourceUri = scopeUri ? Uri.parse(scopeUri) : undefined;
  const folder = (resourceUri ? workspace.getWorkspaceFolder(resourceUri) : undefined) ?? workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }

  const config = workspace.getConfiguration("pave", resourceUri ?? folder.uri);
  const variableName = config.get<string>("cmakeArgsVariable", "PAVEC_ARGS");
  const buildDirectory = resolveConfigVariables(config.get<string>("cmakeBuildDirectory", "build"), folder);
  if (!variableName) {
    return undefined;
  }

  const cacheFilePath = path.isAbsolute(buildDirectory)
    ? path.join(buildDirectory, "CMakeCache.txt")
    : path.join(folder.uri.fsPath, buildDirectory, "CMakeCache.txt");
  const values = await readCMakeCacheListVariable(cacheFilePath, variableName);
  if (!values) {
    outputChannel.appendLine(`Could not find cache variable "${variableName}" in ${cacheFilePath}`);
    return undefined;
  }

  outputChannel.appendLine(`Found cache variable "${variableName}" in ${cacheFilePath}: ${JSON.stringify(values)}`);
  return values;
}

async function readCMakeCacheListVariable(cacheFilePath: string, variableName: string): Promise<string[] | undefined> {
  let content: string;
  try {
    content = await fs.readFile(cacheFilePath, "utf8");
  } catch {
    return undefined;
  }

  const escapedName = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escapedName}:[A-Za-z_]+=(.*)$`, "m").exec(content);
  if (!match) {
    return undefined;
  }

  return match[1].split(";").filter((value) => value.length > 0);
}

async function prepareServerCommand(context: ExtensionContext, command: string): Promise<string> {
  if (process.platform !== "win32") {
    return command;
  }

  const source = await findExecutable(command);
  if (!source) {
    throw new Error(`Could not find ${command} on PATH`);
  }

  const shadowDirectory = path.join(context.globalStorageUri.fsPath, "server-shadow-copies");
  await fs.mkdir(shadowDirectory, { recursive: true });
  await removeStaleShadowCopies(shadowDirectory);

  shadowServerPath = path.join(
    shadowDirectory,
    `${path.parse(source).name}-${process.pid}-${Date.now()}${path.extname(source)}`,
  );
  await fs.copyFile(source, shadowServerPath, constants.COPYFILE_EXCL);
  return shadowServerPath;
}

async function findExecutable(command: string): Promise<string | undefined> {
  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes("/")) {
    try {
      await fs.access(command, constants.X_OK);
      return command;
    } catch {
      return undefined;
    }
  }

  const pathDirectories = (process.env.PATH ?? "").split(path.delimiter);
  const extensions = path.extname(command)
    ? [""]
    : (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(path.delimiter);

  for (const directory of pathDirectories) {
    const unquotedDirectory = directory.replace(/^"|"$/g, "");
    for (const extension of extensions) {
      const candidate = path.resolve(unquotedDirectory || ".", `${command}${extension.toLowerCase()}`);
      try {
        await fs.access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep searching PATH.
      }
    }
  }

  return undefined;
}

async function removeStaleShadowCopies(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (entry.isFile()) {
      // An executable still used by another VS Code window remains locked and is
      // intentionally left in place until a later activation.
      await fs.rm(path.join(directory, entry.name), { force: true }).catch(() => undefined);
    }
  }));
}

async function removeCurrentShadowCopy(): Promise<void> {
  if (shadowServerPath) {
    await fs.rm(shadowServerPath, { force: true }).catch(() => undefined);
    shadowServerPath = undefined;
  }
}
