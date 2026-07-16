import { constants, promises as fs } from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient;
let shadowServerPath: string | undefined;

export async function activate(context: ExtensionContext): Promise<void> {
  console.log("Pave is now active!");

  const serverCommand = await prepareServerCommand(context, "pavels");
  const serverOptions: ServerOptions = {
    run: { command: serverCommand, transport: TransportKind.pipe },
    debug: { command: serverCommand, transport: TransportKind.pipe },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "pave" }],
    synchronize: {
      configurationSection: ["pave"],
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
