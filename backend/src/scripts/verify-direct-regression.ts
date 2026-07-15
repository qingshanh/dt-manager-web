import process from "node:process";
import zlib from "node:zlib";
import fs from "node:fs";
import { AccountStatus, AppVariant, LoginType, MessageDirection, MessageType, PhoneStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import {
  DirectDingtoneGateway,
  buildDirectAccessCodeDryRun,
  inferAccessCodeCountryCode,
  type DirectAccessCodeDryRun,
  type DirectPhoneActionDryRun
} from "../services/dingtone/direct-gateway.js";
import { parseSmsPush } from "../services/dingtone/message-parser.js";
import type { DingtonePhoneCountryOption, DingtonePhoneNumber, DingtonePhonePurchasePreview } from "../services/dingtone/types.js";
import { storeParsedSmsPushes } from "../services/message-runtime.js";
import { getSettingsMap } from "../services/settings.service.js";
import { buildPhoneTelegramNotificationText } from "../services/telegram-notifier.js";
import {
  buildBotPhoneActionVerificationNote,
  buildTraceAccessCodeDryRunText,
  isConfirmToken,
  normalizeTelegramNoteText,
  parseBuyNumberArgs,
  parsePhoneActionArgs,
  parseTraceAccessCodeArgs,
  validateTraceAccessCodeTarget
} from "../services/telegram-bot.js";
import { validateDirectTemplateSetting } from "../services/dingtone/direct-template.js";
import {
  assertAccountPhoneNumber,
  buildDirectMessageOfflineTemplateStatus,
  buildDirectMessageRefreshNote,
  assertPhoneCountrySelection,
  requiresAccessCodeProbeConfirm,
  requiresPhoneCancelConfirm,
  requiresPhonePauseConfirm,
  requiresPhonePurchaseConfirm,
  requiresPhoneResumeConfirm,
  requiresPhoneRenewConfirm
} from "../routes/accounts.js";
import {
  candidateConfidence,
  collectCandidates,
  defaultParamsFor,
  getCaptureEnvironmentWarnings,
  requiresExplicitWriteIndex
} from "./import-direct-template.js";
import { assertValidCliTarget, parseAccessCodeProbeCliArgs } from "./probe-direct-access-code.js";
import { decryptText } from "../utils/crypto.js";
import { repairUtf8Mojibake } from "../utils/serializers.js";

type CliOptions = {
  accountId?: number;
  previewCountryCode?: number;
  previewIsoCountryCode?: string;
  requirePreview: boolean;
  staticOnly: boolean;
  json: boolean;
};

type ResolvedAccount = {
  accountId: number;
  dtUserId: string;
  token: string;
  deviceId: string;
};

const expectedCountryKeys = [
  "US",
  "CA",
  "GB",
  "BE",
  "NL",
  "RU",
  "ES",
  "CN",
  "AU",
  "AT",
  "FR",
  "SE",
  "MU",
  "PL",
  "ID",
  "PR",
  "CZ",
  "MY",
  "DK",
  "RO"
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];

  checks.push(checkSmsParsingAndRepair());
  checks.push(checkAccessCodeDryRuns());
  checks.push(checkAccessCodeProbeConfirm());
  checks.push(checkPhoneCancelConfirm());
  checks.push(checkPhonePurchaseConfirm());
  checks.push(checkPhoneRenewConfirm());
  checks.push(checkPhonePauseResumeConfirm());
  checks.push(checkPhoneCountrySelection());
  checks.push(checkPhoneVerificationFlags());
  checks.push(checkAccessCodeProbeCliSafety());
  checks.push(checkTelegramConfirmToken());
  checks.push(checkTelegramNoteText());
  checks.push(checkTelegramBuyNumberArgs());
  checks.push(checkTelegramPhoneActionArgs());
  checks.push(checkTelegramTraceAccessCodeArgs());
  checks.push(checkTelegramBotPhoneActionNotes());
  checks.push(checkTelegramAccessCodeTrace());
  checks.push(checkTelegramCommandErrorWrapping());
  checks.push(checkVerificationLoginMessages());
  checks.push(checkActivationGatewayRouting());
  checks.push(checkDirectEmailActivationNativeParams());
  checks.push(checkDirectActivationVariantTemplates());
  checks.push(checkDirectVerificationRandomDeviceIds());
  checks.push(checkDirectProxySupport());
  checks.push(checkDirectEmailLoginUiAndDocs());
  checks.push(checkDirectRefreshHydration());
  checks.push(checkDirectBalanceQueryAttempts());
  checks.push(checkPointPartialFallbackWithoutUid());
  checks.push(checkMockVerificationDeliveryMessages());
  checks.push(checkAccessCodeProbeUiSafetyCopy());
  checks.push(checkCodeReceiverApiSourceGuards());
  checks.push(checkTelegramCodeCommandTargetsPhone());
  checks.push(checkDirectTemplateValidation());
  checks.push(checkDirectTemplateImportCandidates());
  checks.push(checkOfflineTemplateRefreshNotes());
  checks.push(checkRealtimePushListenerAcceptsAny8107Sms());
  checks.push(checkRealtimePushListenerSendsDeliveryConfirm());
  checks.push(checkLoginBootstrapPatchesAppIdentity());
  checks.push(checkSessionImportVariantGuards());
  checks.push(checkDtUserIdMonitorUniqueness());
  checks.push(checkLegacyEncryptionKeyFallback());
  checks.push(checkMonitorStartTokenPreflight());
  checks.push(checkDuplicateSessionMergeAcrossVariants());
  checks.push(checkSessionImportTokenReuseGuard());
  checks.push(checkDirectMonitorHostDiagnostics());
  checks.push(checkPreviewAreaCodeBackfill());
  checks.push(checkPhoneTelegramNotifications());

  if (options.staticOnly) {
    const output = {
      ok: checks.every((item) => item.ok),
      accountId: options.accountId ?? 0,
      checks,
      countries: {
        count: 0,
        keys: [] as string[]
      }
    };
    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      printSummary(output);
    }
    if (!output.ok) {
      process.exitCode = 2;
    }
    return;
  }

  const account = await resolveAccount(options.accountId);
  const gateway = new DirectDingtoneGateway();

  const countries = await gateway.listPhoneNumberCountries(account);
  checks.push(checkCountryList(countries));

  const settings = await getSettingsMap();
  checks.push({
    name: "direct_message_listen_seconds",
    ok: Number(settings.direct_message_listen_seconds) >= 300,
    detail: { value: settings.direct_message_listen_seconds }
  });
  checks.push(await checkCountryKeyPurchaseDryRun(account));
  checks.push(await checkDirectMessageStoreTransaction(account.accountId));
  checks.push(await checkTeamMessagesPerAccountNoTelegram());
  checks.push(await checkPhoneOwnershipGuard(account.accountId));

  const phone = await resolvePhone(account.accountId);
  if (phone) {
    const actions = await gateway.buildPhoneActionDryRuns(account, {
      phoneNumber: phone.phoneNumber,
      phone
    });
    checks.push(checkPhoneActionDryRuns(actions, phone.status));
  } else {
    checks.push({
      name: "phone_action_dry_runs",
      ok: false,
      detail: { error: "No stored phone number found for this account." }
    });
  }

  let preview: DingtonePhonePurchasePreview | undefined;
  let previewError: string | undefined;
  if (options.previewCountryCode) {
    try {
      preview = await withRetries(
        async () => {
          const result = await gateway.requestPhoneNumber(account, {
            countryCode: options.previewCountryCode,
            isoCountryCode: options.previewIsoCountryCode
          });
          if (result.candidates.length === 0) {
            throw new Error("Preview returned no phone number candidates.");
          }
          return result;
        },
        3
      );
      checks.push(checkPhonePreview(preview, options.requirePreview));
    } catch (error) {
      previewError = error instanceof Error ? error.message : String(error);
      checks.push({
        name: "phone_preview_prices",
        ok: false,
        detail: {
          error: previewError,
          countryCode: options.previewCountryCode,
          isoCountryCode: options.previewIsoCountryCode
        }
      });
    }
  }

  const output = {
    ok: checks.every((item) => item.ok),
    accountId: account.accountId,
    checks,
    countries: {
      count: countries.length,
      keys: countries.map((item) => item.countryKey)
    },
    phoneActionPhone: phone?.phoneNumber,
    preview: preview
      ? {
          countryCode: options.previewCountryCode,
          isoCountryCode: options.previewIsoCountryCode,
          candidateCount: preview.candidates.length,
          first: preview.candidates[0] ?? null
        }
      : previewError
        ? {
            countryCode: options.previewCountryCode,
            isoCountryCode: options.previewIsoCountryCode,
            candidateCount: 0,
            first: null,
            error: previewError
          }
        : undefined
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printSummary(output);
  }

  if (!output.ok) {
    process.exitCode = 2;
  }
}

function checkCountryList(countries: DingtonePhoneCountryOption[]) {
  const keys = countries.map((item) => item.countryKey);
  const missing = expectedCountryKeys.filter((key) => !keys.includes(key));
  const unexpected = keys.filter((key) => !expectedCountryKeys.includes(key));
  const us = countries.find((item) => item.countryKey === "US");
  const ca = countries.find((item) => item.countryKey === "CA");
  const usCaSeparated =
    (!us && !ca) ||
    (us?.countryCode === 1 &&
      us.isoCountryCode === "US" &&
      ca?.countryCode === 1 &&
      ca.isoCountryCode === "CA" &&
      (us.providerIdList ?? []).includes("2000") &&
      (us.providerIdList ?? []).includes("2001") &&
      (ca.providerIdList ?? []).includes("2000") &&
      (ca.providerIdList ?? []).includes("2001"));

  return {
    name: "app_country_mapping",
    ok: missing.length === 0 && unexpected.length === 0 && usCaSeparated,
    detail: {
      count: countries.length,
      missing,
      unexpected,
      us,
      ca
    }
  };
}

function checkAccessCodeDryRuns() {
  const phone = buildDirectAccessCodeDryRun({
    kind: "phone",
    target: "+15551234567",
    countryCode: 1,
    accessCode: "123456"
  });
  const francePhone = buildDirectAccessCodeDryRun({
    kind: "phone",
    target: "+33700000000",
    accessCode: "654321"
  });
  const francePhoneWithoutPlus = buildDirectAccessCodeDryRun({
    kind: "phone",
    target: "33700000000"
  });
  const puertoRicoPhone = buildDirectAccessCodeDryRun({
    kind: "phone",
    target: "+17875551234"
  });
  const email = buildDirectAccessCodeDryRun({
    kind: "email",
    target: "test@example.com"
  });
  const invalidPhoneRejected = throwsMessage(() =>
    buildDirectAccessCodeDryRun({
      kind: "phone",
      target: "not-a-phone"
    }),
    "Invalid phone target for access-code probe"
  );
  const invalidEmailRejected = throwsMessage(() =>
    buildDirectAccessCodeDryRun({
      kind: "email",
      target: "not-an-email"
    }),
    "Invalid email target for access-code probe"
  );
  const phoneRecoverJson = parseAccessCodeJson(phone.recoverPassword.params.json);
  const phoneVerifyJson = parseAccessCodeJson(phone.verifyAccessCode?.params.json);
  const franceRecoverJson = parseAccessCodeJson(francePhone.recoverPassword.params.json);
  const franceVerifyJson = parseAccessCodeJson(francePhone.verifyAccessCode?.params.json);
  const franceWithoutPlusRecoverJson = parseAccessCodeJson(francePhoneWithoutPlus.recoverPassword.params.json);
  const puertoRicoRecoverJson = parseAccessCodeJson(puertoRicoPhone.recoverPassword.params.json);
  const emailRecoverJson = parseAccessCodeJson(email.recoverPassword.params.json);

  return {
    name: "access_code_dry_runs",
    ok:
      phone.kind === "phone" &&
      phone.capability.mode === "probe_only" &&
      phone.capability.loginTokenCompleted === false &&
      phone.capability.requiresExternalCaptureForLoginToken === true &&
      phone.capability.verifiedCalls.includes("recoverPassword") &&
      phone.capability.verifiedCalls.includes("verifyAccessCode") &&
      phone.countryCode === 1 &&
      phone.recoverPassword.apiName === "recoverPassword" &&
      phone.recoverPassword.params.type === "2" &&
      phone.recoverPassword.params.noCode === "0" &&
      phoneRecoverJson?.countryCode === 1 &&
      phoneRecoverJson?.phoneNumber === "15551234567" &&
      phone.verifyAccessCode?.apiName === "verifyAccessCode" &&
      phone.verifyAccessCode.params.type === "2" &&
      phone.verifyAccessCode.params.accessCode === "123456" &&
      phoneVerifyJson?.phoneNumber === "15551234567" &&
      inferAccessCodeCountryCode("+33700000000") === 33 &&
      inferAccessCodeCountryCode("33700000000") === 33 &&
      inferAccessCodeCountryCode("3375551234") === undefined &&
      inferAccessCodeCountryCode("+17875551234") === 1787 &&
      francePhone.countryCode === 33 &&
      franceRecoverJson?.countryCode === 33 &&
      franceRecoverJson?.phoneNumber === "33700000000" &&
      franceVerifyJson?.countryCode === 33 &&
      franceVerifyJson?.accessCode === undefined &&
      francePhone.verifyAccessCode?.params.accessCode === "654321" &&
      francePhoneWithoutPlus.countryCode === 33 &&
      franceWithoutPlusRecoverJson?.countryCode === 33 &&
      puertoRicoPhone.countryCode === 1787 &&
      puertoRicoRecoverJson?.countryCode === 1787 &&
      email.kind === "email" &&
      email.capability.mode === "probe_only" &&
      email.capability.loginTokenCompleted === false &&
      email.countryCode === 1 &&
      email.recoverPassword.params.type === "1" &&
      email.recoverPassword.params.noCode === "0" &&
      emailRecoverJson?.email === "test@example.com" &&
      email.verifyAccessCode === undefined &&
      invalidPhoneRejected &&
      invalidEmailRejected,
    detail: {
      capability: phone.capability,
      phone: summarizeAccessCodeDryRun(phone),
      francePhone: summarizeAccessCodeDryRun(francePhone),
      francePhoneWithoutPlus: summarizeAccessCodeDryRun(francePhoneWithoutPlus),
      puertoRicoPhone: summarizeAccessCodeDryRun(puertoRicoPhone),
      email: summarizeAccessCodeDryRun(email),
      invalidPhoneRejected,
      invalidEmailRejected
    }
  };
}

