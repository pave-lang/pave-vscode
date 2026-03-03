import * as path from "node:path";
import type { ExtensionContext } from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient;

export function activate(context: ExtensionContext) {
  console.log("Pave is now active!");

  const serverModule = context.asAbsolutePath(path.join("out", "pavels"));

  const serverOptions: ServerOptions = {
    run: { command: serverModule, transport: TransportKind.pipe },
    debug: { command: serverModule, transport: TransportKind.pipe },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "pave" }],
    synchronize: {
      configurationSection: ["pave"],
    },
  };

  client = new LanguageClient("pave", "Pave", serverOptions, clientOptions);
  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
