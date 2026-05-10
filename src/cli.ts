#!/usr/bin/env node
import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchWetwPointEntries } from "./adapters/wetw-point-api.js";
import { calculateBalances, identityKey } from "./core/normalize.js";
import type { SyncReport } from "./core/types.js";

const program = new Command();

program
  .name("wp-line-point-migrator")
  .description("Detect, normalize, and migrate WordPress LINE-linked point systems")
  .version("0.1.0");

program
  .command("sync")
  .argument("<adapter>", "source adapter, currently: wetw")
  .requiredOption("--base-url <url>", "WETW point API base URL")
  .requiredOption("--api-key <key>", "WETW point API key")
  .option("--shop-id <id>", "shop ID", Number)
  .option("--line-user-id <uid>", "LINE user ID")
  .requiredOption("--provider-key <key>", "provider key, for example oa1")
  .option("--source-site <url>", "source WordPress site URL")
  .option("--per-page <n>", "page size", Number, 100)
  .option("--max-pages <n>", "maximum pages to read", Number, 500)
  .requiredOption("--out <file>", "output JSON report path")
  .action(async (adapter: string, options) => {
    if (adapter !== "wetw") {
      throw new Error(`Unsupported adapter: ${adapter}`);
    }

    const entries = await fetchWetwPointEntries({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      shopId: options.shopId,
      lineUserId: options.lineUserId,
      providerKey: options.providerKey,
      sourceSite: options.sourceSite,
      perPage: options.perPage,
      maxPages: options.maxPages
    });
    const balances = calculateBalances(entries);
    const identities = new Set(entries.map((entry) => identityKey(entry.identity)));
    const report: SyncReport = {
      sourceRef: {
        sourceType: "wetw-point-api",
        sourceSite: options.sourceSite,
        providerKey: options.providerKey,
        shopId: options.shopId
      },
      fetchedEntries: entries.length,
      normalizedEntries: entries.length,
      identities: identities.size,
      balances,
      entries
    };

    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`Wrote ${entries.length} entries for ${identities.size} identities to ${options.out}`);
  });

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