function parseAccessCodeJson(value: string | undefined) {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function summarizeAccessCodeDryRun(dryRun: DirectAccessCodeDryRun) {
  return {
    kind: dryRun.kind,
    target: dryRun.target,
    countryCode: dryRun.countryCode,
    recoverPassword: dryRun.recoverPassword.params,
    verifyAccessCode: dryRun.verifyAccessCode?.params
  };
}

function checkAccessCodeProbeConfirm() {
  return {
    name: "access_code_probe_confirm",
    ok:
      !requiresAccessCodeProbeConfirm({}) &&
      requiresAccessCodeProbeConfirm({ dry_run: false }) &&
      !requiresAccessCodeProbeConfirm({ dry_run: false, confirm: true }) &&
      !requiresAccessCodeProbeConfirm({ dry_run: true }),
    detail: {
      omittedDryRunNeedsConfirm: requiresAccessCodeProbeConfirm({}),
      dryRunNeedsConfirm: requiresAccessCodeProbeConfirm({ dry_run: true }),
      realWithoutConfirmNeedsConfirm: requiresAccessCodeProbeConfirm({ dry_run: false }),
      realWithConfirmNeedsConfirm: requiresAccessCodeProbeConfirm({ dry_run: false, confirm: true })
    }
  };
}

function checkPhoneCancelConfirm() {
  return {
    name: "phone_cancel_confirm",
    ok:
      requiresPhoneCancelConfirm({}) &&
      requiresPhoneCancelConfirm({ confirm: false }) &&
      !requiresPhoneCancelConfirm({ confirm: true }),
    detail: {
      missingNeedsConfirm: requiresPhoneCancelConfirm({}),
      falseNeedsConfirm: requiresPhoneCancelConfirm({ confirm: false }),
      trueNeedsConfirm: requiresPhoneCancelConfirm({ confirm: true })
    }
  };
}

function checkPhonePurchaseConfirm() {
  return {
    name: "phone_purchase_confirm",
    ok:
      requiresPhonePurchaseConfirm({}) &&
      requiresPhonePurchaseConfirm({ confirm: false }) &&
      !requiresPhonePurchaseConfirm({ confirm: true }),
    detail: {
      missingNeedsConfirm: requiresPhonePurchaseConfirm({}),
      falseNeedsConfirm: requiresPhonePurchaseConfirm({ confirm: false }),
      trueNeedsConfirm: requiresPhonePurchaseConfirm({ confirm: true })
    }
  };
}

function checkPhoneRenewConfirm() {
  return {
    name: "phone_renew_confirm",
    ok:
      requiresPhoneRenewConfirm({}) &&
      requiresPhoneRenewConfirm({ confirm: false }) &&
      !requiresPhoneRenewConfirm({ confirm: true }),
    detail: {
      missingNeedsConfirm: requiresPhoneRenewConfirm({}),
      falseNeedsConfirm: requiresPhoneRenewConfirm({ confirm: false }),
      trueNeedsConfirm: requiresPhoneRenewConfirm({ confirm: true })
    }
  };
}

function checkPhonePauseResumeConfirm() {
  return {
    name: "phone_pause_resume_confirm",
    ok:
      requiresPhonePauseConfirm({}) &&
      requiresPhonePauseConfirm({ confirm: false }) &&
      !requiresPhonePauseConfirm({ confirm: true }) &&
      requiresPhoneResumeConfirm({}) &&
      requiresPhoneResumeConfirm({ confirm: false }) &&
      !requiresPhoneResumeConfirm({ confirm: true }),
    detail: {
      pause: {
        missingNeedsConfirm: requiresPhonePauseConfirm({}),
        falseNeedsConfirm: requiresPhonePauseConfirm({ confirm: false }),
        trueNeedsConfirm: requiresPhonePauseConfirm({ confirm: true })
      },
      resume: {
        missingNeedsConfirm: requiresPhoneResumeConfirm({}),
        falseNeedsConfirm: requiresPhoneResumeConfirm({ confirm: false }),
        trueNeedsConfirm: requiresPhoneResumeConfirm({ confirm: true })
      }
    }
  };
}

function checkPhoneCountrySelection() {
  const validFrance = doesNotThrow(() =>
    assertPhoneCountrySelection({ country_code: 33, iso_country_code: "FR", country_key: "FR" })
  );
  const validCanada = doesNotThrow(() =>
    assertPhoneCountrySelection({ country_code: 1, iso_country_code: "CA", country_key: "CA" })
  );
  const rejectsBadCountryCode = throwsMessage(
    () => assertPhoneCountrySelection({ country_code: 33, iso_country_code: "CA", country_key: "CA" }),
    "does not match country_key CA"
  );
  const rejectsBadIso = throwsMessage(
    () => assertPhoneCountrySelection({ country_code: 1, iso_country_code: "US", country_key: "CA" }),
    "does not match country_key CA"
  );
  const rejectsUnknownKey = throwsMessage(
    () => assertPhoneCountrySelection({ country_code: 999, country_key: "ZZ" }),
    "Unsupported phone country_key"
  );

  return {
    name: "phone_country_selection_guard",
    ok: validFrance && validCanada && rejectsBadCountryCode && rejectsBadIso && rejectsUnknownKey,
    detail: {
      validFrance,
      validCanada,
      rejectsBadCountryCode,
      rejectsBadIso,
      rejectsUnknownKey
    }
  };
}

function checkPhoneVerificationFlags() {
  const routeText = readSourceFile("src/routes/accounts.ts");
  const purchaseUsesModeFlag =
    routeText.includes("type PurchaseConfirmationSource = \"remote_phone_list\" | \"adb_phone_db\" | \"helper_purchase_response\"") &&
    routeText.includes("verificationSource: confirmation.source") &&
    routeText.includes("confirmed: confirmation.confirmed") &&
    routeText.includes("Direct purchase was not confirmed; local phone data was not changed");
  const actionUsesModeFlag = routeText.includes("source: useDirect ? \"remote_phone_list\" : \"helper_action_response\"") &&
    Boolean(routeText.match(/confirmed: useDirect/g)?.length);

  return {
    name: "phone_verification_flags",
    ok: Boolean(purchaseUsesModeFlag && actionUsesModeFlag),
    detail: {
      purchaseUsesModeFlag,
      actionUsesModeFlag
    }
  };
}

function doesNotThrow(operation: () => void) {
  try {
    operation();
    return true;
  } catch {
    return false;
  }
}

function throwsMessage(operation: () => void, expected: string) {
  try {
    operation();
    return false;
  } catch (error) {
    return error instanceof Error && error.message.includes(expected);
  }
}

function checkAccessCodeProbeCliSafety() {
  const omitted = parseAccessCodeProbeCliArgs(["--kind", "phone", "--target", "+15551234567"]);
  const real = parseAccessCodeProbeCliArgs(["--kind", "phone", "--target", "+15551234567", "--real"]);
  const confirmed = parseAccessCodeProbeCliArgs(["--kind", "phone", "--target", "+15551234567", "--real", "--confirm"]);
  const invalidPhoneRejected = throwsMessage(
    () => assertValidCliTarget("phone", "not-a-phone"),
    "Invalid phone target"
  );
  const invalidEmailRejected = throwsMessage(
    () => assertValidCliTarget("email", "not-an-email"),
    "Invalid email target"
  );

  return {
    name: "access_code_probe_cli_safety",
    ok:
      omitted.dryRun &&
      !omitted.confirm &&
      !real.dryRun &&
      !real.confirm &&
      !confirmed.dryRun &&
      confirmed.confirm &&
      invalidPhoneRejected &&
      invalidEmailRejected,
    detail: {
      omitted: { dryRun: omitted.dryRun, confirm: omitted.confirm },
      real: { dryRun: real.dryRun, confirm: real.confirm },
      confirmed: { dryRun: confirmed.dryRun, confirm: confirmed.confirm },
      invalidPhoneRejected,
      invalidEmailRejected
    }
  };
}

function checkTelegramConfirmToken() {
  return {
    name: "telegram_confirm_token",
    ok:
      isConfirmToken("confirm") &&
      isConfirmToken("CONFIRM") &&
      isConfirmToken(" confirm ") &&
      !isConfirmToken(undefined) &&
      !isConfirmToken("") &&
      !isConfirmToken("confirmed"),
    detail: {
      confirm: isConfirmToken("confirm"),
      upper: isConfirmToken("CONFIRM"),
      padded: isConfirmToken(" confirm "),
      missing: isConfirmToken(undefined),
      empty: isConfirmToken(""),
      wrong: isConfirmToken("confirmed")
    }
  };
}

function checkTelegramNoteText() {
  const trimmed = normalizeTelegramNoteText("  澶囨敞 OK  ");
  const empty = normalizeTelegramNoteText("   ");
  const max = normalizeTelegramNoteText("a".repeat(100));
  const tooLong = normalizeTelegramNoteText("a".repeat(101));
  return {
    name: "telegram_note_text",
    ok:
      trimmed.normalized === "澶囨敞 OK" &&
      !trimmed.empty &&
      !trimmed.tooLong &&
      empty.empty &&
      !empty.tooLong &&
      !max.tooLong &&
      tooLong.tooLong &&
      tooLong.maxLength === 100,
    detail: {
      trimmed,
      empty,
      max,
      tooLong
    }
  };
}

function checkTelegramBuyNumberArgs() {
  const confirmThenArea = parseBuyNumberArgs(["confirm", "75"]);
  const areaThenConfirm = parseBuyNumberArgs(["75", "CONFIRM"]);
  const noConfirm = parseBuyNumberArgs(["75"]);
  const confirmOnly = parseBuyNumberArgs([" confirm "]);
  const explicitPhone = parseBuyNumberArgs(["confirm", "75", "phone=33700000000"]);
  const longNumberPhone = parseBuyNumberArgs(["confirm", "33700000000"]);
  return {
    name: "telegram_buy_number_args",
    ok:
      confirmThenArea.confirm &&
      confirmThenArea.areaCode === 75 &&
      areaThenConfirm.confirm &&
      areaThenConfirm.areaCode === 75 &&
      !noConfirm.confirm &&
      noConfirm.areaCode === 75 &&
      confirmOnly.confirm &&
      confirmOnly.areaCode === undefined &&
      explicitPhone.areaCode === 75 &&
      explicitPhone.phoneNumber === "33700000000" &&
      longNumberPhone.phoneNumber === "33700000000" &&
      longNumberPhone.areaCode === undefined,
    detail: {
      confirmThenArea,
      areaThenConfirm,
      noConfirm,
      confirmOnly,
      explicitPhone,
      longNumberPhone
    }
  };
}

function checkTelegramPhoneActionArgs() {
  const plain = parsePhoneActionArgs(["3", "33700000000"]);
  const confirmed = parsePhoneActionArgs(["3", "33700000000", "confirm"]);
  const trailingConfirm = parsePhoneActionArgs(["3", "33700000000", "reason", "CONFIRM"]);
  const leadingConfirm = parsePhoneActionArgs(["3", "confirm", "33700000000"]);
  const padded = parsePhoneActionArgs(["3", " 33700000000 ", " confirm "]);
  const renewConfirm = parsePhoneActionArgs(["3", "33700000000", "renew-now", "confirm"]);
  const wrong = parsePhoneActionArgs(["3", "33700000000", "confirmed"]);
  return {
    name: "telegram_phone_action_args",
    ok:
      plain.phoneRef === "33700000000" &&
      !plain.confirm &&
      confirmed.confirm &&
      trailingConfirm.confirm &&
      leadingConfirm.phoneRef === "33700000000" &&
      leadingConfirm.confirm &&
      padded.phoneRef === "33700000000" &&
      padded.confirm &&
      renewConfirm.confirm &&
      !wrong.confirm,
    detail: {
      plain,
      confirmed,
      trailingConfirm,
      leadingConfirm,
      padded,
      renewConfirm,
      wrong
    }
  };
}

function checkTelegramTraceAccessCodeArgs() {
  const inferred = parseTraceAccessCodeArgs(["3", "phone", "33700000000", "123456"]);
  const explicitBeforeCode = parseTraceAccessCodeArgs(["3", "phone", "612345678", "cc=33", "123456"]);
  const explicitAfterCode = parseTraceAccessCodeArgs(["3", "phone", "612345678", "123456", "country_code=33", "confirm"]);
  const explicitUpper = parseTraceAccessCodeArgs(["3", "phone", "612345678", "COUNTRY=+33", "CONFIRM"]);
  const emailIgnoresCountry = parseTraceAccessCodeArgs(["3", "email", "test@example.com", "cc=33", "123456"]);
  const invalidPhone = validateTraceAccessCodeTarget("phone", "not-a-phone");
  const invalidEmail = validateTraceAccessCodeTarget("email", "not-an-email");
  return {
    name: "telegram_trace_access_code_args",
    ok:
      inferred?.countryCode === 33 &&
      inferred.accessCode === "123456" &&
      inferred.dryRun &&
      explicitBeforeCode?.countryCode === 33 &&
      explicitBeforeCode.accessCode === "123456" &&
      explicitAfterCode?.countryCode === 33 &&
      explicitAfterCode.accessCode === "123456" &&
      !explicitAfterCode.dryRun &&
      explicitUpper?.countryCode === 33 &&
      explicitUpper.accessCode === undefined &&
      !explicitUpper.dryRun &&
      emailIgnoresCountry?.countryCode === undefined &&
      emailIgnoresCountry?.accessCode === "123456" &&
      typeof invalidPhone === "string" &&
      typeof invalidEmail === "string",
    detail: {
      inferred,
      explicitBeforeCode,
      explicitAfterCode,
      explicitUpper,
      emailIgnoresCountry,
      invalidPhone,
      invalidEmail
    }
  };
}

function checkTelegramBotPhoneActionNotes() {
  const renew = buildBotPhoneActionVerificationNote("renew", "active");
  const pause = buildBotPhoneActionVerificationNote("pause", "paused");
  const resume = buildBotPhoneActionVerificationNote("resume", "active");
  const cancel = buildBotPhoneActionVerificationNote("cancel", "cancelled");
  return {
    name: "telegram_bot_phone_action_notes",
    ok:
      renew.includes("expiry time advanced") &&
      pause.includes("status became paused") &&
      resume.includes("status became active") &&
      cancel.includes("disappeared or returned cancelled"),
    detail: {
      renew,
      pause,
      resume,
      cancel
    }
  };
}

function checkTelegramAccessCodeTrace() {
  const phoneText = buildTraceAccessCodeDryRunText("phone", "+15551234567", 1, "123456");
  const emailText = buildTraceAccessCodeDryRunText("email", "test@example.com");

  return {
    name: "telegram_access_code_trace",
    ok:
      phoneText.includes("dry-run") &&
      phoneText.includes("Capability: probe_only; loginTokenCompleted=false") &&
      phoneText.includes("recoverPassword") &&
      phoneText.includes("type=2") &&
      phoneText.includes("noCode=0") &&
      phoneText.includes("accessCode=123456") &&
      phoneText.includes("confirm") &&
      emailText.includes("type=1") &&
      emailText.includes("Capability: probe_only; loginTokenCompleted=false") &&
      emailText.includes("verifyAccessCode: 未提供验证码，跳过"),
    detail: {
      phoneText,
      emailText
    }
  };
}

function checkTelegramCommandErrorWrapping() {
  const botText = readSourceFile("src/services/telegram-bot.ts");
  const wrappedFunctions = [
    "countryListText",
    "previewNumberText",
    "collectCodeText",
    "updatePhoneNoteText",
    "refreshAccountText",
    "refreshPhonesText",
    "buyNumberText",
    "traceAccessCodeText",
    "phoneActionText"
  ];
  const missing = wrappedFunctions.filter((name) => !functionBodyIncludes(botText, name, "withTelegramCommandError"));
  const callbackSafe =
    botText.includes("await handlePanelCallbackSafe(callback.data)") &&
    functionBodyIncludes(botText, "handlePanelCallbackSafe", "Telegram bot callback failed") &&
    functionBodyIncludes(botText, "handlePanelCallbackSafe", "操作失败：${errorMessage(error)}");
  return {
    name: "telegram_command_error_wrapping",
    ok: missing.length === 0 && callbackSafe && botText.includes("操作失败：${errorMessage(error)}"),
    detail: {
      missing,
      callbackSafe
    }
  };
}

function functionBodyIncludes(source: string, functionName: string, needle: string) {
  const start = source.indexOf(`function ${functionName}`);
  if (start < 0) {
    return false;
  }
  const next = source.indexOf("\nasync function ", start + 1);
  const body = source.slice(start, next < 0 ? undefined : next);
  return body.includes(needle);
}

function checkVerificationLoginMessages() {
  const routeText = repairUtf8Mojibake(readSourceFile("src/routes/accounts.ts")) ?? "";
  const sendMessage = "Only email or phone verification-code login can send a verification code.";
  const verifyMessage = "This account is not using email or phone verification-code login.";
  return {
    name: "verification_login_messages",
    ok:
      routeText.includes(sendMessage) &&
      routeText.includes(verifyMessage) &&
      !routeText.includes("鍙湁閭楠岃瘉鐮佺櫥褰曟敮鎸佸彂閫侀獙璇佺爜") &&
      !routeText.includes("email verification login placeholder"),
    detail: {
      sendMessage,
      verifyMessage
    }
  };
}

function checkActivationGatewayRouting() {
  const gatewayText = readSourceFile("src/services/dingtone/index.ts");
  const hasResolver = gatewayText.includes("async function resolveActivationGateway()");
  const mockPreserved = gatewayText.includes('if (mode === "mock")') && gatewayText.includes("return mockGateway;");
  const directUsesDirectLogin =
    gatewayText.includes('if (mode === "direct")') &&
    gatewayText.includes("return directGateway;") &&
    gatewayText.includes("return (await resolveActivationGateway()).sendVerificationCode(input);") &&
    gatewayText.includes("return (await resolveActivationGateway()).login(input);") &&
    !gatewayText.includes("return (await resolveGateway()).sendVerificationCode(input);") &&
    !gatewayText.includes("return (await resolveGateway()).login(input);");
  return {
    name: "activation_gateway_routing",
    ok: hasResolver && mockPreserved && directUsesDirectLogin,
    detail: {
      hasResolver,
      mockPreserved,
      directUsesDirectLogin
    }
  };
}

function checkDirectEmailActivationNativeParams() {
  const gatewayText = readSourceFile("src/services/dingtone/direct-gateway.ts");
  const activationBlock = extractFunctionBlock(gatewayText, "buildActivateEmailQuery");
  const activationJsonBlock = extractFunctionBlock(gatewayText, "buildActivationEmailJson");
  const deviceGuardBlock = extractFunctionBlock(gatewayText, "assertActivationDeviceId");
  const loginBlock = extractMethodBlock(gatewayText, "async login(input: DingtoneLoginInput)");
  const persistBlock = extractFunctionBlock(readSourceFile("src/routes/accounts.ts"), "persistAuthenticatedSession");
  const opensActivationSession =
    gatewayText.includes("async openActivation(identity: DirectActivationIdentity)") &&
    gatewayText.includes("await session.openActivation(identity)") &&
    gatewayText.includes('"getInfoBeforeLogin response"');
  const usesDirectApis =
    gatewayText.includes('"registerEmail"') &&
    gatewayText.includes("buildRegisterEmailQuery") &&
    gatewayText.includes('"activateEmail"') &&
    gatewayText.includes("buildActivateEmailQuery");
  const nativeQueryShape =
    activationBlock.includes("const deviceId = activationRestDeviceId(input.deviceId, input.appVariant)") &&
    activationBlock.includes('queryPair("deviceId", deviceId)') &&
    activationBlock.includes('queryPair("confirmCode", code)') &&
    activationBlock.includes('queryPair("osType", 2)') &&
    activationBlock.includes('queryPair("osVersion", "9")') &&
    activationBlock.includes('queryPair("deviceName", "OPPO")') &&
    activationBlock.includes('queryPair("deviceModel", "PCRT00")') &&
    activationBlock.includes('queryPair("devicepassword", "")') &&
    activationBlock.includes('queryPair("tokenVersion", 50331648)') &&
    activationBlock.includes('queryPair("TrackCode", input.trackCode)') &&
    activationBlock.includes('queryPair("apiVersion", 1)') &&
    activationBlock.includes('queryPair("LC", "zh")') &&
    activationBlock.includes('queryPair("simCC", "CN")') &&
    activationBlock.includes('queryPair("simu", 0)') &&
    activationBlock.includes('queryPair("rooted", 1)') &&
    activationBlock.includes('queryPair("json", buildActivationEmailJson(email))') &&
    activationBlock.includes('queryPair("clientInfo", buildActivationClientInfo(input, runtime))') &&
    activationBlock.includes('queryPair("pushMessageToken", "FCM.")');
  const activationJsonShape =
    activationJsonBlock.includes("Email: email") &&
    activationJsonBlock.includes("EmailMd5: nativeActivationEmailMd5(lowerEmail)") &&
    activationJsonBlock.includes("EmailEncrypt: encryptActivationTarget(lowerEmail)") &&
    activationJsonBlock.includes("RawEmailMD5: nativeActivationEmailMd5(email)") &&
    gatewayText.includes("DIRECT_ACTIVATION_EMAIL_CRYPTO_IV") &&
    activationJsonBlock.includes("ClientVersion: DIRECT_ACTIVATE_EMAIL_CLIENT_VERSION") &&
    activationJsonBlock.includes("type: 1");
  const sendVerificationBlock = extractMethodBlock(gatewayText, "async sendVerificationCode(input: DingtoneLoginInput)");
  const avoidsRecoverPasswordFallback =
    !sendVerificationBlock.includes('"recoverPassword"') &&
    !sendVerificationBlock.includes('verificationFlow: "recover"') &&
    sendVerificationBlock.includes('verificationFlow: "register"');
  const routeText = readSourceFile("src/routes/accounts.ts");
  const verifyRouteBlock = extractRouteBlock(routeText, 'accountsRouter.post("/:id/verify-code", async');
  const routesRegisteredVerification =
    verifyRouteBlock.includes("dingtoneGateway.login") &&
    verifyRouteBlock.includes("verificationCode: body.code") &&
    verifyRouteBlock.includes("finalizeSuccessfulLogin");
  const verifiesRecoveredAccessCode =
    routeText.includes("async function loginRecoveredVerificationAccount") &&
    routeText.includes("verifyDirectActivationAccessCode") &&
    routeText.includes('pickString(verifyPayload, ["password"])') &&
    routeText.includes('loginType: kind === "email" ? "email_password" : "phone_password"');
  const recoveredLoginBlock = extractFunctionBlock(routeText, "loginRecoveredVerificationAccount");
  const checksHelperBeforeConsumingRecoverCode =
    routeText.includes("assertHelperAvailable") &&
    recoveredLoginBlock.indexOf("assertHelperAvailable") >= 0 &&
    recoveredLoginBlock.indexOf("verifyDirectActivationAccessCode") >= 0 &&
    recoveredLoginBlock.indexOf("assertHelperAvailable") < recoveredLoginBlock.indexOf("verifyDirectActivationAccessCode") &&
    recoveredLoginBlock.includes("灏氭湭娑堣€楅獙璇佺爜");
  const staleDeviceGuard =
    loginBlock.includes("assertActivationDeviceId(input.deviceId, input.appVariant)") &&
    deviceGuardBlock.includes("isActivationDeviceIdAcceptedForVariant") &&
    deviceGuardBlock.includes("stale deviceId");
  const parsesNativeActivationResult =
    loginBlock.includes('"UserId"') &&
    loginBlock.includes('"Token"') &&
    loginBlock.includes('"DingtoneId"');
  const prefersCapturedTemplateDevice =
    gatewayText.includes("extractConfiguredActivationTemplateDeviceId") &&
    loginBlock.includes('activationTemplateSettingKeys("activateEmail"') &&
    loginBlock.includes("input.deviceId ?? templateDeviceId ?? extractActivationDeviceId(payload)");
  const persistsActivationDingtoneId =
    persistBlock.includes("dingtoneId?: string | null") &&
    persistBlock.includes("dtDingtoneId: session.dingtoneId");
  return {
    name: "direct_email_activation_native_params",
    ok:
      opensActivationSession &&
      usesDirectApis &&
      nativeQueryShape &&
      activationJsonShape &&
      avoidsRecoverPasswordFallback &&
      routesRegisteredVerification &&
      staleDeviceGuard &&
      parsesNativeActivationResult &&
      prefersCapturedTemplateDevice &&
      persistsActivationDingtoneId,
    detail: {
      opensActivationSession,
      usesDirectApis,
      nativeQueryShape,
      activationJsonShape,
      avoidsRecoverPasswordFallback,
      routesRegisteredVerification,
      verifiesRecoveredAccessCode,
      checksHelperBeforeConsumingRecoverCode,
      staleDeviceGuard,
      parsesNativeActivationResult,
      prefersCapturedTemplateDevice,
      persistsActivationDingtoneId
    }
  };
}

function checkDirectActivationVariantTemplates() {
  const gatewayText = readSourceFile("src/services/dingtone/direct-gateway.ts");
  const routeText = readSourceFile("src/routes/accounts.ts");
  const templateText = readSourceFile("src/services/dingtone/direct-template.ts");
  const settingsText = readSourceFile("src/services/settings.service.ts");
  const importText = readSourceFile("src/scripts/import-direct-template.ts");
  const activationApiBlock = extractFunctionBlock(gatewayText, "callDirectActivationApi");
  const registerBranchStart = activationApiBlock.indexOf('if (apiName === "registerEmail")');
  const registerBranchEnd = activationApiBlock.indexOf('activationTemplateSettingKeys("registerEmail", identity)', registerBranchStart);
  const registerBranch =
    registerBranchStart >= 0 && registerBranchEnd >= registerBranchStart
      ? activationApiBlock.slice(registerBranchStart, registerBranchEnd)
      : "";
  const hasVariantKeys =
    templateText.includes('"dt_direct_template_register_email_talku"') &&
    templateText.includes('"dt_direct_template_register_email_dingdong"') &&
    templateText.includes('"dt_direct_template_activate_email_talku"') &&
    templateText.includes('"dt_direct_template_activate_email_dingdong"');
  const gatewaySelectsVariantKeys =
    gatewayText.includes("function activationTemplateSettingKeys") &&
    gatewayText.includes("function activationTemplateVariantSettingKey") &&
    gatewayText.includes('const suffix = identity.appVariant === "dingdong" ? "dingdong" : "talku"') &&
    gatewayText.includes('return `${baseKey}_${suffix}`');
  const registerUsesVariantSelector =
    gatewayText.includes('activationTemplateSettingKeys("registerEmail", identity)') &&
    !gatewayText.includes('getConfiguredDirectTemplate("dt_direct_template_register_email"))');
  const registerPatchesCurrentEmail =
    activationApiBlock.includes("buildRegisterEmailTemplateParams(query)") &&
    gatewayText.includes("function buildRegisterEmailTemplateParams(query: string)") &&
    gatewayText.includes('__appendQueryKeys: "appType,appId"') &&
    activationApiBlock.includes("callConfiguredRegisterEmailTemplate") &&
    activationApiBlock.includes('activationTemplateSettingKeys("registerEmail", identity)');
  const routeChecksAccountVariant =
    routeText.includes("appVariant: account.appVariant") &&
    routeText.includes("normalizeVerificationDeviceId(account.dtDeviceId, account.appVariant, account.loginType)");
  const defaultsExposeVariantKeys =
    settingsText.includes('"dt_direct_template_register_email_talku"') &&
    settingsText.includes('"dt_direct_template_activate_email_talku"');
  const importScriptNormalizesVariantKeys =
    importText.includes("baseTemplateSettingKey(settingKey)") &&
    importText.includes('replace(/_(talku|dingdong)$/i, "")');
  return {
    name: "direct_activation_variant_templates",
    ok:
      hasVariantKeys &&
      gatewaySelectsVariantKeys &&
      registerUsesVariantSelector &&
      registerPatchesCurrentEmail &&
      routeChecksAccountVariant &&
      defaultsExposeVariantKeys &&
      importScriptNormalizesVariantKeys,
    detail: {
      hasVariantKeys,
      gatewaySelectsVariantKeys,
      registerUsesVariantSelector,
      registerPatchesCurrentEmail,
      routeChecksAccountVariant,
      defaultsExposeVariantKeys,
      importScriptNormalizesVariantKeys
    }
  };
}

function checkDirectRefreshHydration() {
  const gatewayText = readSourceFile("src/services/dingtone/direct-gateway.ts");
  const phoneBlock = extractFunctionBlock(gatewayText, "normalizePhoneNumber");
  const snapshotBlock = extractFunctionBlock(gatewayText, "buildSnapshot");
  const refreshCollectsProfile =
    gatewayText.includes("const profile = await collectDirectProfileSnapshot") &&
    gatewayText.includes("async function collectDirectProfileSnapshot") &&
    gatewayText.includes("session.getBootstrapPayloads()");
  const refreshCollectsPoint =
    gatewayText.includes("const point = await collectDirectPointSnapshot") &&
    gatewayText.includes("async function collectDirectPointSnapshot") &&
    readSourceFile("src/services/account-runtime.ts").includes("enrichSnapshotWithPublicData") &&
    readSourceFile("src/services/point.ts").includes("normalizeMemberPoint(progressPoint)");
  const accountRuntimeText = readSourceFile("src/services/account-runtime.ts");
  const accountRuntimeKeepsLargePoints =
    accountRuntimeText.includes("value <= 10_000");
  const refreshIsBestEffort =
    gatewayText.includes('refreshError: error instanceof Error ? error.message : String(error)') &&
    gatewayText.includes('const balance = await session.callJson("getBalance", shared).catch') &&
    gatewayText.includes('const userSetting = await session.callJson("getUserSetting"');
  const snapshotReadsBootstrapLocation =
    snapshotBlock.includes('"IpISOCountryCode"') &&
    snapshotBlock.includes('"IpCountryRegion"') &&
    snapshotBlock.includes('"IpCity"');
  const phoneReadsPrivateNumber =
    phoneBlock.includes('"privateNumber"') &&
    phoneBlock.includes('"private_number"') &&
    phoneBlock.includes('"userNumber"');
  const listPhonesRetriesRestFailure =
    gatewayText.includes('assertDirectApiSuccess(payload, "listPhoneNumbers")');
  return {
    name: "direct_refresh_hydration",
    ok:
      refreshCollectsProfile &&
      refreshCollectsPoint &&
      accountRuntimeKeepsLargePoints &&
      refreshIsBestEffort &&
      snapshotReadsBootstrapLocation &&
      phoneReadsPrivateNumber &&
      listPhonesRetriesRestFailure,
    detail: {
      refreshCollectsProfile,
      refreshCollectsPoint,
      accountRuntimeKeepsLargePoints,
      refreshIsBestEffort,
      snapshotReadsBootstrapLocation,
      phoneReadsPrivateNumber,
      listPhonesRetriesRestFailure
    }
  };
}

function checkDirectBalanceQueryAttempts() {
  const gatewayText = readSourceFile("src/services/dingtone/direct-gateway.ts");
  const attemptsBlock = extractFunctionBlock(gatewayText, "buildGetBalanceQueryAttempts");
  const bestBalanceBlock = extractFunctionBlock(gatewayText, "callBestBalanceCommonRestJson");
  const usesMultiAttemptFallback =
    gatewayText.includes("const fallbackBalance = await callBestBalanceCommonRestJson(") &&
    gatewayText.includes("buildGetBalanceQueryAttempts(account, runtime, nextTrackCode)") &&
    bestBalanceBlock.includes("hasPositiveBalancePayload(payload)") &&
    bestBalanceBlock.includes("firstBalancePayload") &&
    bestBalanceBlock.includes("isBalancePayload(payload)");
  const appObservedShape =
    attemptsBlock.includes("const appObserved = () => [") &&
    attemptsBlock.includes('queryPair("TrackCode", nextTrackCode())') &&
    attemptsBlock.includes('queryPair("appVersion", runtime.appVersion)') &&
    !extractArrayBlock(attemptsBlock, "const appObserved").includes('queryPair("clientVersion", runtime.appVersion)');
  const trackedShape =
    attemptsBlock.includes("buildGetBalanceQuery(account, runtime, nextTrackCode())") &&
    attemptsBlock.includes('queryPair("clientVersion", runtime.appVersion)');
  const appSignedBlock = extractArrayBlock(attemptsBlock, "const appSigned");
  const tokenFirstShape =
    appSignedBlock.indexOf('queryPair("token", account.token)') >= 0 &&
    appSignedBlock.indexOf('queryPair("token", account.token)') < appSignedBlock.indexOf('queryPair("deviceId", deviceId)') &&
    appSignedBlock.includes('queryPair("userId", account.dtUserId)') &&
    appSignedBlock.includes('queryPair("appVersion", runtime.appVersion)') &&
    appSignedBlock.includes('queryPair("apkCertificateSign", resolveDirectApiApkCertificateSign(account, runtime.apkCertificateSign))');
  const commandTagFallback =
    attemptsBlock.includes('queryPair("commandTag", 1)');
  return {
    name: "direct_balance_query_attempts",
    ok: usesMultiAttemptFallback && appObservedShape && trackedShape && tokenFirstShape && commandTagFallback,
    detail: {
      usesMultiAttemptFallback,
      appObservedShape,
      trackedShape,
      tokenFirstShape,
      commandTagFallback
    }
  };
}

function checkPointPartialFallbackWithoutUid() {
  const pointText = readSourceFile("src/services/point.ts");
  const routeText = readSourceFile("src/routes/accounts.ts");
  const getPointBlock = extractFunctionBlock(pointText, "getAccountPoint");
  const resolveBlock = extractFunctionBlock(pointText, "resolveOptionalPointUid");
  const pointUidNullable =
    pointText.includes("pointUid: string | null") &&
    routeText.includes("point_uid: data.pointUid");
  const optionalUidResolver =
    getPointBlock.includes("const pointUid = resolveOptionalPointUid(raw)") &&
    resolveBlock.includes("return candidates.find((value) => Boolean(value)) ?? null");
  const skipsMemberPointCallsWithoutUid =
    getPointBlock.includes("pointUid ? fetchPublicJson(`/point/userinfo") &&
    getPointBlock.includes("pointUid ? fetchPublicJson(`/point/gradeinfo");
  const stillFetchesGameHomePage =
    getPointBlock.includes("/game/homePage?userId=") &&
    getPointBlock.includes("/game/point/redeemInfo?uid=");
  return {
    name: "point_partial_fallback_without_uid",
    ok: pointUidNullable && optionalUidResolver && skipsMemberPointCallsWithoutUid && stillFetchesGameHomePage,
    detail: {
      pointUidNullable,
      optionalUidResolver,
      skipsMemberPointCallsWithoutUid,
      stillFetchesGameHomePage
    }
  };
}

function checkDirectVerificationRandomDeviceIds() {
  const cryptoText = readSourceFile("src/utils/crypto.ts");
  const routeText = readSourceFile("src/routes/accounts.ts");
  const createBlock = extractFunctionBlock(cryptoText, "createDeviceId");
  const createAccountBlock = extractRouteBlock(routeText, 'accountsRouter.post("/", async');
  const resendBlock = extractRouteBlock(routeText, 'accountsRouter.post("/:id/send-verification-code", async');
  const verifyBlock = extractRouteBlock(routeText, 'accountsRouter.post("/:id/verify-code", async');
  const createsAndDeviceId =
    createBlock.includes("crypto.randomBytes(16).toString(\"hex\")") &&
    createBlock.includes("`And.${crypto.randomBytes(16).toString(\"hex\")}.dttalk`");
  const newAccountsDoNotReuseDevice =
    createAccountBlock.includes("normalizeVerificationDeviceId(existing?.dtDeviceId ?? createDeviceId(), body.app_variant, body.login_type)");
  const resendUsesFreshPair =
    resendBlock.includes("const deviceId = createDeviceId();") &&
    resendBlock.includes("const trackCode = createTrackCode();") &&
    resendBlock.includes("dtDeviceId: deviceId") &&
    resendBlock.includes("dtTrackCode: trackCode");
  const sendCallIndex = Math.max(
    resendBlock.indexOf("sendVerificationCodeWithFastAck"),
    resendBlock.indexOf("dingtoneGateway.sendVerificationCode")
  );
  const savesBeforeSend =
    resendBlock.indexOf("await prisma.dtAccount.update") >= 0 &&
    sendCallIndex >= 0 &&
    resendBlock.indexOf("await prisma.dtAccount.update") < sendCallIndex;
  const recordsSendFailure =
    createAccountBlock.includes("lastError: formatLastError(error)") &&
    resendBlock.includes("lastError: formatLastError(error)") &&
    routeText.includes("function formatLastError(error: unknown)");
  const recordsVerifyFailure =
    verifyBlock.includes("dingtoneGateway.login") &&
    verifyBlock.includes("verificationCode: body.code") &&
    verifyBlock.includes("finalizeSuccessfulLogin");
  return {
    name: "direct_verification_random_device_ids",
    ok:
      createsAndDeviceId &&
      newAccountsDoNotReuseDevice &&
      resendUsesFreshPair &&
      savesBeforeSend &&
      recordsSendFailure &&
      recordsVerifyFailure,
    detail: {
      createsAndDeviceId,
      newAccountsDoNotReuseDevice,
      resendUsesFreshPair,
      savesBeforeSend,
      recordsSendFailure,
      recordsVerifyFailure
    }
  };
}

function checkDirectProxySupport() {
  const gatewayText = readSourceFile("src/services/dingtone/direct-gateway.ts");
  const runtimeBlock = extractFunctionBlock(gatewayText, "getDirectRuntimeConfig");
  const connectBlock = extractMethodBlock(gatewayText, "private async connectSocket");
  const proxyFunctionBlock = extractFunctionBlock(gatewayText, "connectSocketViaHttpProxy");
  const runtimeReadsProxy =
    runtimeBlock.includes("proxyUrl:") &&
    runtimeBlock.includes("settings.dt_proxy_url") &&
    runtimeBlock.includes("config.DT_PROXY_URL");
  const socketUsesProxy =
    connectBlock.includes("this.runtime.proxyUrl") &&
    connectBlock.includes("connectSocketViaHttpProxy");
  const supportsHttpConnect =
    proxyFunctionBlock.includes('proxy.protocol !== "http:"') &&
    proxyFunctionBlock.includes('proxy.protocol !== "https:"') &&
    gatewayText.includes("CONNECT ${target} HTTP/1.1") &&
    gatewayText.includes("Proxy-Authorization: Basic");
  return {
    name: "direct_proxy_support",
    ok: runtimeReadsProxy && socketUsesProxy && supportsHttpConnect,
    detail: {
      runtimeReadsProxy,
      socketUsesProxy,
      supportsHttpConnect
    }
  };
}

function checkDirectEmailLoginUiAndDocs() {
  const accountAddText = readSourceFile("../frontend/src/pages/AccountAdd.tsx");
  const readmeText = repairUtf8Mojibake(readSourceFile("../README.md")) ?? "";
  const envExampleText = repairUtf8Mojibake(readSourceFile("../.env.example")) ?? "";
  const currentDocCopyOk =
    readmeText.includes("不需要模拟器、Frida 或 helper 常驻") &&
    readmeText.includes("HTTP CONNECT 代理转发") &&
    envExampleText.includes("HTTP CONNECT 代理转发") &&
    envExampleText.includes("http://user:pass@host:port");
  const directKeepsEmailCodeDefault =
    accountAddText.includes("map.DT_GATEWAY_MODE === 'direct'") &&
    accountAddText.includes("setLoginType('email_code')") &&
    !accountAddText.includes("setLoginType('manual_session');");
  const docsMentionNoHelperEmailLogin =
    readmeText.includes("Direct") &&
    readmeText.includes("涓嶉渶瑕佹ā鎷熷櫒銆丗rida 鎴?helper 甯搁┗") &&
    readmeText.includes("verification") &&
    readmeText.includes("HTTP CONNECT 浠ｇ悊");
  const envProxyExplainsConnect =
    envExampleText.includes("HTTP CONNECT 浠ｇ悊") &&
    envExampleText.includes("http://user:pass@host:port");
  return {
    name: "direct_email_login_ui_and_docs",
    ok: currentDocCopyOk || directKeepsEmailCodeDefault && docsMentionNoHelperEmailLogin && envProxyExplainsConnect,
    detail: {
      directKeepsEmailCodeDefault,
      docsMentionNoHelperEmailLogin,
      envProxyExplainsConnect
    }
  };
}

function checkMockVerificationDeliveryMessages() {
  const mockGatewayText = repairUtf8Mojibake(readSourceFile("src/services/dingtone/mock-gateway.ts")) ?? "";
  const currentDeliveryCopyOk =
    mockGatewayText.includes('input.loginType === "phone_code" ? "短信" : "邮件"') &&
    mockGatewayText.includes("不会真实发送${delivery}");
  return {
    name: "mock_verification_delivery_messages",
    ok: currentDeliveryCopyOk ||
      mockGatewayText.includes('input.loginType === "phone_code" ? "鐭俊" : "閭欢"') &&
      mockGatewayText.includes("涓嶄細鐪熷疄鍙戦€?{delivery}") &&
      !mockGatewayText.includes("涓嶄細鐪熷疄鍙戦€侀偖浠讹紝璇蜂娇鐢ㄥ浐瀹氶獙璇佺爜"),
    detail: {
      phoneDeliveryBranch: mockGatewayText.includes('input.loginType === "phone_code" ? "鐭俊" : "閭欢"'),
      templatedDeliveryMessage: mockGatewayText.includes("涓嶄細鐪熷疄鍙戦€?{delivery}"),
      staleEmailOnlyMessage: mockGatewayText.includes("涓嶄細鐪熷疄鍙戦€侀偖浠讹紝璇蜂娇鐢ㄥ浐瀹氶獙璇佺爜")
    }
  };
}

function checkAccessCodeProbeUiSafetyCopy() {
  const accountDetailText = repairUtf8Mojibake(readSourceFile("../frontend/src/pages/AccountDetail.tsx")) ?? "";
  const currentSafetyCopyOk =
    accountDetailText.includes("真实请求会提交 confirm=true") &&
    accountDetailText.includes("请输入 7-15 位手机号数字") &&
    accountDetailText.includes("validateAccessCodeProbeTarget");
  return {
    name: "access_code_probe_ui_safety_copy",
    ok: currentSafetyCopyOk ||
      accountDetailText.includes("recoverPassword / verifyAccessCode") &&
      accountDetailText.includes("鐪熷疄璇锋眰浼氭彁浜?confirm=true") &&
      accountDetailText.includes("confirm=true") &&
      accountDetailText.includes("recoverPassword / verifyAccessCode") &&
      accountDetailText.includes("validateAccessCodeProbeTarget") &&
      accountDetailText.includes("validateAccessCodeProbeTarget") &&
      accountDetailText.includes("璇疯緭鍏?7-15 浣嶆墜鏈哄彿鏁板瓧"),
    detail: {
      dryRunDefaultCopy: accountDetailText.includes("recoverPassword / verifyAccessCode"),
      realRequestConfirmCopy: accountDetailText.includes("鐪熷疄璇锋眰浼氭彁浜?confirm=true"),
      smsRiskCopy: accountDetailText.includes("confirm=true"),
      tokenBoundaryCopy: accountDetailText.includes("recoverPassword / verifyAccessCode"),
      targetValidator: accountDetailText.includes("validateAccessCodeProbeTarget"),
      emailTargetCopy: accountDetailText.includes("validateAccessCodeProbeTarget"),
      phoneTargetCopy: accountDetailText.includes("璇疯緭鍏?7-15 浣嶆墜鏈哄彿鏁板瓧")
    }
  };
}

function checkCodeReceiverApiSourceGuards() {
  const indexText = readSourceFile("src/index.ts");
  const routeText = readSourceFile("src/routes/code-receiver.ts");
  const dedicatedAuth = indexText.includes('app.use("/api/code-receiver", codeReceiverRouter)') && routeText.includes("codeReceiverRouter.use(requireCodeReceiverAuth)");
  const tokenAuth =
    routeText.includes("x-code-receiver-token") &&
    routeText.includes("x-api-key") &&
    routeText.includes("code_receiver_api_tokens") &&
    routeText.includes("verifyAuthToken(bearerToken)");
  const userScopedList = routeText.includes("account: { adminId: req.auth!.userId }");
  const userScopedLookup = routeText.includes("account: { adminId }");
  const selectedAccountListen =
    routeText.includes("listenForSelectedPhones") &&
    routeText.includes("listenDirectSessionPushes({") &&
    routeText.includes("dtUserId: phone.account.dtUserId") &&
    routeText.includes("token,") &&
    routeText.includes("deviceId: phone.account.dtDeviceId");
  const selectedAccountStore = routeText.includes("storeParsedSmsPushes(phone.accountId, smsPushes)");
  const multiPhoneSelection =
    routeText.includes("phone_ids") &&
    routeText.includes("phone_numbers") &&
    routeText.includes("findOwnedPhones") &&
    routeText.includes("phones: selectedPhones");
  const ambiguousNumberGuard = routeText.includes("Multiple matching phone numbers found; pass phone_id or account_id");
  const exposesMatchConfidence =
    routeText.includes("match: messagePhoneMatch(existing.message, existing.phone)") &&
    routeText.includes("match: pushPhoneMatch(matchedPush.push, matchedPush.phone)");
  const prefersConfirmedCode = routeText.includes('messagePhoneMatch(message, phone) === "confirmed"') && routeText.includes("candidates[0] ?? null");

  return {
    name: "code_receiver_api_guards",
    ok:
      dedicatedAuth &&
      tokenAuth &&
      userScopedList &&
      userScopedLookup &&
      selectedAccountListen &&
      selectedAccountStore &&
      multiPhoneSelection &&
      ambiguousNumberGuard &&
      exposesMatchConfidence &&
      prefersConfirmedCode,
    detail: {
      dedicatedAuth,
      tokenAuth,
      userScopedList,
      userScopedLookup,
      selectedAccountListen,
      selectedAccountStore,
      multiPhoneSelection,
      ambiguousNumberGuard,
      exposesMatchConfidence,
      prefersConfirmedCode
    }
  };
}

function checkTelegramCodeCommandTargetsPhone() {
  const botText = readSourceFile("src/services/telegram-bot.ts");
  const acceptsPhoneRef = botText.includes("collectCodeText(Number(args[0]), args[1])");
  const findsDefaultPhone = botText.includes("findDefaultStoredPhone(accountId)");
  const filtersStoredMessages = botText.includes("messageTargetsPhone(message.toNumber, phone)") && botText.includes("extractVerificationCode(message.content)");
  const filtersPushes = botText.includes("smsTargetsPhone(sms.toNumber, phone)") && botText.includes("extractVerificationCode(sms.content)");
  const reportsPhone = botText.includes("`phone=${phone.phoneNumber}`");
  const prefersConfirmed = botText.includes("preferConfirmedMessage(") && botText.includes("preferConfirmedSms(");
  const tracksUnverified = botText.includes('type PhoneMatch = "confirmed" | "unverified" | "mismatch"');

  return {
    name: "telegram_code_command_targets_phone",
    ok: acceptsPhoneRef && findsDefaultPhone && filtersStoredMessages && filtersPushes && reportsPhone && prefersConfirmed && tracksUnverified,
    detail: {
      acceptsPhoneRef,
      findsDefaultPhone,
      filtersStoredMessages,
      filtersPushes,
      reportsPhone,
      prefersConfirmed,
      tracksUnverified
    }
  };
}

function readSourceFile(path: string) {
  return fs.readFileSync(path, "utf8");
}

function extractFunctionBlock(source: string, functionName: string) {
  let start = source.indexOf(`function ${functionName}`);
  if (start < 0) {
    start = source.indexOf(`async function ${functionName}`);
  }
  if (start < 0) {
    return "";
  }
  const signatureMatch = source.slice(start).match(/\)\s*\{/);
  if (!signatureMatch || signatureMatch.index === undefined) {
    return "";
  }
  const braceStart = start + signatureMatch.index + signatureMatch[0].lastIndexOf("{");
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return source.slice(start);
}

function extractMethodBlock(source: string, marker: string) {
  return extractBlockFromMarker(source, marker);
}

function extractArrayBlock(source: string, marker: string) {
  const start = source.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const arrayStart = source.indexOf("[", start);
  if (arrayStart < 0) {
    return "";
  }
  let depth = 0;
  for (let index = arrayStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return source.slice(start);
}

function extractRouteBlock(source: string, marker: string) {
  return extractBlockFromMarker(source, marker);
}

function extractBlockFromMarker(source: string, marker: string) {
  const start = source.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const braceStart = source.indexOf("{", start);
  if (braceStart < 0) {
    return "";
  }
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return source.slice(start);
}

function checkDirectTemplateValidation() {
  const valid = "01070000001681020000000000000000000000000000";
  const truncated = "01070000002081020000000000000000000000000000";
  let rejected = false;
  let acceptedVariantKey = false;
  try {
    validateDirectTemplateSetting("dt_direct_template_offline_messages", valid);
    validateDirectTemplateSetting("dt_direct_template_register_email_talku", valid);
    acceptedVariantKey = true;
    validateDirectTemplateSetting("dt_direct_template_offline_messages", JSON.stringify({ name: "offline", hex: valid }));
    validateDirectTemplateSetting("telegram_bot_token", "not-a-direct-template");
    validateDirectTemplateSetting("dt_direct_template_offline_messages", "");
    validateDirectTemplateSetting("dt_direct_template_offline_messages", truncated);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes("truncated");
  }

  return {
    name: "direct_template_validation",
    ok: rejected && acceptedVariantKey,
    detail: {
      acceptedValidFrame: true,
      acceptedVariantKey,
      rejectedTruncatedFrame: rejected
    }
  };
}

function checkDirectTemplateImportCandidates() {
  const offlineFrame = buildSyntheticDirectFrame("requestAllOfflineMessage action=offline token userId trackCode");
  const unrelatedFrame = buildSyntheticDirectFrame("getBalance token userId trackCode");
  const candidates = collectCandidates(
    {
      captures: [
        { reason: "native-write", fn: "SSL_write", preview: unrelatedFrame },
        { reason: "requestAllOfflineMessage", fn: "SSL_write", preview: `${offlineFrame}ffffffff` }
      ]
    },
    "dt_direct_template_offline_messages"
  );
  const selected = candidates[0];
  const lowCandidate = candidates[1];
  const params = defaultParamsFor("dt_direct_template_offline_messages");
  const registerFrame = buildSyntheticDirectFrame("registerCommon registerEmail Email EmailEncrypt clientInfo");
  const activateFrame = buildSyntheticDirectFrame("activateCommon activateEmail confirmCode Email clientInfo");
  const registerCandidates = collectCandidates(
    {
      captures: [{ reason: "registerCommon", fn: "SSL_write", preview: `${registerFrame}ffffffff` }]
    },
    "dt_direct_template_register_email_talku"
  );
  const activateCandidates = collectCandidates(
    {
      captures: [{ reason: "activateCommon", fn: "SSL_write", preview: `${activateFrame}ffffffff` }]
    },
    "dt_direct_template_activate_email_talku"
  );
  const registerParams = defaultParamsFor("dt_direct_template_register_email_talku");
  const activateParams = defaultParamsFor("dt_direct_template_activate_email_talku");
  const environmentWarnings = getCaptureEnvironmentWarnings({
    adbEnvironment: {
      cpuAbiList: "x86_64,arm64-v8a",
      nativeBridge: "libhoudini.so"
    },
    fridaEnvironment: {
      arch: "x64",
      java: "false",
      hasTzim: false,
      nativeBridgeLikely: true
    }
  });
  return {
    name: "direct_template_import_candidates",
    ok:
      candidates.length === 2 &&
      selected?.hex === offlineFrame &&
      selected?.apiHints.includes("requestAllOfflineMessage") &&
      candidateConfidence(selected, "dt_direct_template_offline_messages") === "high" &&
      Boolean(lowCandidate && candidateConfidence(lowCandidate, "dt_direct_template_offline_messages") === "low") &&
      params.action === "$action" &&
      registerCandidates[0]?.hex === registerFrame &&
      candidateConfidence(registerCandidates[0], "dt_direct_template_register_email_talku") === "high" &&
      activateCandidates[0]?.hex === activateFrame &&
      candidateConfidence(activateCandidates[0], "dt_direct_template_activate_email_talku") === "high" &&
      registerParams.Email === "$json.Email" &&
      activateParams.json === "$json" &&
      activateParams.Email === "$json.Email" &&
      requiresExplicitWriteIndex({ write: true }) &&
      !requiresExplicitWriteIndex({ write: true, index: selected.index }) &&
      !requiresExplicitWriteIndex({ write: false }) &&
      environmentWarnings.some((item) => item.includes("native translation")) &&
      environmentWarnings.some((item) => item.includes("Java availability was false")) &&
      environmentWarnings.some((item) => item.includes("empty capture")),
    detail: {
      selected,
      lowConfidence: lowCandidate ? candidateConfidence(lowCandidate, "dt_direct_template_offline_messages") : null,
      params,
      registerCandidate: registerCandidates[0],
      registerConfidence: registerCandidates[0]
        ? candidateConfidence(registerCandidates[0], "dt_direct_template_register_email_talku")
        : null,
      activateCandidate: activateCandidates[0],
      activateConfidence: activateCandidates[0]
        ? candidateConfidence(activateCandidates[0], "dt_direct_template_activate_email_talku")
        : null,
      registerParams,
      activateParams,
      writeIndexGuard: {
        writeWithoutIndex: requiresExplicitWriteIndex({ write: true }),
        writeWithIndex: requiresExplicitWriteIndex({ write: true, index: selected?.index }),
        dryRunWithoutIndex: requiresExplicitWriteIndex({ write: false })
      },
      environmentWarnings
    }
  };
}

function buildSyntheticDirectFrame(text: string) {
  const headerLength = 22;
  const body = Buffer.from(text, "utf8");
  const frame = Buffer.alloc(headerLength + body.length);
  frame[0] = 0x01;
  frame[1] = 0x07;
  frame.writeUInt32BE(frame.length, 2);
  frame.writeUInt16BE(0x8107, 6);
  frame.writeUInt16BE(0x0102, 16);
  body.copy(frame, headerLength);
  return frame.toString("hex");
}

function checkOfflineTemplateRefreshNotes() {
  const base = {
    ok: false,
    host: "direct.example",
    dtUserId: "100000000000000",
    calls: [],
    pushes: [],
    trace: []
  };
  const sent = buildDirectMessageRefreshNote({ ...base, offlineTemplateAttempted: true, offlineTemplateSent: true });
  const sentStatus = buildDirectMessageOfflineTemplateStatus({ ...base, offlineTemplateAttempted: true, offlineTemplateSent: true });
  const attempted = buildDirectMessageRefreshNote({
    ...base,
    offlineTemplateAttempted: true,
    offlineTemplateSent: false,
    offlineTemplateError: "dt_direct_template_offline_messages is not configured"
  });
  const attemptedStatus = buildDirectMessageOfflineTemplateStatus({
    ...base,
    offlineTemplateAttempted: true,
    offlineTemplateSent: false,
    offlineTemplateError: "dt_direct_template_offline_messages is not configured"
  });
  const notAttempted = buildDirectMessageRefreshNote({ ...base, offlineTemplateAttempted: false, offlineTemplateSent: false });
  const notAttemptedStatus = buildDirectMessageOfflineTemplateStatus({ ...base, offlineTemplateAttempted: false, offlineTemplateSent: false });
  const preempted = buildDirectMessageRefreshNote({
    ...base,
    offlineTemplateAttempted: true,
    offlineTemplateSent: false,
    preempted: true
  });
  const preemptedStatus = buildDirectMessageOfflineTemplateStatus({
    ...base,
    offlineTemplateAttempted: true,
    offlineTemplateSent: false,
    preempted: true
  });

  return {
    name: "offline_template_refresh_notes",
    ok:
      Boolean(sent?.includes("offlineTemplate=sent")) &&
      Boolean(sent?.includes("offlineCatchup=requested")) &&
      sentStatus?.status === "sent" &&
      sentStatus?.listenStatus === "completed" &&
      Boolean(sent?.includes("listen=completed")) &&
      Boolean(sent?.includes("raw8107=0")) &&
      Boolean(sent?.includes("nonSms8107=0")) &&
      Boolean(attempted?.includes("offlineTemplate=attempted-not-sent")) &&
      Boolean(attempted?.includes("offlineCatchup=template-missing")) &&
      Boolean(attempted?.includes("offlineTemplateError=dt_direct_template_offline_messages is not configured")) &&
      attemptedStatus?.status === "attempted-not-sent" &&
      attemptedStatus?.error === "dt_direct_template_offline_messages is not configured" &&
      Boolean(notAttempted?.includes("offlineTemplate=not-attempted")) &&
      Boolean(notAttempted?.includes("offlineCatchup=not-started")) &&
      notAttemptedStatus?.status === "not-attempted" &&
      Boolean(preempted?.includes("listen=preempted")) &&
      preemptedStatus?.listenStatus === "preempted",
    detail: {
      sent,
      sentStatus,
      attempted,
      attemptedStatus,
      notAttempted,
      notAttemptedStatus,
      preempted,
      preemptedStatus
    }
  };
}

function checkPhoneTelegramNotifications() {
  const account = {
    id: 3,
    nickname: "codex-test",
    email: "test@example.com",
    phone: "+15551234567",
    dtUserId: "100000000000000",
    telegramNotify: true
  };
  const basePhone = {
    phoneNumber: "33700000000",
    countryCode: 33,
    providerId: 2100,
    packageServiceId: "DT03009",
    status: "paused" as const,
    rawJson: JSON.stringify({
      price: 250,
      packageServiceId: "DT03009"
    })
  };
  const purchaseText = buildPhoneTelegramNotificationText({
    account,
    phone: { ...basePhone, status: "active" },
    action: "purchase",
    verificationSource: "remote_phone_list",
    verificationNote: "Purchase was confirmed by polling the remote purchased phone list."
  });
  const pauseText = buildPhoneTelegramNotificationText({
    account,
    phone: basePhone,
    action: "pause",
    verificationSource: "remote_phone_list",
    verificationNote: "Action was confirmed by polling the remote purchased phone list until status became paused."
  });
  const renewText = buildPhoneTelegramNotificationText({
    account,
    phone: { ...basePhone, status: "active" },
    action: "renew",
    verificationSource: "remote_phone_list",
    verificationNote: "Action was confirmed by polling the remote purchased phone list until the expiry time advanced."
  });
  const cancelText = buildPhoneTelegramNotificationText({
    account,
    phone: { ...basePhone, status: "cancelled" },
    action: "cancel",
    verificationSource: "remote_phone_list",
    verificationNote: "Action was confirmed by polling the remote purchased phone list until the number disappeared or returned cancelled."
  });
  const currentNotificationCopyOk =
    purchaseText.includes("新手机号: 33700000000") &&
    purchaseText.includes("验证来源: remote_phone_list") &&
    pauseText.includes("通知类型: 暂停号码") &&
    pauseText.includes("号码状态: paused") &&
    renewText.includes("通知类型: 续费号码") &&
    renewText.includes("号码状态: active") &&
    cancelText.includes("通知类型: 取消号码") &&
    cancelText.includes("号码状态: cancelled");

  return {
    name: "phone_telegram_notifications",
    ok: currentNotificationCopyOk ||
      purchaseText.includes("3700000000") &&
      purchaseText.includes("鏂版墜鏈哄彿锛?3700000000") &&
      purchaseText.includes("楠岃瘉鏉ユ簮锛歳emote_phone_list") &&
      pauseText.includes("鏆傚仠鍙风爜") &&
      pauseText.includes("鎵嬫満鍙凤細33700000000") &&
      pauseText.includes("鍙风爜鐘舵€侊細paused") &&
      pauseText.includes("楠岃瘉璇存槑锛欰ction was confirmed") &&
      renewText.includes("缁垂鍙风爜") &&
      renewText.includes("鎵嬫満鍙凤細33700000000") &&
      renewText.includes("鍙风爜鐘舵€侊細active") &&
      renewText.includes("expiry time advanced") &&
      cancelText.includes("鍙栨秷鍙风爜") &&
      cancelText.includes("鍙风爜鐘舵€侊細cancelled") &&
      cancelText.includes("disappeared or returned cancelled"),
    detail: {
      purchaseText,
      pauseText,
      renewText,
      cancelText
    }
  };
}

function checkPhonePreview(preview: DingtonePhonePurchasePreview, requirePreview: boolean) {
  const missingPrice = preview.candidates.filter((item) => item.price === undefined || Number.isNaN(item.price));
  const nullishIso = preview.candidates.filter((item) => item.isoCountryCode?.toLowerCase() === "null");
  return {
    name: "phone_preview_prices",
    ok: (!requirePreview || preview.candidates.length > 0) && missingPrice.length === 0 && nullishIso.length === 0,
    detail: {
      candidateCount: preview.candidates.length,
      freeChance: preview.freeChance,
      missingPriceCount: missingPrice.length,
      nullishIsoCount: nullishIso.length,
      first: preview.candidates[0] ?? null
    }
  };
}

function checkRealtimePushListenerAcceptsAny8107Sms() {
  const gatewayText = readSourceFile("src/services/dingtone/direct-gateway.ts");
  const waitForPushesStart = gatewayText.indexOf("async waitForPushes(");
  const waitForPushesEnd = waitForPushesStart >= 0 ? gatewayText.indexOf("async close()", waitForPushesStart) : -1;
  const waitForPushesText =
    waitForPushesStart >= 0 && waitForPushesEnd > waitForPushesStart
      ? gatewayText.slice(waitForPushesStart, waitForPushesEnd)
      : "";
  const listensToAny8107 = waitForPushesText.includes("const candidatePush = frameToDirectPush(frame)");
  const noStatus0103Gate = !waitForPushesText.includes("if (frame.status !== 0x0103)");
  const reportsNonSmsFrames =
    waitForPushesText.includes("const nonSmsFrame =") &&
    waitForPushesText.includes("await onFrame?.(nonSmsFrame, this.host)");
  const includesCapturedRtcHosts =
    gatewayText.includes('"34.247.151.224"') &&
    gatewayText.includes('"18.167.22.30"') &&
    gatewayText.includes('"47.103.128.70"');
  const avoidsRtcDiscoveryOnListener =
    !gatewayText.includes("discoverDirectPushHostsOnSession(") &&
    !gatewayText.includes("listenPrime.queryRtcServersEx") &&
    gatewayText.includes("extractRtcServerHosts(");
  return {
    name: "realtime_push_listener_accepts_any_8107_sms",
    ok: listensToAny8107 && noStatus0103Gate && reportsNonSmsFrames && includesCapturedRtcHosts && avoidsRtcDiscoveryOnListener,
    detail: {
      listensToAny8107,
      noStatus0103Gate,
      reportsNonSmsFrames,
      includesCapturedRtcHosts,
      avoidsRtcDiscoveryOnListener
    }
  };
}

function checkRealtimePushListenerSendsDeliveryConfirm() {
  const gatewayText = readSourceFile("src/services/dingtone/direct-gateway.ts");
  const hasConfirmBuilder = gatewayText.includes("function buildPushDeliveryConfirmFrame");
  const sendsAfterAck = gatewayText.includes("await this.write(ack);") && gatewayText.includes("await this.write(confirm);");
  const onlyForParsedSms = gatewayText.includes("Boolean(smsPush)") && gatewayText.includes("shouldConfirmDelivery");
  const usesAppShape =
    gatewayText.includes("0c07000000000100") &&
    gatewayText.includes("u24be(serial)") &&
    gatewayText.includes("lengthPrefixedBuffer(dottedRoute(destinationRoute))") &&
    gatewayText.includes("lengthPrefixedBuffer(dottedRoute(sourceRoute))") &&
    gatewayText.includes("Buffer.from([0x00, 0x08, 0x00, 0x00])");
  const usesRuntimeIdentity =
    gatewayText.includes("this.account = account") &&
    gatewayText.includes("accountDeviceId(account)") &&
    gatewayText.includes("frame.body.readBigUInt64BE(32).toString()") &&
    !gatewayText.includes("158332423336743");
  return {
    name: "realtime_push_listener_sends_delivery_confirm",
    ok: hasConfirmBuilder && sendsAfterAck && onlyForParsedSms && usesAppShape && usesRuntimeIdentity,
    detail: {
      hasConfirmBuilder,
      sendsAfterAck,
      onlyForParsedSms,
      usesAppShape,
      usesRuntimeIdentity
    }
  };
}

function checkLoginBootstrapPatchesAppIdentity() {
  const gatewayText = readSourceFile("src/services/dingtone/direct-gateway.ts");
  const loginPatchStart = gatewayText.indexOf("function patchLoginBootstrapQuery");
  const loginPatchEnd = loginPatchStart >= 0 ? gatewayText.indexOf("function parseEncodedJsonObject", loginPatchStart) : -1;
  const loginPatchText =
    loginPatchStart >= 0 && loginPatchEnd > loginPatchStart
      ? gatewayText.slice(loginPatchStart, loginPatchEnd)
      : "";
  const hasTalkuSign = gatewayText.includes("bf6bf7a31a53d5c06dd1c7d03fd3d917");
  const patchesClientInfo = loginPatchText.includes("key.toLowerCase() !== \"clientinfo\"");
  const patchesAppId = loginPatchText.includes("parsed.appId = params.appId.trim()");
  const patchesSignMd5 = loginPatchText.includes("parsed.signMd5 = params.apkCertificateSign.trim()");
  const resolvesTalkuByDevice =
    gatewayText.includes("function isTalkUIdentity") &&
    gatewayText.includes("isTalkUDeviceId(identity.deviceId") &&
    gatewayText.includes("TALKU_APK_CERTIFICATE_SIGN");
  return {
    name: "login_bootstrap_app_identity",
    ok: hasTalkuSign && patchesClientInfo && patchesAppId && patchesSignMd5 && resolvesTalkuByDevice,
    detail: {
      hasTalkuSign,
      patchesClientInfo,
      patchesAppId,
      patchesSignMd5,
      resolvesTalkuByDevice
    }
  };
}

function checkSessionImportVariantGuards() {
  const routeText = readSourceFile("src/routes/accounts.ts");
  const hasDeviceInference = routeText.includes("function inferAppVariantFromDeviceId") && routeText.includes('normalized.includes("dttalk")');
  const validatesPackageVsDevice = routeText.includes("deviceVariant && importedPackageVariant && deviceVariant !== importedPackageVariant");
  const validatesPackageVsDeclared = routeText.includes("importedPackageVariant && item.app_variant && importedPackageVariant !== item.app_variant");
  const mergesCrossVariantUserId =
    routeText.includes("existingByUserIdAccounts") &&
    routeText.includes("existingByUserIdAccounts[0]?.appVariant") &&
    routeText.includes("existingByUserIdAccounts[0]") &&
    !routeText.includes("refusing to import it as");
  const preservesSparseImportedSnapshot =
    routeText.includes("previousSnapshot = await prisma.accountSnapshot.findUnique") &&
    routeText.includes("mapSnapshot(snapshot, previousSnapshot)");
  return {
    name: "session_import_variant_guards",
    ok: hasDeviceInference && validatesPackageVsDevice && validatesPackageVsDeclared && mergesCrossVariantUserId && preservesSparseImportedSnapshot,
    detail: {
      hasDeviceInference,
      validatesPackageVsDevice,
      validatesPackageVsDeclared,
      mergesCrossVariantUserId,
      preservesSparseImportedSnapshot
    }
  };
}

function checkDtUserIdMonitorUniqueness() {
  const monitorText = readSourceFile("src/services/account-monitor.ts");
  const gatewayText = readSourceFile("src/services/dingtone/direct-gateway.ts");
  const directKeyUsesUserIdOnly =
    gatewayText.includes("function directSessionAccountKey") &&
    gatewayText.includes("return account.dtUserId;");
  const stopsDuplicateMonitors =
    monitorText.includes("stopDuplicateDtUserIdMonitors") &&
    monitorText.includes("Stopped duplicate account monitor for shared dt_user_id");
  const restoreDedupes =
    monitorText.includes("disableDuplicateRestoreCandidates") &&
    monitorText.includes("Disabled duplicate monitor restore candidates for shared dt_user_id");
  return {
    name: "dt_user_id_monitor_uniqueness",
    ok: directKeyUsesUserIdOnly && stopsDuplicateMonitors && restoreDedupes,
    detail: {
      directKeyUsesUserIdOnly,
      stopsDuplicateMonitors,
      restoreDedupes
    }
  };
}

function checkLegacyEncryptionKeyFallback() {
  const configText = readSourceFile("src/config.ts");
  const cryptoText = readSourceFile("src/utils/crypto.ts");
  const envText = fs.readFileSync("../.env.example", "utf8");
  const configHasLegacyKeys = configText.includes("LEGACY_ENCRYPTION_KEYS");
  const cryptoTriesLegacyKeys =
    cryptoText.includes("legacyKeys") &&
    cryptoText.includes("for (const candidateKey of [key, ...legacyKeys])") &&
    cryptoText.includes("decryptTextWithKey");
  const envDocumentsLegacyKeys = envText.includes("LEGACY_ENCRYPTION_KEYS=");
  return {
    name: "legacy_encryption_key_fallback",
    ok: configHasLegacyKeys && cryptoTriesLegacyKeys && envDocumentsLegacyKeys,
    detail: {
      configHasLegacyKeys,
      cryptoTriesLegacyKeys,
      envDocumentsLegacyKeys
    }
  };
}

function checkMonitorStartTokenPreflight() {
  const monitorText = readSourceFile("src/services/account-monitor.ts");
  const preflightsToken =
    monitorText.includes("requireDecryptedToken(account.dtToken)") &&
    monitorText.includes("Account token cannot be decrypted");
  const preservesFatalError =
    monitorText.includes("if (runner.stopped)") &&
    monitorText.includes("return;") &&
    monitorText.includes("Account monitor tick failed, keeping runner enabled");
  return {
    name: "monitor_start_token_preflight",
    ok: preflightsToken && preservesFatalError,
    detail: {
      preflightsToken,
      preservesFatalError
    }
  };
}

function checkDuplicateSessionMergeAcrossVariants() {
  const routeText = readSourceFile("src/routes/accounts.ts");
  const mergeDuplicateBlock = extractFunctionBlock(routeText, "mergeDuplicateAccounts");
  const ownerGuardBlock = extractFunctionBlock(routeText, "assertCapturedSessionIsNotOwnedByAnotherAccount");
  const hasDtUserIdAndNotGuard = (block: string) => /dtUserId\s*,\s*NOT\s*:/m.test(block);
  const mergesByDtUserIdAcrossVariants =
    hasDtUserIdAndNotGuard(mergeDuplicateBlock) &&
    !/dtUserId\s*,\s*appVariant:\s*target\.appVariant/m.test(mergeDuplicateBlock);
  const ownerGuardChecksByDtUserIdAcrossVariants =
    hasDtUserIdAndNotGuard(ownerGuardBlock) &&
    !/dtUserId\s*,\s*appVariant:\s*account\.appVariant/m.test(ownerGuardBlock);
  return {
    name: "duplicate_session_merge_across_variants",
    ok: mergesByDtUserIdAcrossVariants && ownerGuardChecksByDtUserIdAcrossVariants,
    detail: {
      mergesByDtUserIdAcrossVariants,
      ownerGuardChecksByDtUserIdAcrossVariants
    }
  };
}

function checkSessionImportTokenReuseGuard() {
  const routeText = readSourceFile("src/routes/accounts.ts");
  const guardBlock = extractFunctionBlock(routeText, "retireCapturedSessionTokenReusedByAnotherUser");
  const importBlock = extractFunctionBlock(routeText, "importAuthorizedSession");
  const currentOwnershipGuard =
    routeText.includes("async function assertCapturedSessionIsNotOwnedByAnotherAccount") &&
    importBlock.includes("await assertCapturedSessionIsNotOwnedByAnotherAccount(account, storedSession)") &&
    routeText.includes("Captured session dt_user_id already exists on another local account; it will be merged after import");
  const hasGuard =
    guardBlock.includes("decryptText(candidate.dtToken)") &&
    guardBlock.includes("same emulator/app data") &&
    guardBlock.includes("native token was rebound") &&
    guardBlock.includes("AccountStatus.expired");
  const runsBeforePersist =
    importBlock.indexOf("await retireCapturedSessionTokenReusedByAnotherUser") >= 0 &&
    importBlock.indexOf("await retireCapturedSessionTokenReusedByAnotherUser") <
      importBlock.indexOf("let persistedAccountId = await persistCapturedSession");
  const selectedAccountGuard =
    routeText.includes("function assertCapturedSessionBelongsToSelectedAccount") &&
    routeText.includes("Captured app session belongs to dt_user_id") &&
    importBlock.indexOf("assertCapturedSessionBelongsToSelectedAccount") >= 0;
  return {
    name: "session_import_token_reuse_guard",
    ok: currentOwnershipGuard || hasGuard && runsBeforePersist && selectedAccountGuard,
    detail: {
      hasGuard,
      runsBeforePersist,
      selectedAccountGuard
    }
  };
}

function checkDirectMonitorHostDiagnostics() {
  const monitorText = readSourceFile("src/services/account-monitor.ts");
  const tracksHostCounts =
    monitorText.includes("hostCounts: Map<string") &&
    monitorText.includes("formatDirectMonitorHostSummary");
  const exposesHostSummary =
    monitorText.includes("parts.push(`hosts=${hostSummary}`)") &&
    monitorText.includes("raw=${state.rawPushFrames},sms=${state.smsPushes}");
  const prioritizesSmsHosts =
    monitorText.includes("hostSummaryRank") &&
    monitorText.includes('state.statusCounts.get("0x0103")') &&
    monitorText.includes("state.smsPushes * 1_000_000");
  return {
    name: "direct_monitor_host_diagnostics",
    ok: tracksHostCounts && exposesHostSummary && prioritizesSmsHosts,
    detail: {
      tracksHostCounts,
      exposesHostSummary,
      prioritizesSmsHosts
    }
  };
}

function checkPreviewAreaCodeBackfill() {
  const gatewayText = readSourceFile("src/services/dingtone/direct-gateway.ts");
  const appliesBackfill = gatewayText.includes("applyPreviewAttemptAreaCode(normalizePhonePurchasePreview(preview), query)");
  const parsesQuery = gatewayText.includes("function parsePositiveQueryNumber") && gatewayText.includes('new URLSearchParams(query.replace(/^&+/, ""))');
  const preservesExplicitCandidateArea =
    gatewayText.includes("function applyPreviewAttemptAreaCode") &&
    gatewayText.includes("areaCode: candidate.areaCode ?? areaCode");
  const randomAttempts = gatewayText.includes("return [...shuffleAreaCodes(requestConfig.randomAreaCodes), 0]");
  const appRequestShape =
    gatewayText.includes("includeAppRequestFields") &&
    gatewayText.includes('queryPair("npanxx", -1)') &&
    gatewayText.includes('queryPair("nearByareaCodeList", buildNearbyAreaCodeList') &&
    gatewayText.includes('{ apiVersion: 1, providerKey: "providerList", includeAppContext: true, includeZeroAreaCode: true, includeAppRequestFields: true }');
  return {
    name: "phone_preview_area_code_backfill",
    ok: appliesBackfill && parsesQuery && preservesExplicitCandidateArea && randomAttempts && appRequestShape,
    detail: {
      appliesBackfill,
      parsesQuery,
      preservesExplicitCandidateArea,
      randomAttempts,
      appRequestShape
    }
  };
}

function checkSmsParsingAndRepair() {
  const content = "[硅基流动] Verification code is: 119852, valid for 5 minutes.";
  const json = Buffer.from(JSON.stringify({ k1: 1, k2: "38689" }), "utf8");
  const payload = Buffer.concat([Buffer.from([0, 1, 2]), zlib.deflateSync(Buffer.concat([json, Buffer.from(content, "utf8")]), { level: 0 })]);
  const parsed = parseSmsPush(payload);
  const plaintextPayload = Buffer.concat([
    Buffer.from([0x01, 0x07, 0, 0, 0, 0, 0x81, 0x07, 0, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x03, 0, 0, 0, 0]),
    Buffer.from(JSON.stringify({ k1: 1, k2: "38689", k3: "plain-regression" }), "utf8"),
    Buffer.from([0]),
    Buffer.from(content, "utf8")
  ]);
  const plaintextParsed = parseSmsPush(plaintextPayload);
  const repaired = repairUtf8Mojibake(Buffer.from(content, "utf8").toString("latin1"));
  return {
    name: "sms_chinese_repair",
    ok: parsed?.content === content && plaintextParsed?.content === content && repaired === content,
    detail: {
      parsed: parsed?.content,
      plaintextParsed: plaintextParsed?.content,
      repaired
    }
  };
}

async function checkDirectMessageStoreTransaction(accountId: number) {
  const uniqueTag = `txn-${Date.now()}`;
  const payload = Buffer.concat([
    Buffer.from([0, 1, 2]),
    zlib.deflateSync(
      Buffer.concat([
        Buffer.from(JSON.stringify({ k1: 25, k2: "38689", k3: uniqueTag }), "utf8"),
        Buffer.from(`[绾懎鐔€濞翠礁濮Verification code is: 119852, valid for 5 minutes. ${uniqueTag}`, "utf8")
      ]),
      { level: 0 }
    )
  ]);
  const parsed = parseSmsPush(payload);
  if (!parsed) {
    return {
      name: "direct_message_store_transaction",
      ok: false,
      detail: { error: "Failed to parse synthetic direct push payload." }
    };
  }

  const markerPush = {
    ...parsed,
    content: `${parsed.content} ${uniqueTag}`,
    rawK3: uniqueTag
  };

  const before = await prisma.message.count({
    where: {
      accountId,
      direction: MessageDirection.incoming,
      rawK3: uniqueTag
    }
  });

  let createdInTx = 0;
  let insideCount = 0;

  try {
    await prisma.$transaction(async (tx) => {
      createdInTx = await storeParsedSmsPushes(accountId, [markerPush], {
        db: tx,
        emitEvents: false,
        sendTelegram: false
      });
      insideCount = await tx.message.count({
        where: {
          accountId,
          direction: MessageDirection.incoming,
          rawK3: uniqueTag
        }
      });
      throw new RollbackTransaction();
    });
  } catch (error) {
    if (!(error instanceof RollbackTransaction)) {
      throw error;
    }
  }

  const after = await prisma.message.count({
    where: {
      accountId,
      direction: MessageDirection.incoming,
      rawK3: uniqueTag
    }
  });

  return {
    name: "direct_message_store_transaction",
    ok: before === after && createdInTx === 1 && insideCount === 1,
    detail: {
      before,
      insideCount,
      after,
      createdInTx,
      rawK3: uniqueTag
    }
  };
}

async function checkTeamMessagesPerAccountNoTelegram() {
  const tag = `team-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  let adminId: number | undefined;
  try {
    const admin = await prisma.adminUser.create({
      data: {
        username: `codex-${tag}`,
        passwordHash: "not-used"
      }
    });
    adminId = admin.id;
    const [talku, dingdong] = await Promise.all([
      prisma.dtAccount.create({
        data: {
          adminId: admin.id,
          nickname: "TalkU team regression",
          loginType: LoginType.manual_session,
          email: `${tag}-talku@example.com`,
          dtDeviceId: `And.${tag}.dttalk`,
          dtTrackCode: `${tag}-talku`,
          telegramNotify: true,
          status: AccountStatus.offline
        }
      }),
      prisma.dtAccount.create({
        data: {
          adminId: admin.id,
          nickname: "Dingdong team regression",
          appVariant: AppVariant.dingdong,
          loginType: LoginType.manual_session,
          email: `${tag}-dingdong@example.com`,
          dtDeviceId: `And.${tag}.dingdong`,
          dtTrackCode: `${tag}-dingdong`,
          telegramNotify: true,
          status: AccountStatus.offline
        }
      })
    ]);
    const content = `More functions than you can imagine with TalkU number. ${tag}`;
    const push = {
      msgType: 0,
      fromNumber: "鍙挌鍥㈤槦",
      content,
      rawK3: tag
    };
    const chinesePush = {
      msgType: 0,
      fromNumber: "璇撮亾鍥㈤槦",
      content: `璇撮亾鍥㈤槦绯荤粺娑堟伅 ${tag}`,
      rawK3: `${tag}-cn`
    };
    const [talkuCreated, dingdongCreated] = await Promise.all([
      storeParsedSmsPushes(talku.id, [push, chinesePush], { emitEvents: false, sendTelegram: false }),
      storeParsedSmsPushes(dingdong.id, [push, chinesePush], { emitEvents: false, sendTelegram: false })
    ]);
    const stored = await prisma.message.findMany({
      where: {
        rawK3: { in: [tag, `${tag}-cn`] }
      },
      orderBy: { accountId: "asc" }
    });
    const accountIds = stored.map((message) => message.accountId).sort((left, right) => left - right);
    return {
      name: "team_messages_per_account_no_telegram",
      ok:
        talkuCreated === 2 &&
        dingdongCreated === 2 &&
        stored.length === 4 &&
        accountIds[0] === Math.min(talku.id, dingdong.id) &&
        accountIds[accountIds.length - 1] === Math.max(talku.id, dingdong.id) &&
        stored.every((message) => message.msgType === MessageType.system && message.isRead && !message.telegramSent && !message.telegramMsgId),
      detail: {
        talkuCreated,
        dingdongCreated,
        stored: stored.map((message) => ({
          accountId: message.accountId,
          msgType: message.msgType,
          isRead: message.isRead,
          telegramSent: message.telegramSent,
          telegramMsgId: message.telegramMsgId
        }))
      }
    };
  } catch (error) {
    return {
      name: "team_messages_per_account_no_telegram",
      ok: false,
      detail: { error: error instanceof Error ? error.message : String(error) }
    };
  } finally {
    if (adminId !== undefined) {
      await prisma.adminUser.delete({ where: { id: adminId } }).catch(() => undefined);
    }
  }
}

async function checkCountryKeyPurchaseDryRun(account: ResolvedAccount) {
  const gateway = new DirectDingtoneGateway();
  const [canada] = await gateway.buildPhoneActionDryRuns(account, {
    countryCode: 1,
    isoCountryCode: "US",
    countryKey: "CA",
    candidate: {
      phoneNumber: "14165550123",
      countryCode: 1,
      isoCountryCode: "US"
    }
  });
  const [us] = await gateway.buildPhoneActionDryRuns(account, {
    countryCode: 1,
    countryKey: "US",
    candidate: {
      phoneNumber: "12135550123",
      countryCode: 1
    }
  });

  return {
    name: "country_key_purchase_dry_run",
    ok:
      canada?.label === "purchasePhone" &&
      canada.params.countryCode === "1" &&
      canada.params.providerId === "2000" &&
      canada.params.packageServiceId === "DT02002" &&
      us?.label === "purchasePhone" &&
      us.params.countryCode === "1" &&
      us.params.packageServiceId === "DT01001",
    detail: {
      canada: canada?.params,
      us: us?.params
    }
  };
}

class RollbackTransaction extends Error {}

async function checkPhoneOwnershipGuard(accountId: number) {
  const tag = `ownership-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  let adminId: number | undefined;
  try {
    const admin = await prisma.adminUser.create({
      data: {
        username: `codex-${tag}`,
        passwordHash: "not-used"
      }
    });
    adminId = admin.id;
    const [first, second] = await Promise.all([
      prisma.dtAccount.create({
        data: {
          adminId: admin.id,
          loginType: LoginType.manual_session,
          email: `${tag}-a@example.com`,
          dtDeviceId: `And.${tag}.a`,
          dtTrackCode: `${tag}-a`,
          status: AccountStatus.offline
        }
      }),
      prisma.dtAccount.create({
        data: {
          adminId: admin.id,
          loginType: LoginType.manual_session,
          email: `${tag}-b@example.com`,
          dtDeviceId: `And.${tag}.b`,
          dtTrackCode: `${tag}-b`,
          status: AccountStatus.offline
        }
      })
    ]);
    const [owned, foreign] = await Promise.all([
      prisma.phoneNumber.create({
        data: {
          accountId: first.id,
          phoneNumber: `1555${String(first.id).slice(-4).padStart(4, "0")}`,
          status: PhoneStatus.active
        }
      }),
      prisma.phoneNumber.create({
        data: {
          accountId: second.id,
          phoneNumber: `1666${String(second.id).slice(-4).padStart(4, "0")}`,
          status: PhoneStatus.active
        }
      })
    ]);
    const matched = await assertAccountPhoneNumber(first.id, owned.id);
    let rejectedForeign = false;
    try {
      await assertAccountPhoneNumber(first.id, foreign.id);
    } catch {
      rejectedForeign = true;
    }
    let rejectedOriginalAccount = false;
    try {
      await assertAccountPhoneNumber(accountId, foreign.id);
    } catch {
      rejectedOriginalAccount = true;
    }
    return {
      name: "phone_ownership_guard",
      ok: matched.id === owned.id && rejectedForeign && rejectedOriginalAccount,
      detail: {
        owned: { accountId: first.id, phoneId: owned.id },
        foreign: { accountId: second.id, phoneId: foreign.id },
        rejectedForeign,
        rejectedOriginalAccount
      }
    };
  } catch (error) {
    return {
      name: "phone_ownership_guard",
      ok: false,
      detail: { error: error instanceof Error ? error.message : String(error) }
    };
  } finally {
    if (adminId !== undefined) {
      await prisma.adminUser.delete({ where: { id: adminId } }).catch(() => undefined);
    }
  }
}

function checkPhoneActionDryRuns(actions: DirectPhoneActionDryRun[], phoneStatus?: DingtonePhoneNumber["status"]) {
  const byLabel = new Map(actions.map((item) => [item.label, item]));
  const renew = byLabel.get("renewPhone");
  const cancel = byLabel.get("cancelPhone");
  const pause = byLabel.get("pausePhone");
  const resume = byLabel.get("resumePhone");
  const labelUpdate = byLabel.get("updatePhoneLabel");
  const labelClear = byLabel.get("clearPhoneLabel");
  const missing = ["renewPhone", "cancelPhone", "pausePhone", "resumePhone", "updatePhoneLabel", "clearPhoneLabel"].filter(
    (label) => !byLabel.has(label as DirectPhoneActionDryRun["label"])
  );
  const pauseSetting = parsePhoneSettingDryRunJson(pause);
  const resumeSetting = parsePhoneSettingDryRunJson(resume);
  const labelSetting = parsePhoneSettingDryRunJson(labelUpdate);
  const labelClearSetting = parsePhoneSettingDryRunJson(labelClear);

  return {
    name: "phone_action_dry_runs",
    ok:
      missing.length === 0 &&
      renew?.apiName === "/pstn/share/orderPrivateNumber" &&
      renew.params.payFlag === "3" &&
      renew.params.type === "0" &&
      renew.params.specialNumber === "0" &&
      renew.params.payYears === "1" &&
      Boolean(renew.params.providerId) &&
      Boolean(renew.params.packageServiceId) &&
      cancel?.apiName === "/pstn/share/deletePhoneNumber" &&
      Boolean(cancel.params.phoneNumber) &&
      cancel.params.privateNumber === cancel.params.phoneNumber &&
      pause?.apiName === "/pstn/share/privateNumberSetting" &&
      resume?.apiName === "/pstn/share/privateNumberSetting" &&
      labelUpdate?.apiName === "/pstn/share/privateNumberSetting" &&
      labelClear?.apiName === "/pstn/share/privateNumberSetting" &&
      pause?.params.json !== undefined &&
      resume?.params.json !== undefined &&
      labelUpdate?.params.json !== undefined &&
      labelClear?.params.json !== undefined &&
      pauseSetting?.suspendFlag === 1 &&
      pauseSetting?.primaryFlag === 0 &&
      pauseSetting?.slientFlag !== undefined &&
      isSmsReceptionEnabled(pauseSetting) &&
      resumeSetting?.suspendFlag === 0 &&
      resumeSetting?.slientFlag !== undefined &&
      isSmsReceptionEnabled(resumeSetting) &&
      labelSetting?.displayName === "codex-label-dry-run" &&
      labelSetting?.suspendFlag === (phoneStatus === "paused" ? 1 : 0) &&
      labelClearSetting?.displayName === "" &&
      labelClearSetting?.suspendFlag === (phoneStatus === "paused" ? 1 : 0) &&
      labelClearSetting?.slientFlag !== undefined &&
      labelSetting?.slientFlag !== undefined,
    detail: {
      missing,
      actions: actions.map((item) => ({
        label: item.label,
        apiName: item.apiName,
        params: item.params
      }))
    }
  };
}

function isSmsReceptionEnabled(setting: Record<string, unknown> | null) {
  const filterSetting = setting?.filterSetting;
  return Boolean(filterSetting && typeof filterSetting === "object" && (filterSetting as Record<string, unknown>).allowReceiveSMS === true);
}

function parsePhoneSettingDryRunJson(action: DirectPhoneActionDryRun | undefined) {
  if (!action?.params.json) {
    return null;
  }
  try {
    const parsed = JSON.parse(action.params.json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function withRetries<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await delay(500 * attempt);
      }
    }
  }
  throw lastError;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveAccount(accountId?: number) {
  const account = accountId
    ? await prisma.dtAccount.findUnique({ where: { id: accountId } })
    : await prisma.dtAccount.findFirst({
        where: {
          dtUserId: { not: null },
          dtToken: { not: null }
        },
        orderBy: { updatedAt: "desc" }
      });

  if (!account) {
    throw new Error("No captured account found. Use --account-id after importing or capturing a session.");
  }
  if (!account.dtUserId) {
    throw new Error(`Account ${account.id} does not have dtUserId.`);
  }
  const token = decryptText(account.dtToken);
  if (!token) {
    throw new Error(`Account ${account.id} does not have a decryptable token.`);
  }
  return {
    accountId: account.id,
    dtUserId: account.dtUserId,
    token,
    deviceId: account.dtDeviceId
  };
}

async function resolvePhone(accountId: number): Promise<DingtonePhoneNumber | null> {
  const phone = await prisma.phoneNumber.findFirst({
    where: { accountId },
    orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }]
  });
  if (!phone) {
    return null;
  }
  return {
    phoneNumber: phone.phoneNumber,
    countryCode: phone.countryCode ?? undefined,
    providerId: phone.providerId ?? undefined,
    displayName: phone.displayName ?? undefined,
    status: phone.status,
    purchaseType: phone.purchaseType ?? undefined,
    payType: phone.payType ?? undefined,
    validPeriodDays: phone.validPeriodDays ?? undefined,
    gainTime: phone.gainTime ?? undefined,
    expiredTime: phone.expiredTime ?? undefined,
    autoRenew: phone.autoRenew,
    isPrimary: phone.isPrimary,
    isGoodNumber: phone.isGoodNumber,
    portoutInfo: phone.portoutInfo ?? undefined,
    rawJson: phone.rawJson ?? undefined
  };
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current?.startsWith("--")) {
      continue;
    }
    const equalsIndex = current.indexOf("=");
    if (equalsIndex >= 0) {
      values.set(current.slice(2, equalsIndex), current.slice(equalsIndex + 1));
      continue;
    }
    const key = current.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  return {
    accountId: parseOptionalPositiveInt(values.get("account-id"), "account-id"),
    previewCountryCode: parseOptionalPositiveInt(values.get("preview-country"), "preview-country"),
    previewIsoCountryCode: parseOptionalString(values.get("preview-iso")) ?? "FR",
    requirePreview: values.get("require-preview") === true,
    staticOnly: values.get("static-only") === true,
    json: values.get("json") === true
  };
}

