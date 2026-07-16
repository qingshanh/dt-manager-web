import express, { type Application, type RequestHandler } from "express";

type JsonBodyLimitOptions = {
  standardLimit?: string | number;
  backupLimit?: string | number;
};

export function installJsonBodyParsers(
  app: Pick<Application, "use">,
  requireBackupAuth: RequestHandler,
  options: JsonBodyLimitOptions = {}
) {
  app.use(
    "/api/accounts/backup/import",
    requireBackupAuth,
    express.json({ limit: options.backupLimit ?? "100mb" })
  );
  app.use(express.json({ limit: options.standardLimit ?? "2mb" }));
}