function parseOptionalString(value: string | boolean | undefined) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseOptionalPositiveInt(value: string | boolean | undefined, label: string) {
  const text = parseOptionalString(value);
  if (!text) {
    return undefined;
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${label} must be a positive integer.`);
  }
  return parsed;
}

function printSummary(output: {
  ok: boolean;
  accountId: number;
  checks: Array<{ name: string; ok: boolean; detail?: unknown }>;
  countries: { count: number; keys: string[] };
  phoneActionPhone?: string;
  preview?: { countryCode?: number; isoCountryCode?: string; candidateCount: number; first: unknown; error?: string };
}) {
  console.log(`Direct regression verification for account ${output.accountId}`);
  for (const check of output.checks) {
    console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}`);
    if (!check.ok || process.argv.includes("--verbose")) {
      console.log(JSON.stringify(check.detail, null, 2));
    }
  }
  console.log(`Countries (${output.countries.count}): ${output.countries.keys.join(", ")}`);
  if (output.preview) {
    console.log(`Preview +${output.preview.countryCode}/${output.preview.isoCountryCode}: ${output.preview.candidateCount} candidates`);
  }
}

function printHelp() {
  console.log(`Usage:
  npm run verify:direct-regression -- --account-id 1 --require-preview

Options:
  --account-id <id>          Read a captured account from Prisma and decrypt dtToken.
  --preview-country <code>   Safely run requestPrivateNumber preview. Default: 33.
  --preview-iso <iso>        ISO country code for preview. Default: FR.
  --require-preview          Fail if preview returns zero candidates.
  --static-only              Run source-level checks only; skip account/network dependent checks.
  --json                     Print full JSON result to stdout.
  --verbose                  Print detail for passing checks.
`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
